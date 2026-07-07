---
name: run-partner-center-bookmarklet
description: Run a TikTok Shop scraper bookmarklet via the Claude in Chrome extension. Five targets — `creator` (bookmarklet-src.js, Partner Center video-analysis dashboard, default), `sellers` (bookmarklet-sellers.js, partner-collabs agency-detail page), `live` (bookmarklet-live.js, seller-side LIVE Dashboard on shop.tiktok.com), `streamer` (bookmarklet-streamer.js, seller-side Streamer Compass video-analysis view), and `orders` (extension-seller/scrape-order.js, buyer-side Your-Orders list → order-detail "Default" variant price on www.tiktok.com) — and two environments — `dev` (local fixture, default) and `prod` (live TikTok Shop). Trigger on phrases like "run the partner center bookmarklet", "scrape the partner center", "scrape sellers", "scrape live dashboard", "scrape streamer compass", "scrape orders", "find a product's default price in my orders", or "/run-partner-center-bookmarklet [dev|prod] [creator|sellers|live|streamer|orders] [product name]".
---

# run-partner-center-bookmarklet

Automate the manual step of opening a TikTok Shop page and clicking a scraper
bookmark. Drives the user's real Chrome via the Claude in Chrome extension so
TikTok login cookies are reused — credentials are never typed by Claude.

## Inputs

- `$1` — environment: `dev` (default) or `prod`.
- `$2` — target: `creator` (default), `sellers`, `live`, `streamer`, or
  `orders`.
- `$3` — (only for `orders`) the product name to find in the Orders list, e.g.
  `"VEVOR Softbox Lighting Kit"`. Pass a distinctive prefix, not the whole
  title.

The combinations resolve like this:

| target   | env  | Page                                                                                                                       | Bookmarklet                                                 |
| -------- | ---- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| creator  | dev  | `file:///Users/danieljohnson/CODE/tok-scrape/partner-center.html`                                                          | `bookmarklet-src.js`                                        |
| creator  | prod | `https://partner.us.tiktokshop.com/compass/video-analysis`                                                                 | `bookmarklet-src.js`                                        |
| sellers  | dev  | `file:///Users/danieljohnson/CODE/tok-scrape/partner-center2.html`                                                         | `bookmarklet-sellers.js`                                    |
| sellers  | prod | An already-open tab matching `partner.us.tiktokshop.com/affiliate-campaign/partner-collabs/agency/detail?campaign_id=*`    | `bookmarklet-sellers.js`                                    |
| live     | dev  | `file:///Users/danieljohnson/CODE/tok-scrape/seller-center.html`                                                           | `bookmarklet-live.js`                                       |
| live     | prod | An already-open tab matching `shop.tiktok.com/workbench/live/overview?room_id=*`                                           | `bookmarklet-live.js`                                       |
| streamer | dev  | `file:///Users/danieljohnson/CODE/tok-scrape/seller-center2.html`                                                          | `bookmarklet-streamer.js`                                   |
| streamer | prod | `https://shop.tiktok.com/streamer/compass/video-analysis/view`                                                             | `bookmarklet-streamer.js`                                   |
| orders   | dev  | `file:///…/tok-scrape-main/fixtures/Tiktok Shop - Orders.html` (list) + `…/order.html` (detail) — see the `orders` section | `extension-seller/scrape-order-list.js` + `scrape-order.js` |
| orders   | prod | `https://www.tiktok.com/shop/order_list` → SPA-navigates to `…/order_detail?main_order_id=*`                               | `extension-seller/scrape-order.js`                          |

Both `sellers + prod` and `live + prod` have no canonical landing URL because
each campaign / live session has a unique id (`campaign_id` / `room_id`). Reuse
a tab the user has already navigated to instead of guessing one.
`streamer + prod` _does_ have a single canonical URL (the seller's own
dashboard), so we navigate normally.

`dev` runs are safe for offline testing. POSTs still fire to the real
Graylog/Sheets endpoints, so rows will appear tagged with the fixture's data.

## `orders` target (buyer-side Orders → "Default" price)

`orders` is the only **two-page** target: it finds an order by **product name**
on the buyer-side Orders list (`www.tiktok.com/shop/order_list`), opens that
order's detail page (`…/order_detail?main_order_id=*`), and scrapes the
**"Default" variant unit price** — the headline value the user wants (e.g.
`62.89`). Unlike the other targets it lives in **this** repo's Chrome-extension
layout, so read its scripts from `tok-scrape-main`:

- detail scraper →
  `/Users/danieljohnson/CODE/tok-scrape-main/extension-seller/scrape-order.js`
