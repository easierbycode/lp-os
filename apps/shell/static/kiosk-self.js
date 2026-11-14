// LP-OS self-serve kiosk (/kiosk/self): scan → cart → pay with Cash App →
// thank-you, then back to the start screen for the next customer.
//
// Payment (server: apps/shell/core/kiosk-checkout.ts):
//   cashapp_link (default)  POST /api/kiosk/quotes reserves the items and
//       returns https://cash.app/$cashtag/<total>; we draw it as a QR. The
//       customer pays in Cash App on their phone, then taps "I've paid"
//       (POST …/claim). Staff confirm it against Cash App at /kiosk/payments.
//   square                  only when the server has SQUARE_* set. Square's
//       Web Payments SDK shows its Cash App Pay button; its ontokenization
//       token goes to POST …/pay, which charges it and marks items sold.
//
// Scans arrive three ways: a USB/Bluetooth barcode scanner typing into the
// page (keyboard wedge), the LP-OS scan relay WebSocket, or the code box.
// No framework, no build step (same rule as kiosk.js / os.js).

const ROOT = document.getElementById("ks-root");
const TOAST = document.getElementById("ks-toast");

const CART_IDLE_MS = 120_000; // abandoned cart → start over
const DONE_RESET_MS = 20_000; // thank-you screen → start screen
const HEARTBEAT_MS = 20_000;

/* ---------------------------------------------------------------- utils -- */

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / blocked storage: the id just won't persist
  }
}

function kioskIdFor() {
  const fromUrl = new URLSearchParams(location.search).get("kiosk");
  if (fromUrl && /^[\w.-]{1,64}$/.test(fromUrl)) {
    storageSet("lpos-kiosk-id", fromUrl);
    return fromUrl;
  }
  const saved = storageGet("lpos-kiosk-id");
  if (saved) return saved;
  const made = `self-${Math.random().toString(36).slice(2, 8)}`;
  storageSet("lpos-kiosk-id", made);
  return made;
}

async function api(path, init) {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const error = new Error(data?.error || `${res.status} ${res.statusText}`);
    error.status = res.status;
    error.code = data?.code || null;
    error.details = data?.details || null;
    throw error;
  }
  return data;
}

let toastTimer = 0;
function toast(message) {
  TOAST.textContent = message;
  TOAST.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (TOAST.hidden = true), 3500);
}

/* ---------------------------------------------------------------- state -- */

const state = {
  screen: "loading", // loading|start|cart|pay-link|pay-square|processing|done|error|closed|unready
  config: null,
  kioskId: kioskIdFor(),
  cart: [], // [{id,name,brand,priceCents,priced,imageUrl}]
  quote: null,
  doneKind: null, // "paid" | "claimed"
  errorMessage: "",
  busy: false,
  disabled: false,
};

const timers = { idle: 0, done: 0, countdown: 0 };
let squareMethod = null; // live Square Cash App Pay instance
let squarePayments = null;

function clearTimers() {
  clearTimeout(timers.idle);
  clearTimeout(timers.done);
  clearInterval(timers.countdown);
}

function setScreen(screen) {
  state.screen = screen;
  render();
}

function resetToStart() {
  destroySquare();
  clearTimers();
  state.cart = [];
  state.quote = null;
  state.doneKind = null;
  state.busy = false;
  setScreen(state.disabled ? "closed" : "start");
}

function touchIdle() {
  clearTimeout(timers.idle);
  if (state.screen === "cart" && state.cart.length) {
    timers.idle = setTimeout(resetToStart, CART_IDLE_MS);
  }
}

/* --------------------------------------------------------------- render -- */

