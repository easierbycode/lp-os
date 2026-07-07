// LP-OS Kiosk — the LifePreneur "Inventory Manager" (Samples / Bundles /
// Checkout station). Vanilla rebuild of data-pimp's deployed React SPA
// (static/app.bundle, formerly served at thirsty.store/kiosk): same routes,
// same /api/samples|bundles|transactions calls, same scan-intake and open-url
// wire protocol — no framework (LP-OS ships no React).
//
// main.ts serves this page for /kiosk AND /kiosk/*; routing is client-side
// over the history API, so the /kiosk/checkout?code= deep links baked into
// os.js routeScanToKiosk and the scan-relay ecosystem keep working unchanged.

const BASE = "/kiosk";

/* ---------------------------------------------------------------- escape -- */

const esc = (s) =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (
      c,
    ) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]),
  );

/* ------------------------------------------------------------ API client -- */

// Throw on non-OK so we SEE real errors (ported from the bundle verbatim).
async function fetchJson(input, init) {
  const res = await fetch(input, init);
  if (!res.ok) {
    let text = "";
    try {
      text = await res.text();
    } catch {
      // unreadable body: report status alone
    }
    throw new Error(
      `${res.status} ${res.statusText}${text ? ` : ${text}` : ""}`,
    );
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  return res.json();
}

function listUrl(path, filters, orderBy, limit) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(filters || {})) {
    url.searchParams.set(key, String(value));
  }
  if (orderBy) url.searchParams.set("order_by", orderBy);
  if (limit) url.searchParams.set("limit", String(limit));
  return url;
}

// Same call shapes as the bundle's api.entities.{Sample,Bundle,
// InventoryTransaction} — Bundle.filter deliberately takes no order/limit
// (the server preserves that data-pimp quirk too).
const api = {
  samples: {
    list: async (orderBy) =>
      (await fetchJson(listUrl("/api/samples", null, orderBy))) || [],
    filter: async (filters, orderBy, limit) =>
      (await fetchJson(listUrl("/api/samples", filters, orderBy, limit))) ||
      [],
    create: (data) =>
      fetchJson("/api/samples", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    update: (id, data) =>
      fetchJson(`/api/samples/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    remove: async (id) => {
      await fetchJson(`/api/samples/${id}`, { method: "DELETE" });
    },
  },
  bundles: {
    list: async (orderBy) =>
      (await fetchJson(listUrl("/api/bundles", null, orderBy))) || [],
    filter: async (filters) =>
      (await fetchJson(listUrl("/api/bundles", filters))) || [],
    create: (data) =>
      fetchJson("/api/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    update: (id, data) =>
      fetchJson(`/api/bundles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    remove: async (id) => {
      await fetchJson(`/api/bundles/${id}`, { method: "DELETE" });
    },
  },
  transactions: {
    filter: async (filters, orderBy, limit) =>
      (await fetchJson(
        listUrl("/api/transactions", filters, orderBy, limit),
      )) || [],
  },
};

/* ------------------------------------------------------------ formatting -- */

const STATUS_LABELS = {
  available: "Available",
  checked_out: "Checked Out",
  reserved: "Reserved",
  cleared_to_sell: "Cleared to Sell",
  discontinued: "Discontinued",
};

function money(price) {
  if (price === null || price === undefined || price === "") return "—";
  return `$${Number(price).toFixed(2)}`;
}

function shortDate(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function longDate(dateStr) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// fire_sale is a TEXT column upstream, so a row can carry the string "false";
// the bundle's bare truthiness test mis-rendered that case — normalize here.
function isFireSale(sample) {
  const v = sample && sample.fire_sale;
  return v === true || v === "true" || v === "t" || v === "1";
}

function hasLowestPrice(item) {
  if (!item) return false;
  if (item.current_price === null || item.current_price === undefined) {
    return false;
  }
  if (item.best_price === null || item.best_price === undefined) return false;
  return Number(item.current_price) < Number(item.best_price);
}

/* ----------------------------------------------------------------- icons -- */

// Inline lucide glyphs (the bundle pulled lucide-react from esm.sh).
const ICON_PATHS = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  flame:
    '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  trendingDown:
    '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
  sprout:
    '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
  copy:
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  edit:
    '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  mapPin:
    '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  calendar:
    '<rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
  user:
    '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  externalLink:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  cart:
    '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  alertTriangle:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  package:
    '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  qr:
    '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
};

function icon(name, size = 16, cls = "") {
  return `<svg class="ic${
    cls ? ` ${cls}` : ""
  }" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    ICON_PATHS[name] || ""
  }</svg>`;
}

/* --------------------------------------------------------- shared pieces -- */

function spinnerHtml(size = 32) {
  return `<div class="center-py">${icon("loader", size, "spinner")}</div>`;
}

function apiErrorHtml(error) {
  const msg = (error && error.message) || String(error || "");
  return `
    <div class="api-error-wrap">
      <div class="api-error">
        <strong>API Error</strong>
        <pre>${esc(msg)}</pre>
      </div>
    </div>`;
}

function statusBadgeHtml(status) {
  const key = STATUS_LABELS[status] ? status : "available";
  return `<span class="badge badge-${key}">${esc(STATUS_LABELS[key])}</span>`;
}

function fireSaleBadgeHtml() {
  return `<span class="badge badge-fire">${icon("flame", 12)}Fire Sale</span>`;
}

// The shine span is always present; the .celebrating class animates it.
function lowestPriceBadgeHtml() {
  return `<span class="badge badge-lowest">${
    icon("trendingDown", 12)
  }Lowest Price Online<span class="badge-shine"></span></span>`;
}

function priceDisplayHtml(sample) {
  return `
    <div class="price-display">
      <div class="price-row">
        <div>
          <span class="price-label">Current: </span>
          <span class="price-value">${esc(money(sample.current_price))}</span>
        </div>
        ${
    sample.best_price
      ? `<div>
          <span class="price-label">Best: </span>
          <span class="price-best">${esc(money(sample.best_price))}</span>
        </div>`
      : ""
  }
      </div>
      ${
    sample.best_price_source
      ? `<a class="price-source" href="${
        esc(sample.best_price_source)
      }" target="_blank" rel="noopener noreferrer">View source ${
        icon("externalLink", 12)
      }</a>`
      : ""
  }
      ${
    sample.last_price_checked_at
      ? `<p class="price-checked">Last checked: ${
        esc(shortDate(sample.last_price_checked_at))
      }</p>`
      : ""
  }
    </div>`;
}

function affiliateLinkHtml(sample, extraClass = "") {
  if (!sample.tiktok_affiliate_link) return "";
  return `<div class="${extraClass}"><a class="affiliate-btn" href="${
    esc(sample.tiktok_affiliate_link)
  }" target="_blank" rel="noopener noreferrer">TikTok Affiliate Link ${
    icon("externalLink", 16)
  }</a></div>`;
}

// QRCodeDisplay: monospace chip + copy-to-clipboard with a 2s check (despite
// the name it renders no QR image — parity with the bundle).
function qrDisplayHtml(code) {
  if (!code) return "";
  return `
    <div class="qr-display">
      <div class="qr-chip">${icon("qr", 16)}<span>${esc(code)}</span></div>
      <button class="btn btn-ghost copy-btn" type="button" data-copy="${
    esc(code)
  }" title="Copy">${icon("copy", 16)}</button>
    </div>`;
}