- list/inventory feed (optional) →
  `/Users/danieljohnson/CODE/tok-scrape-main/extension-seller/scrape-order-list.js`
- config (defines `globalThis.TOK_CONFIG`) →
  `/Users/danieljohnson/CODE/tok-scrape-main/extension-seller/config.js`

Parse `GRAYLOG_ENDPOINT` from **`config.js`** (not the scraper — the scraper
reads `TOK_CONFIG`). Same stale-check as the other targets: the current GELF
sink is **LP-OS `/gelf`** (`${LPOS_API_URL:-http://localhost:8000}/gelf`;
production `https://thirsty.store/gelf`) — the old `*.ngrok-free.dev` endpoints are **stale**. If
`GRAYLOG_ENDPOINT` points at an ngrok host, warn and stop. These pages are on
`www.tiktok.com`, a different host than the seller scrapers. Because Chrome-MCP
can't click the extension toolbar, **inject the source directly**:
`javascript_tool` the **`config.js` body first**, then the **`scrape-order.js`
body**, so `TOK_CONFIG` exists before the IIFE runs.

### Steps (these replace the generic single-page Steps 5–6 for `orders`)

1. **Open the Orders list.**
   - `dev`: open
     `file:///Users/danieljohnson/CODE/tok-scrape-main/fixtures/Tiktok%20Shop%20-%20Orders.html`.
   - `prod`: navigate to `https://www.tiktok.com/shop/order_list`, then run the
     **prod login gate** (Step 4) — this page can redirect to login.

2. **List readiness probe** — poll until an order card and a details button are
   mounted:
   ```js
   (() => {
     const cards = document.querySelectorAll(
       "div.flex.flex-col.gap-12.background-color-UIPageFlat1.p-16.rounded-6.cursor-pointer.shadow",
     ).length;
     const hasBtn = !!document.querySelector(
       'button[data-testid="tux-web-button"]',
     );
     return { cards, hasBtn };
   })();
   // ready iff cards >= 1 && hasBtn
   ```

3. **Find the order by product name (`$3`) and click into it.** Substitute `$3`
   for the needle:
   ```js
   ((needle) => {
     const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
     const want = norm(needle);
     const cards = Array.from(
       document.querySelectorAll(
         "div.flex.flex-col.gap-12.background-color-UIPageFlat1.p-16.rounded-6.cursor-pointer.shadow",
       ),
     );
     for (const card of cards) {
       const imgs = Array.from(
         card.querySelectorAll("div.relative.flex-shrink-0.w-80.h-80 img[alt]"),
       );
       if (!imgs.some((im) => norm(im.getAttribute("alt")).includes(want))) {
         continue;
       }
       let btn = Array.from(
         card.querySelectorAll('button[data-testid="tux-web-button"]'),
       )
         .find((b) => {
           const c = b.querySelector(".tux-button__content-naVKgq");
           return c && norm(c.textContent) === "view order details";
         }) ||
         card.querySelector('button[data-testid="tux-web-button"]');
       if (btn) {
         btn.click();
         return { clicked: true, alt: imgs.map((i) => i.getAttribute("alt")) };
       }
       return { clicked: false, reason: "matched card but no button" };
     }
     return {
       clicked: false,
       reason: "no card matched",
       seen: cards.flatMap((c) =>
         Array.from(c.querySelectorAll("img[alt]")).map((i) =>
           i.getAttribute("alt")
         )
       ),
     };
   })("VEVOR Softbox Lighting Kit");
   ```
   On `{clicked:false}`, **stop** and report `seen` (the product names found on
   the page) so the user can correct the search term.

4. **Wait for the detail page** — poll until navigation settles and the price
   block is mounted:
   ```js
   (() => {
     const onDetail = /\/shop\/order_detail(?:[/?#]|$)/.test(location.href);
     const hasPrice =
       !!document.querySelector("img.w-90.h-90.object-cover.rounded-4[alt]") &&
       !!document.querySelector(
         ".flex.justify-between.items-center .H4-Semibold.text-color-UIText1",
       );
     return { onDetail, hasPrice, url: location.href };
   })();
   // ready iff onDetail && hasPrice
   ```
   ~20s budget, ~1s between polls (re-call the tool; no sleep loop). On timeout,
   screenshot and report which of `onDetail` / `hasPrice` failed.

5. **Inject** the `config.js` body, then the `scrape-order.js` body, via
   `javascript_tool`.