function render() {
  const s = state.screen;
  if (s === "start") ROOT.innerHTML = startHtml();
  else if (s === "cart") ROOT.innerHTML = cartHtml();
  else if (s === "pay-link") ROOT.innerHTML = payLinkHtml();
  else if (s === "pay-square") ROOT.innerHTML = paySquareHtml();
  else if (s === "processing") {
    ROOT.innerHTML = centerHtml("Confirming your payment…", true);
  } else if (s === "done") ROOT.innerHTML = doneHtml();
  else if (s === "closed") {
    ROOT.innerHTML = centerHtml("This checkout is closed. Please see staff.");
  } else if (s === "unready") {
    ROOT.innerHTML = centerHtml(
      "Self checkout isn't set up yet. Please see staff.",
    );
  } else if (s === "error") ROOT.innerHTML = errorHtml();
  else ROOT.innerHTML = centerHtml("", true);
  bindScreen();
  hydrateImages();
}

function centerHtml(text, spinner = false) {
  return `<div class="ks-center">
    ${spinner ? '<div class="ks-spinner" aria-hidden="true"></div>' : ""}
    ${text ? `<p class="ks-lead">${esc(text)}</p>` : ""}
  </div>`;
}

function codeBoxHtml() {
  return `<form class="ks-codebox" data-codebox>
    <input class="ks-input" name="code" autocomplete="off" inputmode="text"
      placeholder="Or type the code on the tag" aria-label="Item code">
    <button class="ks-btn" type="submit">Add</button>
  </form>`;
}

function startHtml() {
  return `<div class="ks-center ks-start">
    <svg class="ks-scan-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/>
      <path d="M7 12h10"/>
    </svg>
    <h1 class="ks-h1">Scan an item to start</h1>
    <p class="ks-muted">Hold the item's barcode or QR code under the scanner.</p>
    ${codeBoxHtml()}
  </div>`;
}

function itemRowHtml(item, removable) {
  return `<li class="ks-item">
    <img class="ks-thumb" alt="" ${
    item.imageUrl
      ? `src="${esc(item.imageUrl)}"`
      : `data-resolve="${esc(item.id)}" src="/icons/icon.svg"`
  }>
    <div class="ks-item-main">
      <p class="ks-item-name">${esc(item.name || `Item ${item.id}`)}</p>
      ${item.brand ? `<p class="ks-muted ks-small">${esc(item.brand)}</p>` : ""}
    </div>
    <p class="ks-price">${money(item.priceCents)}</p>
    ${
    removable
      ? `<button class="ks-remove" type="button" data-remove="${esc(item.id)}"
          aria-label="Remove ${esc(item.name || "item")}">×</button>`
      : ""
  }
  </li>`;
}

function cartTotal() {
  return state.cart.reduce(
    (sum, item) => sum + Number(item.priceCents || 0),
    0,
  );
}

function payButtonsHtml() {
  const cfg = state.config;
  const methods = cfg?.methods || [];
  const total = money(cartTotal());
  const buttons = [];
  if (methods.includes("cashapp_link")) {
    buttons.push(
      `<button class="ks-btn ks-btn-cash ks-btn-xl" type="button" data-pay="cashapp_link">
        Pay ${total} with Cash App</button>`,
    );
  }
  if (methods.includes("square")) {
    buttons.push(
      `<button class="ks-btn ${
        buttons.length ? "ks-btn-ghost" : "ks-btn-cash ks-btn-xl"
      }" type="button" data-pay="square">
        ${
        buttons.length
          ? "Pay with Cash App Pay (instant)"
          : `Pay ${total} with Cash App`
      }
      </button>`,
    );
  }
  return buttons.join("");
}

function cartHtml() {
  return `<div class="ks-cart">
    <div class="ks-cart-list">
      <h1 class="ks-h2">Your items</h1>
      <ul class="ks-items">${
    state.cart.map((i) => itemRowHtml(i, true)).join("")
  }</ul>
      <p class="ks-muted ks-small">Scan another item to add it.</p>
      ${codeBoxHtml()}
    </div>
    <aside class="ks-cart-side">
      <p class="ks-muted">Total</p>
      <p class="ks-total">${money(cartTotal())}</p>
      <div class="ks-actions">${payButtonsHtml()}</div>
      <button class="ks-btn ks-btn-link" type="button" data-reset>Start over</button>
    </aside>
  </div>`;
}

function countdownHtml() {
  return `<p class="ks-muted ks-small">Time left: <span data-countdown>—</span></p>`;
}