function wireCopyButtons(scope) {
  for (const btn of scope.querySelectorAll("button[data-copy]")) {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy || "");
      } catch {
        return; // clipboard unavailable (permissions/insecure ctx): no-op
      }
      btn.innerHTML = icon("check", 16, "copied");
      setTimeout(() => {
        btn.innerHTML = icon("copy", 16);
      }, 2000);
    });
  }
}

/* ---------------------------------------------------------- product image -- */

// Neutral placeholder (inline SVG) shown only when no image can be resolved.
const PRODUCT_PLACEHOLDER = "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'>" +
      "<rect width='400' height='400' fill='#f1f5f9'/>" +
      "<g fill='none' stroke='#cbd5e1' stroke-width='14' stroke-linecap='round' stroke-linejoin='round'>" +
      "<path d='M200 92 L300 148 V252 L200 308 L100 252 V148 Z'/>" +
      "<path d='M100 148 L200 204 L300 148'/><path d='M200 204 V308'/>" +
      "</g></svg>",
  );

// Older "price-only" rows have no picture_url; /api/samples/:id/image resolves
// one via ScrapeCreators and backfills Postgres. Cache lookups per page load
// so a grid full of legacy rows asks once per sample, not once per render.
const imageLookups = new Map();

function lookupSampleImage(id) {
  const key = String(id);
  let pending = imageLookups.get(key);
  if (!pending) {
    pending = fetchJson(`/api/samples/${encodeURIComponent(key)}/image`)
      .then((res) => (res && res.picture_url ? String(res.picture_url) : ""))
      .catch(() => "");
    imageLookups.set(key, pending);
  }
  return pending;
}

function productImageHtml(sample, cls) {
  const src = sample && sample.picture_url ? String(sample.picture_url) : "";
  const needsResolve = !src && sample && sample.id != null;
  return `<img class="${cls}" loading="lazy" alt="${
    esc((sample && sample.name) || "")
  }" src="${esc(src || PRODUCT_PLACEHOLDER)}" data-img-fallback${
    needsResolve ? ` data-img-resolve="${esc(String(sample.id))}"` : ""
  }>`;
}

function hydrateProductImages(scope) {
  for (const img of scope.querySelectorAll("img[data-img-resolve]")) {
    const id = img.getAttribute("data-img-resolve") || "";
    lookupSampleImage(id).then((url) => {
      if (url && img.isConnected) img.src = url;
    });
  }
}

// Broken picture_urls fall back to the placeholder ("error" doesn't bubble,
// so listen in capture phase once for every product image).
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (
      img instanceof HTMLImageElement &&
      img.hasAttribute("data-img-fallback") &&
      img.src !== PRODUCT_PLACEHOLDER
    ) {
      img.src = PRODUCT_PLACEHOLDER;
    }
  },
  true,
);

/* --------------------------------------------------------- confirm dialog -- */