6. **Verify & summarize.** Console: the `[tok-scrape:order]` payload +
   `[graylog] sent`. Network: a POST to the GELF host parsed from `config.js`
   (LP-OS `/gelf`; opaque / status 0 in the CORS sense, or 202 — presence is the
   success signal). Report: product, **`defaultPrice`** (e.g. 62.89),
   `defaultVariant`, `orderId`, `store`, `lineItemCount`, and Graylog
   `source:tiktok-bookmarklet-orders`.

### dev seam (offline)

The saved list fixture is a static snapshot — its "View order details" buttons
have **no SPA wiring**, so the live click→navigate hop is **prod-only**. In
`dev`, validate the two halves separately: run the Step-3 snippet against the
list fixture and assert `{clicked:true, alt:[…VEVOR…]}`, then **separately**
open
`file:///Users/danieljohnson/CODE/tok-scrape-main/fixtures/Tiktok%20Shop%20-%20Inside%20a%20specific%20order.html`
and inject `config.js` + `scrape-order.js` — expect `defaultPrice:62.89`,
`lineItems[0].variant:"Default"`, and `orderId:577312748349657317` (via the DOM
fallback, since the `file://` URL has no `main_order_id`). Requires **"Allow
access to file URLs"** on the extension.

### list/inventory feed

To log **every** order's products instead of drilling into one (store / date /
status / product names — no prices, none exist on the list page): on the
`order_list` page (or the list fixture) inject `config.js` +
**`scrape-order-list.js`** → `[tok-scrape:orders-list]` payload + Graylog
`source:tiktok-bookmarklet-orders-list`.

## Required tools

All from the Claude in Chrome MCP (`mcp__Claude_in_Chrome__*`):
`tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `javascript_tool`,
`read_console_messages`, `read_network_requests`, `read_page`, plus
`mcp__computer-use__screenshot` as a fallback for debugging. Plus `Read` for
disk access to the bookmarklet source.

If the extension isn't connected, stop and tell the user to install/connect it —
do not fall back to computer-use mouse-clicks on Chrome (it's tier-"read" and
clicks are blocked).

## Steps

1. **Pick the bookmarklet file based on `$2`:**
   - `creator` (or omitted) →
     `/Users/danieljohnson/CODE/tok-scrape/bookmarklet-src.js`
   - `sellers` → `/Users/danieljohnson/CODE/tok-scrape/bookmarklet-sellers.js`
   - `live` → `/Users/danieljohnson/CODE/tok-scrape/bookmarklet-live.js`
   - `streamer` → `/Users/danieljohnson/CODE/tok-scrape/bookmarklet-streamer.js`

   `Read` it from disk. Parse out the `GRAYLOG_ENDPOINT` and `ENDPOINT` values
   so you can filter network requests to those hosts later. The current GELF
   sink is **LP-OS `/gelf`** (`${LPOS_API_URL:-http://localhost:8000}/gelf`;
   production `https://thirsty.store/gelf`). If `GRAYLOG_ENDPOINT` still points at an
   `*.ngrok-free.dev` host, warn the user that the endpoint is **stale** (the
   old ngrok Graylog stack is retired) and stop — the bookmarklet source needs
   its `GRAYLOG_ENDPOINT` repointed at LP-OS `/gelf` first.

2. **Resolve the target URL** from `($1, $2)` per the table above. For
   `sellers + prod` and `live + prod`, do **not** navigate — instead skip ahead
   to step 3 and only reuse a matching open tab.

3. **Find or create the tab.** Call `tabs_context_mcp` to list open tabs.
   - For `creator` (any env), `sellers + dev`, `live + dev`, and `streamer` (any
     env): if a tab already matches the target URL (startsWith match on
     origin+path), reuse it and `navigate` to force a refresh. Otherwise, open a
     new tab via `tabs_create_mcp` with the target URL.
   - For `sellers + prod`: look for a tab whose URL contains
     `partner.us.tiktokshop.com/affiliate-campaign/partner-collabs/agency/detail`
     and includes a `campaign_id=` query string. If none, stop and say:
     > No Partner Collabs Agency Detail tab is open. Navigate to the campaign
     > you want to scrape (Partner Center → Partner Collabs → pick a campaign →
     > "Detail"), then re-run the skill. Do not guess a `campaign_id`.
   - For `live + prod`: look for a tab whose URL contains
     `shop.tiktok.com/workbench/live/overview` and includes a `room_id=` query
     string. If none, stop and say:
     > No Seller Center LIVE Dashboard tab is open. Navigate to the live session
     > you want to scrape (Seller Center → Live → pick a session → "Dashboard"),
     > then re-run the skill. Do not guess a `room_id`.