function qrSvg(text) {
  try {
    // deno-lint-ignore no-undef
    const qr = globalThis.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({
      cellSize: 8,
      margin: 2,
      scalable: true,
      alt: "Cash App payment code",
    });
  } catch {
    return "";
  }
}

function payLinkHtml() {
  const q = state.quote;
  const svg = q?.payUrl ? qrSvg(q.payUrl) : "";
  return `<div class="ks-pay">
    <div class="ks-qr" aria-label="QR code that opens Cash App">${
    svg || `<p class="ks-muted">${esc(q?.payUrl || "")}</p>`
  }</div>
    <div class="ks-pay-side">
      <p class="ks-muted">Pay</p>
      <p class="ks-total">${money(q?.amountCents)}</p>
      <p class="ks-muted">to <strong>$${
    esc(state.config?.cashApp?.cashtag || "")
  }</strong></p>
      <ol class="ks-steps">
        <li>Point your phone's camera at the code.</li>
        <li>Cash App opens with the amount filled in. Send it.</li>
        <li>Tap <strong>I've paid</strong> below.</li>
      </ol>
      ${countdownHtml()}
      <div class="ks-actions">
        <button class="ks-btn ks-btn-cash ks-btn-xl" type="button" data-claim>I've paid</button>
        <button class="ks-btn ks-btn-ghost" type="button" data-cancel>Cancel</button>
      </div>
    </div>
  </div>`;
}

function paySquareHtml() {
  const q = state.quote;
  return `<div class="ks-pay">
    <div class="ks-square">
      <div id="cash-app-pay"></div>
      <p class="ks-muted ks-small" data-square-status>Loading Cash App Pay…</p>
    </div>
    <div class="ks-pay-side">
      <p class="ks-muted">Pay</p>
      <p class="ks-total">${money(q?.amountCents)}</p>
      <ol class="ks-steps">
        <li>Tap the Cash App Pay button.</li>
        <li>Scan the code it shows with your phone.</li>
        <li>Approve in Cash App. This screen updates by itself.</li>
      </ol>
      ${countdownHtml()}
      <div class="ks-actions">
        <button class="ks-btn ks-btn-ghost" type="button" data-cancel>Cancel</button>
      </div>
    </div>
  </div>`;
}

function doneHtml() {
  const q = state.quote;
  const items = (q?.items || []).map((i) =>
    itemRowHtml({
      id: i.sampleId,
      name: i.name,
      brand: i.brand,
      priceCents: i.priceCents,
      imageUrl: state.cart.find((c) => c.id === i.sampleId)?.imageUrl ?? null,
    }, false)
  ).join("");
  const paid = state.doneKind === "paid";
  return `<div class="ks-center ks-done">
    <div class="ks-check" aria-hidden="true">✓</div>
    <h1 class="ks-h1">${paid ? "Paid. Thank you!" : "Thank you!"}</h1>
    <p class="ks-lead">${
    paid
      ? `${money(q?.amountCents)} received${
        q?.receiptNumber ? `. Receipt ${esc(q.receiptNumber)}` : ""
      }. Your receipt is in Cash App.`
      : `A staff member will confirm your ${
        money(q?.amountCents)
      } Cash App payment. Keep your Cash App receipt handy.`
  }</p>
    <ul class="ks-items ks-items-done">${items}</ul>
    <button class="ks-btn ks-btn-xl" type="button" data-reset>Done</button>
  </div>`;
}

function errorHtml() {
  return `<div class="ks-center">
    <p class="ks-lead">${esc(state.errorMessage || "Something went wrong.")}</p>
    <button class="ks-btn ks-btn-xl" type="button" data-back>Back</button>
  </div>`;
}

