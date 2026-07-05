// Graylog-compatible message store over Postgres (table graylog_messages).
// Port of tok-scrape/graylog-shim/main.ts with Deno KV swapped for Postgres;
// parser/response semantics unchanged (see docs/CONTRACTS.md "Graylog store").

// @ts-types="@types/pg"
import type { Pool } from "pg";
import { astToSql, parseQuery } from "./lucene.ts";

export const GRAYLOG_INDEX = "graylog_pg";

const FIVE_YEARS_S = 157_680_000; // range values ≥ this mean "all-time"
const DEFAULT_LIMIT = 150;
const MAX_LIMIT = 10_000;

export interface SearchParams {
  query?: string;
  /** Window in seconds back from now; 0 or ≥ ~5 years ⇒ all-time. */
  rangeSeconds?: number;
  limit?: number;
  /** Field whitelist; timestamp + source are always included. */
  fields?: string[] | null;
}

export interface SearchMessage {
  message: Record<string, unknown>;
  index: string;
}

export interface SearchResult {
  messages: SearchMessage[];
  total_results: number;
  from: string;
  to: string;
  fields: string[];
  used_indices: string[];
  time: number;
  /**
   * Lower bound of the search window (epoch ms); null ⇒ unbounded. Drives the
   * empty-window 500 rule in handleSearchRequest — not part of the HTTP body.
   */
  windowMinMs: number | null;
}

export interface GraylogStore {
  /** GELF v1.1 message (or backup-shaped object) → one graylog_messages row. */
  ingestGelf(
    body: unknown,
  ): Promise<{ ok: boolean; id?: string; error?: string }>;
  /** In-process writer replacing sendGelfMessage; source defaults to "lp-os". */
  logEvent(
    shortMessage: string,
    fields: Record<string, unknown>,
  ): Promise<boolean>;
  search(params: SearchParams): Promise<SearchResult>;
  newestTimestampMs(): Promise<number | null>;
}

interface NormalizedRow {
  messageId: string;
  timestamp: string; // canonical ISO, always UTC "…Z"
  source: string;
  message: string;
  fields: Record<string, unknown>;
}

// GELF v1.1 → row: host→source, short_message→message, unix-seconds fractional
// timestamp→ISO, single-underscore prefix stripped from custom fields,
// _graylog_key consumed by the auth gate and never stored.
export function gelfToRow(g: Record<string, unknown>): NormalizedRow {
  const source = String(g.host ?? "unknown");
  const n = g.timestamp != null ? Number(g.timestamp) : NaN;
  const ms = Number.isNaN(n) ? Date.now() : Math.round(n * 1000);
  const ts = new Date(ms).toISOString();
  const fields: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(g)) {
    if (
      key === "version" || key === "host" || key === "timestamp" ||
      key === "level" || key === "_graylog_key"
    ) continue;
    if (key === "short_message" || key === "full_message") {
      fields.message = v;
      continue;
    }
    fields[key.startsWith("_") ? key.slice(1) : key] = v;
  }
  fields.source = source;
  fields.timestamp = ts;
  const messageId = typeof g._id === "string" && g._id
    ? g._id
    : crypto.randomUUID();
  const message = typeof g.short_message === "string"
    ? g.short_message
    : String(fields.message ?? "");
  return { messageId, timestamp: ts, source, message, fields };
}