// Replaces the bundle's AlertDialog stack: resolves true on confirm, false on
// cancel/backdrop.
function confirmDialog({ title, description, confirmLabel = "Delete" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
      <div class="dialog-backdrop"></div>
      <div class="dialog-panel" role="alertdialog" aria-modal="true">
        <h2>${esc(title)}</h2>
        <p class="desc">${esc(description)}</p>
        <div class="dialog-footer">
          <button class="btn btn-outline" type="button" data-act="cancel">Cancel</button>
          <button class="btn btn-destructive" type="button" data-act="confirm">${
      esc(confirmLabel)
    }</button>
        </div>
      </div>`;
    const done = (result) => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector(".dialog-backdrop").addEventListener(
      "click",
      () => done(false),
    );
    overlay.querySelector('[data-act="cancel"]').addEventListener(
      "click",
      () => done(false),
    );
    overlay.querySelector('[data-act="confirm"]').addEventListener(
      "click",
      () => done(true),
    );
    document.body.appendChild(overlay);
  });
}

/* ------------------------------------------------------ status multiselect -- */

const FILTER_OPTIONS = [
  { value: "available", label: STATUS_LABELS.available },
  { value: "checked_out", label: STATUS_LABELS.checked_out },
  { value: "reserved", label: STATUS_LABELS.reserved },
  { value: "cleared_to_sell", label: STATUS_LABELS.cleared_to_sell },
  { value: "discontinued", label: STATUS_LABELS.discontinued },
  { value: "fire_sale", label: "Fire Sale" },
  { value: "lowest_price", label: "Lowest Price Online" },
];

function msOptionIcon(value) {
  if (value === "fire_sale") return icon("flame", 12);
  if (value === "lowest_price") return icon("trendingDown", 12);
  if (value === "cleared_to_sell") return icon("sprout", 12);
  return "";
}

// StatusMultiSelect: trigger shows selected pills (each with an ✕), a
// clear-all ✕ and a chevron; the dropdown lists checkbox rows. `selected` is
// mutated in place; onChange re-renders the caller's grid.
function mountStatusFilter(slot, selected, onChange) {
  const el = document.createElement("div");
  el.className = "multiselect";
  slot.appendChild(el);

  const renderTrigger = () => {
    const pills = selected.length === 0
      ? '<span class="ms-placeholder">Filter by status...</span>'
      : selected
        .map((v) => {
          const opt = FILTER_OPTIONS.find((o) => o.value === v);
          return `<span class="ms-pill ms-pill-${esc(v)}">${msOptionIcon(v)}${
            esc((opt && opt.label) || v)
          }<span class="ms-x" data-ms-remove="${esc(v)}">${
            icon("x", 12)
          }</span></span>`;
        })
        .join("");
    const options = FILTER_OPTIONS.map((opt) => {
      const isSel = selected.includes(opt.value);
      return `<div class="ms-option ms-option-${esc(opt.value)}${
        isSel ? " selected" : ""
      }" data-ms-option="${esc(opt.value)}"><span class="ms-check">${
        icon("check", 12)
      }</span>${msOptionIcon(opt.value)}<span>${esc(opt.label)}</span></div>`;
    }).join("");
    el.innerHTML = `
      <button class="ms-trigger" type="button" data-ms-trigger>
        <span class="ms-pills">${pills}</span>
        <span class="ms-controls">${
      selected.length > 0
        ? `<span class="ms-clear" data-ms-clear>${icon("x", 16)}</span>`
        : ""
    }<span class="ms-chevron">${icon("chevronDown", 16)}</span></span>
      </button>
      <div class="ms-dropdown">${options}</div>`;
  };

  el.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const remove = target.closest("[data-ms-remove]");
    if (remove) {
      e.stopPropagation();
      const v = remove.getAttribute("data-ms-remove");
      selected.splice(selected.indexOf(v), 1);
      renderTrigger();
      el.classList.remove("open");
      onChange();
      return;
    }
    if (target.closest("[data-ms-clear]")) {
      e.stopPropagation();
      selected.length = 0;
      renderTrigger();
      el.classList.remove("open");
      onChange();
      return;
    }
    const option = target.closest("[data-ms-option]");
    if (option) {
      const v = option.getAttribute("data-ms-option") || "";
      const at = selected.indexOf(v);
      if (at >= 0) selected.splice(at, 1);
      else selected.push(v);
      const wasOpen = el.classList.contains("open");
      renderTrigger();
      el.classList.toggle("open", wasOpen); // stay open while multi-picking
      onChange();
      return;
    }
    if (target.closest("[data-ms-trigger]")) el.classList.toggle("open");
  });

  renderTrigger();
}

// One global closer for any open multiselect (views come and go; a per-mount
// document listener would leak across renders).
document.addEventListener("mousedown", (e) => {
  for (const ms of document.querySelectorAll(".multiselect.open")) {
    if (e.target instanceof Node && !ms.contains(e.target)) {
      ms.classList.remove("open");
    }
  }
});

/* ----------------------------------------------------------------- router -- */

let renderSeq = 0;

function routeName() {
  let path = location.pathname.toLowerCase();
  // Strip the basename only on a real segment boundary ("/kiosk.html" must
  // not become ".html").
  if (path === BASE || path === `${BASE}/`) return "samples";
  if (path.startsWith(`${BASE}/`)) path = path.slice(BASE.length + 1);
  else path = path.replace(/^\/+/, ""); // served off-base (defensive)
  path = path.replace(/\/+$/, "");
  return path || "samples"; // "/" and "/samples" are both the samples grid
}

function navigate(href) {
  history.pushState({}, "", href);
  render();
}

async function render() {
  const seq = ++renderSeq;
  clearCelebration();
  const name = routeName();
  if (name !== "checkout") checkoutCart.length = 0; // cart is Checkout-local
  const root = document.getElementById("root");
  if (!root) return;
  const view = ROUTES[name];
  if (!view) {
    root.innerHTML = placeholderHtml("Page Not Found");
    return;
  }
  try {
    await view(root, seq);
  } catch (error) {
    if (seq === renderSeq) root.innerHTML = apiErrorHtml(error);
  }
}

function placeholderHtml(title) {
  return `
    <div class="container-4xl page-body">
      <div class="card placeholder-card">
        <h1>${esc(title)}</h1>
        <p class="muted">This page is under construction.</p>
      </div>
    </div>`;
}

// Internal /kiosk/* links route client-side; everything else falls through
// (external links are the open-url hook's business when embedded).
document.addEventListener("click", (e) => {
  if (
    e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey ||
    e.shiftKey || e.altKey
  ) {
    return;
  }
  const anchor = e.target instanceof Element
    ? e.target.closest("a[href]")
    : null;
  if (!anchor || anchor.target === "_blank") return;
  const href = anchor.getAttribute("href") || "";
  if (!href.startsWith(BASE)) return;
  e.preventDefault();
  navigate(href);
});

addEventListener("popstate", render);

/* ------------------------------------------------------------ samples page -- */

async function renderSamplesPage(root, seq) {
  const state = { search: "", filters: [] };

  root.innerHTML = `
    <div class="page-head page-head-sticky">
      <div class="container-7xl page-head-row">
        <div>
          <h1 class="page-title">Samples</h1>
          <p class="page-sub" id="samples-count">Loading…</p>
        </div>
        <a class="btn btn-primary" href="${BASE}/samplecreate">${
    icon("plus", 16)
  }New Sample</a>
      </div>
    </div>
    <div class="container-7xl page-body">
      <div class="card filter-bar">
        <div class="filter-row">
          <div class="search-wrap">
            ${icon("search", 16)}
            <input id="samples-search" class="input" placeholder="Search...">
          </div>
          <div id="samples-filter"></div>
        </div>
      </div>
      <div id="samples-grid">${spinnerHtml()}</div>
    </div>`;

  let samples = [];
  const grid = root.querySelector("#samples-grid");
  const countEl = root.querySelector("#samples-count");

  const applyFilters = () => {
    const q = state.search.toLowerCase();
    return samples.filter((sample) => {
      const matchesSearch = !q ||
        (sample.name || "").toLowerCase().includes(q) ||
        (sample.brand || "").toLowerCase().includes(q) ||
        (sample.qr_code || "").toLowerCase().includes(q);

      // Badge pseudo-filters OR together when no status is picked; otherwise
      // statuses and badges AND (exact port of the bundle's logic).
      let matchesStatusFilter = true;
      if (state.filters.length > 0) {
        const statusValues = state.filters.filter(
          (f) => !["fire_sale", "lowest_price"].includes(f),
        );
        const hasBadgeFilters = state.filters.includes("fire_sale") ||
          state.filters.includes("lowest_price");

        const matchesStatus = statusValues.length === 0 ||
          statusValues.includes(sample.status || "");
        const matchesFire = !state.filters.includes("fire_sale") ||
          isFireSale(sample);
        const matchesLowest = !state.filters.includes("lowest_price") ||
          hasLowestPrice(sample);

        if (statusValues.length === 0 && hasBadgeFilters) {
          matchesStatusFilter =
            (state.filters.includes("fire_sale") && isFireSale(sample)) ||
            (state.filters.includes("lowest_price") &&
              hasLowestPrice(sample));
        } else {
          matchesStatusFilter = matchesStatus && matchesFire && matchesLowest;
        }
      }

      return matchesSearch && matchesStatusFilter;
    });
  };

  const updateGrid = () => {
    const filtered = applyFilters();
    countEl.textContent = `${filtered.length} of ${samples.length} samples`;
    if (filtered.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          ${icon("filter", 48)}
          <p>No results found</p>
        </div>`;
      return;
    }
    grid.innerHTML = `<div class="samples-grid">${
      filtered
        .map(
          (sample) => `
        <a href="${BASE}/sampledetails?id=${esc(sample.id)}">
          <div class="card card-hover sample-card">
            <div class="sample-media">
              ${productImageHtml(sample, "")}
              <div class="badge-stack">
                ${statusBadgeHtml(sample.status || "available")}
                ${isFireSale(sample) ? fireSaleBadgeHtml() : ""}
                ${hasLowestPrice(sample) ? lowestPriceBadgeHtml() : ""}
              </div>
            </div>
            <div class="sample-body">
              <h3 class="truncate">${esc(sample.name)}</h3>
              <p class="brand">${esc(sample.brand)}</p>
              ${
            sample.current_price
              ? `<p class="price">${esc(money(sample.current_price))}</p>`
              : ""
          }
            </div>
          </div>
        </a>`,
        )
        .join("")
    }</div>`;
    hydrateProductImages(grid);
  };

  root.querySelector("#samples-search").addEventListener("input", (e) => {
    state.search = e.target.value;
    updateGrid();
  });
  mountStatusFilter(
    root.querySelector("#samples-filter"),
    state.filters,
    updateGrid,
  );

  try {
    samples = await api.samples.list("-created_date");
  } catch (error) {
    if (seq === renderSeq) root.innerHTML = apiErrorHtml(error);
    return;
  }
  if (seq !== renderSeq) return;
  updateGrid();
}

/* ---------------------------------------------------------- sample details -- */

function notFoundHtml(message, backHref) {
  return `
    <div class="center-screen">
      <div class="empty-state">
        ${icon("alertTriangle", 48, "warn")}
        <h2>${esc(message)}</h2>
        <a class="btn btn-outline" href="${backHref}">Back</a>
      </div>
    </div>`;
}

function txDotClass(action) {
  const a = String(action || "").replace(/_/g, "");
  if (a === "checkout") return "dot-warning";
  if (a === "checkin") return "dot-success";
  return "dot-accent";
}

