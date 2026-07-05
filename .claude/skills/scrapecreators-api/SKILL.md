---
name: scrapecreators-api
description: >-
  Answer TikTok Shop product questions DURING SAMPLE INTAKE via the connected
  ScrapeCreators MCP server. Trigger when, while intaking or looking at a sample,
  the user asks about a product's REVIEWS ("what are the reviews like for this
  product", "is it any good", "what's the rating", "any complaints") or about a
  creator's OTHER / SIMILAR products ("what similar products are in their
  showcase", "what else does @x promote", "what's in their storefront"). The
  inputs are already on hand at intake: the sample's TikTok Shop PDP url or its
  numeric productId (= the sample's qr_code), and the creator @handle. Read-only
  product research — it does NOT write sample state; lifecycle writes
  (status/assign/sold/listing) are the sample-lifecycle skill's job.
allowed-tools: mcp__f520785f-7c81-4ad1-a212-026d9c945eb7__v1_tiktok_shop_product_reviews, mcp__f520785f-7c81-4ad1-a212-026d9c945eb7__v1_tiktok_product, mcp__f520785f-7c81-4ad1-a212-026d9c945eb7__v1_tiktok_user_showcase, mcp__f520785f-7c81-4ad1-a212-026d9c945eb7__v1_tiktok_shop_products, mcp__f520785f-7c81-4ad1-a212-026d9c945eb7__v1_tiktok_shop_search
---

# scrapecreators-api

Product research for sample intake, backed by the **already-connected
ScrapeCreators MCP** (tools prefixed
`mcp__f520785f-7c81-4ad1-a212-026d9c945eb7__`). This is the read-side companion
to `sample-lifecycle`: when the user is deciding what to do with a sample, this
answers "is this product any good?" and "what else does this creator push?". It
never changes inventory — that's `sample-lifecycle`.

You already have the inputs at intake: the TikTok Shop **PDP url** or the
numeric **productId** (which is the sample's `qr_code`), and the **creator
@handle**.

## Workflow 1 — Reviews ("what are the reviews like for this product?")

Call `mcp__…__v1_tiktok_shop_product_reviews` with `url` = the sample's PDP url
(or `product_id` = the numeric `qr_code`), `region: "US"`, `page: 1`.

- Headline from `rating_distribution` + `total_reviews` — e.g. "4.6★ across
  1,243 reviews, ~78% 5-star".
- Representative quotes from
  `product_reviews[].{rating, display_text,
  sku_specification, review_timestamp_fmt}`
  — quote a couple of high and low ones and note which variant
  (`sku_specification`) they bought.
- Paginate with `page` for more.

**Shortcut:** if you also want price/stock/image in the same breath, call
`mcp__…__v1_tiktok_product` (`url` required, US-only) once — its
`product_detail_review` (`product_rating`, `review_count`) gives a quick rating
summary plus `related_videos` (affiliate TikToks promoting it). The reviews tool
is still the source of truth for the full list + distribution.

## Workflow 2 — Showcase / similar products ("what similar products are in their showcase?")

Call `mcp__…__v1_tiktok_user_showcase` with `handle` = the creator handle
**without the `@`** (e.g. `boosteddealsdaily`), `region: "US"`, `cursor` to
page.

- Read each product's `{title, price, images, shop}`; surface titles + prices,
  and flag any that overlap or compete with the sample being intaken.
- If the user means the **shop's** other products (not the creator's showcase),
  use `mcp__…__v1_tiktok_shop_products` (`url` = store url, `sort_by: "top"`).
- For similar products across TikTok Shop generally, use
  `mcp__…__v1_tiktok_shop_search` (`query` = the product name/keywords).

## Guardrails

- **Read-only.** Never changes sample state — defer all writes (status, assign,
  sold, listing) to the `sample-lifecycle` skill.
- **Always `region: "US"`.** It's the only reliable region; `v1_tiktok_product`
  is US-only. Non-US returns limited/inconsistent data.
- **Reuse the id you already have.** The sample's `qr_code` IS the TikTok
  productId — pass it (or the PDP url) directly. Don't re-search by name: a name
  search on a bare id can bind an unrelated listing, and each lookup costs a
  credit.
- **Prefer these connected MCP tools** over raw curl. (LP-OS's own
  `SCRAPECREATORS_API_KEY` paths in `core/samples.ts` / `product-image.ts` are
  server-side enrichment, not ad-hoc Q&A.)
- The MCP server UUID in `allowed-tools` is connection-specific; if the
  ScrapeCreators tools stop resolving, re-confirm the server prefix.
