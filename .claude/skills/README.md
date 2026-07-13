# LP-OS agent skills

The seven Claude Code skills consolidated from data-pimp and tok-scrape (see
`docs/CONTRACTS.md` → "Skills" for the binding spec).

Global conventions after the merge:

- Every `https://thirsty.store` API reference became the configurable
  `LPOS_API_URL` (default `http://localhost:8000`). **LP-OS's production domain
  is `https://thirsty.store`** (it replaced data-pimp behind it) — set
  `LPOS_API_URL=https://thirsty.store` to target production.
- `https://admin.thirsty.store` (the sample-tracker UI) is unchanged — the
  tracker has not migrated into LP-OS yet, so those links still point at the
  pre-migration deployment.
- The GELF write sink is LP-OS `POST /gelf`; the old
  `tok-graylog-gelf.ngrok-free.dev` endpoints are stale/retired.
- The `easierbycode.com` Samples-Import page URL is kept as-is. The legacy
  `easierbycode.com/tok-scrape/chrome.zip` is the OLD extension (ships GELF to
  the retired shim, no role gate) — the merged extension is installed
  load-unpacked from this repo's `extension/` folder (see `/install`).

| Skill                            | What it does                                                                                                                                         | From                   | What changed                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ebay-listing`                   | Opens eBay's create-listing form via Claude-in-Chrome and autofills title/condition/price/description from a sample; never submits.                  | data-pimp              | `/api/ebay-price` was NOT ported into LP-OS — pricing calls target the still-live `https://thirsty.store` endpoint (override `EBAY_PRICE_API_URL`), with an inline-formula fallback documented.                                                                                                                                                                           |
| `sample-e2e`                     | Repeatable import/lifecycle end-to-end walk (import → Postgres verify → Graylog verify) plus the visual two-pane `?workspace=samples-import` replay. | data-pimp              | The `sample-e2e.ts` harness and its `/api/product-lookup` + `/api/product-creators` routes were NOT ported — the skill documents a direct API walk (`/api/sample-import`, `/api/samples`, `/api/creators`) instead; workspace URL uses `LPOS_API_URL`; ngrok GELF example removed.                                                                                        |
| `sample-lifecycle`               | The write-side lifecycle skill: status changes, assign-to-creator, agency intake, listings, (bulk) sales — dual-writes Postgres + Graylog events.    | data-pimp              | Endpoints described as LP-OS lifecycle routes (`@lp-os/lifecycle`); audit table renamed `inventory_transactions` → `transactions`; the thirsty-samples MCP (still in data-pimp) reads `THIRSTY_API_URL` — it must be repointed at the LP-OS base (documented in the skill); read-back recipes call the new `graylog_query.ts`; admin.thirsty.store note added.            |
| `samples-import`                 | Opens the Samples-Import page (paste IDs → hydrate → import) and walks the merged extension install (load-unpacked from `extension/`).               | data-pimp              | `/install` now served by the LP-OS shell; the legacy `chrome.zip` is flagged as the OLD extension (retired-shim GELF, no role gate); "Thirsty OS" → "LP-OS".                                                                                                                                                                                                              |
| `scrapecreators-api`             | Read-only TikTok Shop product research during intake (reviews, showcase/similar products) via the ScrapeCreators MCP.                                | data-pimp              | Effectively unchanged (one wording fix: server-side enrichment paths attributed to LP-OS).                                                                                                                                                                                                                                                                                |
| `run-partner-center-bookmarklet` | Injects the TikTok Shop scraper bookmarklets (creator/sellers/live/streamer/orders) via Claude-in-Chrome, dev fixtures or prod.                      | tok-scrape             | TikTok URLs + tok-scrape file paths kept; GELF guidance inverted — LP-OS `/gelf` is the current sink, ngrok endpoints are flagged stale (warn-and-stop).                                                                                                                                                                                                                  |
| `graylog-query`                  | Plain-language questions over the scrape/lifecycle log store: Lucene query + window → table/terms/JSON.                                              | tok-scrape (rewritten) | Tool rewritten as `scripts/graylog_query.ts` (Deno): default mode queries Postgres directly via `@lp-os/graylog` `parseQuery`/`astToSql` + `DATABASE_URL` (`--show-sql` replaces `--show-url` there); `--url` mode hits any Graylog-compatible REST endpoint with the old Basic-auth conventions. python script, `--opensearch` mode, and the KV cutover runbook dropped. |

Run the `graylog-query` script from the repo root so the `@lp-os/graylog`
workspace import resolves:

```bash
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --list-sources --all
```