async function renderSampleDetails(root, seq) {
  const id = new URLSearchParams(location.search).get("id");
  root.innerHTML = `<div class="center-screen">${spinnerHtml()}</div>`;

  let sample = null;
  if (id) {
    try {
      sample = (await api.samples.filter({ id }))[0] || null;
    } catch {
      sample = null;
    }
  }
  if (seq !== renderSeq) return;
  if (!sample) {
    root.innerHTML = notFoundHtml("Sample not found", `${BASE}/samples`);
    return;
  }

  // Secondary reads fail soft, like the bundle's ignored useQuery errors.
  const [bundleRows, transactions] = await Promise.all([
    sample.bundle_id
      ? api.bundles.filter({ id: sample.bundle_id }).catch(() => [])
      : Promise.resolve([]),
    api.transactions
      .filter({ sample_id: sample.id }, "-created_date", 10)
      .catch(() => []),
  ]);
  if (seq !== renderSeq) return;
  const bundle = bundleRows[0] || null;

  root.innerHTML = `
    <div class="page-head">
      <div class="container-5xl page-head-row">
        <a class="back-link" href="${BASE}/samples">${
    icon("arrowLeft", 16)
  }<span>Samples</span></a>
        <div class="head-actions">
          <a class="btn btn-outline btn-sm" href="${BASE}/sampleedit?id=${
    esc(sample.id)
  }">${icon("edit", 16)}Edit</a>
          <button class="btn btn-outline btn-sm btn-danger-text" type="button" id="delete-sample">${
    icon("trash", 16)
  }Delete</button>
        </div>
      </div>
    </div>
    <div class="container-5xl details-grid">
      <div class="details-main stack">
        <div class="card hero-card">
          <div class="hero-side">
            <div class="hero-media">
              ${productImageHtml(sample, "")}
              <div class="badge-stack">
                ${statusBadgeHtml(sample.status || "available")}
                ${isFireSale(sample) ? fireSaleBadgeHtml() : ""}
              </div>
            </div>
          </div>
          <div class="hero-body">
            <h1>${esc(sample.name)}</h1>
            <p class="brand">${esc(sample.brand)}</p>
            ${qrDisplayHtml(sample.qr_code)}
            <div class="hero-meta">
              ${
    sample.location
      ? `<div class="meta-item">${icon("mapPin", 16)}${
        esc(sample.location)
      }</div>`
      : ""
  }
              ${
    bundle
      ? `<a class="meta-link" href="${BASE}/bundledetails?id=${
        esc(bundle.id)
      }">${icon("package", 16)}${esc(bundle.name)}</a>`
      : ""
  }
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h3 class="card-title">Pricing</h3></div>
          <div class="card-content">
            ${priceDisplayHtml(sample)}
            ${affiliateLinkHtml(sample, "mt-4")}
          </div>
        </div>
        ${
    sample.notes
      ? `<div class="card">
          <div class="card-header"><h3 class="card-title">Notes</h3></div>
          <div class="card-content"><p class="notes-text">${
        esc(sample.notes)
      }</p></div>
        </div>`
      : ""
  }
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-header"><h3 class="card-title">Checkout Status</h3></div>
          <div class="card-content status-rows">
            ${
    sample.checked_out_to
      ? `<div class="status-row">${icon("user", 16)}<div>
            <p class="k">Checked out to</p><p class="v">${
        esc(sample.checked_out_to)
      }</p></div></div>`
      : ""
  }
            ${
    sample.checked_out_at
      ? `<div class="status-row">${icon("calendar", 16)}<div>
            <p class="k">Checked out at</p><p class="v">${
        esc(longDate(sample.checked_out_at))
      }</p></div></div>`
      : ""
  }
            ${
    sample.checked_in_at
      ? `<div class="status-row">${icon("calendar", 16)}<div>
            <p class="k">Checked in at</p><p class="v">${
        esc(longDate(sample.checked_in_at))
      }</p></div></div>`
      : ""
  }
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h3 class="card-title">Recent Activity</h3></div>
          <div class="card-content">
            ${
    transactions.length === 0
      ? '<p class="activity-empty">No activity yet</p>'
      : `<div class="activity-list">${
        transactions
          .map(
            (tx) => `
            <div class="activity-row">
              <div class="activity-dot ${txDotClass(tx.action)}"></div>
              <div>
                <p class="action">${
              // lp-os action vocab uses underscores (check_out); show words.
              esc(String(tx.action || "").replace(/_/g, " "))}</p>
                <p class="when">${
              esc(longDate(tx.created_date || tx.created_at))
            }${tx.operator ? ` by ${esc(tx.operator)}` : ""}</p>
              </div>
            </div>`,
          )
          .join("")
      }</div>`
  }
          </div>
        </div>
      </div>
    </div>`;

  hydrateProductImages(root);
  wireCopyButtons(root);
  root.querySelector("#delete-sample").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Delete Sample",
      description: "Are you sure?",
    });
    if (!ok) return;
    await api.samples.remove(sample.id);
    navigate(`${BASE}/samples`);
  });
}

/* ------------------------------------------------------------ sample form -- */

function fieldHtml(id, label, value, opts = {}) {
  const required = opts.required ? " *" : "";
  return `
    <div class="form-field${opts.span2 ? " span-2" : ""}">
      <label class="label" for="${id}">${esc(label)}${required}</label>
      <input class="input" id="${id}" value="${esc(value || "")}"${
    opts.type ? ` type="${opts.type}" step="0.01" min="0"` : ""
  }${opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : ""}>
      <p class="field-error hidden" data-error-for="${id}">Required</p>
    </div>`;
}

function sampleFormHtml(sample, bundles) {
  const s = sample || {};
  const statusOptions = Object.entries(STATUS_LABELS)
    .map(
      ([value, label]) =>
        `<option value="${value}"${
          (s.status || "available") === value ? " selected" : ""
        }>${esc(label)}</option>`,
    )
    .join("");
  const bundleOptions = ['<option value="">No Bundle</option>']
    .concat(
      bundles.map(
        (b) =>
          `<option value="${esc(b.id)}"${
            String(s.bundle_id ?? "") === String(b.id) ? " selected" : ""
          }>${esc(b.name)}</option>`,
      ),
    )
    .join("");
  return `
    <form class="form-stack" id="sample-form" novalidate>
      <div class="card">
        <div class="card-header"><h3 class="card-title-sm">Basic Information</h3></div>
        <div class="card-content form-grid">
          ${fieldHtml("f-name", "Name", s.name, { required: true })}
          ${fieldHtml("f-brand", "Brand", s.brand, { required: true })}
          ${
    fieldHtml("f-qr", "QR Code", s.qr_code, {
      required: true,
      placeholder: "Enter unique code",
    })
  }
          ${
    fieldHtml("f-location", "Location", s.location, {
      placeholder: "e.g., Shelf A-12",
    })
  }
          <div class="form-field">
            <label class="label" for="f-status">Status</label>
            <select class="select" id="f-status">${statusOptions}</select>
          </div>
          <div class="form-field">
            <label class="label" for="f-bundle">Bundle</label>
            <select class="select" id="f-bundle">${bundleOptions}</select>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3 class="card-title-sm">Image</h3></div>
        <div class="card-content form-fields">
          ${
    fieldHtml("f-picture", "Image URL", s.picture_url, {
      placeholder: "https://...",
    })
  }
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3 class="card-title-sm">Pricing</h3></div>
        <div class="card-content form-grid">
          ${
    fieldHtml("f-current-price", "Current Price", s.current_price, {
      type: "number",
      placeholder: "0.00",
    })
  }
          ${
    fieldHtml("f-best-price", "Best Price", s.best_price, {
      type: "number",
      placeholder: "0.00",
    })
  }
          ${
    fieldHtml("f-best-source", "Best Price Source", s.best_price_source, {
      span2: true,
      placeholder: "https://...",
    })
  }
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3 class="card-title-sm">Additional Details</h3></div>
        <div class="card-content form-fields">
          ${
    fieldHtml("f-tiktok", "TikTok Affiliate Link", s.tiktok_affiliate_link, {
      placeholder: "https://tiktok.com/...",
    })
  }
          <div class="fire-sale-row">
            <div>
              <label class="label" for="f-fire-sale">Fire Sale</label>
              <p>Mark this item for fire sale pricing</p>
            </div>
            <button class="switch" type="button" role="switch" id="f-fire-sale"
              aria-checked="${isFireSale(s) ? "true" : "false"}">
              <span class="switch-thumb"></span>
            </button>
          </div>
          <div class="form-field">
            <label class="label" for="f-notes">Notes</label>
            <textarea class="textarea" id="f-notes" rows="3"
              placeholder="Additional notes...">${esc(s.notes || "")}</textarea>
          </div>
        </div>
      </div>
      <div id="form-error"></div>
      <div class="form-actions">
        <button class="btn btn-outline" type="button" data-form-cancel>Cancel</button>
        <button class="btn btn-primary" type="submit" data-form-save>Save</button>
      </div>
    </form>`;
}

function wireSampleForm(scope, { onSave, onCancel }) {
  const form = scope.querySelector("#sample-form");
  const val = (id) => scope.querySelector(`#${id}`).value;
  const fireSwitch = scope.querySelector("#f-fire-sale");
  fireSwitch.addEventListener("click", () => {
    const next = fireSwitch.getAttribute("aria-checked") !== "true";
    fireSwitch.setAttribute("aria-checked", String(next));
  });
  scope.querySelector("[data-form-cancel]").addEventListener(
    "click",
    onCancel,
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Required-field validation matches the bundle: name/brand/qr_code.
    let valid = true;
    for (const id of ["f-name", "f-brand", "f-qr"]) {
      const input = scope.querySelector(`#${id}`);
      const err = scope.querySelector(`[data-error-for="${id}"]`);
      const bad = !input.value.trim();
      input.classList.toggle("input-error", bad);
      err.classList.toggle("hidden", !bad);
      if (bad) valid = false;
    }
    if (!valid) return;

    // Same coercions as the bundle: prices → Number|null, bundle "" → null.
    const data = {
      name: val("f-name"),
      brand: val("f-brand"),
      qr_code: val("f-qr"),
      location: val("f-location"),
      status: val("f-status"),
      bundle_id: val("f-bundle") || null,
      picture_url: val("f-picture"),
      tiktok_affiliate_link: val("f-tiktok"),
      fire_sale: fireSwitch.getAttribute("aria-checked") === "true",
      current_price: val("f-current-price")
        ? Number(val("f-current-price"))
        : null,
      best_price: val("f-best-price") ? Number(val("f-best-price")) : null,
      best_price_source: val("f-best-source"),
      notes: val("f-notes"),
    };

    const save = scope.querySelector("[data-form-save]");
    const cancel = scope.querySelector("[data-form-cancel]");
    save.disabled = cancel.disabled = true;
    save.innerHTML = `${icon("loader", 16, "spinner")}Save`;
    try {
      await onSave(data);
    } catch (error) {
      // The bundle swallowed mutation errors; surface them instead.
      scope.querySelector("#form-error").innerHTML = apiErrorHtml(error);
      save.disabled = cancel.disabled = false;
      save.textContent = "Save";
    }
  });
}

