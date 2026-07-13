# Graylog data model — sources & fields

Every message in this Graylog arrives via the **GELF HTTP input** as a JSON
payload with a `host` and a set of `_`-prefixed custom fields. Graylog indexes
`host` as the **`source`** field and **drops the leading underscore** from
custom fields — so a payload key `_order_id` is queryable as `order_id`, and
`_metrics_json` as `metrics_json`. There is no `host` field on the stored
message; filter by `source:` instead.

`source` is the primary way to scope a query — it identifies which scraper /
pipeline produced the row. The creator handle (with a leading `@`) is in
`creator` on most sources.

## Querying `creator` reliably

`creator` is a text field with a `.keyword` sub-field. Handles containing a `.`
(e.g. `@prettyplug.x`) get tokenized by the standard analyzer, so a phrase query
against the analyzed field is unreliable for them. Match both forms:

```
(creator:"@prettyplug.x" OR creator.keyword:"@prettyplug.x")
```

Single-token handles (`@wizardofdealz`) match both clauses, so OR-ing is always
safe. Known handles seen in the data: `@wizardofdealz`, `@boosteddealsdaily`,
`@prettyplug.x` (plus synthetic seeder handles like `@beautybybri` if the local
seeder has run).

Numeric fields are stored with a `_num` suffix where a clean number was
available (e.g. `gmv_num`, `price_num`) — use those for range queries like
`gmv_num:[100 TO *]`. The human-formatted originals (`$1,234.00`) live inside
the `*_json` blobs.

---

## Sources

### `source:tiktok-bookmarklet` — Partner Center creator video-analysis

One message per dashboard scrape (the "Log Key Metrics" bookmarklet). Fields:
`creator`, `scrapedAt`, `date_start`, `date_end`, `metrics_count`,
`videos_count`, `metrics_json`, `videos_json`. `metrics_json` = the 5 KPI tiles
(Affiliate GMV, Items sold, Est. commissions, Direct GMV, Videos). `videos_json`
= per-video rows (Video ID, Name, Views, Affiliate GMV, …).

### `source:tiktok-bookmarklet-streamer` — seller Streamer Compass video-analysis

Fields: `creator`, `page`, `date_label`, `date_start`, `date_end`, `scrapedAt`,
`metrics_count`, `metrics_json`, `videos_count`, `videos_json`. Same shape as
the creator source but scraped from the seller side.

### `source:tiktok-bookmarklet-live` — seller LIVE Dashboard (real-time)

One message per LIVE session snapshot. Fields: `page`, `shop`, `room_id`,
`duration`, `session_range`, `scrapedAt`, `gmv`, `performance_count`,
`traffic_count`, `products_count` (plus the detail blobs the bookmarklet sends).
No `creator` — scope by `shop` or `room_id`.

### `source:tiktok-bookmarklet-livestream-analytics` — seller LIVE analytics dump

Fields: `creator`, `scrapedAt`, `sections_count`, `metrics_count`, `rows_count`,
`sections_json`, `core_data_json`, `livestreams_json`.

### `source:tiktok-bookmarklet-data-overview` — Compass "Data Overview"

KPI tiles + optional recent-livestreams table. Fields: `creator`, `page`,
`scrapedAt`, `date_label`, `date_start`, `date_end`, `metrics_count`,
`metrics_json`, `recent_livestreams_count`, `recent_livestreams_json`.

### `source:tiktok-bookmarklet-creator-analysis` — Partner Center creator-analysis

One message per scrape; one row per creator in scope. Fields: `scrapedAt`,
`date_start`, `date_end`, `columns_json`, `creators_count`, `creators_json`. (No
top-level `creator` — the creators are inside `creators_json`.)

### `source:tiktok-bookmarklet-product-analysis` — Compass "Product Analytics"

