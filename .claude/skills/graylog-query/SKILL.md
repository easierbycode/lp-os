---
name: graylog-query
description: >-
  Query the LP-OS Graylog store (the TikTok Shop scrape log store, now a
  Postgres table inside LP-OS) from the command line and answer questions
  about the data in it. Use this whenever the user wants to look something up
  in Graylog, search the logs/messages, or asks a data question that the
  scrapers feed into Graylog — e.g. "how many affiliate orders did
  @wizardofdealz get", "what's the latest LIVE scrape for that shop", "which
  creators have data", "what sources/streams exist", "show me the Default
  price for that order", "how much GMV this week", or anything phrased as
  searching/counting/listing scraped TikTok metrics, orders, videos, creators,
  or sellers. Also trigger on direct asks like "query graylog", "search
  graylog for …", or "/graylog-query". Translate the question into a Lucene
  query, run scripts/graylog_query.ts, and summarize the results.
---

# graylog-query

Lets you ask Graylog questions in plain language. "Graylog" here is the LP-OS
message store — a Postgres table (`graylog_messages`, owned by `@lp-os/graylog`)
where all the TikTok Shop scrapers land their data (creator dashboards, seller
LIVE sessions, affiliate order exports, buyer orders, sample-lifecycle events,
…). The job here is: turn the question into a **Lucene query + time window**,
run the bundled script, and read the answer back.

The tool is `scripts/graylog_query.ts` (Deno). It has two modes:

- **Direct mode (default):** queries Postgres straight over `DATABASE_URL`,
  using `@lp-os/graylog`'s `parseQuery`/`astToSql` to translate the same
  mini-Lucene grammar into parameterized SQL. No server needed.
- **`--url` mode:** hits any Graylog-compatible REST endpoint
  (`GET /api/search/universal/relative`) — LP-OS itself (`http://localhost:8000`
  by default; production domain TBD), the legacy Deno-KV shim
  (`https://graylog-shim.easierbycode.deno.net`), or a real Graylog — with the
  same Basic-auth conventions as the old python script.

## Workflow

1. **Map the question to a `source` + Lucene query + window.** Use the source
   table below; read `references/sources.md` for the full field list of whatever
   source is involved. If you don't know what's in there, start with
   `--list-sources` to see which sources have data, then drill in.
2. **Run the script from the lp-os repo root** (workspace resolution for
   `@lp-os/graylog` depends on it):
   ```bash
   deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts [options]
   ```
3. **Read the result and answer.** Summarize in plain language — don't just dump
   the table. If the result is empty, say so; the script distinguishes "empty
   window" from "genuinely no match".

## The script

```
graylog_query.ts       (deno run -A, from the lp-os repo root)
  -q, --query LUCENE     Lucene query (default '*'). Quote it in the shell.
  --last 7d|24h|90m      Relative window (also: 3600 = seconds).
  --range SECONDS        Relative window in seconds.
  --all                  ~5 years (effectively all time).
  --fields a,b,c         Field whitelist for the result rows.
  --limit N              Max messages to fetch (default 200).
  --sort FIELD:dir       Default timestamp:desc.
  --terms FIELD          Count messages per distinct value of FIELD (aggregate).
  --list-sources         Shortcut for --terms source — what's in the store.
  --json                 Raw JSON (for piping / deep inspection).
  --show-sql             Direct mode: print the SQL + params and exit
                         (replaces --show-url there).
  --show-url             --url mode: print the request URL (no creds) and exit.
  --url / --token / --user / --password   REST-mode overrides (see below).
```

Default window is **30 days**. Reach for `--all` when the user says "ever", "all
time", "historically", or when a narrow window comes back empty (this data is
bursty — a creator may have nothing in the last 30d but plenty overall).

`--terms` / `--list-sources` aggregate **client-side** over the fetched messages
(in both modes, so the two modes always agree). The script auto-raises the fetch
limit for aggregation so counts are exact for these data volumes; if you're
aggregating a genuinely huge source, bump `--limit` higher.

## Modes, endpoint & auth

**Direct mode (default)** needs `DATABASE_URL` (the Neon Postgres LP-OS runs
on). It runs the same grammar through `@lp-os/graylog`'s parser, so results
match what the REST endpoint would return. `--show-sql` prints the generated
SQL + parameters (never the connection string) for debugging. Run from the repo
root — the `@lp-os/graylog` import resolves via the Deno workspace.

