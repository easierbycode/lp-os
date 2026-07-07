const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const defaultProductId = new URLSearchParams(location.search).get("product") ||
  "";

let currentProductId = "";

// The price-queue summary is a two-pill toggle between the unpriced backlog
// (default) and the rows whose prices have been recovered. loadUnpricedSamples()
// fetches the full set once (see SAMPLE_LIMIT) and caches it, so flipping views
// just re-filters the cached list -- no refetch.
let sampleView = "unpriced";
let lastSampleData = null;

// Fetch the whole set in one shot so both views are complete. The backend keeps
// every priced (edited) row in the page and fills the rest with the unpriced
// backlog up to this limit; with priced rows able to outnumber a small limit,
// anything lower would starve the unpriced slice. The product universe is capped
// server-side (~1000), so this returns everything matched. Declared up here (not
// beside loadUnpricedSamples) because that function runs during module init,
// before a const lower in the file would leave its temporal dead zone.
const SAMPLE_LIMIT = "1000";

// Launch clean: never replay a remembered/browser-restored search, and put the
// cursor in the search box so the user can search or scan immediately. The
// product details stay hidden until a search/scan actually loads a product.
const globalQuery = document.getElementById("global-query");
globalQuery.value = "";
globalQuery.focus();

// Collapsible panels: clicking a section header (or its chevron) slides the
// body open/closed. The chevron points down when open, right when collapsed.
for (const head of document.querySelectorAll("section.panel > .section-head")) {
  const panel = head.closest("section.panel");
  const toggle = head.querySelector(".panel-toggle");
  if (!panel || !toggle) continue;
  head.addEventListener("click", (event) => {
    // Don't hijack clicks on real controls that might live in a header.
    if (event.target.closest("a, input, select, textarea")) return;
    const collapsed = panel.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
  });
}

document.getElementById("global-search").addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
    const query = document.getElementById("global-query").value.trim();
    // One search box: always filters the recovery queue; a bare numeric
    // product ID also loads that product's analysis up top.
    loadUnpricedSamples();
    if (/^\d{6,}$/.test(query)) loadProduct(query);
  },
);

document.getElementById("unpriced-refresh").addEventListener("click", () => {
  loadUnpricedSamples();
});

// Flip between the unpriced backlog and the recovered (priced) list. Only the
// inactive pill is clickable (the active one has pointer-events: none), so a
// click always names the view to switch to; re-render from cached data.
document.getElementById("sample-view-toggle").addEventListener(
  "click",
  (event) => {
    const pill = event.target.closest("button[data-view]");
    if (!pill || !lastSampleData) return;
    if (pill.dataset.view === sampleView) return;
    sampleView = pill.dataset.view;
    renderSamples();
  },
);

document.getElementById("unpriced-rows").addEventListener(
  "click",
  async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const row = button.closest("[data-product-id]");
    if (!row) return;

    if (button.dataset.action === "save") {
      await saveUnpricedSample(row);
    } else if (button.dataset.action === "fetch-price") {
      await fetchUnpricedPrice(row);
    }
  },
);

await loadHealth();
await Promise.all([
  // Only load a product when explicitly deep-linked via ?product=; otherwise the
  // hero waits for a search instead of auto-showing the most recent product.
  defaultProductId ? loadProduct(defaultProductId) : Promise.resolve(),
  loadUnpricedSamples(),
  loadComparison(),
  loadKiosks(),
]);

setInterval(loadKiosks, 5000);

async function loadHealth() {
  const health = await json("/api/health");
  const warning = document.getElementById("setup-warning");

  if (!health.graylogConfigured) {
    warning.classList.remove("hidden");
    warning.textContent =
      "The message store is not configured yet. Set DATABASE_URL (LP-OS keeps Graylog data in the graylog_messages Postgres table) and restart the shell.";
  }
}

async function loadProduct(productId) {
  let product;
  try {
    product = await json(`/api/product/${encodeURIComponent(productId)}`);
  } catch (error) {
    showNotice(error.message);
    return;
  }

  currentProductId = product.productId;
  document.querySelector(".product-shell").classList.remove("hidden");
  document.getElementById("product-name").textContent = product.name;
  document.getElementById("product-meta").textContent =
    `${product.category} | ${product.seller} | Product ID ${product.productId} | ${product.priceRange}`;
  document.getElementById("min-price").textContent = money(
    product.min_sku_original_price,
  );
  document.getElementById("gmv").textContent = money(product.gmv);
  document.getElementById("customers").textContent = count(product.customers);
  document.getElementById("quantity").textContent = count(product.quantity);
  document.getElementById("sku-orders").textContent = count(product.skuOrders);
  document.getElementById("refunds").textContent = money(product.refunds);
  document.getElementById("units-refunded").textContent = count(
    product.unitsRefunded,
  );
  document.getElementById("videos").textContent = count(product.videos);
  document.getElementById("live-streams").textContent = count(
    product.liveStreams,
  );
}