function formPageHtml(backHref, backLabel, title, formHtml) {
  return `
    <div class="page-head">
      <div class="container-3xl form-head">
        <a class="back-link" href="${backHref}">${icon("arrowLeft", 16)}<span>${
    esc(backLabel)
  }</span></a>
        <h1 class="page-title">${esc(title)}</h1>
      </div>
    </div>
    <div class="container-3xl page-body">${formHtml}</div>`;
}

async function renderSampleCreate(root, seq) {
  root.innerHTML = `<div class="center-screen">${spinnerHtml()}</div>`;
  const bundles = await api.bundles.list().catch(() => []);
  if (seq !== renderSeq) return;
  root.innerHTML = formPageHtml(
    `${BASE}/samples`,
    "Samples",
    "New Sample",
    sampleFormHtml(null, bundles),
  );
  wireSampleForm(root, {
    onSave: async (data) => {
      const created = await api.samples.create(data);
      navigate(`${BASE}/sampledetails?id=${created.id}`);
    },
    onCancel: () => navigate(`${BASE}/samples`),
  });
}

async function renderSampleEdit(root, seq) {
  const id = new URLSearchParams(location.search).get("id");
  root.innerHTML = `<div class="center-screen">${spinnerHtml()}</div>`;
  let sample = null;
  if (id) {
    try {
      sample = (await api.samples.filter({ id }))[0] || null;
    } catch {
      sample = null;
    }
  }
  const bundles = await api.bundles.list().catch(() => []);
  if (seq !== renderSeq) return;
  if (!sample) {
    root.innerHTML = notFoundHtml("Sample not found", `${BASE}/samples`);
    return;
  }
  const detailsHref = `${BASE}/sampledetails?id=${esc(id)}`;
  root.innerHTML = formPageHtml(
    detailsHref,
    "Back to Sample",
    "Edit Sample",
    sampleFormHtml(sample, bundles),
  );
  wireSampleForm(root, {
    onSave: async (data) => {
      await api.samples.update(id, data);
      navigate(detailsHref);
    },
    onCancel: () => navigate(detailsHref),
  });
}

/* ------------------------------------------------------------ bundles page -- */

async function renderBundlesPage(root, seq) {
  root.innerHTML = `
    <div class="page-head">
      <div class="container-7xl page-head-row">
        <h1 class="page-title">Bundles</h1>
        <a class="btn btn-primary" href="${BASE}/bundlecreate">${
    icon("plus", 16)
  }New Bundle</a>
      </div>
    </div>
    <div class="container-7xl page-body">
      <div class="card filter-bar">
        <div class="search-wrap search-wrap-md">
          ${icon("search", 16)}
          <input id="bundles-search" class="input" placeholder="Search bundles...">
        </div>
      </div>
      <div id="bundles-grid">${spinnerHtml()}</div>
    </div>`;

  let bundles = [];
  const grid = root.querySelector("#bundles-grid");
  let search = "";

  const updateGrid = () => {
    const filtered = bundles.filter(
      (b) => !search || (b.name || "").toLowerCase().includes(search),
    );
    grid.innerHTML = `<div class="bundles-grid">${
      filtered
        .map(
          (bundle) => `
      <a href="${BASE}/bundledetails?id=${esc(bundle.id)}">
        <div class="card card-hover bundle-card">
          <div class="bundle-card-head">
            <div class="bundle-icon">${icon("package", 24)}</div>
            <div>
              <h3>${esc(bundle.name)}</h3>
              ${
            bundle.location
              ? `<p class="location">${esc(bundle.location)}</p>`
              : ""
          }
            </div>
          </div>
          <code class="code-chip">${esc(bundle.qr_code)}</code>
        </div>
      </a>`,
        )
        .join("")
    }</div>`;
  };

  root.querySelector("#bundles-search").addEventListener("input", (e) => {
    search = e.target.value.toLowerCase();
    updateGrid();
  });

  try {
    bundles = await api.bundles.list("-created_date");
  } catch (error) {
    if (seq === renderSeq) root.innerHTML = apiErrorHtml(error);
    return;
  }
  if (seq !== renderSeq) return;
  updateGrid();
}

