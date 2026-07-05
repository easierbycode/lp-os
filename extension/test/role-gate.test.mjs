// Role-gate test: loads the REAL ../background.js under a chrome API stub and
// asserts the behavior x role matrix — which LP-OS user unlocks which scrape
// family, resolution order (shell tab -> storage -> disabled), and the
// injection mechanics (pre-injected LPOS_USER global, MAIN-world second pass).
//
//   deno run -A extension/test/role-gate.test.mjs   (also runs under: node extension/test/role-gate.test.mjs)

const isDeno = typeof Deno !== "undefined";
const readFile = async (rel) => {
  const url = new URL(rel, import.meta.url);
  if (isDeno) return await Deno.readTextFile(url);
  const { readFile } = await import("node:fs/promises");
  return await readFile(url, "utf8");
};
const exit = (code) => (isDeno ? Deno.exit(code) : process.exit(code));

// --- chrome stub ------------------------------------------------------------
const state = {
  tabs: [],            // resolveRole scans these
  storage: {},         // chrome.storage.local backing
  injections: [],      // executeScript calls, in order
  badges: [],
  onMessage: null,
};
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { state.onMessage = fn; } },
    lastError: undefined,
  },
  action: {
    setBadgeText: (o) => { if (o.text) state.badges.push(o.text); },
    setBadgeBackgroundColor: () => {},
  },
  tabs: {
    query: async () => state.tabs,
    get: async (id) => state.tabs.find((t) => t.id === id),
  },
  storage: {
    local: {
      get: async (keys) => {
        const ks = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of ks) if (k in state.storage) out[k] = state.storage[k];
        return out;
      },
      set: async (obj) => Object.assign(state.storage, obj),
      remove: async (k) => { delete state.storage[k]; },
    },
  },
  scripting: {
    executeScript: async (opts) => { state.injections.push(opts); },
  },
};

(0, eval)(await readFile("../background.js"));

// --- helpers ----------------------------------------------------------------
const send = (msg) =>
  new Promise((resolve) => {
    const async = state.onMessage(msg, null, resolve);
    if (async !== true) resolve({ ok: false, error: "listener was not async" });
  });

const scrapeAt = async (url) => {
  state.tabs = state.tabs.filter((t) => t.id !== 99);
  state.tabs.push({ id: 99, url, title: "target" });
  state.injections = [];
  return await send({ source: "lp-os-popup", type: "scrape", tabId: 99 });
};

const setContext = ({ shellUrl, stored }) => {
  state.tabs = shellUrl ? [{ id: 1, url: shellUrl, title: "LP-OS" }] : [];
  state.storage = {};
  if (stored) state.storage.lpos_user = stored;
};

const injectedFiles = () => state.injections.flatMap((i) => i.files || []);

