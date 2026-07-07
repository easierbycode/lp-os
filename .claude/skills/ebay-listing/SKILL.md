---
name: ebay-listing
description: >-
  Open eBay's create-listing page in the browser and AUTOFILL it from a sample's
  data — the click-through behind the "eBay draft" in the Samples-Import demo.
  Trigger when the user wants to actually post/draft a sample on eBay — e.g.
  "open the eBay listing and autofill it", "autofill this eBay listing with the
  sample data", "list <product> on eBay", "post the eBay draft for sample 123".
  Drives the Claude-in-Chrome browser tools: navigate to the eBay listing form,
  wait for the user to sign in if needed, then fill title / condition / price /
  description (and the photo when possible) from the product. It does NOT submit
  or publish — it leaves a ready-to-review draft. Pairs with the visual eBay-draft
  snapshot rendered by the Samples-Import app / EbayDraft component.
allowed-tools: mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__read_page, mcp__Claude_in_Chrome__get_page_text, mcp__Claude_in_Chrome__find, mcp__Claude_in_Chrome__form_input, mcp__Claude_in_Chrome__computer, mcp__Claude_in_Chrome__file_upload, mcp__Claude_in_Chrome__read_console_messages, mcp__f520785f-7c81-4ad1-a212-026d9c945eb7__v1_tiktok_product, WebFetch
---

# ebay-listing

Opens eBay's "Create your listing" page and autofills it from a sample's data
using the **Claude-in-Chrome** browser tools. This is the action behind the
Samples-Import "eBay draft" → "Open in eBay & autofill" button (the draft is a
visual snapshot; this skill does the real autofill).

If the Chrome extension isn't connected, ask the user to install/connect it
(this skill needs `mcp__Claude_in_Chrome__*`); don't fall back to screen
control.

## Inputs

The product to list, ideally already on hand from the import/lifecycle context:
`name` (→ title), a `retail`/MSRP price (the TikTok price — the pricing input,
NOT the Buy-It-Now directly), condition (default **New** — these are fresh
samples), `description`, an `image` URL, and the `productId`. If you only have a
`productId` / PDP url, hydrate first via `…__v1_tiktok_product` (LP-OS serves
no `/api/product-lookup/:id` — that data-pimp route was not ported) for the
title/price/image. The **Buy-It-Now price is computed by the pricing formula**
(see Pricing below), not taken raw.

## Workflow