function bindScreen() {
  const form = ROOT.querySelector("[data-codebox]");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = form.querySelector("input");
      const code = input.value.trim();
      input.value = "";
      if (code) addCode(code);
    });
  }
  for (const btn of ROOT.querySelectorAll("[data-remove]")) {
    btn.addEventListener("click", () => {
      const id = Number(btn.getAttribute("data-remove"));
      state.cart = state.cart.filter((i) => i.id !== id);
      setScreen(state.cart.length ? "cart" : "start");
      touchIdle();
    });
  }
  for (const btn of ROOT.querySelectorAll("[data-pay]")) {
    btn.addEventListener(
      "click",
      () => startPayment(btn.getAttribute("data-pay")),
    );
  }
  ROOT.querySelector("[data-reset]")?.addEventListener("click", resetToStart);
  ROOT.querySelector("[data-cancel]")?.addEventListener(
    "click",
    () => cancelPayment(),
  );
  ROOT.querySelector("[data-claim]")?.addEventListener("click", claimPayment);
  ROOT.querySelector("[data-back]")?.addEventListener("click", () => {
    setScreen(state.cart.length ? "cart" : "start");
  });
  if (state.screen === "pay-link" || state.screen === "pay-square") {
    startCountdown();
  }
}

// Samples without a picture_url resolve one via /api/samples/:id/image.
function hydrateImages() {
  for (const img of ROOT.querySelectorAll("img[data-resolve]")) {
    const id = img.getAttribute("data-resolve");
    img.removeAttribute("data-resolve");
    fetch(`/api/samples/${encodeURIComponent(id)}/image`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.picture_url && img.isConnected) img.src = data.picture_url;
      })
      .catch(() => {});
  }
}

/* ----------------------------------------------------------------- scan -- */

const PAYING = new Set(["pay-link", "pay-square", "processing"]);

async function addCode(code) {
  if (state.disabled) return;
  if (PAYING.has(state.screen)) {
    toast("Finish or cancel this payment first.");
    return;
  }
  if (state.screen === "done") resetToStart();
  if (state.busy) return;
  state.busy = true;
  try {
    const { items } = await api(
      `/api/kiosk/lookup?code=${encodeURIComponent(code)}`,
    );
    if (!items.length) {
      toast("We couldn't find that item.");
      return;
    }
    const inCart = new Set(state.cart.map((i) => i.id));
    const pick = items.find((i) => i.sellable && !inCart.has(i.id));
    if (!pick) {
      toast(
        items.some((i) => inCart.has(i.id))
          ? "That item is already in your cart."
          : "That item isn't for sale here. Please see staff.",
      );
      return;
    }
    state.cart.push(pick);
    setScreen("cart");
    toast(`Added ${pick.name || "item"}, ${money(pick.priceCents)}`);
  } catch (error) {
    toast(
      error.status === 503
        ? "Checkout is offline. Please see staff."
        : "Couldn't look that up. Try again.",
    );
  } finally {
    state.busy = false;
    touchIdle();
  }
}

// Keyboard-wedge scanners "type" the code fast and press Enter. Outside a
// text box, buffer fast keystrokes and treat Enter as end of scan.
let wedge = "";
let wedgeAt = 0;
document.addEventListener("keydown", (e) => {
  const target = e.target;
  if (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  ) return;
  const now = Date.now();
  if (now - wedgeAt > 80) wedge = "";
  wedgeAt = now;
  if (e.key === "Enter") {
    if (wedge.length >= 3) addCode(wedge);
    wedge = "";
    return;
  }
  if (e.key.length === 1) wedge += e.key;
});

