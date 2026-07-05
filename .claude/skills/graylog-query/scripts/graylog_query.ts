#!/usr/bin/env -S deno run -A
// Query the LP-OS Graylog message store from the command line.
//
// Two modes:
//
//   DIRECT (default) — queries Postgres (`graylog_messages`) straight over
//   DATABASE_URL, translating the mini-Lucene query with @lp-os/graylog's
//   parseQuery/astToSql. No HTTP server needed.
//
//     DATABASE_URL=postgres://... \
//       deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --list-sources --all
//
//   IMPORTANT: run from the lp-os repo root (or any dir inside the repo) so
//   Deno's workspace resolution can map "@lp-os/graylog" to packages/graylog.
//
//   --url — hits any Graylog-compatible REST endpoint
//   (GET /api/search/universal/relative): LP-OS itself, the legacy Deno-KV
//   shim, or a real Graylog. Same Basic-auth conventions as the old python
//   script: an API token goes in the Basic username slot with the literal
//   password "token"; a user/password pair is plain Basic auth. LP-OS does
//   not require auth; the legacy shim does.
//
//     deno run -A .../graylog_query.ts --url http://localhost:8000 -q 'source:thirsty-store-kiosk' --last 7d
//
// Credential resolution in --url mode, highest priority first:
//   1. --user/--password  (or env GRAYLOG_USER / GRAYLOG_PASSWORD)
//   2. --token            (or env GRAYLOG_TOKEN)
//   3. none → unauthenticated request (fine for LP-OS; the legacy shim 401s)
//
// Read-only by design: it only SELECTs / GETs. It never ingests, never
// deletes, and never prints DATABASE_URL or credentials.

import { parseArgs } from "node:util";
import { astToSql, parseQuery } from "@lp-os/graylog";
import pg from "pg";

const FIVE_YEARS_SECONDS = 5 * 365 * 24 * 3600; // ≥ this (or 0) ⇒ all-time
const DEFAULT_RANGE_SECONDS = 30 * 24 * 3600; // 30 days
const DEFAULT_COLUMNS = ["timestamp", "source", "creator", "message"];

// --------------------------------------------------------------------------
// Args
// --------------------------------------------------------------------------

const HELP =
  `graylog_query.ts — query the LP-OS Graylog store (run from the lp-os repo root)

  -q, --query LUCENE     Lucene query (default '*'). Quote it in the shell.
  --last 7d|24h|90m      Relative window (also plain seconds: 3600).
  --range SECONDS        Relative window in seconds.
  --all                  ~5 years (effectively all time).
  --fields a,b,c         Field whitelist for the result rows.
  --limit N              Max messages to fetch (default 200).
  --sort FIELD:dir       Default timestamp:desc.
  --terms FIELD          Count messages per distinct value of FIELD (aggregate).
  --list-sources         Shortcut for --terms source — what's in the store.
  --json                 Raw JSON (Graylog response envelope shape).
  --show-sql             Direct mode: print the SQL + params and exit.
  --show-url             --url mode: print the request URL (no creds) and exit.
  --url URL              Graylog-compatible REST base (env GRAYLOG_API_URL).
  --token TOKEN          API token for --url mode (env GRAYLOG_TOKEN).
  --user / --password    Basic auth for --url mode (env GRAYLOG_USER/GRAYLOG_PASSWORD).
  -h, --help             This text.

Direct mode needs DATABASE_URL. If DATABASE_URL is unset but GRAYLOG_API_URL
is set, URL mode is used automatically.`;

function parseCli(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        query: { type: "string", short: "q", default: "*" },
        last: { type: "string" },
        range: { type: "string" },
        all: { type: "boolean", default: false },
        fields: { type: "string" },
        limit: { type: "string", default: "200" },
        sort: { type: "string", default: "timestamp:desc" },
        terms: { type: "string" },
        "list-sources": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "show-sql": { type: "boolean", default: false },
        "show-url": { type: "boolean", default: false },
        url: { type: "string" },
        token: { type: "string" },
        user: { type: "string" },
        password: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }).values;
  } catch (e) {
    fail(`${(e as Error).message}\n\n${HELP}`);
  }
}

