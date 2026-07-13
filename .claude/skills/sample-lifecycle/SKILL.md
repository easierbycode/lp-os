---
name: sample-lifecycle
description: >-
  Manage a sample's full lifecycle in the LP Sample Tracker (the LP-OS API /
  admin.thirsty.store): change status, ASSIGN a sample to a creator, intake an
  agency bulk lot, list it for resale, or log a (bulk) sale. Trigger whenever the
  user wants to act on a sample — e.g. "assign 1 Cupids Desire Drops to
  @boosteddealsdaily", "check this out to @x", "we got 50 of <product> for the
  agency / credit them to kyle", "mark <product> as sold", "this sold on eBay for
  $40", "set <product> to cleared to sell", "reserve sample 42", "list this on
  eBay for $45", "sold a bulk lot of 12 samples for $300", "attribute this sale to
  @wizardofdealz". Each action writes a Graylog event (and, for
  status/sold/assign, the inventory truth to Postgres). For READ-ONLY questions
  ("how much resale revenue did @x make", "what's listed where", "which samples
  sold this month", "who's assigned what") use the graylog-query skill instead —
  this skill only WRITES.
allowed-tools: mcp__thirsty-samples__list_samples, mcp__thirsty-samples__list_sample_statuses, mcp__thirsty-samples__list_creators, mcp__thirsty-samples__list_product_creators, mcp__thirsty-samples__update_sample_status, mcp__thirsty-samples__list_on_marketplace, mcp__thirsty-samples__mark_sample_sold, mcp__thirsty-samples__bulk_sample_sold, mcp__thirsty-samples__agency_intake, mcp__thirsty-samples__assign_sample
---

# sample-lifecycle

Mutates a sample's lifecycle state through the **thirsty-samples** MCP server,
which calls the lifecycle endpoints (`/api/sample-status`, `/api/sample-sold`,
`/api/sample-listing`, `/api/sample-bulk-sold`, `/api/agency-intake`,
`/api/sample-assign`, `/api/sample-import` — served in LP-OS by `apps/shell` via
`@lp-os/lifecycle`).

> **MCP configuration.** The thirsty-samples MCP server has NOT been ported into
> this repo; it still lives in data-pimp (`mcp/thirsty-samples/server.ts`) and
> reads its API base from **`THIRSTY_API_URL`** (or `THIRSTY_API`), defaulting
> to `https://thirsty.store` — which LP-OS now serves (it replaced data-pimp
> behind that domain at the 2026-07 changeover), so the default writes to
> production LP-OS. It does **not** read `LPOS_API_URL`; set
> `THIRSTY_API_URL=http://localhost:8000` to target a local shell instead.

Every action writes to **two** places:

- **Postgres** (`public.samples` + `transactions` — renamed from data-pimp's
  `inventory_transactions`) — the inventory source of truth, shared with the
  tracker UI. Note: the tracker at `admin.thirsty.store` still points at the
  pre-migration deployment (it hasn't migrated into LP-OS yet).
- **Graylog** — the durable analytics spine. Status changes and sales become
  GELF events keyed by `product_id` (the sample's `qr_code`, the join key across
  the whole lifecycle) so they can be read back by the `graylog-query` skill.

This skill is **write-only**. Reading the data back (revenue reports, "who sold
what") is the `graylog-query` skill's job — see _Reading it back_ below.

## Workflow 1 — Update a sample's status

1. **Resolve the sample.** If the user named a product, call `list_samples` with
   a `query` to find the row and its `id`. Prefer acting by `id`. If several
   samples share a name/productId, show the matches and ask which one.
2. **Validate the target status.** Call `list_sample_statuses` and confirm the
   requested status is one of the exclusive lifecycle statuses — `available`,
   `checked_out`, `reserved`, `cleared_to_sell`, `discontinued`. (`sold` is also
   `kind:"status"` but is rejected here — route sales through Workflow 3.) Map
   the user's words to the canonical `value` (e.g. "clear it to sell" →
   `cleared_to_sell`).
3. **Write it.** Call `update_sample_status` with `sampleId` (or `productId`),
   `status`, and an optional `note`.
4. **Report honestly.** Echo the result's `message`. The result shows what
   persisted (`postgres.updated`, `graylog`). If `graylog` is `false`, say the
   Graylog event did **not** write — don't report unqualified success.

> "Sold" is **not** a plain status here. `update_sample_status` rejects it on
> purpose, because a sale must attribute revenue to a creator → use Workflow 3.

## Workflow 2 — List a sample on a marketplace

Records that a sample is up for resale — the step between "how much GMV did my
content drive?" and "what did the listing sell for?". This is
**analytics-only**: it emits a Graylog listing event and does **not** change the
sample's status (a listing is intent-to-sell, not an inventory state).

1. **Resolve the sample** via `list_samples` (prefer a specific `sampleId`).
2. **Confirm the creator** (via `list_creators`) the listing is attributed to —
   the same handle you'd attribute the eventual sale to.
3. **Gather** `marketplace` + `askPrice` (plus optional `listingUrl`, `note`).
4. **Write it.** Call `list_on_marketplace`; it emits `sample_listing_json`
   (`creator` + `product_id` + `ask_price_num` + `marketplace`).
5. **Report honestly.** Echo `message`; if `graylog` is `false`, the listing was
   **not** recorded.

> A listing does not mark the sample sold. When it actually sells, follow
> Workflow 3 (`mark_sample_sold`). Comparing `ask_price_num` to the final
> `gmv_num`/`net_num` is then a `graylog-query` question.

## Workflow 3 — Mark a sample SOLD (with creator attribution)

This is the revenue path. The creator-attribution prompt is mandatory.

1. **Resolve the sample** (as above, via `list_samples`). For a sale, prefer a
   specific `sampleId` so you mark the right physical unit; if only a productId
   is given and multiple unsold units match, ask which one.
2. **Ask which creator gets the revenue.** This is the load-bearing step the
   user asked for. Call `list_creators` and ask: _"Which creator account should
   this resale revenue be attributed to?"_ Offer the @-handles it returns (real
   handles sort first). If the intended handle isn't listed, confirm the exact
   spelling before proceeding — a typo silently fragments that creator's
   revenue. Do not guess.
3. **Gather the sale details.** Required: `salePrice` (gross) and `marketplace`
   (`ebay`, `offerup`, `fbmarketplace`, …). Optional, for net profit: `fees`,
   `shipping`, `costBasis` (net = sale − fees − shipping − cost), plus `buyer`,
   `orderRef`, `note`. Ask for what's missing rather than assuming.
4. **Write it.** Call `mark_sample_sold`. It sets the sample to `sold` with the
   sale columns + a `sold` inventory transaction in Postgres, and emits the
   Graylog revenue event (`creator` + `gmv_num` gross + `net_num`).
5. **Report honestly.** Echo `message`, the computed `net`, and the attributed
   `creator`. If `graylog` is `false`, the revenue event did **not** record —
   flag it clearly (the sale won't show up for the creator until it's re-sent).
   The `message` also warns if the Postgres audit transaction wasn't written.

> **Re-selling is refused by default.** Marking an already-sold sample sold
> again would double-count the creator's revenue (Graylog events are
> append-only). If the user genuinely needs to re-attribute, confirm first, then
> pass `force: true` to `mark_sample_sold`.