/* ---------------------------------------------------------- bundle details -- */

async function renderBundleDetails(root, seq) {
  const id = new URLSearchParams(location.search).get("id");
  root.innerHTML = `<div class="center-screen">${spinnerHtml()}</div>`;

  let bundle = null;
  if (id) {
    try {
      bundle = (await api.bundles.filter({ id }))[0] || null;
    } catch {
      bundle = null;
    }
  }
  if (seq !== renderSeq) return;
  if (!bundle) {
    root.innerHTML = notFoundHtml("Bundle not found", `${BASE}/bundles`);
    return;
  }

  const [bundleSamples, allSamples] = await Promise.all([
    api.samples.filter({ bundle_id: id }).catch(() => []),
    api.samples.list().catch(() => []),
  ]);
  if (seq !== renderSeq) return;
  const availableSamples = allSamples.filter((s) => !s.bundle_id);

  root.innerHTML = `
    <div class="page-head">
      <div class="container-5xl page-head-row">
        <a class="back-link" href="${BASE}/bundles">${
    icon("arrowLeft", 16)
  }<span>Bundles</span></a>
        <div class="head-actions">
          <a class="btn btn-outline btn-sm" href="${BASE}/bundleedit?id=${
    esc(bundle.id)
  }">${icon("edit", 16)}Edit</a>
          <button class="btn btn-outline btn-sm btn-danger-text" type="button" id="delete-bundle">${
    icon("trash", 16)
  }Delete</button>
        </div>
      </div>
    </div>
    <div class="container-5xl page-body stack">
      <div class="card card-pad">
        <div class="bundle-info-row">
          <div class="bundle-icon bundle-icon-lg">${icon("package", 40)}</div>
          <div class="bundle-info-main">
            <h1>${esc(bundle.name)}</h1>
            <div class="bundle-info-meta">
              ${
    bundle.location
      ? `<div class="meta-item">${icon("mapPin", 16)}${
        esc(bundle.location)
      }</div>`
      : ""
  }
              <span>${bundleSamples.length} ${
    bundleSamples.length === 1 ? "sample" : "samples"
  }</span>
            </div>
            ${qrDisplayHtml(bundle.qr_code)}
            ${
    bundle.notes ? `<p class="bundle-notes">${esc(bundle.notes)}</p>` : ""
  }
          </div>
        </div>
      </div>
      <div class="card">
        <div class="bundle-manage-head">
          <h3 class="card-title">Samples in Bundle</h3>
          <div class="bundle-add">
            <select class="select" id="add-sample-select">
              <option value="">Select sample to add</option>
              ${
    availableSamples
      .map(
        (s) =>
          `<option value="${esc(s.id)}">${esc(s.name)} (${
            esc(s.brand)
          })</option>`,
      )
      .join("")
  }
            </select>
            <button class="btn btn-primary btn-sm" type="button" id="add-sample" disabled>${
    icon("plus", 16)
  }Add Sample</button>
          </div>
        </div>
        <div class="card-content">
          ${
    bundleSamples.length === 0
      ? `<div class="empty-state">
          ${icon("package", 48)}
          <p>No samples in this bundle</p>
          <p class="page-sub">Add samples using the dropdown above</p>
        </div>`
      : `<div class="member-list">${
        bundleSamples
          .map(
            (sample) => `
          <div class="member-row">
            <a href="${BASE}/sampledetails?id=${esc(sample.id)}">
              <div class="card card-hover member-card">
                <div class="member-card-inner">
                  <div class="who">
                    <h4 class="truncate">${esc(sample.name)}</h4>
                    <p class="brand">${esc(sample.brand)}</p>
                  </div>
                  ${statusBadgeHtml(sample.status || "available")}
                </div>
              </div>
            </a>
            <button class="btn btn-ghost btn-icon member-remove" type="button"
              data-remove-sample="${
              esc(sample.id)
            }" title="Remove from bundle">${icon("x", 16)}</button>
          </div>`,
          )
          .join("")
      }</div>`
  }
        </div>
      </div>
    </div>`;

  wireCopyButtons(root);

  const select = root.querySelector("#add-sample-select");
  const addBtn = root.querySelector("#add-sample");
  select.addEventListener("change", () => {
    addBtn.disabled = !select.value;
  });
  addBtn.addEventListener("click", async () => {
    if (!select.value) return;
    addBtn.disabled = true;
    // Adding also moves the sample to the bundle's location (bundle parity).
    await api.samples.update(select.value, {
      bundle_id: bundle.id,
      location: bundle.location,
    });
    render(); // refetch, like the bundle's query invalidation
  });

  for (const btn of root.querySelectorAll("button[data-remove-sample]")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await api.samples.update(btn.dataset.removeSample, { bundle_id: null });
      render();
    });
  }

  root.querySelector("#delete-bundle").addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Delete Bundle",
      description:
        "Are you sure you want to delete this bundle? This will remove all samples from this bundle but won't delete the samples themselves.",
    });
    if (!ok) return;
    await api.bundles.remove(bundle.id);
    navigate(`${BASE}/bundles`);
  });
}

/* ------------------------------------------------------------- bundle form -- */

function bundleFormHtml(bundle) {
  const b = bundle || {};
  return `
    <form class="form-stack" id="bundle-form" novalidate>
      <div class="card">
        <div class="card-header"><h3 class="card-title-sm">Bundle Information</h3></div>
        <div class="card-content form-grid">
          ${
    fieldHtml("f-name", "Bundle Name", b.name, {
      required: true,
      placeholder: "e.g., Summer Collection",
    })
  }
          ${
    fieldHtml("f-qr", "QR Code", b.qr_code, {
      required: true,
      placeholder: "Enter unique bundle code",
    })
  }
          ${
    fieldHtml("f-location", "Location", b.location, {
      placeholder: "e.g., Storage Room B",
    })
  }
          <div class="form-field span-2">
            <label class="label" for="f-notes">Notes</label>
            <textarea class="textarea" id="f-notes" rows="3"
              placeholder="Additional notes about this bundle...">${
    esc(b.notes || "")
  }</textarea>
          </div>
        </div>
      </div>
      <div id="form-error"></div>
      <div class="form-actions">
        <button class="btn btn-outline" type="button" data-form-cancel>Cancel</button>
        <button class="btn btn-primary" type="submit" data-form-save>Save</button>
      </div>
    </form>`;
}

function wireBundleForm(scope, { onSave, onCancel }) {
  const form = scope.querySelector("#bundle-form");
  scope.querySelector("[data-form-cancel]").addEventListener(
    "click",
    onCancel,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let valid = true;
    for (const id of ["f-name", "f-qr"]) {
      const input = scope.querySelector(`#${id}`);
      const err = scope.querySelector(`[data-error-for="${id}"]`);
      const bad = !input.value.trim();
      input.classList.toggle("input-error", bad);
      err.classList.toggle("hidden", !bad);
      if (bad) valid = false;
    }
    if (!valid) return;
    const data = {
      name: scope.querySelector("#f-name").value,
      qr_code: scope.querySelector("#f-qr").value,
      location: scope.querySelector("#f-location").value,
      notes: scope.querySelector("#f-notes").value,
    };
    const save = scope.querySelector("[data-form-save]");
    const cancel = scope.querySelector("[data-form-cancel]");
    save.disabled = cancel.disabled = true;
    save.innerHTML = `${icon("loader", 16, "spinner")}Save`;
    try {
      await onSave(data);
    } catch (error) {
      scope.querySelector("#form-error").innerHTML = apiErrorHtml(error);
      save.disabled = cancel.disabled = false;
      save.textContent = "Save";
    }
  });
}