function fail(msg: string): never {
  console.error(msg);
  Deno.exit(1);
}

const DUR_UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

function parseDuration(s: string): number {
  const t = s.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(\d+)\s*([smhdw])$/);
  if (!m) fail(`Bad --last value '${s}'. Use forms like 7d, 24h, 90m, 3600.`);
  return Number(m[1]) * DUR_UNITS[m[2]];
}

function resolveRange(a: ReturnType<typeof parseCli>): number {
  if (a.all) return FIVE_YEARS_SECONDS;
  if (a.range !== undefined) {
    if (!/^\d+$/.test(a.range)) {
      fail(`--range must be an integer (got '${a.range}').`);
    }
    return Number(a.range);
  }
  if (a.last) return parseDuration(a.last);
  return DEFAULT_RANGE_SECONDS;
}

// --------------------------------------------------------------------------
// Direct mode (Postgres via @lp-os/graylog's parser)
// --------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Envelope = {
  messages: { message: Row }[];
  total_results: number;
  time?: number;
  _empty_window?: boolean;
  _direct?: boolean;
};

function sortExpr(sort: string): string {
  const [rawField, rawDir] = sort.split(":");
  const field = (rawField || "timestamp").trim();
  const dir = (rawDir || "desc").trim().toLowerCase() === "asc"
    ? "ASC"
    : "DESC";
  if (!/^[A-Za-z0-9_.@-]+$/.test(field)) fail(`Bad --sort field '${field}'.`);
  if (field === "timestamp") return `"timestamp" ${dir}`;
  const lit = field.replaceAll("'", "''");
  // Numeric-looking values sort numerically, everything else lexically;
  // rows missing the field sort last. Timestamp is the tiebreak.
  return `(CASE WHEN fields->>'${lit}' ~ '^-?[0-9]+(\\.[0-9]+)?$' ` +
    `THEN (fields->>'${lit}')::numeric END) ${dir} NULLS LAST, ` +
    `fields->>'${lit}' ${dir} NULLS LAST, "timestamp" DESC`;
}

function buildDirectSql(
  query: string,
  rangeSeconds: number,
  sort: string,
  limit: number,
): { countSql: string; rowsSql: string; params: unknown[] } {
  const ast = parseQuery(query || "*");
  // Contract (docs/CONTRACTS.md, Graylog section): astToSql returns a
  // parameterized WHERE clause whose placeholders are numbered $1..$n in
  // order, matching `values` — extra params are appended after them.
  const { clause, values } = astToSql(ast);
  const params: unknown[] = [...values];
  let where = clause && clause.trim() ? `(${clause})` : "TRUE";
  if (rangeSeconds > 0 && rangeSeconds < FIVE_YEARS_SECONDS) {
    params.push(rangeSeconds);
    where +=
      ` AND "timestamp" >= now() - ($${params.length} * interval '1 second')`;
  }
  const countSql =
    `SELECT count(*)::int AS n FROM graylog_messages WHERE ${where}`;
  params.push(limit);
  const rowsSql = `SELECT message_id, "timestamp", source, message, fields ` +
    `FROM graylog_messages WHERE ${where} ` +
    `ORDER BY ${sortExpr(sort)} LIMIT $${params.length}`;
  return { countSql, rowsSql, params };
}

function flattenRow(r: Row, fields: string[] | null): Row {
  const raw = (r.fields ?? {}) as Row;
  const msg: Row = { ...raw };
  // Mirror the search-endpoint contract: fields carries flat copies, but
  // timestamp/source/message fall back to the real columns.
  const ts = r.timestamp instanceof Date
    ? r.timestamp.toISOString()
    : r.timestamp;
  if (msg.timestamp === undefined) msg.timestamp = ts;
  if (msg.source === undefined) msg.source = r.source;
  if (msg.message === undefined) msg.message = r.message;
  if (!fields) return msg;
  const keep = new Set([...fields, "timestamp", "source"]);
  const out: Row = {};
  for (const k of keep) if (msg[k] !== undefined) out[k] = msg[k];
  return out;
}