async function loadUnpricedSamples() {
  const query = document.getElementById("global-query").value.trim();
  const params = new URLSearchParams({ limit: SAMPLE_LIMIT });

  if (query) params.set("query", query);

  try {
    lastSampleData = await json(`/api/unpriced-samples?${params}`);
    renderSamples();
  } catch (error) {
    lastSampleData = null;
    document.getElementById("unpriced-rows").innerHTML =
      `<div class="empty-row">${escapeHtml(error.message)}</div>`;
  }
}

// Render the cached sample list for the active view. The response carries every
// matched row, so each view is a filter on it; both pills always show their
// count, the active one is highlighted, and the heading names the active view.
function renderSamples() {
  const data = lastSampleData;
  if (!data) return;

  const body = document.getElementById("unpriced-rows");
  const unpricedPill = document.getElementById("view-unpriced");
  const pricedPill = document.getElementById("view-priced");
  const title = document.getElementById("queue-title");

  const priced = sampleView === "priced";
  const label = priced ? "priced" : "unpriced";

  // Both pills always show their live count; only the inactive one is clickable.
  unpricedPill.textContent = `${count(data.unpricedCount)} unpriced`;
  pricedPill.textContent = `${count(data.pricedCount)} priced`;
  unpricedPill.classList.toggle("is-active", !priced);
  pricedPill.classList.toggle("is-active", priced);
  unpricedPill.setAttribute("aria-pressed", String(!priced));
  pricedPill.setAttribute("aria-pressed", String(priced));

  title.textContent = priced ? "Priced Samples" : "Unpriced Samples";

  const rows = data.items.filter((sample) => sample.priced === priced);

  body.innerHTML = rows.length
    ? rows.map(unpricedRowHtml).join("")
    : `<div class="empty-row">No ${label} samples found.</div>`;
}

async function saveUnpricedSample(row) {
  const productId = row.dataset.productId;

  setRowBusy(row, true);

  try {
    await json(`/api/unpriced-samples/${encodeURIComponent(productId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        price: row.querySelector(".price-input").value,
        sampleCount: row.querySelector(".sample-count-input").value,
        notes: row.querySelector(".notes-input").value,
      }),
    });
    await refreshAfterPriceChange(productId);
  } catch (error) {
    showNotice(error.message);
  } finally {
    setRowBusy(row, false);
  }
}

async function fetchUnpricedPrice(row) {
  const productId = row.dataset.productId;

  setRowBusy(row, true);

  let fetched;
  try {
    fetched = await json(
      `/api/unpriced-samples/${encodeURIComponent(productId)}/fetch-price`,
      { method: "POST" },
    );
  } catch (error) {
    showNotice(error.message);
    setRowBusy(row, false);
    return;
  }

  // The lookup only proposes a price -- preview it in the row, then offer to save.
  const priceInput = row.querySelector(".price-input");
  if (priceInput) priceInput.value = priceInputValue(fetched.price);

  if (
    !confirm(
      `Found ${money(fetched.price)} for ${fetched.name}. Save this price?`,
    )
  ) {
    await loadUnpricedSamples();
    setRowBusy(row, false);
    return;
  }

  try {
    await json(`/api/unpriced-samples/${encodeURIComponent(productId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        price: fetched.price,
        source: "scrapecreators",
        sourceUrl: fetched.sourceUrl,
        apiTitle: fetched.apiTitle,
        apiSeller: fetched.apiSeller,
        fetchedAt: fetched.fetchedAt,
      }),
    });
    await refreshAfterPriceChange(productId);
  } catch (error) {
    showNotice(error.message);
  } finally {
    setRowBusy(row, false);
  }
}

async function refreshAfterPriceChange(productId) {
  const tasks = [loadUnpricedSamples(), loadComparison()];
  if (productId && productId === currentProductId) {
    tasks.push(loadProduct(productId));
  }
  await Promise.all(tasks);
}

function unpricedRowHtml(sample) {
  const lastSeen = sample.lastSeen
    ? new Date(sample.lastSeen).toLocaleDateString()
    : "No timestamp";
  const fetchedAt = sample.fetchedAt
    ? ` · Looked up ${new Date(sample.fetchedAt).toLocaleDateString()}`
    : "";
  const source = sourceLabel(sample.source);
  const canFetch = Number(sample.price || 0) <= 0;

  return `
    <div class="sample-row" data-product-id="${escapeAttr(sample.productId)}">
      <div class="cell product-cell">
        <p class="row-title" title="${escapeAttr(sample.name)}">${
    escapeHtml(sample.name)
  }</p>
        <p class="row-sub">
          <span class="source-tag ${sourceClass(sample.source)}">${
    escapeHtml(source)
  }</span>
          <span>ID ${escapeHtml(sample.productId)}</span>
          <span>${escapeHtml(lastSeen)}${escapeHtml(fetchedAt)}</span>
        </p>
      </div>
      <div class="cell">
        <span class="m-label">Price</span>
        <input class="price-input tnum" type="number" min="0" step="0.01" placeholder="0.00" value="${
    escapeAttr(priceInputValue(sample.price))
  }">
        <span class="cell-hint tnum">Graylog ${
    money(sample.originalPrice)
  }</span>
      </div>
      <div class="cell">
        <span class="m-label">Samples</span>
        <input class="sample-count-input tnum" type="number" min="0" step="1" value="${
    escapeAttr(sample.sampleCount)
  }">
      </div>
      <div class="cell">
        <span class="m-label">Value</span>
        <span class="row-value tnum">${money(sample.sampleValue)}</span>
      </div>
      <div class="cell notes-cell">
        <span class="m-label">Notes</span>
        <input class="notes-input" value="${
    escapeAttr(sample.notes)
  }" placeholder="Notes">
      </div>
      <div class="cell row-actions">
        <button class="small" type="button" data-action="fetch-price" ${
    canFetch ? "" : "disabled"
  }>Look Up Price</button>
        <button class="small ghost" type="button" data-action="save">Save</button>
      </div>
    </div>
  `;
}

