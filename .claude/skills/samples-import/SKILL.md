---
name: samples-import
description: >-
  Open the tok-scrape Samples-Import page (paste/upload TikTok product IDs →
  hydrate → add to inventory assigned to a creator) and, when needed, help the
  user install the merged LP-OS scraper Chrome extension. Trigger when the user
  wants to import sample product IDs, open Samples-Import, scrape TikTok
  order/seller pages, or install the scraper extension. Two load paths: the
  Claude-in-Chrome browser skill, or the installed extension; the install help
  (load-unpacked from the repo's extension/ folder) surfaces in an LP-OS
  window or a browser tab.
allowed-tools: mcp__Claude_in_Chrome__list_connected_browsers, mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__find, mcp__Claude_in_Chrome__javascript_tool, mcp__Claude_in_Chrome__get_page_text
---

# samples-import

Gets the user into the **Samples-Import** workflow, by whichever path is
available, and helps install the **merged LP-OS scraper** Chrome extension if
they want the scraper. Samples-Import itself is a standalone page — it needs no
extension; the extension is for scraping TikTok order/seller pages into LP-OS's
Graylog store (`POST /gelf`).

Key URLs:

- Samples-Import page: `https://easierbycode.com/tok-scrape/samples-import/www/`
  (also an LP-OS app: **Demos → Samples-Import**)
- Extension install help: `${LPOS_API_URL:-http://localhost:8000}/install` (also
  **Apps → Install Extension** in LP-OS) — has the load-unpacked steps.
  (Production is `https://thirsty.store`; set `LPOS_API_URL` to target it.)
- Extension source: the `extension/` folder of the lp-os repo checkout, or the
  zip the shell serves at `/extension.zip` (linked from `/install`). The legacy
  `https://easierbycode.com/tok-scrape/chrome.zip` is the OLD tok-scrape
  extension — it posts GELF to the retired graylog-shim (scrapes never reach
  LP-OS) and has no role gate. Don't offer it for LP-OS use.

## Branch A — load via the Claude-in-Chrome browser skill (preferred)

When a Chrome browser is connected:

1. `list_connected_browsers` → pick the Chrome.
2. `navigate` to the Samples-Import URL.
3. Drive it with `find` / `javascript_tool` / `get_page_text` (paste the product
   IDs into `#ids`, set `#creator`, optionally the auto-list panel, click
   `#start`). The page calls the live `/api/sample-import` itself.

If the Chrome extension isn't connected, ask the user to install/connect it
rather than falling through to slower tooling.

## Branch B — load via LP-OS / the extension

- **In LP-OS:** open **Demos → Samples-Import** (the registered app), or **Apps
  → Install Extension** for the install window.
- **With the merged extension installed:** the extension adds its scrape
  button on TikTok pages; Samples-Import still opens as the page above. The
  extension is what makes order/seller scrapes flow to LP-OS's Graylog store
  (and stamps `_creator` on order scrapes).

## Install the extension (load unpacked from the repo)

Surface the install help as an **LP-OS window** (Apps → Install Extension) or,
via the browser skill, `navigate` to
`${LPOS_API_URL:-http://localhost:8000}/install`. That page walks:

1. **Locate** the `extension/` folder in the lp-os repo checkout (clone the
   repo if the user doesn't have one — no zip is published yet).
2. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → pick the `extension/` folder.

**CRX caveat — be explicit:** Chrome blocks `.crx` installs from outside the Web
Store for normal profiles, so there is **no `.crx`** to "install" directly; the
supported path is the **Load unpacked** flow above. (Enterprise force-install
policy is the only exception.) Don't promise a one-click `.crx`.

## Guardrails

- **Downloading is an explicit-permission action** — confirm before triggering a
  download or opening the install flow.
- Samples-Import works **without** the extension (via Branch A); only offer the
  install when the user wants the scraper or asks for it.
- This skill loads/installs; the actual import writes are the page's
  `/api/sample-import` calls (see the `sample-lifecycle` skill for the lifecycle
  events). Reviews/showcase questions are the `scrapecreators-api` skill.