async function searchDirect(
  dbUrl: string,
  query: string,
  rangeSeconds: number,
  fields: string[] | null,
  limit: number,
  sort: string,
  showSql: boolean,
): Promise<Envelope | null> {
  const { countSql, rowsSql, params } = buildDirectSql(
    query,
    rangeSeconds,
    sort,
    limit,
  );
  if (showSql) {
    console.log(rowsSql);
    console.log(`-- count: ${countSql}`);
    console.log(`-- params: ${JSON.stringify(params)}`);
    return null;
  }
  const host = (() => {
    try {
      return new URL(dbUrl).hostname;
    } catch {
      return "";
    }
  })();
  const local = host === "localhost" || host === "127.0.0.1" || host === "";
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: local ? undefined : { rejectUnauthorized: false }, // Neon-compatible TLS
  });
  const started = Date.now();
  let count: { rows: Row[] };
  let rows: { rows: Row[] };
  let emptyWindow = false;
  try {
    await client.connect();
    count = await client.query(countSql, params.slice(0, params.length - 1));
    rows = await client.query(rowsSql, params);
    // Mirror --url mode's empty-window distinction: 0 results in a BOUNDED
    // window whose lower edge is newer than everything stored means "the
    // window misses the data", not "no data matches".
    const bounded = rangeSeconds > 0 && rangeSeconds < FIVE_YEARS_SECONDS;
    if (bounded && Number(count.rows[0]?.n ?? 0) === 0) {
      const newest = await client.query(
        `SELECT max("timestamp") AS newest FROM graylog_messages`,
      );
      const raw = newest.rows[0]?.newest;
      const newestMs = raw instanceof Date
        ? raw.getTime()
        : raw
        ? Date.parse(String(raw))
        : NaN;
      if (
        Number.isFinite(newestMs) &&
        newestMs < Date.now() - rangeSeconds * 1000
      ) {
        emptyWindow = true;
      }
    }
  } catch (e) {
    await client.end().catch(() => {}); // closing a failed connection is best-effort
    fail(
      `Postgres query failed: ${(e as Error).message}\n` +
        `Check DATABASE_URL (not printed here) and that migrations created graylog_messages.`,
    );
  }
  await client.end().catch(() => {});
  return {
    messages: rows.rows.map((r: Row) => ({ message: flattenRow(r, fields) })),
    total_results: Number(count.rows[0]?.n ?? 0),
    time: Date.now() - started,
    _direct: true,
    ...(emptyWindow ? { _empty_window: true } : {}),
  };
}

// --------------------------------------------------------------------------
// URL mode (Graylog-compatible REST)
// --------------------------------------------------------------------------

function resolveAuth(
  a: ReturnType<typeof parseCli>,
): { header: string | null; label: string } {
  const user = a.user || Deno.env.get("GRAYLOG_USER");
  const password = a.password ?? Deno.env.get("GRAYLOG_PASSWORD") ?? "";
  if (user) {
    return {
      header: "Basic " + btoa(`${user}:${password}`),
      label: `user '${user}'`,
    };
  }
  const token = a.token || Deno.env.get("GRAYLOG_TOKEN");
  if (token) {
    // Graylog convention: token in the username slot, literal password "token".
    return {
      header: "Basic " + btoa(`${token}:token`),
      label: `API token (…${token.slice(-6)})`,
    };
  }
  return {
    header: null,
    label: "no auth (LP-OS accepts this; legacy shim will 401)",
  };
}

function buildSearchUrl(
  base: string,
  query: string,
  rangeSeconds: number,
  fields: string[] | null,
  limit: number,
  sort: string,
): string {
  const u = new URL(
    base.replace(/\/+$/, "") + "/api/search/universal/relative",
  );
  u.searchParams.set("query", query || "*");
  u.searchParams.set("range", String(rangeSeconds));
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("sort", sort);
  if (fields) u.searchParams.set("fields", fields.join(","));
  return u.href;
}

