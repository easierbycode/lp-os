---
name: sample-e2e
description: >-
  Run the repeatable sample-lifecycle end-to-end test, and/or open the visual
  two-pane workspace. Trigger when the user wants to e2e-test the import/lifecycle
  pipeline, "test these product ids", verify the API + Graylog path, or watch an
  import happen visually. Feed an array of TikTok product IDs (priced and/or
  unpriced); it walks import (assign to creator) → Postgres verify → Graylog
  verify via the LP-OS API, and can also show it: Samples-Import replaying the
  adds on the left, Apps/Inventory table on the right.
allowed-tools: Bash, mcp__Claude_in_Chrome__list_connected_browsers, mcp__Claude_in_Chrome__navigate
---

# sample-e2e

Two halves — a scriptable API+Graylog walk, and a visual two-pane workspace. Use
either or both for whatever the user is verifying.

## Part 1 — the repeatable test (API walk)

> **Not ported yet.** data-pimp's `scripts/sample-e2e.ts` harness has NOT been
> carried into LP-OS (there is no `apps/shell/scripts/sample-e2e.ts`), and
> neither have the `/api/product-lookup/:id` (hydrate) and
> `/api/product-creators` (order-scrape dropdown verify) routes it exercised —
> both 404 on the LP-OS shell. Until the port lands, run the walk below directly
> against the LP-OS API with curl/Bash and report each step's result.

Per product id, against `${LPOS_API_URL:-http://localhost:8000}`:

1. **import** — `POST /api/sample-import` with JSON
   `{"productId":"<id>","name":"<name>","price":<num|omit>,"creator":"@e2e-test"}`
   → expect `ok:true`, a `sampleId`, `graylog:true`, and the creator echoed. (A
   missing `price` exercises the unpriced path.)
2. **verify Postgres** — `GET /api/samples?qr_code=<id>` → the new row has
   `status=checked_out` and `checked_out_to=@e2e-test`.
3. **verify Graylog** — the import response's `graylog:true`, plus
   `GET /api/creators` → `@e2e-test` appears (the `creator:*` sweep reads the
   assignment event back from the message store).
4. **cleanup (optional)** — `DELETE /api/samples/:id` per created row (leave the
   rows when the user wants to inspect them in Inventory).

The hydrate step (PRICED vs unpriced report from a live TikTok lookup) and the
order-scrape → creator-dropdown verify have **no LP-OS equivalent yet** — say so
rather than improvising a substitute. The order-detail **scraper transform**
test (runs the real `scrape-order.js` against a fake order page) lives in
tok-scrape: `extension-seller/test-order-scrape.mjs` (`deno run -A`).

## Part 2 — the visual two-pane workspace

Open LP-OS with `?workspace=samples-import` to watch it: **Samples-Import tiles
LEFT and auto-replays the import** (each product shown in the order modal),
**Apps/Inventory tiles RIGHT** as a table of the imported rows (edit / enhance
via its "Fetch from API"). Pass the run's ids/creator straight through:

```
${LPOS_API_URL:-http://localhost:8000}/?workspace=samples-import&autostart=1&creator=@e2e-test&ids=1729587769570529799,9001234567890
```

Via the Claude-in-Chrome browser skill: `list_connected_browsers` → `navigate`
to that URL. (Without `autostart=1` it just prefills, so the user clicks Start.)

## Typical flow

1. Run Part 1 with the user's product ids (skip cleanup so the rows persist).
2. Open Part 2 with the same `ids`/`creator` so the user sees the adds land and
   can inspect/edit them in the Inventory table.
3. Offer cleanup (`DELETE /api/samples/:id`, or delete via Inventory) when done.

## Guardrails

- Runs against `LPOS_API_URL` (default `http://localhost:8000`; production is
  `https://thirsty.store`). Wherever it points, it creates **real** sample rows
  — clean up after CI-style runs and use an obvious test `creator` (e.g.
  `@e2e-test`).
- Graylog is append-only: order-scrape test events persist (clearly tagged).
- This skill verifies/visualizes; the actual writes are `sample-lifecycle` /
  `/api/sample-import`. Product research is `scrapecreators-api`.