function renderBundleCreate(root) {
  root.innerHTML = formPageHtml(
    `${BASE}/bundles`,
    "Bundles",
    "New Bundle",
    bundleFormHtml(null),
  );
  wireBundleForm(root, {
    onSave: async (data) => {
      const created = await api.bundles.create(data);
      navigate(`${BASE}/bundledetails?id=${created.id}`);
    },
    onCancel: () => navigate(`${BASE}/bundles`),
  });
}

async function renderBundleEdit(root, seq) {
  const id = new URLSearchParams(location.search).get("id");
  root.innerHTML = `<div class="center-screen">${spinnerHtml()}</div>`;
  let bundle = null;
  if (id) {
    try {
      bundle = (await api.bundles.filter({ id }))[0] || null;
    } catch {
      bundle = null;
    }
  }
  if (seq !== renderSeq) return;
  if (!bundle) {
    root.innerHTML = notFoundHtml("Bundle not found", `${BASE}/bundles`);
    return;
  }
  const detailsHref = `${BASE}/bundledetails?id=${esc(id)}`;
  root.innerHTML = formPageHtml(
    detailsHref,
    "Back to Bundle",
    "Edit Bundle",
    bundleFormHtml(bundle),
  );
  wireBundleForm(root, {
    onSave: async (data) => {
      await api.bundles.update(id, data);
      navigate(detailsHref);
    },
    onCancel: () => navigate(detailsHref),
  });
}

/* --------------------------------------------------------------- checkout -- */

// Local counter only: the deployed kiosk never wrote a transaction or showed
// a cart panel — "Add to Cart" appends to this array and bumps "(N)".
// Persists across ?code= rescans, resets when leaving Checkout (see render()).
const checkoutCart = [];

