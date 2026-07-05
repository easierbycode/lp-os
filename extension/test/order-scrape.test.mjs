// Order-detail scraper transform test (ported from tok-scrape extension-seller).
// Runs the REAL ../scrape-order.js against a fabricated order page (deno-dom)
// and asserts the GELF it emits: _creator (from the SSR user_nick_name), the
// synthetic _product_id (= stableProductId), the default product/price, and the
// per-line-item id. With --live it also pushes to the configured GELF endpoint
// (creds read from ../config.js — not duplicated) and confirms the creator
// surfaces in /api/product-creators.
//
//   deno run -A extension/test/order-scrape.test.mjs           # transform assertions only (no writes)
//   deno run -A extension/test/order-scrape.test.mjs --live    # also push to GELF + verify dropdown
import { DOMParser } from "jsr:@b-fuze/deno-dom";

const LIVE = Deno.args.includes("--live");

function cfgValue(src, name) {
  const m = src.match(new RegExp(name + "\\s*=\\s*['\"]([^'\"]+)['\"]"));
  return m ? m[1] : "";
}
const cfgSrc = await Deno.readTextFile(new URL("../config.js", import.meta.url)).catch(() => "");
// The merged config.js assigns defaults to DEFAULT_* vars, then derives the
// live values from optional runtime globals — read the defaults here.
const GELF_URL = cfgValue(cfgSrc, "DEFAULT_GRAYLOG_ENDPOINT") || cfgValue(cfgSrc, "GRAYLOG_ENDPOINT");
const GELF_TOKEN = cfgValue(cfgSrc, "DEFAULT_GRAYLOG_TOKEN") || cfgValue(cfgSrc, "GRAYLOG_TOKEN");

const stamp = Date.now();
const CREATOR = "E2E Warehouse Tester";
const PRODUCT = `E2E Cupids Desire Drops ${stamp}`;
const ORDER_ID = "577" + String(stamp).slice(-12);

function stableProductId(name) {
  const s = name.replace(/\s+/g, " ").trim();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return "900" + String(h >>> 0).padStart(10, "0");
}

const html = `<!DOCTYPE html><html><body>
  <div id="__MODERN_ROUTER_DATA__">{"loaderData":{"order":{"user_nick_name":"${CREATOR}"}}}</div>
  <div class="H3-Bold text-color-UIText1"><span>Order completed</span></div>
  <div class="H4-Bold text-color-UIText1">E2E Test Shop</div>
  <div class="flex gap-16">
    <img class="w-90 h-90 object-cover rounded-4" alt="${PRODUCT}" src="https://x/y.jpg" />
    <div class="P1-Regular text-color-UIText1">${PRODUCT}</div>
    <div class="P2-Regular text-color-UIText3">Default</div>
    <div class="flex justify-between items-center">
      <div class="flex items-center gap-4"><span class="H4-Semibold text-color-UIText1">$24.99</span></div>
      <span class="H4-Semibold text-color-UIText2">x1</span>
    </div>
  </div>
  <div class="flex justify-between items-center"><div>Order date</div><div>Jun 28, 2026</div></div>
  <div class="flex justify-between items-center"><div>Total</div><div>$24.99</div></div>
</body></html>`;

globalThis.document = new DOMParser().parseFromString(html, "text/html");
globalThis.location = { href: `https://www.tiktok.com/shop/order_detail?main_order_id=${ORDER_ID}` };
globalThis.window = { location: globalThis.location, addEventListener() {}, removeEventListener() {}, postMessage() {} };
// The scraper only emits when an endpoint is set, but our sendMessage stub
// CAPTURES (never POSTs) — so a placeholder is safe in transform-only mode; the
// real network write happens only in the explicit --live fetch below.
globalThis.TOK_CONFIG = { GRAYLOG_ENDPOINT: GELF_URL || "https://capture.local/gelf", GRAYLOG_TOKEN: GELF_TOKEN };
let captured = null;
globalThis.chrome = { runtime: { lastError: undefined, sendMessage(m, cb) { captured = m; if (cb) cb({ ok: true, status: 202 }); } } };

(0, eval)(await Deno.readTextFile(new URL("../scrape-order.js", import.meta.url)));
await new Promise((r) => setTimeout(r, 1500));

if (!captured) { console.error("FAIL: scraper emitted no GELF"); Deno.exit(1); }
const g = captured.payload;
const want = stableProductId(PRODUCT);
const checks = [
  ["_creator", g._creator === CREATOR],
  ["_creator_kind=display_name", g._creator_kind === "display_name"],
  ["_default_product", g._default_product === PRODUCT],
  ["_default_price=24.99", g._default_price === 24.99],
  ["_product_id == stableProductId", g._product_id === want],
  ["_product_id_source=name-hash", g._product_id_source === "name-hash"],
  ["host=tiktok-bookmarklet-orders", g.host === "tiktok-bookmarklet-orders"],
  ["line item carries synthetic id", JSON.parse(g._line_items_json || "[]")[0]?.productId === want],
];
let fail = 0;
console.log("order-scrape transform:");
for (const [n, ok] of checks) { console.log(`  ${ok ? "✓" : "✗ FAIL"}  ${n}`); if (!ok) fail++; }

if (LIVE && !fail) {
  if (!GELF_URL) { console.log("  --live: no GELF endpoint in config.js, skipping"); }
  else {
    const r = await fetch(GELF_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(g) }).catch((e) => ({ ok: false, status: e.message }));
    console.log(`  GELF POST -> ${r.status}`);
    if (r.ok) {
      const API_BASE = Deno.env.get("LPOS_API_URL") || "http://localhost:8000";
      let seen = false;
      for (let i = 0; i < 6 && !seen; i++) {
        await new Promise((res) => setTimeout(res, 6000));
        const j = await fetch(`${API_BASE}/api/product-creators?productId=${want}&name=${encodeURIComponent(PRODUCT)}`).then((x) => x.json()).catch(() => null);
        if (((j && j.orderCreators) || []).includes(CREATOR)) seen = true;
      }
      console.log(`  ${seen ? "✓" : "✗"}  creator in /api/product-creators orderCreators`);
      if (!seen) fail++;
    }
  }
}
console.log(fail ? `\n${fail} check(s) failed.` : "\nAll checks passed.");
Deno.exit(fail ? 1 : 0);