function clampLimit(v: unknown): number {
  const n = Number(v ?? DEFAULT_LIMIT);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export function createGraylogStore(pool: Pool): GraylogStore {
  // ON CONFLICT DO NOTHING = idempotency on message_id (original _id or UUID).
  async function insertRow(row: NormalizedRow): Promise<void> {
    await pool.query(
      `INSERT INTO graylog_messages (message_id, "timestamp", source, message, fields)
       VALUES ($1, $2::timestamptz, $3, $4, $5::jsonb)
       ON CONFLICT (message_id) DO NOTHING`,
      [
        row.messageId,
        row.timestamp,
        row.source,
        row.message,
        JSON.stringify(row.fields),
      ],
    );
  }

  return {
    async ingestGelf(body: unknown) {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, error: "expected a GELF object" };
      }
      try {
        const row = gelfToRow(body as Record<string, unknown>);
        await insertRow(row);
        return { ok: true, id: row.messageId };
      } catch (err) {
        return {
          ok: false,
          error: String(err instanceof Error ? err.message : err),
        };
      }
    },

    async logEvent(shortMessage: string, fields: Record<string, unknown>) {
      try {
        const source = String(fields.source ?? "lp-os");
        const ts = new Date().toISOString();
        const flat: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(fields)) {
          if (key === "_graylog_key") continue;
          flat[key.startsWith("_") ? key.slice(1) : key] = v;
        }
        flat.source = source;
        flat.message = shortMessage;
        flat.timestamp = ts;
        await insertRow({
          messageId: crypto.randomUUID(),
          timestamp: ts,
          source,
          message: shortMessage,
          fields: flat,
        });
        return true;
      } catch (err) {
        console.error("[graylog] logEvent failed:", err);
        return false;
      }
    },

    async search(p: SearchParams): Promise<SearchResult> {
      const t0 = performance.now();
      const ast = parseQuery(p.query ?? "*");
      const rangeRaw = Number(p.rangeSeconds ?? 0);
      const rangeS = Number.isFinite(rangeRaw) ? rangeRaw : 0;
      const unbounded = rangeS <= 0 || rangeS >= FIVE_YEARS_S;
      const nowMs = Date.now();
      const minMs = unbounded ? null : nowMs - rangeS * 1000;

      const { clause, values } = astToSql(ast);
      const params: unknown[] = [...values];
      let where = `(${clause})`;
      params.push(new Date(nowMs).toISOString());
      where += ` AND "timestamp" <= $${params.length}::timestamptz`;
      if (minMs !== null) {
        params.push(new Date(minMs).toISOString());
        where += ` AND "timestamp" >= $${params.length}::timestamptz`;
      }
      const limit = clampLimit(p.limit);
      params.push(limit);

      const res = await pool.query(
        `SELECT fields, COUNT(*) OVER() AS total
           FROM graylog_messages
          WHERE ${where}
          ORDER BY "timestamp" DESC, id DESC
          LIMIT $${params.length}`,
        params,
      );

      const total = res.rows.length ? Number(res.rows[0].total) : 0;
      const whitelist = p.fields && p.fields.length ? p.fields : null;
      const messages: SearchMessage[] = res.rows.map((row) => {
        let m = row.fields as Record<string, unknown>;
        if (whitelist) {
          const keep: Record<string, unknown> = {
            timestamp: m.timestamp,
            source: m.source,
          };
          for (const f of whitelist) if (f in m) keep[f] = m[f];
          m = keep;
        }
        return { message: m, index: GRAYLOG_INDEX };
      });

      const fieldSet = new Set<string>();
      for (const m of messages) {
        for (const k of Object.keys(m.message)) fieldSet.add(k);
      }

      return {
        messages,
        total_results: total,
        from: minMs === null
          ? new Date(0).toISOString()
          : new Date(minMs).toISOString(),
        to: new Date(nowMs).toISOString(),
        fields: [...fieldSet].sort(),
        used_indices: [GRAYLOG_INDEX], // ALWAYS non-empty on a real response
        time: Math.round(performance.now() - t0),
        windowMinMs: minMs,
      };
    },

    async newestTimestampMs(): Promise<number | null> {
      const res = await pool.query(
        `SELECT max("timestamp") AS newest FROM graylog_messages`,
      );
      const v = res.rows[0]?.newest;
      if (v == null) return null;
      return v instanceof Date ? v.getTime() : Date.parse(String(v));
    },
  };
}