async function searchUrl(
  base: string,
  auth: { header: string | null; label: string },
  query: string,
  rangeSeconds: number,
  fields: string[] | null,
  limit: number,
  sort: string,
): Promise<Envelope> {
  const url = buildSearchUrl(base, query, rangeSeconds, fields, limit, sort);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Requested-By": "graylog-query-skill",
  };
  if (auth.header) headers.Authorization = auth.header;
  let resp: Response;
  try {
    resp = await fetch(url, { headers });
  } catch (e) {
    fail(
      `Could not reach ${base} (${(e as Error).message}). ` +
        `Is the LP-OS shell (deno task dev) or the target endpoint up?`,
    );
  }
  const body = await resp.text();
  if (resp.status === 401) {
    fail(
      "The endpoint rejected the credential (HTTP 401).\n" +
        "LP-OS itself doesn't require auth — a 401 usually means you're talking to the\n" +
        "legacy shim or a real Graylog. Pass --token (or GRAYLOG_TOKEN), or\n" +
        "--user/--password (or GRAYLOG_USER/GRAYLOG_PASSWORD). Never paste tokens into\n" +
        `chat or commit them.\n${trim(body)}`,
    );
  }
  // Empty-window quirk: 500 + index_not_found_exception means "no results in
  // this window", not a failure (see docs/CONTRACTS.md / the shim contract).
  if (resp.status === 500 && body.includes("index_not_found_exception")) {
    return { messages: [], total_results: 0, _empty_window: true };
  }
  if (!resp.ok) fail(`HTTP ${resp.status} ${resp.statusText}\n${trim(body)}`);
  try {
    return body ? JSON.parse(body) : { messages: [], total_results: 0 };
  } catch {
    fail(`Endpoint returned non-JSON:\n${trim(body)}`);
  }
}