async function renderCheckoutPage(root, seq) {
  const params = new URLSearchParams(location.search);
  const isDebug = params.get("debug") === "true";

  root.innerHTML = `
    <div class="checkout-page">
      <div class="checkout-head">
        <div class="checkout-head-inner">
          <div class="checkout-icon">${icon("qr", 32)}</div>
          <h1>Checkout Station</h1>
          <p>Scan a QR code or barcode</p>
        </div>
      </div>
      <div class="checkout-body">
        <div id="checkout-error"></div>
        <div class="card lookup-card">
          <div class="lookup-row">
            <input id="checkout-code" class="input input-lg"
              placeholder="Scan or enter code...">
            <button class="btn btn-primary btn-lookup" type="button" id="checkout-lookup">Lookup</button>
          </div>
        </div>
        <div id="checkout-result"></div>
      </div>
    </div>`;

  const input = root.querySelector("#checkout-code");
  const errorEl = root.querySelector("#checkout-error");
  const resultEl = root.querySelector("#checkout-result");

  const showResult = (result) => {
    if (result.type === "not_found") {
      resultEl.innerHTML =
        `<div class="card result-card"><p class="result-notfound">Not Found</p></div>`;
      return;
    }
    if (result.type === "bundle") {
      resultEl.innerHTML = `
        <div class="card result-card">
          <h2 class="result-head-title page-title">${esc(result.data.name)}</h2>
          <p class="page-sub">Bundle scanned. Sample details are not available.</p>
        </div>`;
      return;
    }
    const sample = result.data;
    const showLowest = hasLowestPrice(sample);
    resultEl.innerHTML = `
      <div class="card result-card">
        <div class="result-flex">
          ${productImageHtml(sample, "result-img")}
          <div class="result-main">
            <div class="result-head">
              <div>
                <h2>${esc(sample.name)}</h2>
                <p class="brand">${esc(sample.brand)}</p>
              </div>
              <div class="result-badges">
                ${statusBadgeHtml(sample.status || "available")}
                ${isFireSale(sample) ? fireSaleBadgeHtml() : ""}
                ${showLowest ? lowestPriceBadgeHtml() : ""}
              </div>
            </div>
            <div class="mt-3">${priceDisplayHtml(sample)}</div>
            ${affiliateLinkHtml(sample, "mt-3")}
            ${
      isDebug
        ? `<p class="debug-line">has_fire_sale: <span class="${
          isFireSale(sample) ? "on" : "off"
        }">${isFireSale(sample) ? "true" : "false"}</span></p>`
        : ""
    }
            <button class="btn btn-accent btn-block mt-4" type="button" id="add-to-cart">
              ${icon("cart", 16)}Add to Cart<span class="cart-count${
      checkoutCart.length > 0 ? "" : " hidden"
    }" id="cart-count">(${checkoutCart.length})</span>
            </button>
          </div>
        </div>
      </div>`;
    hydrateProductImages(resultEl);
    resultEl.querySelector("#add-to-cart").addEventListener("click", () => {
      checkoutCart.push(sample);
      const count = resultEl.querySelector("#cart-count");
      count.textContent = `(${checkoutCart.length})`;
      count.classList.remove("hidden");
    });
    if (showLowest) {
      celebrate(resultEl.querySelector(".badge-lowest"));
    }
  };

  const doLookup = async (nextCode) => {
    errorEl.innerHTML = "";
    const scanCode = String(
      typeof nextCode === "string" ? nextCode : input.value,
    ).trim();
    if (!scanCode) return;
    try {
      const samples = await api.samples.filter({ qr_code: scanCode });
      if (seq !== renderSeq) return;
      if (samples.length > 0) {
        showResult({ type: "sample", data: samples[0] });
        return;
      }
      const bundles = await api.bundles.filter({ qr_code: scanCode });
      if (seq !== renderSeq) return;
      showResult(
        bundles.length > 0
          ? { type: "bundle", data: bundles[0] }
          : { type: "not_found" },
      );
    } catch (error) {
      if (seq === renderSeq) errorEl.innerHTML = apiErrorHtml(error);
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLookup();
  });
  root.querySelector("#checkout-lookup").addEventListener(
    "click",
    () => doLookup(),
  );

  // Auto-lookup from ?code=. Every location.search change re-renders this
  // view (scan intake appends &rescan=<nonce> for identical codes), so this
  // effectively re-fires per scan — parity with the bundle's search effect.
  const codeParam = params.get("code");
  if (codeParam && codeParam.trim()) {
    input.value = codeParam.trim();
    await doLookup(codeParam.trim());
  }
}

/* -------------------------------------------- lowest-price celebration -- */

// Timings ported from the bundle: 300ms render settle → 600ms badge bulge +
// shine → 60-particle confetti burst from the badge's screen position,
// cleaned up 3.5s later.
const celebrationTimers = [];

function clearCelebration() {
  for (const t of celebrationTimers) clearTimeout(t);
  celebrationTimers.length = 0;
  for (const el of document.querySelectorAll(".confetti-overlay")) el.remove();
}

function celebrate(badgeEl) {
  if (!badgeEl) return;
  celebrationTimers.push(
    setTimeout(() => {
      badgeEl.classList.add("celebrating");
      celebrationTimers.push(
        setTimeout(() => {
          badgeEl.classList.remove("celebrating");
          if (!badgeEl.isConnected) return;
          const rect = badgeEl.getBoundingClientRect();
          confettiBurst({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          });
        }, 600),
      );
    }, 300),
  );
}

function confettiBurst(origin) {
  const colors = [
    "#22c55e",
    "#10b981",
    "#14b8a6",
    "#06b6d4",
    "#3b82f6",
    "#6366f1",
    "#8b5cf6",
    "#fbbf24",
    "#f59e0b",
  ];
  const overlay = document.createElement("div");
  overlay.className = "confetti-overlay";
  const particleCount = 60;
  for (let i = 0; i < particleCount; i++) {
    const angle = (i / particleCount) * 360 + (Math.random() * 30 - 15);
    const velocity = 150 + Math.random() * 200;
    const radians = (angle * Math.PI) / 180;
    const size = 4 + Math.random() * 6;
    const isRect = Math.random() > 0.5;
    const p = document.createElement("div");
    p.className = "confetti-particle";
    p.style.left = `${origin.x}px`;
    p.style.top = `${origin.y}px`;
    p.style.width = `${isRect ? size * 1.5 : size}px`;
    p.style.height = `${isRect ? size * 0.6 : size}px`;
    p.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    p.style.borderRadius = isRect ? "1px" : "2px";
    p.style.animationDelay = `${Math.random() * 0.15}s`;
    p.style.animationDuration = `${1.5 + Math.random()}s`;
    p.style.setProperty("--tx", `${Math.cos(radians) * velocity}px`);
    p.style.setProperty("--ty", `${Math.sin(radians) * velocity}px`);
    p.style.setProperty("--rot", `${Math.random() * 1080 - 540}deg`);
    overlay.appendChild(p);
  }
  document.body.appendChild(overlay);
  celebrationTimers.push(setTimeout(() => overlay.remove(), 3500));
}

/* -------------------------------------------------------------- routes -- */

const ROUTES = {
  samples: renderSamplesPage,
  sampledetails: renderSampleDetails,
  samplecreate: renderSampleCreate,
  sampleedit: renderSampleEdit,
  bundles: renderBundlesPage,
  bundledetails: renderBundleDetails,
  bundlecreate: renderBundleCreate,
  bundleedit: renderBundleEdit,
  checkout: renderCheckoutPage,
};

/* ------------------------------------------------------------ scan intake -- */
// Ported from data-pimp static/scan-client.js. Two sources feed Checkout:
//   1. Embedded under the OS shell: same-origin postMessage
//      {source:"thirsty-os", type:"scan"} (os.js routeScanToKiosk).
//   2. Standalone kiosk tab: direct scan-relay WebSocket subscription.
// Either way a usable code lands on Checkout via ?code=, which the view
// auto-scans (and re-scans when location.search changes — the &rescan= nonce
// varies the URL for identical repeat scans). The "thirsty-os" source string
// is wire protocol shared with deployed apps — do NOT rebrand it.

const PRODUCT_ID_RE = /^\d{18,19}$/; // TikTok product ids
const BARCODE_RE = /^(\d{8}|\d{12,14})$/; // UPC-A/E, EAN-8/13, ITF-14

const embedded = globalThis.parent !== globalThis.self;
const seenScanIds = new Set();

function rememberScan(scanId) {
  if (!scanId) return true; // no id → cannot dedupe, accept
  if (seenScanIds.has(scanId)) return false;
  seenScanIds.add(scanId);
  if (seenScanIds.size > 500) {
    for (const id of seenScanIds) {
      seenScanIds.delete(id);
      if (seenScanIds.size <= 250) break;
    }
  }
  return true;
}

let rescanNonce = 0;

function goToCheckout(code) {
  let target = `${BASE}/checkout?code=${encodeURIComponent(code)}`;
  const here = location.pathname + location.search;
  if (here === target) {
    // Same code scanned again: vary the URL with a throwaway nonce so the
    // checkout view re-renders (and re-looks-up) on identical rescans.
    target += `&rescan=${++rescanNonce}`;
  }
  history.pushState({}, "", target);
  dispatchEvent(new PopStateEvent("popstate"));
}

function handleScan(value, scanId) {
  if (typeof value !== "string" || !value) return;
  if (!rememberScan(scanId)) return;
  if (PRODUCT_ID_RE.test(value)) {
    goToCheckout(value);
    return;
  }
  // Standalone checkout station: a retail barcode is still a checkout lookup
  // (samples store the UPC in qr_code when no TikTok match existed). Under
  // the OS the shell routes barcodes to Apps/Inventory instead — it never
  // sends them here.
  if (!embedded && BARCODE_RE.test(value)) {
    goToCheckout(value);
  }
}

// Source 1 — the OS shell (same-origin parent).
globalThis.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  const data = e.data;
  if (!data || data.source !== "thirsty-os" || data.type !== "scan") return;
  handleScan(data.value, data.scanId);
});

// Source 2 — direct relay subscription when there is no OS shell above us.
// THIRSTY_SCAN_RELAY is the legacy thin-client global; LPOS_SCAN_RELAY is
// LP-OS's mirror of it (main.ts injects it on the shell page).
if (!embedded) {
  const relayUrl = globalThis.THIRSTY_SCAN_RELAY ||
    globalThis.LPOS_SCAN_RELAY ||
    `${
      location.protocol === "http:" ? "ws" : "wss"
    }://${location.host}/api/scan-socket`;
  let retryMs = 1000;

  const connect = () => {
    let socket;
    try {
      socket = new WebSocket(relayUrl);
    } catch {
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
      return;
    }
    let pingTimer = 0;
    socket.addEventListener("open", () => {
      retryMs = 1000;
      socket.send(
        JSON.stringify({ type: "hello", role: "listener", name: "Kiosk" }),
      );
      pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "ping" }));
        }
      }, 10000);
    });
    socket.addEventListener("message", (e) => {
      let msg;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg && msg.type === "scan") handleScan(msg.value, msg.scanId);
    });
    const reconnect = () => {
      clearInterval(pingTimer);
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
    socket.addEventListener("close", reconnect, { once: true });
  };

  connect();
}

/* --------------------------------------------------------- open-url hook -- */
// When embedded in the OS shell (the Kiosk app window), route external /
// new-tab links (like TikTok affiliate links) up to the OS so it opens them
// in a draggable browser window instead of navigating away or popping a raw
// tab. Ported verbatim from the bundle tail; the targetOrigin pins the parent
// to our own origin, which works again now that the kiosk is same-origin.
if (globalThis.parent !== globalThis.self) {
  document.addEventListener(
    "click",
    (e) => {
      const anchor = e.target instanceof Element
        ? e.target.closest("a[href]")
        : null;
      if (!anchor) return;
      const href = anchor.href || "";
      const external = /^https?:\/\//i.test(href) &&
        !href.startsWith(globalThis.location.origin);
      if (!external && anchor.target !== "_blank") return;
      if (!/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      globalThis.parent.postMessage(
        { source: "thirsty-os", type: "open-url", url: href },
        globalThis.location.origin,
      );
    },
    true,
  );
}

/* ------------------------------------------------------------------ boot -- */

render();
