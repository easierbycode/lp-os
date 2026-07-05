# Shipping integration — scope (not yet built)

What it would take to close the loop after a sample sells on eBay: see the
order, charge/collect shipping correctly, buy a label, mark it shipped with
tracking, and record the outcome in LP-OS. Researched against eBay's docs
July 2026; written so the same shape extends to marketplaces #2 and #3.

## Where listing stops today

`@lp-os/marketplace` publishes fixed-price listings (offer carries a
fulfillment policy — flat-rate USPS by default) and records
`listings.status = listed`. Nothing observes the sale: `sold` still enters
LP-OS manually via the sample-lifecycle skill / `POST /api/sample-sold`.

## Phase S1 — see eBay orders (the minimum that closes the loop)

- **Poll `GET /sell/fulfillment/v1/order`** (Fulfillment API, scope
  `sell.fulfillment`) with `orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}`
  on the existing auto-lister interval. Push-based order events are NOT worth
  it at our volume: order topics still ride the legacy Platform Notifications
  (SOAP-to-your-HTTPS-endpoint) system, and the modern REST Notification API's
  public topic list doesn't clearly cover orders yet — polling is the
  pragmatic hobby-scale answer (limits are thousands of calls/day; a
  5-minute poll is nothing).
- Match orders to `listings` rows by `lineItems[].legacyItemId` ==
  `listings.external_id` (fallback: `sku` == `lpos-<sampleId>`).
- On match: set `listings.status = 'sold'`, stamp `ended_at`, and call the
  existing `recordSampleSold` with marketplace `ebay`, real
  `salePrice`/`fees` (order `pricingSummary` + `marketplaceFee`), `buyer`,
  `orderRef` — creator attribution and Graylog revenue events then work
  exactly like manual sales today.
- New needs: `sell.fulfillment` scope on the stored token (re-mint consent),
  an `orders`-ish audit trail (either a new `marketplace_orders` table or
  just Graylog events `sample_event:"marketplace_order"`), idempotency by
  eBay `orderId`.
- Effort: ~1–2 days. No new UI beyond a "Sold" badge already supported by the
  listings table.

## Phase S2 — shipping data + policy correctness

- **Flat vs calculated**: today we default to one flat-rate USPS Priority
  policy. Calculated shipping needs package weight + dimensions per item:
  eBay `packageWeightAndSize` on the inventory item
  (`weight {value, unit:POUND}`, `dimensions {length,width,height, unit:INCH}`,
  weight required for calculated; weight alone is enough for flat-with-
  surcharge).
- Data model: add `weight_oz`, `dim_l_in`, `dim_w_in`, `dim_h_in` (or one
  `package_json` jsonb) to `samples` via a `0003` migration; capture at
  intake (Samples-Import already hydrates product data; TikTok PDPs rarely
  carry shipping dims, so expect manual entry in the intake flow or a
  per-brand default table).
- Marketplace settings additions: choose policy mode
  (flat cost | calculated | existing policy id per category), handling time.
- Effort: ~2–3 days including intake-UI capture and eBay policy switch.

## Phase S3 — labels + mark-shipped

- **eBay's own Logistics API is out**: `/sell/logistics/v1` (shipping quote →
  buy label → download PDF) is Limited Release, whitelisted partners only,
  USPS-only. Not available to a solo developer keyset.
- Realistic options, in order of effort:
  1. **Manual labels (zero code)** — buy in eBay Seller Hub (eBay rates,
     auto-uploads tracking). LP-OS just ingests tracking on the next order
     poll (S1 already reads `fulfillmentHrefs`). Recommended first.
  2. **Third-party label API** — EasyPost or Shippo (both have per-label
     pricing, USPS/UPS/FedEx, test modes). New `packages/shipping` adapter
     (same structural-deps pattern), a `shipments` table (listing_id/order
     ref, carrier, service, cost, tracking_number, label_url, created_at),
     UI = "Buy label" button on a sold listing row + printable label link.
     Needs S2's weight/dims. Then **`POST /sell/fulfillment/v1/order/{orderId}
     /shipping_fulfillment`** with `{lineItems, shippingCarrierCode,
     trackingNumber, shippedDate}` to mark shipped on eBay.
  3. Label-broker deep links (Pirate Ship etc.) — cheaper than 2 to build
     (no API spend), clunkier to use.
- Credentials: a second `marketplace_accounts`-style row (or a
  `shipping_accounts` table) for the EasyPost/Shippo key — same
  "enter locally in the window, never echoed" pattern.
- Effort: option 2 is ~4–6 days end-to-end (adapter + table + UI + fulfillment
  push + tests); option 1 is ~0.5 day (tracking ingest only).

## Phase S4 — returns/cancellations (later)

Post-Order API (returns, cancellations, disputes) is its own surface with
separate scopes; out of scope until real volume. Manual handling in Seller
Hub, with a `listings.status = 'ended'` patch when a listing dies.

## Cross-marketplace notes (marketplaces #2 and #3)

Keep the split: `MarketplaceClient` gains `getOrders()`/`markShipped()`
methods per marketplace; the label side (S3) is marketplace-agnostic by
design — one `packages/shipping` adapter serves all three. The `listings`
table already carries `marketplace`, so S1's matcher and the sold flow are
generic from day one.

## Suggested order

S1 (order polling → auto-sold) delivers the most value per line of code and
makes the resale revenue numbers real without human data entry. S2 only when
flat-rate pricing visibly loses money. S3 option 1 immediately, option 2 when
label volume justifies it.