function trim(body: string, n = 600): string {
  const b = (body || "").trim();
  return b.length <= n ? b : b.slice(0, n) + " …";
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

function messagesToRows(resp: Envelope): Row[] {
  return (resp.messages ?? []).map((m) => m.message ?? {});
}

function renderTerms(rows: Row[], field: string): string {
  const counts = new Map<string, number>();
  let missing = 0;
  for (const r of rows) {
    const v = r[field];
    if (v === null || v === undefined || v === "") {
      missing++;
      continue;
    }
    const key = String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0 && missing === 0) {
    return `(no values for field '${field}' in the fetched messages)`;
  }
  const width = Math.max(
    field.length,
    5,
    ...[...counts.keys()].map((k) => k.length),
  );
  const lines = [
    `${"value".padEnd(width)}  count`,
    `${"-".repeat(width)}  -----`,
  ];
  const sorted = [...counts.entries()].sort((a, b) =>
    b[1] - a[1] || (a[0] < b[0] ? -1 : 1)
  );
  for (const [k, c] of sorted) lines.push(`${k.padEnd(width)}  ${c}`);
  if (missing) lines.push(`${"(field absent)".padEnd(width)}  ${missing}`);
  return lines.join("\n");
}

function short(v: unknown, n = 70): string {
  if (v === null || v === undefined) return "";
  const s = (typeof v === "object" ? JSON.stringify(v) : String(v)).replaceAll(
    "\n",
    " ",
  );
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function autoColumns(rows: Row[]): string[] {
  const present = new Set(rows.flatMap((r) => Object.keys(r)));
  const cols = DEFAULT_COLUMNS.filter((c) => present.has(c));
  return cols.length ? cols : ["timestamp", "source"];
}

function renderTable(rows: Row[], columns: string[] | null): string {
  if (rows.length === 0) return "(no messages)";
  const cols = columns && columns.length ? columns : autoColumns(rows);
  const widths = new Map(cols.map((c) => [c, c.length]));
  const cells = rows.map((r) => {
    const row: Record<string, string> = {};
    for (const c of cols) {
      row[c] = short(r[c]);
      widths.set(c, Math.max(widths.get(c)!, row[c].length));
    }
    return row;
  });
  const pad = (c: string, s: string) => s.padEnd(widths.get(c)!);
  const out = [
    cols.map((c) => pad(c, c)).join("  "),
    cols.map((c) => "-".repeat(widths.get(c)!)).join("  "),
    ...cells.map((row) => cols.map((c) => pad(c, row[c])).join("  ")),
  ];
  return out.join("\n");
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main() {
  const a = parseCli(Deno.args);
  if (a.help) {
    console.log(HELP);
    return;
  }

  const rangeSeconds = resolveRange(a);
  const aggField = a["list-sources"] ? "source" : (a.terms ?? null);
  let limit = Number(a.limit);
  if (!Number.isInteger(limit) || limit <= 0) {
    fail(`--limit must be a positive integer.`);
  }
  // Client-side aggregation needs enough rows to be exact; bump small limits.
  if (aggField && limit < 1000) limit = 10000;
  const fields = aggField
    ? [aggField]
    : (a.fields
      ? a.fields.split(",").map((f) => f.trim()).filter(Boolean)
      : null);
  const query = a.query ?? "*";

  const dbUrl = Deno.env.get("DATABASE_URL");
  const urlBase = a.url || Deno.env.get("GRAYLOG_API_URL");
  const useUrlMode = Boolean(a.url) || (!dbUrl && Boolean(urlBase));

  let resp: Envelope;
  let label: string;
  if (useUrlMode) {
    if (!urlBase) {
      fail("--url mode needs a base URL (flag or GRAYLOG_API_URL).");
    }
    if (a["show-sql"]) {
      fail("--show-sql is direct-mode only; use --show-url here.");
    }
    const auth = resolveAuth(a);
    if (a["show-url"]) {
      console.log(
        buildSearchUrl(urlBase, query, rangeSeconds, fields, limit, a.sort!),
      );
      return;
    }
    resp = await searchUrl(
      urlBase,
      auth,
      query,
      rangeSeconds,
      fields,
      limit,
      a.sort!,
    );
    label = `${urlBase} (${auth.label})`;
  } else {
    if (!dbUrl) {
      fail(
        "No DATABASE_URL set (direct mode) and no --url/GRAYLOG_API_URL (REST mode).\n" +
          "Direct mode: DATABASE_URL=postgres://... deno run -A ...graylog_query.ts ...\n" +
          "REST mode:   deno run -A ...graylog_query.ts --url http://localhost:8000 ...",
      );
    }
    if (a["show-url"]) {
      fail("--show-url is --url-mode only; use --show-sql here.");
    }
    const direct = await searchDirect(
      dbUrl,
      query,
      rangeSeconds,
      fields,
      limit,
      a.sort!,
      a["show-sql"]!,
    );
    if (!direct) return; // --show-sql printed and exited cleanly
    resp = direct;
    label = "Postgres direct (graylog_messages)";
  }

  if (a.json) {
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  const total = resp.total_results ?? 0;
  const rows = messagesToRows(resp);
  const window = rangeSeconds === 0 || rangeSeconds >= FIVE_YEARS_SECONDS
    ? "all time (~5y)"
    : `last ${rangeSeconds}s`;
  let head = `query='${query}'  window=${window}  total_results=${total}`;
  if (resp.time !== undefined) head += `  (${resp.time}ms)`;
  head += `  via ${label}`;
  console.log(head + "\n");

  if (aggField) console.log(renderTerms(rows, aggField));
  else console.log(renderTable(rows, fields));

  if (total === 0) {
    if (resp._empty_window) {
      console.log(
        "\n(empty window: no data covers this time range — try --all or a wider --last.)",
      );
    } else {
      console.log(
        "\n(0 results. This data is bursty — try --all before concluding 'no data', " +
          "and check field names against references/sources.md.)",
      );
    }
  } else if (rows.length >= limit && !aggField) {
    console.log(
      `\n(showing first ${limit}; total is ${total} — raise --limit for more.)`,
    );
  }
}

if (import.meta.main) {
  await main();
}