**`--url` mode** targets any Graylog-compatible REST endpoint:

- LP-OS itself: `--url http://localhost:8000` (or wherever `LPOS_API_URL`
  points; production domain TBD). No auth required.
- The legacy Deno-KV shim: `--url https://graylog-shim.easierbycode.deno.net`
  (still holds the pre-migration corpus until the backfill runs). Needs a token.
- If `DATABASE_URL` is unset but `GRAYLOG_API_URL` is set, URL mode is used
  automatically.

**Credential** resolution in `--url` mode, highest priority first:

1. `--user` + `--password` (or `GRAYLOG_USER` / `GRAYLOG_PASSWORD`) — Basic
   auth, e.g. an `admin` login.
2. `--token` (or `GRAYLOG_TOKEN`) — a Graylog API token. Tokens go in the
   Basic-auth **username** slot with the literal password `token` — the script
   does this for you.
3. Nothing — the request is sent unauthenticated (fine for LP-OS; the legacy
   shim will 401, and the script prints how to recover).

## Sources at a glance

| `source:` value                           | What it is                                      | Scope by                                |
| ----------------------------------------- | ----------------------------------------------- | --------------------------------------- |
| `tiktok-bookmarklet`                      | Partner Center creator video-analysis           | `creator`                               |
| `tiktok-bookmarklet-streamer`             | Seller Streamer Compass video-analysis          | `creator`                               |
| `tiktok-bookmarklet-live`                 | Seller LIVE Dashboard (real-time)               | `shop`, `room_id`                       |
| `tiktok-bookmarklet-livestream-analytics` | Seller LIVE analytics dump                      | `creator`                               |
| `tiktok-bookmarklet-data-overview`        | Compass "Data Overview" KPIs                    | `creator`                               |
| `tiktok-bookmarklet-creator-analysis`     | Partner Center creator-analysis                 | (in `creators_json`)                    |
| `tiktok-bookmarklet-product-analysis`     | Compass "Product Analytics" (multi-page)        | `creator`                               |
| `tiktok-affiliate-export`                 | Affiliate xlsx upload — order rows (richest)    | `creator`, `product_name`, `content_id` |
| `tiktok-bookmarklet-orders`               | Buyer-side order detail ("Default" price)       | `store`, `order_id`                     |
| `tiktok-bookmarklet-orders-list`          | Buyer-side orders inventory feed                | —                                       |
| `tiktok-bookmarklet-sellers`              | Partner-collabs agency detail                   | `campaign_id`, `status`                 |
| `thirsty-store-kiosk`                     | Sample-lifecycle events (status/sold/listing/…) | `creator`, `product_id`                 |

Full field lists per source → `references/sources.md`; lifecycle event shapes →
`../sample-lifecycle/references/lifecycle-events.md`. Remember: GELF custom
fields lose their leading underscore, so `_gmv_num` is queryable as `gmv_num`.

## Query recipes

Map the question → command. Quote Lucene in single quotes; escape inner double
quotes only if needed. All examples run from the lp-os repo root; the
`.../graylog_query.ts` shorthand means
`.claude/skills/graylog-query/scripts/graylog_query.ts`.

**"What's even in Graylog / which sources have data?"**

```bash
deno run -A .../graylog_query.ts --list-sources --all
```

**"Which creators do we have data for?"**

```bash
deno run -A .../graylog_query.ts --all --terms creator \
  -q 'source:tiktok-bookmarklet OR source:tiktok-bookmarklet-streamer OR source:tiktok-bookmarklet-livestream-analytics OR source:tiktok-bookmarklet-data-overview OR source:tiktok-bookmarklet-product-analysis OR source:tiktok-affiliate-export'
```

(All six creator-scoped sources. Drop one and you silently miss creators who
only appear in that source.)

**"How many affiliate orders did @wizardofdealz get (ever)?"**

```bash
deno run -A .../graylog_query.ts --all \
  -q 'source:tiktok-affiliate-export AND (creator:"@wizardofdealz" OR creator.keyword:"@wizardofdealz")'
```

The `total_results` line is the count. Add `--terms product_name` to see the
breakdown by product.

**"Show the latest LIVE scrape for that shop."**

