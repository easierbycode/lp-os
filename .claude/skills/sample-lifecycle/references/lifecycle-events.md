# Sample-lifecycle Graylog events

The events this skill writes, and how `graylog-query` reads them back. All are
emitted by `@lp-os/lifecycle` (port of data-pimp `core/lifecycle.ts`) via the
graylog store's `logEvent()`, which keeps `source:"thirsty-store-kiosk"` for
continuity of existing queries, single-`_`-prefixes every field on the GELF
wire, and drops empty/null values. The store strips the leading underscore, so a
field written as `_sample_status` is queried as `sample_status`.

Design: one JSON-string **container** field per event (lossless round-trip, like
the existing `sample_edit_json`) **plus** flat scalar fields so queries can
filter/range/`--terms` without parsing JSON.

Join key across every stage: **`product_id`** (the sample's `qr_code`). The
Postgres **`sample_id`** is stamped alongside as a reconciliation fallback.

## Event 1 — status change

`short_message`: `thirsty sample status: <name>`

| Field                | Type        | Notes                                                                                   |
| -------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `sample_status_json` | JSON string | `{productId, sampleId, status, previousStatus, qrCode, name, source, note?, updatedAt}` |
| `sample_status`      | string      | flat, filterable — e.g. `sample_status:cleared_to_sell`                                 |
| `product_id`         | string      | join key (= `qr_code`)                                                                  |
| `sample_id`          | string      | Postgres id (when a row matched)                                                        |
| `sample_source`      | string      | `skill` (who wrote it)                                                                  |

Status is one of `available`, `checked_out`, `reserved`, `cleared_to_sell`,
`discontinued` (`sold` is rejected — it goes through Event 2).

## Event 2 — sold / resale revenue

`short_message`:
`thirsty sample sold: <name> $<price> via <marketplace> → <creator>`

| Field                                   | Type        | Notes                                                                                                                            |
| --------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `sample_sold_json`                      | JSON string | `{productId, sampleId, name, creator, marketplace, salePrice, fees, shipping, costBasis, net, buyer?, orderRef?, soldAt, note?}` |
| `creator`                               | string      | attribution handle — same field/convention the scraper sources use                                                               |
| `gmv_num`                               | number      | **gross** sale price (matches affiliate-export `gmv_num`, so existing revenue recipes sum it)                                    |
| `sale_price_num`                        | number      | alias of gross (explicit)                                                                                                        |
| `fee_num` / `shipping_num` / `cost_num` | number      | the deductions                                                                                                                   |
| `net_num`                               | number      | `salePrice − fees − shipping − costBasis`                                                                                        |
| `marketplace`                           | string      | `ebay` / `offerup` / `fbmarketplace` / …                                                                                         |
| `product_id`                            | string      | join key                                                                                                                         |
| `sample_id`                             | string      | Postgres id                                                                                                                      |
| `sample_status`                         | string      | `sold`                                                                                                                           |
| `sample_source`                         | string      | `skill-resale`                                                                                                                   |

Note: affiliate-export's `creator` is an _agency label_, but these resale events
are authored by the skill, so the real `@handle` is stamped directly — resale
revenue attributes more cleanly than affiliate data.

**Bulk lots.** A bulk sale (`recordBulkSampleSold`) emits one Event-2 record
**per sample**, each with its own allocated `gmv_num`/`net_num` and `creator`,
plus two fields tying it to the lot: **`bulk_id`** (shared across the lot) and
**`bulk_total_num`** (the lot's gross); `sample_source` becomes
`skill-bulk-resale`. Because each item is a normal `sample_sold_json`, every
recipe below already counts bulk lots — query `bulk_id:"<id>"` to isolate one.

## Event 3 — listing (marketplace)

`short_message`:
`thirsty sample listed: <name> @ $<askPrice> on <marketplace> → <creator>`

Analytics-only — written by `recordSampleListing`; it does **not** touch
Postgres (a listing is intent-to-sell, not an inventory status). It marks the
step between the content-GMV question and the resale-net question.

| Field                 | Type        | Notes                                                                                       |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `sample_listing_json` | JSON string | `{productId, sampleId, name, creator, marketplace, askPrice, listingUrl?, listedAt, note?, listingId?, externalId?}` |
| `creator`             | string      | attribution handle (same convention as Events 1–2)                                          |
| `ask_price_num`       | number      | the listing/ask price — compare to the eventual `gmv_num`/`net_num`                         |
| `marketplace`         | string      | `ebay` / `offerup` / `fbmarketplace` / …                                                    |
| `product_id`          | string      | join key                                                                                    |
| `sample_id`           | string      | Postgres id (when a row matched)                                                            |
| `sample_event`        | string      | `listed` (flat, filterable)                                                                 |
| `sample_source`       | string      | `skill-listing` (manual note) · `marketplace-api` (on-demand real eBay publish) · `marketplace-cron` (scheduled auto-list) · `marketplace-auto` (listed on cleared_to_sell) |
| `listing_id`          | string      | only on real-API listings: Postgres `listings.id` (the current-status row)                  |
| `external_listing_id` | string      | only on real-API listings: marketplace-side id (eBay listingId)                             |

A `product_id` carrying a `sample_listing_json` with no later `sample_sold_json`
is still on the market. Since the eBay API integration (`@lp-os/marketplace`),
CURRENT listing status also lives in Postgres (`listings` table, read via
`GET /api/listings`) — Graylog remains the history/analytics view.

### Event 3b — listing failed (real-API publish errors)

`short_message`:
`thirsty sample listing failed: <name> on <marketplace> — <error>`

Written by the marketplace listing service when a real publish attempt fails.
Deliberately a SEPARATE `sample_event` so `sample_event:listed` never matches
failures.

| Field                | Type        | Notes                                                                                    |
| -------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `listing_error_json` | JSON string | `{listingId, sampleId, productId, name, creator, marketplace, askPrice, error, permanent, failedAt}` |
| `sample_event`       | string      | `listing_failed`                                                                          |
| `sample_source`      | string      | `marketplace-api` / `marketplace-cron` / `marketplace-auto`                               |
| `listing_id`         | string      | Postgres `listings.id` (row is `status:'failed'` with the same error)                     |
| plus                 |             | the usual flat `creator` / `marketplace` / `ask_price_num` / `product_id` / `sample_id`   |

## Event 4 — agency intake (bulk lot → bucket)

`short_message`: `thirsty agency intake: <name> ×<qty> → bucket <agency_bucket>`

Written by `recordAgencyIntake`. Postgres: each unit set/created `reserved` with
`checked_out_to = <agency_bucket>` + an `agency_intake` transaction.

| Field                | Type        | Notes                                                              |
| -------------------- | ----------- | ------------------------------------------------------------------ |
| `sample_intake_json` | JSON string | `{productId, sampleIds, name, agencyBucket, qty, note?, intakeAt}` |
| `sample_event`       | string      | `agency_intake`                                                    |
| `agency_bucket`      | string      | the bucket/admin credited (e.g. `kyle`)                            |
| `qty_num`            | number      | units in the lot                                                   |
| `product_id`         | string      | join key                                                           |
| `sample_source`      | string      | `skill-agency-intake`                                              |

## Event 5 — assignment (fulfillment → checked out)

`short_message`: `thirsty sample assigned: <name> → <creator>`

Written by `recordSampleAssignment`. Postgres: the exact check-out field-set
(`status='checked_out'`, `checked_out_to=<creator>`, `checked_out_at`) + a
`check_out` transaction whose `notes` carry the campaign + enrichment summary.

| Field                      | Type        | Notes                                                                                                        |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `sample_assignment_json`   | JSON string | `{productId, sampleId, name, creator, agencyBucket?, campaign?, campaignId?, fromStatus, assignedAt, note?}` |
| `creator`                  | string      | who it's assigned to (reuses the lifecycle creator vocabulary)                                               |
| `sample_status`            | string      | `checked_out`                                                                                                |
| `sample_event`             | string      | `assigned`                                                                                                   |
| `agency_bucket`            | string      | the bucket it came from, if any                                                                              |
| `campaign` / `campaign_id` | string      | matched campaign (config-driven — no campaign data source yet)                                               |
| `product_id` / `sample_id` | string      | join keys                                                                                                    |
| `sample_source`            | string      | `skill-assignment`                                                                                           |

The assignment response also returns an `enrichment[]` note: **bundle**
membership (REAL, from `samples.bundle_id`) + the campaign's **daily-video
goal** and **promo** (CONFIG from `core/campaign-config.json`, labelled
`[from campaign-config]`).

## Read-back recipes (`graylog-query`)

`--terms` only counts; it can't SUM — fetch rows and sum the `*_num` field
client-side. Match handles with both forms:
`(creator:"@x" OR creator.keyword:"@x")`.

**All resale sales (any creator), newest first:**

```bash
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --all -q 'sample_sold_json:*' \
  --fields creator,product_id,marketplace,gmv_num,net_num --sort timestamp:desc
```

**One bulk lot's per-sample breakdown:**

```bash
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --all -q 'bulk_id:"bulk-..."' \
  --fields creator,product_id,sample_id,gmv_num,net_num,bulk_total_num
```

**One creator's resale revenue, by marketplace:**

```bash
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --all \
  -q '(creator:"@wizardofdealz" OR creator.keyword:"@wizardofdealz") AND sample_sold_json:*' \
  --terms marketplace
# then fetch rows and sum gmv_num (gross) / net_num (profit)
```

**High-value resales this quarter:**

```bash
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --last 90d \
  -q 'sample_sold_json:* AND gmv_num:[50 TO *]' \
  --fields creator,product_id,marketplace,gmv_num,net_num --sort gmv_num:desc
```

**What's currently listed for resale (and where):**

```bash
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --all -q 'sample_listing_json:*' \
  --fields creator,product_id,marketplace,ask_price_num --sort timestamp:desc
```

A `product_id` with a `sample_listing_json` and no later `sample_sold_json` is
still on the market. `--terms marketplace` shows where listings cluster.

**Ask vs. actual — did listings sell for what we asked?** Pull
`sample_listing_json:*` (`ask_price_num`) and `sample_sold_json:*` (`gmv_num`)
for the same `product_id` and compare per product.

**Status history of one sample/product:**

```bash
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --all -q 'product_id:"1729..." AND sample_status_json:*' \
  --fields sample_status,sample_status_json --sort timestamp:desc
```

**Full lifecycle thread for a product** — status + sale + the scraper content
(videos/lives) that share the same `product_id`/`creator`:

```bash
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --all -q 'product_id:"1729..."' \
  --fields source,creator,sample_status,gmv_num,sample_status_json,sample_sold_json
```

**Who's assigned what / agency-bucket holdings:**

```bash
# assignments (per creator)
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --all -q 'sample_event:assigned' \
  --fields creator,product_id,sample_id,agency_bucket,campaign --sort timestamp:desc
# agency intakes (per bucket)
deno run -A .claude/skills/graylog-query/scripts/graylog_query.ts --all -q 'sample_event:agency_intake' \
  --terms agency_bucket
```

(Current assignment is also the live Postgres truth:
`GET /api/samples?status=checked_out` → `checked_out_to` is the creator;
`status=reserved` → `checked_out_to` is the bucket.)

## Lifecycle join — current reach and the gap

`product_id` links: **intake** (`samples.qr_code`) → **agency bucket** (Event 4)
→ **assignment / checkout to a creator** (Event 5) → **status changes**
(Event 1) → **content** (`source:tiktok-bookmarklet-product-analysis` etc.,
which carry `Product ID` + `creator`) → **listing** (Event 3) → **resale**
(Event 2).

The weak link is **order-received** (`source:tiktok-bookmarklet-orders`): those
scrape events carry neither `product_id` nor `creator` (product is matched by
name only), so "order received → which content sold it" can't be joined
automatically yet. Closing that needs the order scraper to capture a productId —
out of scope for this skill. Until then, that hop is matched manually by product
name against the catalog (`/api/products`).

## Event 6 — sample valuation instance (recomputable)

`recordSampleValuation` (`POST /api/sample-valuation/record`, MCP
`record_sample_valuation`) snapshots a valuation to Graylog with **all raw
inputs needed to recompute it later**, keyed by a `valuation_id` (+
`valuation_revision_num`). The live read (`GET /api/sample-valuation`,
`fetchSampleValuation`) is unchanged — this is purely additive persistence.

| field                                                            | type        | meaning                                                                         |
| ---------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `sample_valuation_json`                                          | JSON string | `{valuationId, revision, recordedAt, recomputedFrom?, params, items[], totals}` |
| `valuation_id`                                                   | string      | instance id (`val-<uuid>`)                                                      |
| `valuation_revision_num`                                         | number      | 0 for the snapshot; +1 per recompute                                            |
| `retail_value_num` / `resale_value_num` / `net_num` / `cost_num` | number      | flat totals for `--terms`/aggregation                                           |

`items[]` are the recompute fuel — per product:
`productId, name, category,
sampleCount, unitRetail, retailValue, cost, resaleRate?, affiliateRate?, affiliateLink?`.
`params` = `{defaultResaleRate, resaleRates[3], maintainableCap, currency}`.
Totals are **derived** (`computeValuationTotals`) so headline numbers match
`fetchSampleValuation`; extra fields (`resaleValue` at the per-item rate,
`affiliateValue`, `netValue`, `totalCost`) are additive.

**Recompute later with changed variables** — `recomputeSampleValuation`
(`POST /api/sample-valuation/recompute`, MCP `recompute_sample_valuation`):
fetch the stored instance and `addItems` / `updateItems` (e.g. a product's
`resaleRate` or `affiliateRate` for a different affiliate link) /
`removeProductIds` / change `params`, and it re-derives the totals. Persists a
new revision by default (`recomputedFrom` links it), so each scenario is itself
queryable; `persist:false` for a preview. Query a period's valuations:
`sample_valuation_json:*`, group by `valuation_id`, take max
`valuation_revision_num`.