async function loadComparison() {
  const rows = await json("/api/comparison");
  const body = document.getElementById("comparison-rows");

  body.innerHTML = rows.length
    ? rows.map((row) => `
    <div class="cmp-row">
      <div class="cell product-cell">
        <p class="row-title" title="${escapeAttr(row.name)}">${
      escapeHtml(row.name)
    }</p>
        <p class="row-sub"><span>${
      escapeHtml(row.category || "Uncategorized")
    }</span></p>
      </div>
      <div class="cell num"><span class="m-label">Rank</span>${
      row.rank ? `#${count(row.rank)}` : "-"
    }</div>
      <div class="cell num"><span class="m-label">Creator videos</span>${
      count(row.creatorVideos)
    }</div>
      <div class="cell num"><span class="m-label">Platform videos</span>${
      count(row.platformVideos)
    }</div>
      <div class="cell num tnum"><span class="m-label">Sales</span>${
      money(row.sales)
    }</div>
      <div class="cell num tnum"><span class="m-label">Sample value</span>${
      money(row.sampleValue)
    }</div>
      <div class="cell"><span class="signal ${signalClass(row.signal)}">${
      escapeHtml(row.signal)
    }</span></div>
    </div>
  `).join("")
    : `<div class="empty-row">No comparison rows found in Graylog yet.</div>`;
}

async function loadKiosks() {
  const kiosks = await json("/api/kiosks");
  const root = document.getElementById("kiosks");

  // No inline onclick here: kiosk/scanner ids are client-supplied (the scan
  // relay hello), and JS-string escaping inside an HTML attribute is exactly
  // the double-encoding trap that invites XSS. The id rides a data attribute
  // (escapeAttr is sufficient there) and the handler binds via DOM API.
  root.innerHTML = kiosks.length
    ? kiosks.map((kiosk) => `
    <article class="kiosk">
      <strong>${escapeHtml(kiosk.label || kiosk.id)}</strong>
      <p class="kiosk-kind ${kiosk.kind === "scanner" ? "scanner" : ""}">${
      kiosk.kind === "scanner" ? "Scanner" : "Kiosk"
    }</p>
      <p class="status ${kiosk.online ? "" : "off"}">${
      kiosk.disabled ? "DISABLED" : kiosk.online ? "ONLINE" : "OFFLINE"
    }</p>
      <p class="muted">Last seen ${
      kiosk.lastSeen ? new Date(kiosk.lastSeen).toLocaleString() : "never"
    }</p>
      <button class="small ghost" data-kiosk-id="${
      escapeAttr(kiosk.id)
    }">Disable</button>
    </article>
  `).join("")
    : `<p class="muted">No kiosk heartbeats yet.</p>`;
  for (const btn of root.querySelectorAll("button[data-kiosk-id]")) {
    btn.addEventListener("click", () => disableKiosk(btn.dataset.kioskId));
  }
}

globalThis.disableKiosk = async (id) => {
  await fetch(`/api/kiosks/${encodeURIComponent(id)}/disable`, {
    method: "POST",
  });
  await loadKiosks();
};

async function json(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { "content-type": "application/json" } : undefined,
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed: ${path}`);
  return data;
}

function setRowBusy(row, busy) {
  for (const control of row.querySelectorAll("button, input")) {
    control.disabled = busy;
  }
}

function showNotice(message) {
  const warning = document.getElementById("setup-warning");
  warning.classList.remove("hidden");
  warning.textContent = message;
}

function money(value) {
  return currency.format(Number(value || 0));
}

function count(value) {
  return integer.format(Number(value || 0));
}

function priceInputValue(value) {
  const number = Number(value || 0);
  return number > 0 ? number.toFixed(2) : "";
}

function sourceLabel(value) {
  if (value === "scrapecreators") return "API";
  if (value === "extension") return "Extension";
  if (value === "manual") return "Manual";
  return "Graylog";
}

function sourceClass(value) {
  if (value === "scrapecreators") return "api";
  if (value === "extension") return "api";
  if (value === "manual") return "manual";
  return "graylog";
}

function signalClass(signal) {
  if (signal === "Under-posted") return "good";
  if (signal === "Priority") return "hot";
  return "watch";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