```bash
deno run -A .../graylog_query.ts --all --limit 1 \
  -q 'source:tiktok-bookmarklet-live' \
  --fields shop,room_id,gmv,products_count,scrapedAt
```

**"Find the Default price for an order containing 'VEVOR Softbox'."**

```bash
deno run -A .../graylog_query.ts --all \
  -q 'source:tiktok-bookmarklet-orders AND default_product:VEVOR' \
  --fields default_product,default_variant,default_price,store,order_date
```

**"High-GMV affiliate orders this quarter."**

```bash
deno run -A .../graylog_query.ts --last 90d \
  -q 'source:tiktok-affiliate-export AND gmv_num:[100 TO *]' \
  --fields creator,product_name,gmv_num,order_date --sort gmv_num:desc
```

For deeper structure (per-video metrics, per-product rows), the detail lives
inside `*_json` fields — pull the row with `--json` and parse the relevant
`metrics_json` / `videos_json` / `rows_json` blob.

## Interpreting results

- **`total_results`** is the true match count for the window; the table shows up
  to `--limit` rows. If `total_results` > rows shown, raise `--limit` or
  aggregate with `--terms`.
- **Empty but not an error.** `0 results` with the "empty window" note means the
  window is newer than all stored data — widen with `--all`. This data is
  genuinely bursty, so an empty narrow window is common; try `--all` before
  concluding "no data".
- **Creator handles with dots** (`@prettyplug.x`) — match both forms:
  `(creator:"@x.y" OR creator.keyword:"@x.y")`. The parser collapses `.keyword`
  to plain equality, so the OR is always safe.
- **Existence queries (`field:*`) work.** Like real Graylog/Elasticsearch,
  `sample_sold_json:*` matches messages where the field is present with a
  non-empty value (a QUOTED `"*"` stays literal equality). The flat companion
  fields are an equivalent alternative for lifecycle events: sold events carry
  `sample_status:sold`, listings `sample_event:listed`, assignments
  `sample_event:assigned`, intakes `sample_event:agency_intake`.
- If direct mode and `--url` mode disagree, the Postgres direct answer is the
  LP-OS truth; a divergent remote endpoint (e.g. the legacy shim) means the
  backfill/dual-write hasn't caught that message up yet — report both.

## Guardrails

- **Read-only.** This skill only _searches_ (SELECTs / GETs). It never ingests,
  never creates inputs/dashboards/streams, never deletes. Ingest is the
  bookmarklet/extension path (`POST /gelf`).
- **Don't leak secrets.** Never paste an API token, the admin password, or
  `DATABASE_URL` into chat or commit them here; pass them via env/flags at call
  time. The script itself never prints credentials (`--show-sql` / `--show-url`
  are credential-free by design).
- **Don't guess data.** If a query errors or the store is unreachable, surface
  the script's message verbatim — don't fabricate counts.
- **Prefer the script over raw curl/psql.** It encodes the grammar, the auth,
  the empty-window handling, and the aggregation fallback. If you must debug the
  exact request, `--show-sql` (direct) / `--show-url` (REST) print it without
  credentials.
- **User-supplied search strings go through `parseQuery`/`astToSql`** — never
  hand-interpolate them into SQL.

## Troubleshooting

| Symptom                                      | Meaning / fix                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `error: ... "@lp-os/graylog"` unresolved     | You're not running from the lp-os repo root — `cd` there so the Deno workspace maps the import.                     |
| `No DATABASE_URL set ...`                    | Export `DATABASE_URL` for direct mode, or pass `--url http://localhost:8000` for REST mode.                         |
| `Postgres query failed ... graylog_messages` | Migrations haven't run — `deno task migrate` (needs `DATABASE_URL`).                                                |
| `HTTP 401` (`--url` mode)                    | The endpoint requires auth (legacy shim / real Graylog). Pass `--token` / `GRAYLOG_TOKEN` or `--user`+`--password`. |
| `Could not reach ...` (`--url` mode)         | The target isn't serving — for LP-OS run `deno task dev`; for remote endpoints check the URL.                       |
| `0 results` + "empty window"                 | Time range newer than all data — use `--all`.                                                                       |
| Creator query misses `@x.y` handles          | Use the `(creator:"@x.y" OR creator.keyword:"@x.y")` form.                                                          |