1. **Open the listing form.** `navigate` to `https://www.ebay.com/sl/sell`
   (eBay's create-listing entry). eBay may route through a "what are you
   selling" prelist step — proceed to the listing form.
2. **Handle sign-in — never type the user's credentials.** If eBay shows a
   sign-in wall, tell the user to log in themselves in that tab, wait, then
   continue. (Treat eBay creds like any secret — the user enters them, not you.)
3. **Locate the fields.** Use `read_page` / `get_page_text` / `find` to identify
   the title input, condition selector, format/price (Buy It Now) input, and the
   description editor. eBay's DOM changes often, so locate by visible label, not
   a hardcoded selector.
4. **Compute the Buy-It-Now price** with the eBay pricing formula — undercut the
   competition, move fast, never below a fee-aware floor (see **Pricing**
   below). You're already on eBay, so grab real comps first: eBay's search
   results for the title (or the "Similar sold items" panel) are competitor
   prices. Then call the `/api/ebay-price` endpoint (see Pricing for where it
   lives) with the product's `retail`/MSRP, `costBasis` (0 for a free sample),
   `condition`, and those `comps`, and use the returned `price`. Surface its
   `explanation` to the user.
5. **Autofill** with `form_input` (or `computer` for rich controls):
   - **Title** ← `name` (trim to eBay's 80-char limit).
   - **Condition** ← `New`.
   - **Price / Buy It Now** ← the **recommended price from step 4** — a
     floor-protected, charm-`.99` ask that undercuts the cheapest credible comp.
     Never fill a price below the formula's returned `floor`.
   - **Description** ← `description` (or a sensible default: "Brand-new, sealed
     TikTok Shop sample. Ships fast from a smoke-free home.").
   - **Photo** ← the `image`: if eBay accepts an image URL or `file_upload`
     works, add it; otherwise leave photos and tell the user to drop the image
     in.
6. **Stop at a reviewable draft. Do NOT submit/publish.** Leave the form filled
   and tell the user what was populated and what to check (category, item
   specifics, shipping) before they click **List it** themselves.

## Pricing

The Buy-It-Now price comes from the eBay pricing formula
(`packages/marketplace/ebay-pricing.ts`, ported verbatim from data-pimp),
exposed as `GET|POST /api/ebay-price` on the LP-OS shell.

> **autoComps caveat.** LP-OS did not port data-pimp's live-eBay comps
> scraper, so against LP-OS `autoComps=1` returns `compsSource: "none"` and
> the formula anchors on retail — pass explicit `comps=` for market-aware
> pricing. The `https://thirsty.store` default works before the domain
> cutover (data-pimp) and after it (LP-OS); set `EBAY_PRICE_API_URL` to
> `http://localhost:8000` to hit a local shell.

It undercuts the cheapest **credible** competitor, marks down the longer a
unit sits, and never drops below a fee-aware floor (so a listing never loses
money after eBay's ~13.25% + $0.30). Call it, e.g.:

```
GET ${EBAY_PRICE_API_URL:-https://thirsty.store}/api/ebay-price?retail=89.99&costBasis=0&condition=new&comps=58,62,65
# or POST JSON: { "retail": 89.99, "costBasis": 0, "condition": "new", "comps": [58,62,65] }
# or let the server fetch live eBay sold comps for you:
GET ${EBAY_PRICE_API_URL:-https://thirsty.store}/api/ebay-price?retail=89.99&condition=new&autoComps=1&query=Ninja+AF101+Air+Fryer+4qt
```

If the endpoint is unreachable, compute the core of the formula inline as a
fallback (defaults from data-pimp `core/ebay-pricing.ts`): anchor = cheapest
credible comp; with no comps, anchor = retail × 0.30. Undercut the anchor by
max(5%, $1.00) (one comp only → gentler max(3%, $0.50)). Fee-aware floor =
(costBasis + shipping + $0.30) / (1 − 0.1325), minimum $1.00 — never price
below it. Land on a charm `.99` ending. Say clearly that the local fallback
was used instead of the endpoint.

It returns `price` (the charm-`.99` Buy-It-Now to fill), plus `floor`, `anchor`,
`netAtPrice`, `undercutFromAnchor`, `floorHit`, a one-line `explanation`, and a
`compsSource` (`provided` / `ebay-sold` / `ebay-sold(cache)` / `none`).
Guidance:

- **Pass comps when you have them.** Real eBay comps let the formula undercut
  the actual market; with none it falls back to a conservative retail-based
  anchor.
- **Or use `autoComps=1&query=<title>`.** The server then pulls live eBay SOLD
  comps itself (best-effort, cached) and feeds them in — check `compsSource` /
  `compsMeta` to see whether real comps were found. Comps you read off the page
  directly still take precedence when you pass them.
- **Respect the floor.** If `floorHit` is true the market is at/below break-even
  — the returned `price` sits at the floor; don't hand-edit it lower.
- **Relay the reasoning.** Tell the user what the `explanation` says (e.g.
  "undercuts the cheapest comp $58 → $54.99, nets $47.40 after fees").
- Try it yourself: `deno task demo:ebay-pricing` (CLI), or the visual demo at
  `/demos/ebay-pricing` (Demos → eBay Pricing in the shell) — pick a catalog
  product from the dropdown, or deep-link `?product=<productId>`. The
  Marketplace window's "List a sample now" runs the same formula to suggest the
  Ask price.

## Guardrails

- **Never publish or pay.** Don't click "List it" / "Submit" / confirm fees —
  posting a live listing is the user's action. Autofill + hand back.
- **Never enter the user's eBay credentials.** Sign-in is the user's job.
- **Locate by label, verify before typing.** Confirm you're on the right field
  (read the page) before `form_input`; eBay's layout shifts.
- **One listing at a time.** For a batch, confirm each before moving on.
- Read-only product research (reviews/showcase) is the `scrapecreators-api`
  skill; inventory writes (assign/sold/listing events) are `sample-lifecycle`.
  This skill only drives the eBay browser form.
