// Backfill graylog_messages from a Graylog backup ndjson file.
//
// Line shape (from ~/graylog-backups/<date>/messages.ndjson):
//   { "_id": "...", "source": "...", "timestamp": "2026-05-28 03:17:37.000", "fields": { ... } }
//
// Usage:
//   DATABASE_URL=postgres://… deno run -A packages/graylog/scripts/backfill.ts <messages.ndjson>
//
// Idempotent: ON CONFLICT (message_id) DO NOTHING, so duplicate lines collapse
// and re-running is safe. Prints imported/skipped counts.

// @ts-types="@types/pg"
import pg from "pg";
// @ts-types="@types/pg"
import type { Pool } from "pg";
import { ensureGraylogSchema } from "../schema.ts";

const BATCH_SIZE = 200;

interface BackupLine {
  _id: string;
  source: string;
  timestamp: string;
  fields: Record<string, unknown>;
}

export interface BackfillResult {
  lines: number;
  imported: number;
  skipped: number;
}

// Backup timestamps are space-separated UTC with NO zone ("2026-05-28 03:17:37.000").
// NEVER `new Date("2026-05-28 03:17:37.000")` — V8 parses the space form as LOCAL
// time. Force ISO-T + Z so it's unambiguously UTC, matching the wire contract.
export function parseBackupTs(ts: string): number {
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  const ms = Date.parse(iso.endsWith("Z") ? iso : iso + "Z");
  if (Number.isNaN(ms)) throw new Error(`bad timestamp: ${ts}`);
  return ms;
}

export async function backfill(
  pool: Pool,
  path: string,
): Promise<BackfillResult> {
  await ensureGraylogSchema(pool);
  const text = await Deno.readTextFile(path);
  const lines = text.split("\n").filter((l) => l.trim());

  let imported = 0;
  let skipped = 0;

  for (let i = 0; i < lines.length; i += BATCH_SIZE) {
    const batch = lines.slice(i, i + BATCH_SIZE);
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (const line of batch) {
      const d = JSON.parse(line) as BackupLine;
      if (!d || !d._id) {
        skipped++;
        continue;
      }
      const ms = parseBackupTs(d.timestamp);
      const ts = new Date(ms).toISOString();
      const fields: Record<string, unknown> = {
        ...d.fields,
        source: d.source,
        timestamp: ts,
      };
      const message = typeof fields.message === "string"
        ? fields.message
        : String(fields.message ?? "");
      const base = values.length;
      values.push(d._id, ts, d.source, message, JSON.stringify(fields));
      tuples.push(
        `($${base + 1}, $${base + 2}::timestamptz, $${base + 3}, $${
          base + 4
        }, $${base + 5}::jsonb)`,
      );
    }
    if (!tuples.length) continue;
    const res = await pool.query(
      `INSERT INTO graylog_messages (message_id, "timestamp", source, message, fields)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (message_id) DO NOTHING`,
      values,
    );
    const inserted = res.rowCount ?? 0;
    imported += inserted;
    skipped += tuples.length - inserted;
  }

  return { lines: lines.length, imported, skipped };
}

if (import.meta.main) {
  const path = Deno.args[0];
  if (!path) {
    console.error(
      "usage: deno run -A packages/graylog/scripts/backfill.ts <messages.ndjson>",
    );
    Deno.exit(2);
  }
  const dbUrl = Deno.env.get("DATABASE_URL");
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    Deno.exit(2);
  }
  const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
  try {
    const r = await backfill(pool, path);
    console.log(
      `imported ${r.imported} rows from ${r.lines} lines; skipped ${r.skipped} (duplicate _id / already present)`,
    );
  } finally {
    await pool.end();
  }
}