// LP-OS scan relay (phone scanner app / paired scanners), same wire protocol
// as kiosk.js. Every listener on the relay gets every scan, so a kiosk with
// its own USB scanner is the better fit when several kiosks run at once.
const seenScanIds = new Set();
function connectRelay() {
  const url = `${
    location.protocol === "http:" ? "ws" : "wss"
  }://${location.host}/api/scan-socket`;
  let retryMs = 1000;
  const connect = () => {
    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
      return;
    }
    let ping = 0;
    socket.addEventListener("open", () => {
      retryMs = 1000;
      socket.send(
        JSON.stringify({
          type: "hello",
          role: "listener",
          name: "Self checkout",
        }),
      );
      ping = setInterval(() => {
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
      if (!msg || msg.type !== "scan" || typeof msg.value !== "string") return;
      if (msg.scanId) {
        if (seenScanIds.has(msg.scanId)) return;
        seenScanIds.add(msg.scanId);
        if (seenScanIds.size > 300) seenScanIds.clear();
      }
      addCode(msg.value);
    });
    socket.addEventListener("close", () => {
      clearInterval(ping);
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    }, { once: true });
  };
  connect();
}

/* -------------------------------------------------------------- payment -- */

function startCountdown() {
  clearInterval(timers.countdown);
  const q = state.quote;
  if (!q) return;
  // Server TTL measured locally, so a skewed kiosk clock doesn't matter.
  const ttl = Math.max(0, Date.parse(q.expiresAt) - Date.parse(q.createdAt));
  const deadline = (state.quoteStartedAt || Date.now()) + ttl;
  const tick = () => {
    const left = Math.max(0, deadline - Date.now());
    const el = ROOT.querySelector("[data-countdown]");
    if (el) {
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      el.textContent = `${m}:${String(s).padStart(2, "0")}`;
    }
    if (left <= 0) {
      clearInterval(timers.countdown);
      cancelPayment("Time ran out. Your items are still here.");
    }
  };
  tick();
  timers.countdown = setInterval(tick, 1000);
}

function dropUnavailable(error) {
  const gone = [
    ...(error.details?.unavailable || []),
    ...(error.details?.missing || []),
    ...(error.details?.unpriced || []),
  ].map(Number);
  if (!gone.length) return false;
  state.cart = state.cart.filter((i) => !gone.includes(i.id));
  return true;
}

async function startPayment(method) {
  if (state.busy || !state.cart.length) return;
  state.busy = true;
  try {
    const quote = await api("/api/kiosk/quotes", {
      method: "POST",
      body: JSON.stringify({
        method,
        kioskId: state.kioskId,
        sampleIds: state.cart.map((i) => i.id),
      }),
    });
    state.quote = quote;
    state.quoteStartedAt = Date.now();
    // Prices are locked in by the server; show its numbers.
    for (const item of quote.items) {
      const c = state.cart.find((x) => x.id === item.sampleId);
      if (c) c.priceCents = item.priceCents;
    }
    clearTimeout(timers.idle);
    if (method === "square") {
      setScreen("pay-square");
      await mountSquare();
    } else {
      setScreen("pay-link");
    }
  } catch (error) {
    if (error.status === 409 && dropUnavailable(error)) {
      toast(
        "Some items just sold or can't be bought here, so we removed them.",
      );
      setScreen(state.cart.length ? "cart" : "start");
    } else if (error.status === 423) {
      state.disabled = true;
      resetToStart();
    } else {
      toast(error.message || "Couldn't start the payment.");
    }
  } finally {
    state.busy = false;
  }
}

async function cancelPayment(message) {
  const q = state.quote;
  destroySquare();
  clearInterval(timers.countdown);
  state.quote = null;
  if (q) {
    await api(`/api/kiosk/quotes/${q.id}/cancel`, { method: "POST" }).catch(
      () => {},
    );
  }
  setScreen(state.cart.length ? "cart" : "start");
  if (message) toast(message);
  touchIdle();
}

async function claimPayment() {
  const q = state.quote;
  if (!q || state.busy) return;
  state.busy = true;
  clearInterval(timers.countdown);
  try {
    state.quote = await api(`/api/kiosk/quotes/${q.id}/claim`, {
      method: "POST",
    });
    finish("claimed");
  } catch (error) {
    state.errorMessage = error.message || "Please see staff.";
    setScreen("error");
  } finally {
    state.busy = false;
  }
}

function finish(kind) {
  destroySquare();
  clearTimers();
  state.doneKind = kind;
  setScreen("done");
  timers.done = setTimeout(resetToStart, DONE_RESET_MS);
}

/* ------------------------------------------------------- Square (opt-in) -- */

let sdkPromise = null;
function loadSquareSdk(url) {
  if (globalThis.Square) return Promise.resolve();
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () => {
        sdkPromise = null;
        reject(new Error("Couldn't load Square"));
      };
      document.head.appendChild(script);
    });
  }
  return sdkPromise;
}