## Workflow 4 — Mark a bulk lot sold

One marketplace sale across several samples (a lot), attributed per-creator.

1. **Resolve the units** via `list_samples` — collect a `sampleId` per item
   (preferred over productId so each physical unit is unambiguous).
2. **Confirm the creator(s).** Each item can carry its own `creator`, or set a
   lot-level `creator` as the default. Confirm handles via `list_creators`.
3. **Gather** the lot `totalPrice` + `marketplace` (plus optional lot-level
   `fees`/`shipping`/`costBasis`, allocated across items by gross share). Give
   an item an explicit `price` to pin its share; otherwise the remaining total
   is split equally.
4. **Write it.** Call `bulk_sample_sold` with `items`, `totalPrice`,
   `marketplace`. It emits one `sample_sold_json` per sample tagged with a
   shared `bulk_id`, so every per-creator/per-marketplace revenue query already
   counts the lot.
5. **Report honestly.** Echo `message` (it reports `soldCount/itemCount`, the
   lot `bulkId`, and net) and surface any per-item `failures` (e.g. a unit that
   was already sold).

## Workflow 5 — Agency bulk intake (credit a lot to a bucket)

When a bulk sample order arrives for an agency (e.g. "we got 50 Cupids Desire
Drops for kyle's agency"), credit them to an agency bucket **before** any
creator is assigned. The units sit in `reserved` (held),
`checked_out_to = <bucket>`.

1. **Gather** the `productId` (or name), the `agencyBucket` (e.g. `kyle`), and
   `qty`.
2. **Write it.** Call `agency_intake` (`productId` + `qty` + `agencyBucket`). It
   creates that many `reserved` units and emits a `sample_intake_json` event.
   (To credit units that already exist, pass `sampleIds` instead of `qty`.)
3. **Report.** Echo `message` (how many credited to which bucket) + the
   `sampleIds`.

## Workflow 6 — Assign / fulfill a sample to a creator

"Assign 1 Cupids Desire Drops to @boosteddealsdaily." Moves one unit out of the
agency bucket to that creator and **checks it out**.

1. **Resolve the unit** via `list_samples` (prefer a specific `sampleId`; a
   `reserved` bucket unit is pulled first when you pass a `productId`).
2. **Confirm the creator.** Call `list_product_creators` for that product — the
   derived candidate list (creators who ordered it; pass `includeAllKnown` to
   also offer others). Confirm the exact handle; don't guess.
3. **Write it.** Call `assign_sample` (`sampleId`/`productId` + `creator`). It
   sets the sample to `checked_out` (`checked_out_to = creator`), auto-matches a
   campaign, records a `check_out` transaction, and emits
   `sample_assignment_json`.
4. **Surface the note.** The result's `message` + `enrichment[]` carry the
   nice-to-know lines: any **bundle** the sample belongs to (real), and — if the
   product matches a configured campaign — the **daily-video goal** and
   **promo** (both labelled `[from campaign-config]`, since no measured goal
   exists yet). Relay these to the admin.

## Reading it back — composing with `graylog-query`

These events are written using `graylog-query`'s own conventions, so that
read-only skill surfaces resale revenue **with no changes**. After a sale,
revenue questions go to `graylog-query` (its script lives in this repo at
`.claude/skills/graylog-query/scripts/graylog_query.ts`; run it directly if the
skill isn't loaded). Key recipes (run from the lp-os repo root):

**A creator's resale revenue (ever):**

```bash
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --all \
  -q '(creator:"@wizardofdealz" OR creator.keyword:"@wizardofdealz") AND sample_sold_json:*' \
  --fields product_id,marketplace,gmv_num,net_num,sample_sold_json --sort timestamp:desc
```

`--terms` can't SUM — sum `gmv_num` (gross) or `net_num` (profit) client-side.
Add `--terms marketplace` for a per-channel breakdown.

**Everything that happened to one product (the lifecycle thread):**

```bash
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --all -q 'product_id:"1729..."' \
  --fields source,creator,sample_status,gmv_num,sample_status_json,sample_sold_json
```

This stitches the sample's status changes and its sale alongside the scraper
sources (videos/lives) that share the same `product_id` + `creator`.

**What's listed for resale, and where:**

```bash
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --all -q 'sample_listing_json:*' \
  --fields creator,product_id,marketplace,ask_price_num --sort timestamp:desc
```

A `product_id` with a `sample_listing_json` but no later `sample_sold_json` is
still on the market; `--terms marketplace` shows where listings cluster.

Full field/query reference:
[references/lifecycle-events.md](references/lifecycle-events.md).

## Guardrails

- **Write-only.** This skill never reads/aggregates — that's `graylog-query`.
- **Never fake success.** A Graylog write can fail silently (the API returns
  `graylog:false`); always reflect what actually persisted.
- **Confirm the creator.** Don't attribute revenue to an unconfirmed handle.
- **Writes are real.** The endpoints are open (no auth, by design). LP-OS's API
  base is `http://localhost:8000` in dev and `https://thirsty.store` in
  production (LP-OS now owns that domain) — the thirsty-samples MCP's
  **`THIRSTY_API_URL`** default of `https://thirsty.store` therefore lands in
  LP-OS. Verify it targets the intended system before writing. Treat status/sold
  writes as real inventory changes; confirm ambiguous targets before writing.
- **Join key is `product_id` = `qr_code`.** A `qr_code` holding a barcode (not a
  real TikTok productId) still works for status/sold, but won't join to scraper
  content. `sample_id` is stamped on every event as the reconciliation fallback.