4. **Prod login gate.** In any `prod` mode, after the nav settles, use
   `read_page` to check for a TikTok login form (text like "Log in", "Enter
   password", or the URL pattern `accounts.tiktok` / `/login`). If detected,
   stop and say:
   > The Partner Center redirected to a login page. Please log in manually in
   > that Chrome tab, then re-run the skill. Do not type credentials. Do not
   > click login buttons on the user's behalf.

5. **Wait for the dashboard.** Poll up to ~20 seconds by calling
   `javascript_tool` repeatedly with the readiness probe for the chosen target:

   - **creator** — ready when the date picker, creator selector, and metrics
     panels are mounted with at least one video row:
     ```js
     (() => ({
       spaces: document.querySelectorAll(".arco-space-item").length,
       hasRow: !!document.querySelector("tbody tr.arco-table-tr"),
     }))();
     // ready iff spaces >= 3 && hasRow
     ```

   - **sellers** — ready when the inner status tabs (Pending / Approved /
     Rejected / Pending closed / Closed) exist and at least one product row has
     a checkbox (i.e. real data, not an empty-state row):
     ```js
     (() => ({
       tabs: document.querySelectorAll(".arco-tabs-header-title-text").length,
       hasRow: !!document.querySelector(
         'tbody tr.arco-table-tr input[type="checkbox"]',
       ),
     }))();
     // ready iff tabs >= 5 && hasRow
     ```

   - **live** — ready when the shop avatar, the GMV odometer, and at least one
     product row are all mounted:
     ```js
     (() => ({
       hasShop: !!document.querySelector(
         '.flex.items-center.ml-7 img[alt="avatar"]',
       ),
       hasGmv: !!document.querySelector(
         ".ecom-screen-animated-number-container .odometer-value",
       ),
       hasRow: !!document.querySelector(
         'tbody tr.arco-table-tr a[href*="/view/product/"]',
       ),
     }))();
     // ready iff hasShop && hasGmv && hasRow
     ```

   - **streamer** — ready when the 3-col KPI grid has all 5 cards mounted and at
     least one video thumbnail has rendered:
     ```js
     (() => {
       const grid = document.querySelector(".grid.grid-cols-3");
       const cards = grid ? grid.querySelectorAll(":scope > div").length : 0;
       const hasThumb = !!document.querySelector('img[alt="video thumbnail"]');
       return { cards, hasThumb };
     })();
     // ready iff cards >= 5 && hasThumb
     ```

   Between polls wait ~1s (re-call the tool; do not use a sleep loop). On
   timeout, take a screenshot and report which condition failed.

   For `sellers`, **only the currently active tab's rows are scraped**, and the
   active tab name is included on every row as `Status`. If the user wants a
   different status, ask them to click that tab first and re-run the skill.

   For `live`, the dashboard is real-time and the GMV odometer animates on load
   — scraping captures whatever the page shows at the moment of the click. The
   Performance trends section auto-rotates between metrics; all slides stay
   mounted, so the bookmarklet captures every metric regardless of which one is
   on-screen.

6. **Inject the bookmarklet.** Call `javascript_tool` once, passing the exact
   contents of the source file from step 1 as-is. Both files already wrap
   themselves as `(function(){ ... })();` so no additional wrapping is needed.
   Do not modify the source in-memory.

7. **Verify.**
   - Call `read_console_messages` and look for:
     - The logged payload object (creator:
       `{creator, scrapedAt, dateRange, metrics, videos}`; sellers:
       `{page, campaignId, status, statusCount, statusTabs, scrapedAt, sellers}`;
       live:
       `{page, shop, roomId, duration, sessionRange, scrapedAt, gmv, sideKpis, performance, trafficSources, products}`;
       streamer: `{page, dateLabel, dateRange, scrapedAt, metrics, videos}`).
     - `[sheet]` followed by a JSON response — **only for `creator` and
       `live`**. The `sellers` bookmarklet is Graylog-only by design (no
       `ENDPOINT` / no Sheets POST), so the absence of `[sheet]` for sellers is
       expected, not a failure. For creator the response is
       `{ok:true, metricsWritten:N, videosUpserted:M}`; for live the response
       may surface as zero-counts until the Apps Script is taught the new schema
       — that's fine, the request still succeeded.
     - `[graylog] sent` with a status (will be `opaque` because the Graylog POST
       uses `mode:'no-cors'` — that's expected, still a success signal). **All
       three targets must produce this line.**
   - Call `read_network_requests`:
     - For `creator` and `live`, filter to `script.google.com` → expect a POST;
       status should be 200 (or a 302 follow-redirect; Apps Script sometimes
       redirects). For `sellers`, skip — there's no Sheets POST.
     - For all targets, filter to the GELF host parsed in step 1 (LP-OS `/gelf`)
       → expect a POST request to exist. The response will be opaque (status 0
       in the CORS sense), so assert only that the **request was sent**, not
       that the status was 200.
   - If the Graylog POST is missing entirely, or if the console shows an error
     like `Key metrics container not found` / `[sheet] post failed` /
     `[graylog] post failed`, capture a screenshot and surface the error
     verbatim.

8. **Summarize back to the user.** Report:
   - target + env used
   - final URL
   - For `creator`: video count, `metricsWritten` / `videosUpserted` from the
     Sheets response (if present)
   - For `sellers`: seller count, active status tab + count, all status-tab
     counts
   - For `live`: shop name, room id, GMV, items sold, viewers, product count,
     performance-metric count, traffic-source count
   - For `streamer`: page title, date range + label, KPI count + values (GMV /
     Items sold / Views / New followers / Videos), video count
   - Graylog status (and `source` value: `tiktok-bookmarklet` for creator,
     `tiktok-bookmarklet-sellers` for sellers, `tiktok-bookmarklet-live` for
     live, `tiktok-bookmarklet-streamer` for streamer — Graylog indexes GELF
     `host` as `source`)
   - Any warnings.

## Guardrails — do not

- Never type TikTok credentials or click login buttons. Login is always manual.
- Never hardcode or inline the bookmarklet source. Always `Read` it fresh from
  disk so the GELF endpoint and Graylog token it carries are current (and run
  the step-1 staleness check — ngrok hosts are retired; LP-OS `/gelf` is the
  sink).
- Never run `docker compose up` or `scripts/sync-bookmarklet.py` as a preflight.
  If endpoints look stale, fail fast with a clear message.
- Never retry the injection on timeout — surface the failure so the selectors
  can be fixed. The Arco classes are fragile and silent retries mask DOM
  regressions.
- Never auto-click status tabs in `sellers` mode. The user picks the status; we
  scrape what's visible.
- Never guess a `campaign_id` or `room_id`. For `sellers + prod` and
  `live + prod`, require an already-open matching tab.
- If the Claude in Chrome extension is not connected, stop and ask the user to
  install/connect it — do not drive Chrome via `mcp__computer-use__*`
  (tier-"read" blocks clicks/typing on browsers).

## Notes

- All four Graylog POSTs use `mode: 'no-cors'`, so in the Network panel their
  responses appear as opaque/status 0. This is by design. Presence of the
  request is the success signal.
- GELF endpoint status: the current sink is **LP-OS `/gelf`**
  (`${LPOS_API_URL:-http://localhost:8000}/gelf`; production
  `https://thirsty.store/gelf`). The
  old `https://tok-graylog-gelf.ngrok-free.dev/gelf` ngrok endpoint is
  stale/retired — treat any bookmarklet still carrying it as needing a repoint
  before scraping.
- The fixtures (`partner-center.html`, `partner-center2.html`,
  `seller-center.html`, `seller-center2.html`) are snapshots of the real DOM, so
  the same selectors and readiness probes work in both `dev` and `prod`.
- The streams in Graylog are distinguished by the `source` field:
  `source:tiktok-bookmarklet` (creator) vs `source:tiktok-bookmarklet-sellers`
  vs `source:tiktok-bookmarklet-live` vs `source:tiktok-bookmarklet-streamer` vs
  `source:tiktok-bookmarklet-orders` (order detail / Default price) vs
  `source:tiktok-bookmarklet-orders-list` (orders inventory feed).
- For a headless / CI variant of this flow, see `scripts/run-bookmarklet.ts`
  (Playwright). It reads the scrapers + `config.js` from this repo's extension
  dirs (`extension-seller/`, `extension-agency/`), injects a `chrome.runtime`
  relay shim so the POSTs fire outside the extension, and mirrors the toggles
  via `--target=creator|sellers|live|streamer|orders|orders-list` and
  `--env=dev|prod`. Flags: `--target=sellers --env=prod` needs
  `--campaign-id=<id>`; `--target=live --env=prod` needs `--room-id=<id>`;
  `--target=orders --env=prod` needs `--product="<name>"` (it loads the Orders
  list, finds + clicks into that order, then scrapes the detail). `orders` dev
  injects against the saved order-detail fixture; `orders-list` enumerates the
  Orders list. `creator`/`sellers` have no local dev fixture in this repo, so
  run them with `--env=prod`. Run via `cd scripts && npm i` then e.g.
  `npm run bookmarklet:orders` / `npm run bookmarklet:orders-list`.