function destroySquare() {
  const method = squareMethod;
  squareMethod = null;
  if (method && typeof method.destroy === "function") {
    Promise.resolve(method.destroy()).catch(() => {});
  }
}

function squareStatus(text) {
  const el = ROOT.querySelector("[data-square-status]");
  if (el) el.textContent = text;
}

async function mountSquare() {
  const cfg = state.config?.square;
  const quote = state.quote;
  if (!cfg || !quote) return;
  try {
    await loadSquareSdk(cfg.sdkUrl);
    if (!squarePayments) {
      squarePayments = await globalThis.Square.payments(
        cfg.applicationId,
        cfg.locationId,
      );
    }
    destroySquare();
    const request = squarePayments.paymentRequest({
      countryCode: "US",
      currencyCode: "USD",
      total: { amount: quote.amount, label: "Total" },
    });
    const method = await squarePayments.cashAppPay(request, {
      redirectURL: `${location.origin}/kiosk/self`,
      referenceId: quote.id,
    });
    if (state.quote?.id !== quote.id) {
      method.destroy?.();
      return; // cancelled while loading
    }
    squareMethod = method;
    method.addEventListener("ontokenization", (event) => {
      const { tokenResult, error } = event.detail || {};
      if (error || !tokenResult || tokenResult.status !== "OK") {
        squareStatus("That didn't go through. Tap the button to try again.");
        return;
      }
      chargeSquare(quote.id, tokenResult.token);
    });
    await method.attach("#cash-app-pay", {
      shape: "semiround",
      width: "full",
      size: "medium",
    });
    squareStatus("Tap the button, then scan with your phone.");
  } catch (error) {
    squareStatus(error.message || "Cash App Pay isn't available right now.");
  }
}

async function chargeSquare(quoteId, token) {
  if (state.quote?.id !== quoteId) return;
  clearInterval(timers.countdown);
  setScreen("processing");
  try {
    state.quote = await api(`/api/kiosk/quotes/${quoteId}/pay`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    finish("paid");
  } catch (error) {
    if (error.status === 402) {
      // Declined: the quote is pending again; offer the button once more.
      setScreen("pay-square");
      await mountSquare();
      squareStatus("The payment didn't go through. Please try again.");
      return;
    }
    state.quote = null;
    state.errorMessage = error.message ||
      "We couldn't confirm the payment. Please see staff.";
    setScreen("error");
  }
}

/* ------------------------------------------------------------- lockdown -- */

// Full screen on the first touch (browsers only allow it from a gesture) and
// keep the screen awake. Run Chrome with --kiosk for a real lockdown.
document.addEventListener("pointerdown", () => {
  if (
    !document.fullscreenElement && document.documentElement.requestFullscreen
  ) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}, { passive: true });

let wakeLock = null;
async function keepAwake() {
  try {
    if (navigator.wakeLock && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    }
  } catch {
    // not supported or not allowed: the device's own sleep settings apply
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") keepAwake();
});
document.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("pointerdown", touchIdle, { passive: true });

// Fleet heartbeat: /api/kiosks/:id/disable closes this checkout remotely.
async function heartbeat() {
  try {
    const res = await api("/api/heartbeat", {
      method: "POST",
      body: JSON.stringify({ id: state.kioskId, name: "Self checkout" }),
    });
    const disabled = Boolean(res?.disabled);
    if (disabled !== state.disabled) {
      state.disabled = disabled;
      if (disabled && (state.screen === "start" || state.screen === "cart")) {
        resetToStart();
      }
      if (!disabled && state.screen === "closed") resetToStart();
    }
  } catch {
    // offline: keep going; the next beat retries
  }
}

/* ----------------------------------------------------------------- boot -- */

async function boot() {
  keepAwake();
  try {
    state.config = await api("/api/kiosk/pay-config");
  } catch {
    state.config = null;
  }
  await heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS);
  connectRelay();
  if (state.disabled) setScreen("closed");
  else if (!state.config?.ready) setScreen("unready");
  else setScreen("start");
}

boot();