**Multi-message**: one message per table page (`page_num` 1..N, 50 rows/page),
regrouped by `creator` + `scrapedAt`. Fields: `creator`, `page`, `scrapedAt`,
`date_label`, `date_start`, `date_end`, `page_num`, `pages_total`,
`total_products`, `rows_count`, `columns_json`, `rows_json`. When counting
"scrapes", group by (`creator`,`scrapedAt`) — a single scrape spans many rows.

### `source:tiktok-affiliate-export` — affiliate xlsx upload (richest source)

One message **per affiliate order row** (ingested via the mobile app's "Add
Exported Data" — sender is `mobile-app/www/js/app.js`). This is the
content↔product bridge. Full field set:

- **Identity/labels:** `creator`, `agency`, `affiliate_partner`, `order_id`,
  `sku_id`, `product_id`, `product_name`, `shop_name`, `shop_code`, `currency`,
  `order_type`, `commission_type`, `content_type` (Video/LIVE), `content_id`,
  `standard_rate`, `order_settlement_status`.
- **Dates:** `order_date`, `order_date_iso`, `commission_settlement_date`,
  `scraped_at` (note: snake_case here, unlike other sources' `scrapedAt`).
- **Numerics (aggregate on these):** `price_num`, `gmv_num`, `items_sold_num`,
  `items_refunded_num`, `est_commission_num`, `actual_commission_num`,
  `total_final_earned_num`.

⚠️ The xlsx export carries no real TikTok handle, so `creator` is mirrored from
the **agency label** (`agency`), not the `@handle` — keep that in mind when
joining this source to the scraper sources, which use the real handle. Numeric
fields are dropped from a row when a cell doesn't parse (so a missing `gmv_num`
means "unparseable", not necessarily zero).

### `source:tiktok-bookmarklet-orders` — buyer-side order detail ("Default" price)

One message per order detail page. Fields: `order_id`, `store`, `status`,
`default_product`, `default_variant`, `default_price`, `line_item_count`,
`order_total`, `subtotal`, `sales_tax`, `shipping`, `order_date`, `scrapedAt`,
`line_items_json` (the full per-line-item array). On very large orders the
serialized array exceeds Graylog's keyword limit and is dropped — the message
then carries `line_items_json_omitted` instead, so check for that field if
`line_items_json` is missing.

### `source:tiktok-bookmarklet-orders-list` — buyer-side orders inventory feed

One message per list capture. Fields: `order_count`, `scrapedAt` (the order rows
themselves are in the message body / detail blob).

### `source:tiktok-bookmarklet-sellers` — partner-collabs agency detail

Fields: `page`, `campaign_id`, `status`, `status_count`, `scrapedAt`,
`tabs_count`, `tabs_json`, `sellers_count`, `sellers_json`.

### `source:thirsty-store-kiosk` — sample lifecycle + marketplace listings

The write-path events (status/sold/assign/intake/import/listing) documented in
`sample-lifecycle/references/lifecycle-events.md`. Discriminate with
`sample_event:` (`listed`, `listing_failed`, `listing_scheduled`,
`listing_fired`, `assigned`, `imported`, `agency_intake`) and `sample_status:`.
Since the eBay API integration, real-API listings add `listing_id` /
`external_listing_id` flat fields and `sample_source` values `marketplace-api`,
`marketplace-cron`, `marketplace-auto`; publish failures are
`sample_event:listing_failed` with a `listing_error_json` blob (so
`sample_event:listed` still means success only). Current listing STATUS lives in
Postgres (`GET /api/listings`); Graylog holds the history.

---

## "All known sources" filter

To sweep every scraper source at once (e.g. to list creators), OR them:

```
source:tiktok-bookmarklet OR source:tiktok-bookmarklet-streamer OR
source:tiktok-bookmarklet-livestream-analytics OR
source:tiktok-bookmarklet-data-overview OR source:tiktok-affiliate-export
```

This mirrors `ALL_SOURCES_LUCENE` in `mobile-app/scripts/build-preloaded.js`.
The simplest discovery query is just `--list-sources` (counts messages per
`source`), then drill in.
