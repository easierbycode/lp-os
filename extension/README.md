# LP-OS TikTok Shop Scraper (merged Chrome extension)

Merge of the two tok-scrape extensions — `extension-agency` (Partner Center)
and `extension-seller` (seller LIVE Dashboard / Streamer Compass / buyer order
pages) — into one Manifest V3 extension with an LP-OS **role gate**:
a matching page URL alone no longer triggers anything; the resolved LP-OS user
decides which behavior family is enabled. (`extension-creator-demo` was
dropped and not ported.)

## Install (load unpacked)

1. Open `chrome://extensions` and enable **Developer mode** (top right).
2. Click **Load unpacked** and select this `extension/` directory.
3. Optional, for local dev fixtures (`fixtures/*.html` via `file://`): open the
   extension's **Details** page and enable **Allow access to file URLs**.
4. Pin the action icon. Clicking it opens the popup (role status + a
   **Scrape this page** button).

## Role gate

The background resolves the current LP-OS user in this order:

1. **LP-OS shell tab** — any open tab with a `?user=<id>` query param that
   looks like the LP-OS shell (host `localhost`/`127.0.0.1`, or tab title
   containing "LP-OS"; production domain TBD).
2. **Popup override** — `chrome.storage.local.lpos_user`, set from the popup's
   text input.
3. **Neither** → user `null` → **everything disabled**.

Role mapping mirrors `apps/shell/core/roles.json`:

| user | role | enabled family |
|---|---|---|
| `dj` | admin | **agency** |
| any `@handle` (e.g. `@boosteddealsdaily`) | creator | **seller**, scoped to that handle |
| `ka` | warehouse | none (extension does nothing) |
| unknown / none | — | none |

When a scrape is blocked, the badge flashes `X` (red) and the service-worker
console logs *why* (which user/role was resolved, via which source). For
creator scrapes, the resolved handle is stamped into `TOK_CONFIG.LPOS_USER`
(the legacy payload scripts ignore it; new consumers can read it).

## Behavior × role matrix

| behavior (route) | page | family | admin (`dj`) | creator (`@handle`) | warehouse / none |
|---|---|---|---|---|---|
| `creator` | partner.us.tiktokshop.com/compass/{creator-analysis,custom-report} | agency | ✓ | ✕ | ✕ |
| `sellers` | partner.us.tiktokshop.com/affiliate-campaign/partner-collabs/agency/detail | agency | ✓ | ✕ | ✕ |
| `live` (+ fixture) | shop.tiktok.com/workbench/live/overview | seller | ✕ | ✓ | ✕ |
| `streamer` | shop.tiktok.com/streamer/compass/video-analysis/view | seller | ✕ | ✓ | ✕ |
| `product` (isolated + MAIN pair) | shop.tiktok.com/streamer/compass/product-analysis/view | seller | ✕ | ✓ | ✕ |
| `data-overview` | shop.tiktok.com/streamer/compass/data-overview/view | seller | ✕ | ✓ | ✕ |
| `analytics` | shop.tiktok.com/streamer/compass/livestream-analytics/view | seller | ✕ | ✓ | ✕ |
| `order` (+ fixture) | www.tiktok.com/shop/order_detail | seller | ✕ | ✓ | ✕ |
| `orders` (+ fixture) | www.tiktok.com/shop/order_list | seller | ✕ | ✓ | ✕ |

Per the contract, admin gets the agency family only (not seller). To widen a
role, edit `ROLE_FAMILIES` in `background.js`.

The declarative content script `scrape-order-main.js`
(`www.tiktok.com/shop/order_detail*`, MAIN world, `document_start`) is carried
over from extension-seller and still loads by manifest — it must hook
`fetch`/XHR before the page's own code runs, which cannot wait for a role
lookup. It is **passive**: it only buffers product `{id, name}` pairs inside
the page (`window.__tokOrderCap`) and answers a `postMessage` request. Nothing
leaves the page unless the role-gated `order` scrape is injected and asks.

## What changed vs the two source extensions

- **One manifest** — name `LP-OS TikTok Shop Scraper`, unioned
  `host_permissions` (partner.us.tiktokshop.com + shop.tiktok.com +
  www.tiktok.com + the shared Sheets/ngrok/localhost entries), permissions
  gained `tabs` (find the LP-OS shell tab's `?user=`) and `storage` (role
  cache / override).
- **One background.js** — both ROUTES arrays merged (each route tagged with a
  `family`), plus `resolveRole()` and the role gate. The GELF/Sheets relay
  (`msg.source === 'tok-scrape'`) is verbatim from the sources, so all payload
  scripts work unchanged.
- **Popup added** (`popup.html`/`popup.js`). Because the manifest now sets
  `action.default_popup`, `chrome.action.onClicked` no longer fires — the
  scrape trigger moved from "click the icon" to the popup's **Scrape this
  page** button. The popup also shows the resolved user/role and the
  per-behavior enable readout, and sets/clears `lpos_user`.
- **One config.js** — the sources' two copies were identical except the header
  comment. `TOK_CONFIG`'s shape is preserved (`GRAYLOG_ENDPOINT`,
  `GRAYLOG_TOKEN`, `SHEET_ENDPOINT`, `SHEET_TOKEN`); the GELF endpoint now
  defaults to LP-OS at `http://localhost:8000/gelf` (**production domain
  TBD**), overridable per machine via `chrome.storage.local.lpos_gelf_endpoint`
  / `lpos_gelf_token` (pre-injected by background.js). The legacy shim token
  is kept so `_graylog_key` keeps passing the ingest gate.
- **Payload scripts carried over byte-for-byte** — `scrape-creator.js`,
  `scrape-sellers.js` (agency); `scrape-live.js`, `scrape-streamer.js`,
  `scrape-product.js`, `scrape-product-main.js`, `scrape-data-overview.js`,
  `scrape-analytics.js`, `scrape-order.js`, `scrape-order-list.js`,
  `scrape-order-main.js` (seller). No file existed in both sources with
  divergent content (only `config.js`/`background.js`/`manifest.json`, all
  merged above; icons were byte-identical).
- `test-order-scrape.mjs` moved to `test/order-scrape.test.mjs` (paths made
  URL-based for Windows; `--live` dropdown check now targets
  `${LPOS_API_URL:-http://localhost:8000}` instead of thirsty.store).

## Dev checks

```sh
# syntax-check every script
for f in *.js; do node --check "$f"; done

# run the order-scrape transform test (no network writes)
deno run -A test/order-scrape.test.mjs

# run the role-gate test (drives the real background.js under a chrome stub)
deno run -A test/role-gate.test.mjs      # or: node test/role-gate.test.mjs
```