let fail = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? "✓" : "✗ FAIL"}  ${name}`);
  if (!ok) fail++;
};

const URLS = {
  creator: "https://partner.us.tiktokshop.com/compass/custom-report?x=1",
  sellers: "https://partner.us.tiktokshop.com/affiliate-campaign/partner-collabs/agency/detail?campaign_id=5",
  live: "https://shop.tiktok.com/workbench/live/overview?room_id=123",
  product: "https://shop.tiktok.com/streamer/compass/product-analysis/view",
  order: "https://www.tiktok.com/shop/order_detail?main_order_id=1&source=order_list",
  orderList: "https://www.tiktok.com/shop/order_list",
  random: "https://example.com/",
};

// --- scenarios ----------------------------------------------------------------
console.log("role gate: dj (admin) via shell tab");
setContext({ shellUrl: "http://localhost:8000/?user=dj" });
let r = await scrapeAt(URLS.creator);
check("agency creator allowed", r.ok === true && r.family === "agency" && r.user === "dj" && r.role === "admin");
check("injects config.js + scrape-creator.js", injectedFiles().join(",") === "config.js,scrape-creator.js");
r = await scrapeAt(URLS.sellers);
check("agency sellers allowed", r.ok === true && r.route === "sellers");
r = await scrapeAt(URLS.live);
check("seller live blocked for admin", r.ok === false && r.reason === "role");
r = await scrapeAt(URLS.order);
check("seller order blocked for admin", r.ok === false && r.reason === "role");

console.log("role gate: @boosteddealsdaily (creator) via shell tab");
setContext({ shellUrl: "http://127.0.0.1:8000/?user=%40boosteddealsdaily" });
r = await scrapeAt(URLS.live);
check("seller live allowed", r.ok === true && r.family === "seller" && r.role === "creator");
check("LPOS_USER pre-injected with handle", state.injections[0].args && state.injections[0].args[0] === "@boosteddealsdaily");
r = await scrapeAt(URLS.product);
check("product pair injected (isolated then MAIN)", r.ok === true &&
  injectedFiles().join(",") === "config.js,scrape-product.js,scrape-product-main.js" &&
  state.injections[2].world === "MAIN");
r = await scrapeAt(URLS.creator);
check("agency creator blocked for creator role", r.ok === false && r.reason === "role");

console.log("role gate: storage fallback + precedence");
setContext({ stored: "@wizardofdealz" });
r = await scrapeAt(URLS.orderList);
check("storage @handle unlocks seller family", r.ok === true && r.user === "@wizardofdealz");
setContext({ shellUrl: "https://lp-os.example.com/?user=dj" }); // non-localhost, title 'LP-OS'
state.storage.lpos_user = "@someoneelse";
r = await scrapeAt(URLS.creator);
check("shell tab (matched by LP-OS title) wins over storage", r.ok === true && r.user === "dj");

console.log("role gate: disabled cases");
setContext({});
r = await scrapeAt(URLS.live);
check("no user resolved => blocked", r.ok === false && r.reason === "role" && r.user === null);
setContext({ stored: "ka" });
r = await scrapeAt(URLS.live);
check("warehouse (ka) => seller blocked", r.ok === false && r.role === "warehouse");
r = await scrapeAt(URLS.creator);
check("warehouse (ka) => agency blocked", r.ok === false);
setContext({ stored: "randomuser" });
r = await scrapeAt(URLS.creator);
check("unknown non-@ user => blocked (role null)", r.ok === false && r.role === null);
setContext({ shellUrl: "http://localhost:8000/?user=dj" });
r = await scrapeAt(URLS.random);
check("unmatched URL => no-route (never injects)", r.ok === false && r.reason === "no-route" && state.injections.length === 0);

console.log("popup status matrix");
setContext({ shellUrl: "http://localhost:8000/?user=dj" });
r = await send({ source: "lp-os-popup", type: "status", tabUrl: URLS.live });
const byId = Object.fromEntries((r.behaviors || []).map((b) => [b.id, b.enabled]));
check("9 deduped behaviors listed", (r.behaviors || []).length === 9);
check("admin: agency on, seller off", byId.creator === true && byId.sellers === true &&
  byId.live === false && byId.streamer === false && byId.product === false &&
  byId["data-overview"] === false && byId.analytics === false && byId.order === false && byId.orders === false);
check("tab route reported + blocked", r.route && r.route.id === "live" && r.route.enabled === false);
r = await send({ source: "lp-os-popup", type: "set-user", user: "@boosteddealsdaily", tabUrl: URLS.live });
check("set-user override applies immediately", r.route && r.route.enabled === false /* shell tab dj still wins */);
setContext({});
r = await send({ source: "lp-os-popup", type: "set-user", user: "@boosteddealsdaily", tabUrl: URLS.live });
check("set-user without shell tab enables seller", r.route && r.route.enabled === true && r.via === "storage");

console.log(fail ? `\n${fail} check(s) failed.` : "\nAll checks passed.");
// Badge-clear timers (2s) may still be pending; exit explicitly.
setTimeout(() => exit(fail ? 1 : 0), 0);
