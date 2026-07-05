// LP-OS merged scraper service worker.
//
// Combines the two tok-scrape extensions:
//   - agency family: Partner Center creator custom-report + partner-collabs
//     sellers scraping on partner.us.tiktokshop.com
//   - seller family: LIVE Dashboard, Streamer Compass (video / product /
//     data-overview / livestream-analytics) on shop.tiktok.com, plus buyer-side
//     order detail/list on www.tiktok.com
//
// Two jobs:
//   1. Inject the right scrape payload into the current tab — but ONLY if the
//      resolved LP-OS user's role enables that behavior family (see
//      resolveRole below). A matching URL alone never triggers a scrape.
//   2. Relay GELF / Sheets payloads from the injected scripts to their
//      endpoints in a context the page's CSP can't block (unchanged from both
//      source extensions).
//
// NOTE: manifest.json sets action.default_popup, so chrome.action.onClicked
// never fires in this merged extension. Scrapes are triggered from the popup's
// "Scrape this page" button, which messages runScrape() below.

const ROUTES = [
  // ---- agency family (partner.us.tiktokshop.com) ----
  {
    family: 'agency',
    id: 'creator',
    test: /https:\/\/partner\.us\.tiktokshop\.com\/compass\/(creator-analysis|custom-report)/,
    files: ['config.js', 'scrape-creator.js'],
    label: 'creator',
    desc: 'Partner Center custom report (creator analysis)'
  },
  {
    family: 'agency',
    id: 'sellers',
    test: /https:\/\/partner\.us\.tiktokshop\.com\/affiliate-campaign\/partner-collabs\/agency\/detail/,
    files: ['config.js', 'scrape-sellers.js'],
    label: 'sellers',
    desc: 'Partner Collabs agency detail (product x seller matrix)'
  },

  // ---- seller family (shop.tiktok.com + www.tiktok.com) ----
  {
    family: 'seller',
    id: 'live',
    test: /https:\/\/shop\.tiktok\.com\/workbench\/live\/overview/,
    files: ['config.js', 'scrape-live.js'],
    label: 'live',
    desc: 'Seller LIVE Dashboard session'
  },
  {
    // Local dev fixture for the LIVE Dashboard, served either as a file:// URL
    // (Chrome needs "Allow access to file URLs" enabled on the extension) or
    // via a local HTTP server. The trailing group allows optional ?query /
    // #fragment so dev URLs with a cache-buster or anchor still match.
    family: 'seller',
    id: 'live',
    fixture: true,
    test: /\/fixtures\/live_overview(?:__[^/]*)?\.html(?:[?#]|$)/,
    files: ['config.js', 'scrape-live.js'],
    label: 'live',
    desc: 'LIVE Dashboard (dev fixture)'
  },
  {
    family: 'seller',
    id: 'streamer',
    test: /https:\/\/shop\.tiktok\.com\/streamer\/compass\/video-analysis\/view/,
    files: ['config.js', 'scrape-streamer.js'],
    label: 'streamer',
    desc: 'Streamer Compass video analysis'
  },
  {
    // Product Analytics. The list table virtualizes its DOM to ~10 rows, so the
    // full per-page data only exists in the analytics/list API response. That
    // response is only observable from the page's own JS world, so this route
    // pairs an isolated relay (scrape-product.js, holds TOK_CONFIG + talks to
    // chrome.runtime) with a MAIN-world capture/pager (mainFiles below).
    family: 'seller',
    id: 'product',
    test: /https:\/\/shop\.tiktok\.com\/streamer\/compass\/product-analysis\/view/,
    files: ['config.js', 'scrape-product.js'],
    mainFiles: ['scrape-product-main.js'],
    label: 'product',
    desc: 'Streamer Compass product analytics'
  },
  {
    family: 'seller',
    id: 'data-overview',
    test: /https:\/\/shop\.tiktok\.com\/streamer\/compass\/data-overview\/view/,
    files: ['config.js', 'scrape-data-overview.js'],
    label: 'data-overview',
    desc: 'Streamer Compass data overview'
  },
  {
    family: 'seller',
    id: 'analytics',
    test: /https:\/\/shop\.tiktok\.com\/streamer\/compass\/livestream-analytics\/view/,
    files: ['config.js', 'scrape-analytics.js'],
    label: 'analytics',
    desc: 'Streamer Compass livestream analytics'
  },
  {
    // Buyer-side order DETAIL (carries the per-line-item / "Default" price).
    // NB: these order pages are on www.tiktok.com, not shop.tiktok.com — see
    // the matching host_permissions entry in manifest.json. Listed before the
    // order_list route below because the detail page embeds the substring
    // "order_list" in a `source=` query param; anchoring on the path segment
    // plus this ordering keeps them from cross-matching.
    family: 'seller',
    id: 'order',
    test: /https:\/\/www\.tiktok\.com\/shop\/order_detail(?:[/?#]|$)/,
    files: ['config.js', 'scrape-order.js'],
    label: 'order',
    desc: 'Buyer order detail (Default price + line items)'
  },
  {
    family: 'seller',
    id: 'order',
    fixture: true,
    test: /\/fixtures\/order\.html(?:[?#]|$)/,
    files: ['config.js', 'scrape-order.js'],
    label: 'order',
    desc: 'Order detail (dev fixture)'
  },
  {
    // Buyer-side order LIST (enumerate orders + product names; no prices/IDs).
    family: 'seller',
    id: 'orders',
    test: /https:\/\/www\.tiktok\.com\/shop\/order_list(?:[/?#]|$)/,
    files: ['config.js', 'scrape-order-list.js'],
    label: 'orders',
    desc: 'Buyer order list'
  },
  {
    family: 'seller',
    id: 'orders',
    fixture: true,
    test: /\/fixtures\/orders\.html(?:[?#]|$)/,
    files: ['config.js', 'scrape-order-list.js'],
    label: 'orders',
    desc: 'Order list (dev fixture)'
  }
];

// ---------------------------------------------------------------------------
// Role gate.
//
// Mirrors apps/shell/core/roles.json: dj -> admin, ka -> warehouse, and any
// @handle -> creator. admin unlocks the agency behaviors; creator unlocks the
// seller behaviors (scoped to that handle — it is stamped into
// TOK_CONFIG.LPOS_USER via a pre-injected global, see runScrape). warehouse
// (and unknown users) unlock nothing in this extension.
const NON_HANDLE_USERS = { dj: 'admin', ka: 'warehouse' };
const ROLE_FAMILIES = { admin: ['agency'], creator: ['seller'], warehouse: [] };

function roleForUser(user) {
  if (!user || typeof user !== 'string') return null;
  const u = user.trim();
  if (!u) return null;
  if (u.startsWith('@')) return 'creator';
  return NON_HANDLE_USERS[u.toLowerCase()] || null;
}

// An "LP-OS shell tab" is a tab running the LP-OS desktop shell with an
// explicit ?user= param. The shell is localhost:8000 in dev; production
// domain is TBD, so we also accept any tab whose title mentions LP-OS.
function shellUserFromTab(tab) {
  if (!tab || !tab.url) return null;
  let url;
  try { url = new URL(tab.url); } catch (_) { return null; }
  const user = url.searchParams.get('user');
  if (!user) return null;
  const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const titledShell = /lp-?os/i.test(tab.title || '');
  return (localHost || titledShell) ? user : null;
}

async function resolveRole() {
  // (a) an open LP-OS shell tab with ?user=<id> wins
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      const user = shellUserFromTab(tab);
      if (user) return { user, role: roleForUser(user), via: 'shell-tab' };
    }
  } catch (e) {
    console.warn('[lp-os-scraper] tab query failed while resolving role', e);
  }
  // (b) popup-set override in chrome.storage.local
  try {
    const got = await chrome.storage.local.get('lpos_user');
    if (got && got.lpos_user) {
      return { user: got.lpos_user, role: roleForUser(got.lpos_user), via: 'storage' };
    }
  } catch (e) {
    console.warn('[lp-os-scraper] storage read failed while resolving role', e);
  }
  // (c) no user resolved => everything disabled
  return { user: null, role: null, via: 'none' };
}

function enabledFamilies(role) {
  return ROLE_FAMILIES[role] || [];
}

// ---------------------------------------------------------------------------
// Injection (role-gated).

function flashBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 2000);
}

async function runScrape(tab) {
  if (!tab || !tab.id || !tab.url) return { ok: false, reason: 'no-tab' };
  const route = ROUTES.find((r) => r.test.test(tab.url));
  if (!route) {
    console.warn('[lp-os-scraper] no route for', tab.url);
    flashBadge(tab.id, '?', '#888');
    return { ok: false, reason: 'no-route' };
  }

  const auth = await resolveRole();
  if (!enabledFamilies(auth.role).includes(route.family)) {
    const why = auth.user
      ? 'user "' + auth.user + '" (role: ' + (auth.role || 'none') + ', via ' + auth.via +
        ') does not enable the "' + route.family + '" family'
      : 'no LP-OS user resolved — open the LP-OS shell with ?user=<id> or set a user in the popup';
    console.warn('[lp-os-scraper] blocked "' + route.label + '" on ' + tab.url + ': ' + why);
    flashBadge(tab.id, 'X', '#c33');
    return { ok: false, reason: 'role', route: route.label, family: route.family, user: auth.user, role: auth.role };
  }

  try {
    // Pre-seed globals for config.js: the resolved LP-OS user (creator scope)
    // and optional per-machine GELF endpoint/token overrides from storage.
    const over = await chrome.storage.local.get(['lpos_gelf_endpoint', 'lpos_gelf_token']);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (user, endpoint, token) => {
        globalThis.LPOS_USER = user;
        if (endpoint) globalThis.LPOS_GELF_ENDPOINT = endpoint;
        if (token) globalThis.LPOS_GELF_TOKEN = token;
      },
      args: [auth.user, over.lpos_gelf_endpoint || null, over.lpos_gelf_token || null]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: route.files
    });
    // Routes with a MAIN-world half (e.g. product-analysis) inject it second so
    // the isolated relay registered above is already listening for the
    // window.postMessage payloads it emits.
    if (route.mainFiles) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        files: route.mainFiles
      });
    }
    flashBadge(tab.id, route.label[0].toUpperCase(), '#2a8');
    return { ok: true, route: route.label, family: route.family, user: auth.user, role: auth.role };
  } catch (e) {
    console.warn('[lp-os-scraper] inject failed', e);
    return { ok: false, reason: 'inject-failed', error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// Popup protocol.

function behaviorMatrix(role, tabUrl) {
  const families = enabledFamilies(role);
  const seen = {};
  const behaviors = [];
  for (const r of ROUTES) {
    if (r.fixture || seen[r.id]) continue;
    seen[r.id] = true;
    behaviors.push({
      id: r.id,
      label: r.label,
      family: r.family,
      desc: r.desc,
      enabled: families.includes(r.family)
    });
  }
  const route = tabUrl ? ROUTES.find((r) => r.test.test(tabUrl)) : null;
  return {
    behaviors,
    route: route
      ? { id: route.id, label: route.label, family: route.family, desc: route.desc, enabled: families.includes(route.family) }
      : null
  };
}

async function handlePopupMessage(msg) {
  if (msg.type === 'status') {
    const auth = await resolveRole();
    return Object.assign({ ok: true }, auth, behaviorMatrix(auth.role, msg.tabUrl));
  }
  if (msg.type === 'set-user') {
    const user = (msg.user || '').trim();
    if (user) await chrome.storage.local.set({ lpos_user: user });
    else await chrome.storage.local.remove('lpos_user');
    const auth = await resolveRole();
    return Object.assign({ ok: true }, auth, behaviorMatrix(auth.role, msg.tabUrl));
  }
  if (msg.type === 'scrape') {
    const tab = await chrome.tabs.get(msg.tabId);
    return await runScrape(tab);
  }
  return { ok: false, error: 'unknown popup message type: ' + msg.type };
}

// ---------------------------------------------------------------------------
// Message hub: GELF/Sheets relay (verbatim from both source extensions) +
// popup control channel.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.source === 'tok-scrape' && (msg.type === 'gelf' || msg.type === 'sheet')) {
    const headers = msg.type === 'sheet'
      ? { 'Content-Type': 'text/plain;charset=utf-8' }
      : { 'Content-Type': 'application/json' };
    fetch(msg.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg.payload)
    })
      .then(async (r) => {
        // Always drain the body. Sheets returns JSON we want to log; Graylog
        // GELF returns 202 + empty body, but if we don't consume the stream
        // Chrome closes it client-side and stamps the entry net::ERR_ABORTED
        // in DevTools, masking what is in fact a successful POST.
        let body = null;
        try {
          const text = await r.text();
          if (msg.type === 'sheet') {
            try { body = JSON.parse(text); } catch (_) { body = text || null; }
          } else {
            body = text || null;
          }
        } catch (_) { body = null; }
        sendResponse({ ok: r.ok, status: r.status, body });
      })
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async sendResponse
  }

  if (msg.source === 'lp-os-popup') {
    handlePopupMessage(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async sendResponse
  }

  return false;
});
