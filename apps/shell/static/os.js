// LP-OS — a tiny desktop window manager (no dependencies).
// Folders hold app icons; icons launch draggable, resizable windows that
// embed each app in an iframe. Ported from data-pimp's Thirsty OS shell with
// three additions: multi-instance app windows, pinned (saved) windows, and a
// generic per-role default_home boot layout driven by the current USER.

// Escape interpolated text before it goes into an innerHTML template, so a
// future app name/title sourced from config/API can't break out of markup.
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

/* ---------------------------------------------------------------- icons -- */

// Gradient defs live once in a hidden sprite (injected at boot) — SVG url()
// references are document-scoped, so every icon instance reuses them without
// duplicating element ids across the DOM.
const ICON_GRADIENTS = `
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <defs>
      <linearGradient id="g-folder-back" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#c75408"/><stop offset="1" stop-color="#9c4106"/>
      </linearGradient>
      <linearGradient id="g-folder-front" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f6a93f"/><stop offset="1" stop-color="#e8650a"/>
      </linearGradient>
      <linearGradient id="g-inv" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f5832e"/><stop offset="1" stop-color="#d2560a"/>
      </linearGradient>
      <linearGradient id="g-val" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f7c64f"/><stop offset="1" stop-color="#e89b16"/>
      </linearGradient>
      <linearGradient id="g-box" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#4fc3a1"/><stop offset="1" stop-color="#239b7e"/>
      </linearGradient>
      <linearGradient id="g-mobile" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#7c5cd6"/>
      </linearGradient>
      <linearGradient id="g-browser" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#5b9bd5"/><stop offset="1" stop-color="#2f6fb0"/>
      </linearGradient>
      <linearGradient id="g-kiosk" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#54c4f5"/><stop offset="1" stop-color="#1f8fd1"/>
      </linearGradient>
      <linearGradient id="g-content" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fb7185"/><stop offset="1" stop-color="#e11d6b"/>
      </linearGradient>
      <linearGradient id="g-scan" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#4ade80"/><stop offset="1" stop-color="#16a34a"/>
      </linearGradient>
      <linearGradient id="g-gray" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#94a3b8"/><stop offset="1" stop-color="#475569"/>
      </linearGradient>
      <linearGradient id="g-market" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#6366f1"/>
      </linearGradient>
      <linearGradient id="g-lp" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f472b6"/><stop offset="1" stop-color="#c026d3"/>
      </linearGradient>
      <linearGradient id="g-wh" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#ea580c"/>
      </linearGradient>
    </defs>
  </svg>`;

const ICONS = {
  folder: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M5 17a4 4 0 0 1 4-4h13.2a4 4 0 0 1 2.9 1.25L31 19h24a4 4 0 0 1 4 4v25a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4Z" fill="url(#g-folder-back)"/>
      <path d="M7 27a3 3 0 0 1 3-3h44a3 3 0 0 1 3 3v21a4 4 0 0 1-4 4H10a3 3 0 0 1-3-3Z" fill="url(#g-folder-front)"/>
      <path d="M7 27a3 3 0 0 1 3-3h44a3 3 0 0 1 3 3v3H7Z" fill="#fff" opacity=".14"/>
    </svg>`,

  inventory: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-inv)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".10"/>
      <rect x="16" y="33" width="7" height="15" rx="2.5" fill="#fff" opacity=".95"/>
      <rect x="28.5" y="25" width="7" height="23" rx="2.5" fill="#fff" opacity=".95"/>
      <rect x="41" y="18" width="7" height="30" rx="2.5" fill="#fff"/>
      <circle cx="44.5" cy="14" r="3" fill="#ffe7c2"/>
    </svg>`,

  valuation: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-val)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".12"/>
      <path d="M30.5 16.5h9.7a3 3 0 0 1 2.12.88l6.3 6.3a3 3 0 0 1 .88 2.12v9.7a3 3 0 0 1-.88 2.12L34.8 49.4a3 3 0 0 1-4.24 0L16.6 35.44a3 3 0 0 1 0-4.24L28.38 17.4a3 3 0 0 1 2.12-.9Z" fill="#3a2a05" opacity=".22"/>
      <path d="M29.5 15.5h9.7a3 3 0 0 1 2.12.88l6.3 6.3a3 3 0 0 1 .88 2.12v9.7a3 3 0 0 1-.88 2.12L33.8 48.4a3 3 0 0 1-4.24 0L15.6 34.44a3 3 0 0 1 0-4.24L27.38 16.4a3 3 0 0 1 2.12-.9Z" fill="#fffaf0"/>
      <circle cx="39.2" cy="24.8" r="3.4" fill="#e89b16"/>
      <text x="29.5" y="40" font-family="Space Grotesk, sans-serif" font-size="17" font-weight="700" fill="#c77f0c" text-anchor="middle">$</text>
    </svg>`,

  // Lucide "boxes" glyph on the teal tile — shared by Inventory and Kiosk.
  boxes: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-box)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".10"/>
      <g transform="translate(14 14) scale(1.5)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/>
        <path d="m7 16.5-4.74-2.85"/>
        <path d="m7 16.5 5-3"/>
        <path d="M7 16.5v5.17"/>
        <path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/>
        <path d="m17 16.5-5-3"/>
        <path d="m17 16.5 4.74-2.85"/>
        <path d="M17 16.5v5.17"/>
        <path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/>
        <path d="M12 8 7.26 5.15"/>
        <path d="m12 8 4.74-2.85"/>
        <path d="M12 13.5V8"/>
      </g>
    </svg>`,

  // Lucide "puzzle" glyph on the teal tile — the Install Extension app.
  puzzle: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-box)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".10"/>
      <g transform="translate(14 14) scale(1.5)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>
      </g>
    </svg>`,

  mobile: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-mobile)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".12"/>
      <rect x="22" y="13" width="20" height="38" rx="5" fill="#fff"/>
      <rect x="24.5" y="17.5" width="15" height="26" rx="2" fill="#7c5cd6" opacity=".45"/>
      <circle cx="32" cy="15.4" r="0.9" fill="#7c5cd6" opacity=".6"/>
      <rect x="29" y="46.5" width="6" height="1.8" rx="0.9" fill="#7c5cd6" opacity=".6"/>
    </svg>`,

  browser: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-browser)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".12"/>
      <g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round">
        <circle cx="32" cy="32" r="15"/>
        <ellipse cx="32" cy="32" rx="6.5" ry="15"/>
        <line x1="17" y1="32" x2="47" y2="32"/>
        <line x1="19.5" y1="24" x2="44.5" y2="24" stroke-width="1.8" opacity=".8"/>
        <line x1="19.5" y1="40" x2="44.5" y2="40" stroke-width="1.8" opacity=".8"/>
      </g>
    </svg>`,

  // Lucide "qr-code" glyph (the Kiosk's Checkout-tab icon) on a sky tile.
  qr: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-kiosk)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".12"/>
      <g transform="translate(14 14) scale(1.5)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect width="5" height="5" x="3" y="3" rx="1"/>
        <rect width="5" height="5" x="16" y="3" rx="1"/>
        <rect width="5" height="5" x="3" y="16" rx="1"/>
        <path d="M21 16h-3a2 2 0 0 0-2 2v3"/>
        <path d="M21 21v.01"/>
        <path d="M12 7v3a2 2 0 0 1-2 2H7"/>
        <path d="M3 12h.01"/>
        <path d="M12 3h.01"/>
        <path d="M12 16v.01"/>
        <path d="M16 12h1"/>
        <path d="M21 12v.01"/>
        <path d="M12 21v-1"/>
      </g>
    </svg>`,

  // Barcode bars + scan line on a green tile — the remote Scanner companion.
  scanner: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-scan)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".12"/>
      <g fill="#fff">
        <rect x="16" y="20" width="3" height="24" rx="1.2"/>
        <rect x="22" y="20" width="2" height="24" rx="1"/>
        <rect x="27" y="20" width="4.5" height="24" rx="1.4"/>
        <rect x="34.5" y="20" width="2" height="24" rx="1"/>
        <rect x="39.5" y="20" width="3" height="24" rx="1.2"/>
        <rect x="45.5" y="20" width="2.5" height="24" rx="1.1"/>
      </g>
      <rect x="12" y="30.6" width="40" height="2.8" rx="1.4" fill="#052e16" opacity=".65"/>
    </svg>`,

  // Log-lines + magnifier on a slate tile — the Graylog search window.
  graylog: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-gray)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".12"/>
      <g fill="#fff" opacity=".92">
        <rect x="15" y="18" width="26" height="3" rx="1.5"/>
        <rect x="15" y="25" width="20" height="3" rx="1.5"/>
        <rect x="15" y="32" width="24" height="3" rx="1.5"/>
        <rect x="15" y="39" width="14" height="3" rx="1.5"/>
      </g>
      <g fill="none" stroke="#1e293b" stroke-width="3" stroke-linecap="round">
        <circle cx="41" cy="39" r="7.5" fill="#fff"/>
        <line x1="46.5" y1="44.5" x2="52" y2="50"/>
      </g>
    </svg>`,

  // Document-with-lines glyph on a rose tile — the orders→content library page.
  content: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-content)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".12"/>
      <rect x="19" y="14" width="26" height="36" rx="4" fill="#fff"/>
      <rect x="24" y="21" width="16" height="3" rx="1.5" fill="#e11d6b"/>
      <rect x="24" y="28" width="16" height="3" rx="1.5" fill="#fb7185" opacity=".55"/>
      <rect x="24" y="35" width="16" height="3" rx="1.5" fill="#fb7185" opacity=".55"/>
      <rect x="24" y="42" width="10" height="3" rx="1.5" fill="#fb7185" opacity=".55"/>
    </svg>`,

  // Price-tag glyph on a sky/indigo tile — marketplace listings (eBay first).
  marketplace: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-market)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".12"/>
      <path d="M31 15h13a5 5 0 0 1 5 5v13a4 4 0 0 1-1.17 2.83L34.9 48.76a4 4 0 0 1-5.66 0L16.24 35.76a4 4 0 0 1 0-5.66L29.17 17.17A4 4 0 0 1 31 15Z" fill="#fff"/>
      <circle cx="41.5" cy="22.5" r="3.2" fill="#4f46e5"/>
      <text x="31" y="40" font-family="Space Grotesk, sans-serif" font-size="15" font-weight="700" fill="#4f46e5" text-anchor="middle">$</text>
    </svg>`,

  // "LP" monogram tile — the Lifepreneur member site.
  lp: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-lp)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".12"/>
      <text x="32" y="41" font-family="Space Grotesk, sans-serif" font-size="22" font-weight="700" fill="#fff" text-anchor="middle">LP</text>
    </svg>`,

  // Isometric warehouse building — the 3D warehouse dashboard.
  warehouse: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-wh)"/>
      <path d="M14 30 32 18l18 12v18H14z" fill="#fff" opacity=".92"/>
      <path d="M14 30 32 18l18 12" fill="none" stroke="#7c2d12" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="26" y="34" width="12" height="14" rx="1" fill="#ea580c"/>
      <path d="M26 39h12M32 34v14" stroke="#7c2d12" stroke-width="1.6"/>
      <rect x="18" y="34" width="5" height="5" rx="1" fill="#fbbf24"/>
      <rect x="41" y="34" width="5" height="5" rx="1" fill="#fbbf24"/>
    </svg>`,

  // Lucide "users" glyph on the gold tile — the Settings window (account,
  // notifications, and the People & Access users-and-roles console).
  settings: `
    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="url(#g-val)"/>
      <rect x="6" y="6" width="52" height="26" rx="14" fill="#fff" opacity=".12"/>
      <g transform="translate(14 14) scale(1.5)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </g>
    </svg>`,
};

/* --------------------------------------------------------------- config -- */

// Injected by the LP-OS server (apps/shell routes). Every read has a safe
// fallback so this file also works served standalone.
const OS_CONFIG =
  (globalThis.LPOS_OS_CONFIG && typeof globalThis.LPOS_OS_CONFIG === "object")
    ? globalThis.LPOS_OS_CONFIG
    : {};

function safeHttpUrl(value) {
  // Empty must stay empty — resolving "" against location.href would return
  // the shell's own URL (and e.g. an unconfigured Graylog window would then
  // iframe LP-OS inside itself instead of staying hidden).
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, location.href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function configuredScanRelayUrl() {
  return globalThis.LPOS_SCAN_RELAY ||
    OS_CONFIG.scanRelay ||
    `${
      location.protocol === "http:" ? "ws" : "wss"
    }://${location.host}/api/scan-socket`;
}

function urlWithParams(base, params) {
  const safe = safeHttpUrl(base);
  if (!safe) return "";
  const url = new URL(safe);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.href;
}

// Validated base URL with no trailing slash, so `base + "/path"` composes
// (safeHttpUrl normalizes origin-only URLs to end in "/").
function baseAppUrl(value, fallback) {
  const safe = safeHttpUrl(value || fallback);
  return safe ? safe.replace(/\/+$/, "") : "";
}

// Member/Web is its own deployment (data-pimp member dashboard), independent
// of the /member SvelteKit app the shell mounts — Member/App points at the
// Cordova mobile app, matching the original system.
const MEMBER_WEB_URL = baseAppUrl(
  OS_CONFIG.memberWebUrl,
  "https://data-pimp.easierbycode.deno.net/member",
);
// Lifepreneur member site (lifepreneur-v1). LIFEPRENEUR_URL env (via
// OS_CONFIG.lifepreneurUrl) points it at a local instance during dev.
const LIFEPRENEUR_URL = baseAppUrl(
  OS_CONFIG.lifepreneurUrl,
  "https://www.lifepreneur.io",
);
const INVENTORY_APP_URL = baseAppUrl(
  OS_CONFIG.inventoryAppUrl,
  "https://admin.thirsty.store",
);
const INVENTORY_ORIGIN = INVENTORY_APP_URL
  ? new URL(INVENTORY_APP_URL).origin
  : "";
// Same-origin: the kiosk is rebuilt inside LP-OS (static/kiosk.html + kiosk.js).
const KIOSK_APP_URL = "/kiosk";
const SCANNER_APP_URL = urlWithParams(
  OS_CONFIG.scannerAppUrl ||
    (INVENTORY_APP_URL ? INVENTORY_APP_URL + "/scanner" : ""),
  { os: "1", relay: configuredScanRelayUrl() },
);
const SCANNER_APP_ORIGIN = SCANNER_APP_URL
  ? new URL(SCANNER_APP_URL).origin
  : "";
const GRAYLOG_BASE = safeHttpUrl(OS_CONFIG.graylogBase || "");

/* ------------------------------------------------------------ app model -- */

// Per-item `allow` is the iframe Permissions-Policy allowlist. The Kiosk and
// Inventory apps get `camera` for QR/barcode scanning; everything else stays
// minimal. External apps are marked so they get a sandbox that blocks
// top-navigation (a kiosk must not be navigated away from the OS shell).
const FOLDERS = [
  {
    id: "apps",
    name: "Apps",
    icon: ICONS.folder,
    // RBAC: `flag` gates a folder/item per role (see globalThis.LPOS_RBAC).
    flag: "folder.apps",
    items: [
      {
        id: "product-analysis",
        name: "Product Analysis",
        icon: ICONS.inventory,
        flag: "app.productAnalysis",
        // Same-origin analytics dashboard (served by the shell app).
        url: "/inventory",
        allow: "fullscreen",
        width: 1180,
        height: 780,
      },
      {
        id: "inventory",
        name: "Inventory",
        icon: ICONS.boxes,
        flag: "app.inventory",
        // INVENTORY_APP_URL (default admin.thirsty.store until the tracker
        // migrates into LP-OS).
        url: INVENTORY_APP_URL,
        allow: "fullscreen; camera",
        external: true,
        width: 1180,
        height: 780,
      },
      {
        id: "kiosk",
        name: "Kiosk",
        icon: ICONS.qr,
        flag: "app.kiosk",
        // The Inventory Manager kiosk, rebuilt vanilla inside LP-OS — served
        // same-origin at /kiosk, so the postMessage scan/open-url fast path
        // works again. No camera code in the kiosk; scans come off the relay.
        url: KIOSK_APP_URL,
        allow: "fullscreen",
        width: 1180,
        height: 780,
      },
      {
        id: "scanner",
        name: "Scanner",
        icon: ICONS.scanner,
        flag: "app.scanner",
        // The Scanner companion app (served by admin.thirsty.store by default).
        // The server/client append ?os=1 and the active relay URL so local,
        // thin-client, and production shells all land on the same scan bus.
        url: SCANNER_APP_URL,
        allow: "fullscreen; camera; bluetooth",
        external: true,
        width: 560,
        height: 800,
      },
      {
        id: "graylog",
        name: "Graylog",
        icon: ICONS.graylog,
        flag: "app.graylog",
        requiresConfig: "graylog",
        // Configured by LPOS_OS_CONFIG.graylogBase; hidden until set (the
        // same-origin /api/search-backed search page is future work). Scan
        // events auto-drive this window by navigating it to a matching search.
        url: GRAYLOG_BASE,
        allow: "fullscreen",
        external: true,
        width: 1180,
        height: 780,
      },
      {
        id: "install-extension",
        name: "Install Extension",
        icon: ICONS.puzzle,
        flag: "app.installExtension",
        // Same-origin install help: plain-language setup steps for the Chrome
        // extension, download link included (/extension.zip is built from this
        // repo's extension/ folder). Opened by the samples-import skill or
        // from Apps.
        url: "/install",
        width: 600,
        height: 720,
      },
      {
        id: "marketplace",
        name: "Marketplace",
        icon: ICONS.marketplace,
        flag: "app.marketplace",
        // Same-origin marketplace window: eBay API credentials prompt,
        // auto-list settings, on-demand "List on eBay", and the listings
        // status table (served by the shell at /marketplace).
        url: "/marketplace",
        width: 800,
        height: 860,
      },
      {
        id: "warehouse",
        name: "Warehouse",
        icon: ICONS.warehouse,
        flag: "app.warehouse",
        // CSS-3D warehouse dashboard (served by the shell at /warehouse).
        // Walking its steps posts warehouse-step messages back up; the shell
        // opens the matching apps beside it (see the listener below the
        // marketplace relay). openApp appends ?user= for attribution.
        url: "/warehouse",
        allow: "fullscreen",
        width: 1280,
        height: 800,
      },
      {
        id: "settings",
        name: "Settings",
        icon: ICONS.settings,
        flag: "app.settings",
        // Account, Notifications, and a People & Access section that reuses the
        // roles.json users-and-roles console (served same-origin at /settings).
        // openApp appends ?user= so Account prefills the signed-in user, the
        // app.admin gate on People & Access resolves, and its self-lockout
        // guard lands on the right role. The window's "Preview as" picker
        // rewrites that same ?user= to reload under another identity.
        url: "/settings",
        width: 1180,
        height: 800,
      },
    ],
  },
  {
    id: "demos",
    name: "Demos",
    icon: ICONS.folder,
    flag: "folder.demos",
    items: [
      {
        id: "sample-valuation",
        name: "Sample Valuation",
        icon: ICONS.valuation,
        url:
          "https://easierbycode.com/tok-scrape/extension-creator-demo/samples-modal/",
        allow: "fullscreen",
        external: true,
        width: 1040,
        height: 720,
      },
      {
        id: "samples",
        name: "Samples",
        icon: ICONS.mobile,
        url: "https://easierbycode.com/tok-scrape/mobile-demo/www/",
        allow: "fullscreen",
        external: true,
        // Phone-shaped window to suit the mobile demo. `mobile` keeps its width
        // fixed when snapped to a screen half (see snapWindow).
        mobile: true,
        width: 430,
        height: 780,
      },
      {
        id: "samples-import",
        name: "Samples-Import",
        icon: ICONS.mobile,
        // Admin import tool: paste/upload a list of TikTok productIds, hydrate
        // each, and add to inventory assigned to a creator. Reuses the Samples
        // demo's order-modal preview; calls the live import API.
        url: "https://easierbycode.com/tok-scrape/samples-import/www/",
        allow: "fullscreen",
        external: true,
        // Wider than the phone Samples demo (paste box + creator picker +
        // auto-list panel) and resizable — not mobile-locked.
        width: 520,
        height: 840,
      },
      {
        id: "e2e",
        name: "E2E",
        icon: ICONS.content,
        // One-click sample-lifecycle demo: /e2e resolves the latest creator's
        // recent items (or a default product) from analytics, then runs the
        // Samples-Import import live. Same-origin page (no sandbox), opened
        // full-screen so the demo has room to breathe — still draggable/restorable.
        url: "/e2e",
        allow: "fullscreen",
        maximized: true,
        width: 1100,
        height: 760,
      },
      {
        id: "ebay-pricing",
        name: "eBay Pricing",
        icon: ICONS.valuation,
        // Interactive eBay pricing-formula demo (undercut → velocity markdown
        // → fee-aware floor) over the live catalog, served same-origin by the
        // shell. The Marketplace window's Ask-price suggestion deep-links here
        // with ?product=<id>.
        url: "/demos/ebay-pricing",
        allow: "fullscreen",
        width: 1180,
        height: 800,
      },
      {
        id: "content-by-sample",
        name: "Content by Sample",
        icon: ICONS.content,
        // The Sample Orders → Content workflow fixture from tok-scrape. A
        // third-party origin, so it gets the top-navigation-blocking sandbox
        // like the other external demos.
        url:
          "https://easierbycode.com/tok-scrape/fixtures/orders-wizard-content.html",
        allow: "fullscreen",
        external: true,
        // Wide desktop page — its content maxes out at 1180px and includes a
        // content-library table, so it gets a full desktop-sized window.
        width: 1180,
        height: 780,
      },
    ],
  },
  {
    id: "member",
    name: "Member",
    icon: ICONS.folder,
    flag: "folder.member",
    items: [
      {
        id: "tokscrape-dashboard",
        name: "App",
        icon: ICONS.mobile,
        // The Cordova member mobile app (tok-scrape mobile-app), same
        // third-party origin as the other demos — top-navigation-blocking
        // sandbox applies.
        url: "https://easierbycode.com/tok-scrape/mobile-app/www/",
        allow: "fullscreen",
        external: true,
        // Phone-shaped window — it's a mobile app. `mobile` keeps its width
        // fixed when snapped to a screen half.
        mobile: true,
        width: 430,
        height: 780,
      },
      {
        id: "member-web",
        name: "Web",
        icon: ICONS.browser,
        // The member web dashboard (seller/streamer/content dashboards) —
        // a separate deployment from Member/App (MEMBER_WEB_URL).
        url: MEMBER_WEB_URL,
        allow: "fullscreen",
        external: true,
        width: 1180,
        height: 780,
      },
      {
        id: "lifepreneur",
        name: "LP",
        icon: ICONS.lp,
        // The Lifepreneur member site (lifepreneur-v1) — opens at the login
        // page. LIFEPRENEUR_URL points it at a local instance during dev; the
        // site's CSP frame-ancestors must allow this shell's origin.
        url: LIFEPRENEUR_URL ? LIFEPRENEUR_URL + "/auth/login" : "",
        allow: "fullscreen",
        external: true,
        width: 1180,
        height: 780,
      },
    ],
  },
];

/* ----------------------------------------------------------------- RBAC -- */

// Per-device USER gating. `globalThis.LPOS_RBAC` is injected by the shell
// server from core/roles.json (the single source of truth) — users hold a
// functional role (admin/creator/warehouse); the role's capability flags
// decide which folders/apps this profile shows and which default_home boot
// layout it gets. NOT a security boundary: the OS has no auth/session, so a
// hidden app's URL still works if typed directly. Think "kiosk profile",
// not server-enforced authz.
const RBAC = (globalThis.LPOS_RBAC && typeof globalThis.LPOS_RBAC === "object")
  ? globalThis.LPOS_RBAC
  : {
    // Standalone fallback: a single admin user so the whole desktop shows.
    defaultUser: "dj",
    flags: [],
    roles: [{
      id: "admin",
      name: "Admin",
      default_home: [],
      flags: { "*": true },
    }],
    users: [{ id: "dj", name: "DJ", role: "admin" }],
  };
const USER_KEY = "lpos-os-user";

function userById(id) {
  return (RBAC.users || []).find((u) => u.id === id) || null;
}

function roleById(id) {
  return (RBAC.roles || []).find((r) => r.id === id) || null;
}

// The active USER: ?user= URL param wins (transient + readable by the merged
// Chrome extension), else a known stored choice, else the configured default.
function currentUserId() {
  const fromUrl = new URLSearchParams(location.search).get("user");
  if (fromUrl && userById(fromUrl)) return fromUrl;
  const stored = localStorage.getItem(USER_KEY);
  if (stored && userById(stored)) return stored;
  return RBAC.defaultUser || "dj";
}

// Explicit per-role value wins; `"*"` is the wildcard default; else deny.
// Mirrors roleHasFlag() in core/roles.ts so browser + server agree.
function roleAllows(roleId, flag) {
  if (!flag) return true; // unflagged folders/items are always visible
  const role = roleById(roleId);
  if (!role || !role.flags) return false;
  const explicit = role.flags[flag];
  if (typeof explicit === "boolean") return explicit;
  return role.flags["*"] === true;
}

const USER_ID = currentUserId();
const USER = userById(USER_ID) ||
  (RBAC.currentUser && RBAC.currentUser.id === USER_ID
    ? RBAC.currentUser
    : null);
const ROLE = (USER && USER.role) || "";
const allows = (flag) => roleAllows(ROLE, flag);

function itemConfigured(item) {
  if (item.requiresConfig === "graylog") return Boolean(GRAYLOG_BASE);
  if (item.id === "scanner") return Boolean(SCANNER_APP_URL);
  return true;
}

// Folders this user's role may see, each trimmed to its allowed items. A
// folder whose items are all gated away drops out entirely.
function visibleFolders() {
  return FOLDERS
    .filter((f) => allows(f.flag))
    .map((f) => ({
      ...f,
      items: (f.items || []).filter((i) => allows(i.flag) && itemConfigured(i)),
    }))
    .filter((f) => f.items.length > 0);
}

/* ----------------------------------------------------------- WM globals -- */

const desktop = document.getElementById("desktop");
const dock = document.getElementById("dock");
const activeAppLabel = document.getElementById("active-app");
const statusEl = document.getElementById("menubar-status");

const windows = new Map(); // winId -> window state
let zTop = 100;
let openCount = 0;
let statusTimer = 0;

const zidx = (win) => Number(win.el.style.zIndex) || 0;

function deskRect() {
  return desktop.getBoundingClientRect();
}

// Reserve the dock's footprint (matches --dock-h used by .desktop-icons) so
// maximized windows don't tuck their bottom edge under the floating dock.
function dockClearance() {
  const v = getComputedStyle(document.documentElement).getPropertyValue(
    "--dock-h",
  );
  return parseInt(v, 10) || 78;
}

// Smallest a window may be, never larger than the desktop itself (so a
// portrait/kiosk viewport can't force a window wider than the screen).
function minSize(d) {
  return { w: Math.min(340, d.width - 16), h: Math.min(220, d.height - 16) };
}

// Briefly surface a status message in the menubar (app-launch toast).
function flashStatus(msg) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.style.opacity = "1";
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.style.opacity = "0"), 1600);
}

/* ------------------------------------------------------- desktop icons -- */

// Icons are app launchers: a single click/tap opens them (kiosk-friendly,
// and far more reliable on touch than double-tap). As <button>s they also
// activate on Enter/Space for keyboard users.
function makeIcon(label, svg, onOpen) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon";
  btn.innerHTML =
    `<span class="icon-glyph">${svg}</span><span class="icon-label">${
      esc(label)
    }</span>`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onOpen();
  });
  return btn;
}

function renderDesktop() {
  const root = document.getElementById("desktop-icons");
  // Only the folders/apps this user's role may open (see RBAC above).
  for (const folder of visibleFolders()) {
    root.appendChild(
      makeIcon(folder.name, folder.icon, () => openFolder(folder)),
    );
  }
}

/* ----------------------------------------------------------- windowing -- */

// Move keyboard focus into a window's chrome (the close button), so a
// keyboard/SR user lands inside the window that just came forward.
function focusChrome(win) {
  const btn = win.el.querySelector(".light.close");
  if (btn) requestAnimationFrame(() => btn.focus());
}

function focusWindow(winId) {
  const win = windows.get(winId);
  if (!win) return;
  // Keep window z-indexes well below the dock/menubar, even after thousands
  // of focus changes in a long-lived kiosk session.
  if (zTop > 4000) normalizeZ();
  win.el.style.zIndex = String(++zTop);
  for (const other of windows.values()) {
    const active = other === win;
    other.el.classList.toggle("active", active);
    if (other.dockEl) other.dockEl.classList.toggle("focused", active);
  }
  activeAppLabel.textContent = win.title;
}

function normalizeZ() {
  const ordered = [...windows.values()].sort((a, b) => zidx(a) - zidx(b));
  zTop = 100;
  for (const w of ordered) w.el.style.zIndex = String(++zTop);
}

function frontWindow(exclude) {
  return [...windows.values()]
    .filter((w) => w !== exclude && !w.minimized)
    .sort((a, b) => zidx(a) - zidx(b))
    .pop();
}

// Every open instance of one app, newest-focused (highest z) first. The
// multi-instance replacement for the old fixed windows.get("app:<id>") reads.
function windowsForApp(appId) {
  const prefix = "app:" + appId + "#";
  return [...windows.values()]
    .filter((w) => w.id.startsWith(prefix))
    .sort((a, b) => zidx(b) - zidx(a));
}

function clampIntoView(win) {
  const d = deskRect();
  const w = win.el.offsetWidth;
  let x = win.el.offsetLeft;
  let y = win.el.offsetTop;
  x = Math.min(d.width - 60, Math.max(60 - w, x));
  y = Math.min(d.height - 44, Math.max(0, y));
  win.el.style.left = x + "px";
  win.el.style.top = y + "px";
}

function createWindow(
  { id, app, title, instance, icon, bodyHTML, width, height, launcher, mobile },
) {
  const d = deskRect();
  const min = minSize(d);
  const w = Math.max(min.w, Math.min(width, d.width - 24));
  const h = Math.max(min.h, Math.min(height, d.height - 24));

  // Second-and-later instances of one app read "Name · 2", "Name · 3", …
  const fullTitle = instance >= 2 ? `${title} · ${instance}` : title;

  // Cascade so stacked windows stay individually reachable.
  const step = (openCount++ % 6) * 30;
  const left = Math.max(
    12,
    Math.min((d.width - w) / 2 + step - 80, d.width - w - 12),
  );
  const top = Math.max(12, Math.min(28 + step, d.height - h - 12));

  const el = document.createElement("section");
  el.className = "window";
  el.style.width = w + "px";
  el.style.height = h + "px";
  el.style.left = Math.round(left) + "px";
  el.style.top = Math.round(top) + "px";
  el.style.zIndex = String(++zTop);
  // Non-modal labelled group (multiple windows coexist over a live desktop);
  // focusable so keyboard move/resize and focus-restore work.
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", fullTitle);
  el.setAttribute("tabindex", "-1");

  el.innerHTML = `
    <div class="titlebar">
      <div class="traffic">
        <button class="light close" type="button" aria-label="Close ${
    esc(fullTitle)
  }"><span class="glyph">×</span></button>
        <button class="light min" type="button" aria-label="Minimize ${
    esc(fullTitle)
  }"><span class="glyph">−</span></button>
        <button class="light zoom" type="button" aria-label="Zoom ${
    esc(fullTitle)
  }"><span class="glyph">+</span></button>
      </div>
      <div class="titlebar-title"><span class="ttl-glyph">${icon}</span><span class="ttl-text"></span><span class="ttl-instance" hidden></span></div>
      <div class="titlebar-spacer"></div>
    </div>
    <div class="window-body">${bodyHTML}</div>
    <div class="resize-handle" aria-hidden="true"></div>`;

  el.querySelector(".ttl-text").textContent = title;
  if (instance >= 2) {
    const badge = el.querySelector(".ttl-instance");
    badge.hidden = false;
    badge.textContent = `· ${instance}`;
  }
  desktop.appendChild(el);

  const win = {
    id,
    app: app || null, // app item id for "app:" windows; null for folder/browser
    instance: instance || 1,
    el,
    title: fullTitle,
    icon,
    minimized: false,
    maximized: false,
    snapped: null, // null | "left" | "right" — current half-screen tiling
    mobile: !!mobile, // phone-shaped app: keep its width when snapping
    prevRect: null,
    dockEl: null,
    launcher: launcher || null,
    loaderTimer: 0,
    launchUrl: null, // URL the app was opened with (pin fallback)
    pin: null, // the lpos.pins.v1 entry this window is saved as, if pinned
    pinBtn: null,
    _endGesture: null,
  };
  windows.set(id, win);

  // Window chrome wiring.
  const titlebar = el.querySelector(".titlebar");
  el.querySelector(".light.close").addEventListener(
    "click",
    () => closeWindow(win),
  );
  el.querySelector(".light.min").addEventListener(
    "click",
    () => setMinimized(win, true),
  );
  el.querySelector(".light.zoom").addEventListener(
    "click",
    () => toggleMax(win),
  );
  titlebar.addEventListener("dblclick", (e) => {
    if (!e.target.closest(".light")) toggleMax(win);
  });

  el.addEventListener("pointerdown", () => focusWindow(id), true);
  el.addEventListener("keydown", (e) => keyMoveResize(win, e));
  enableDrag(win, titlebar);
  enableResize(win, el.querySelector(".resize-handle"));
  addDockItem(win);

  // Animate in, raise, and hand keyboard focus to the new window.
  requestAnimationFrame(() => el.classList.add("open"));
  focusWindow(id);
  focusChrome(win);
  return win;
}

function closeWindow(win) {
  if (win._endGesture) win._endGesture(); // self-heal an in-flight drag/resize
  if (win.loaderTimer) clearTimeout(win.loaderTimer);
  win.el.classList.remove("open");
  // Deleted from the map BEFORE the dock release: updateScannerDock must see
  // the scanner window as already gone, or the idle status tile never leaves.
  windows.delete(win.id);
  // Closing the workbench window ends its batch-scan session — scans revert
  // to the default kiosk/intake routing immediately.
  if (batchScan && batchScan.winId === win.id) {
    batchScan = null;
    flashStatus("Batch scan ended");
  }
  // The scanner's dock element is shared status UI — release it (it stays put
  // while any scanner is still connected) instead of removing it outright.
  if (win.dockEl && win.dockEl.id === "dock-scanner") {
    releaseScannerDock(win);
  } else {
    if (win.dockEl) win.dockEl.remove();
    // A scanner window with a NORMAL tile may still be the last scanner
    // closing: the shared status tile can outlive its owner (owner closed
    // first, ownerless tile stayed lit for the remaining window), so re-sync
    // it on EVERY scanner close, not only when the closing window owned it.
    if (win.app === "scanner") updateScannerDock();
  }
  setTimeout(() => win.el.remove(), 170);

  // Hand focus to the next window, or back to the icon that launched this one.
  const next = frontWindow(win);
  if (next) {
    focusWindow(next.id);
    focusChrome(next);
  } else {
    activeAppLabel.textContent = "Finder";
    if (win.launcher && document.contains(win.launcher) && win.launcher.focus) {
      win.launcher.focus();
    }
  }
}

function setMinimized(win, min) {
  if (min) {
    win.minimized = true;
    win.el.classList.add("minimizing");
    if (win.dockEl) win.dockEl.classList.add("minimized");
    win.el.addEventListener("transitionend", function hide() {
      if (win.minimized) win.el.style.display = "none";
      win.el.removeEventListener("transitionend", hide);
    });
    const next = frontWindow(win);
    if (next) {
      focusWindow(next.id);
      focusChrome(next);
    } else {
      activeAppLabel.textContent = "Finder";
      if (win.dockEl) win.dockEl.focus(); // keep focus on the now-docked app
    }
  } else {
    win.minimized = false;
    win.el.style.display = "";
    if (win.dockEl) win.dockEl.classList.remove("minimized");
    void win.el.offsetWidth; // reflow so the transition replays
    win.el.classList.remove("minimizing");
    focusWindow(win.id);
    focusChrome(win);
  }
}

function toggleMax(win) {
  const d = deskRect();
  if (win.maximized) {
    const r = win.prevRect;
    Object.assign(win.el.style, {
      left: r.left + "px",
      top: r.top + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
    win.el.classList.remove("maximized");
    win.maximized = false;
    clampIntoView(win); // a stale prevRect can't strand the window off-screen
  } else {
    win.prevRect = {
      left: win.el.offsetLeft,
      top: win.el.offsetTop,
      width: win.el.offsetWidth,
      height: win.el.offsetHeight,
    };
    Object.assign(win.el.style, {
      left: "0px",
      top: "0px",
      width: d.width + "px",
      height: d.height - dockClearance() + "px",
    });
    win.el.classList.add("maximized");
    win.maximized = true;
  }
  focusWindow(win.id);
}

// Tile a window to the left or right half of the desktop. Re-snapping the same
// side restores the pre-snap geometry. Mobile (phone-shaped) apps keep their
// width — they're just parked against that edge at full height. `freeRect` lets
// a drag-snap pass the geometry to restore to (its position before the drag).
function snapWindow(win, side, freeRect) {
  const d = deskRect();
  // Same-side snap toggles back to the floating geometry.
  if (win.snapped === side && !win.maximized) return restoreSnap(win);
  // Capture the floating rect once, before the first tile from a free state.
  // (Coming from maximized, prevRect already holds the pre-maximize rect.)
  if (!win.snapped && !win.maximized) {
    win.prevRect = freeRect || {
      left: win.el.offsetLeft,
      top: win.el.offsetTop,
      width: win.el.offsetWidth,
      height: win.el.offsetHeight,
    };
  }
  // Phone width is read before maximize state is cleared, so a maximized phone
  // falls back to its real (pre-maximize) width rather than the full screen.
  const phoneW = win.maximized && win.prevRect
    ? win.prevRect.width
    : win.el.offsetWidth;
  if (win.maximized) {
    win.el.classList.remove("maximized");
    win.maximized = false;
  }
  const w = win.mobile ? phoneW : Math.round(d.width / 2);
  Object.assign(win.el.style, {
    left: (side === "left" ? 0 : d.width - w) + "px",
    top: "0px",
    width: w + "px",
    height: d.height - dockClearance() + "px",
  });
  win.snapped = side;
  focusWindow(win.id);
}

// Undo a snap (or maximize), returning the window to its saved floating rect.
function restoreSnap(win) {
  win.snapped = null;
  const r = win.prevRect;
  if (!r) return;
  Object.assign(win.el.style, {
    left: r.left + "px",
    top: r.top + "px",
    width: r.width + "px",
    height: r.height + "px",
  });
  clampIntoView(win); // a stale prevRect can't strand the window off-screen
  focusWindow(win.id);
}

// Keyboard move (Arrow) / resize (Shift+Arrow) for the focused window.
function keyMoveResize(win, e) {
  if (!e.key.startsWith("Arrow")) return;
  // Ctrl+Alt+Arrow → window tiling: snap halves, maximize, or restore. Handled
  // before the maximized guard so Down can un-maximize.
  if (e.ctrlKey && e.altKey) {
    e.preventDefault();
    if (e.key === "ArrowLeft") snapWindow(win, "left");
    else if (e.key === "ArrowRight") snapWindow(win, "right");
    else if (e.key === "ArrowUp" && !win.maximized) toggleMax(win);
    else if (e.key === "ArrowDown") {
      win.maximized ? toggleMax(win) : restoreSnap(win);
    }
    return;
  }
  if (win.maximized) return;
  e.preventDefault();
  win.snapped = null; // an arrow nudge floats the window off its tiled half
  const d = deskRect();
  const STEP = 24;
  const dx = e.key === "ArrowLeft" ? -STEP : e.key === "ArrowRight" ? STEP : 0;
  const dy = e.key === "ArrowUp" ? -STEP : e.key === "ArrowDown" ? STEP : 0;
  if (e.shiftKey) {
    const min = minSize(d);
    const maxW = d.width - win.el.offsetLeft - 6;
    const maxH = d.height - win.el.offsetTop - 6;
    win.el.style.width =
      Math.min(maxW, Math.max(min.w, win.el.offsetWidth + dx)) + "px";
    win.el.style.height =
      Math.min(maxH, Math.max(min.h, win.el.offsetHeight + dy)) + "px";
  } else {
    const w = win.el.offsetWidth;
    let x = win.el.offsetLeft + dx;
    let y = win.el.offsetTop + dy;
    x = Math.min(d.width - 60, Math.max(60 - w, x));
    y = Math.min(d.height - 44, Math.max(0, y));
    win.el.style.left = x + "px";
    win.el.style.top = y + "px";
  }
}

/* --------------------------------------------------------- drag/resize -- */

// Pointer capture can throw if the pointer is already gone (or the id is
// synthetic); never let that abort a gesture.
function capture(el, pointerId) {
  try {
    el.setPointerCapture(pointerId);
  } catch { /* ignore */ }
}
function release(el, pointerId) {
  try {
    el.releasePointerCapture(pointerId);
  } catch { /* ignore */ }
}

// A single reusable highlight previewing the half a dragged window will tile
// into when dropped near a side edge (Aero-/Rectangle-style snapping).
let snapPreview = null;
function showSnapPreview(win, side) {
  const d = deskRect();
  if (!snapPreview) {
    snapPreview = document.createElement("div");
    snapPreview.className = "snap-preview";
    desktop.appendChild(snapPreview);
  }
  const w = win.mobile ? win.el.offsetWidth : Math.round(d.width / 2);
  Object.assign(snapPreview.style, {
    left: (side === "left" ? 0 : d.width - w) + "px",
    top: "0px",
    width: w + "px",
    height: d.height - dockClearance() + "px",
    zIndex: String(Math.max(1, zidx(win) - 1)), // sit just behind the window
  });
  snapPreview.classList.add("show");
}
function hideSnapPreview() {
  if (snapPreview) snapPreview.classList.remove("show");
}

// Distance (px) from a side edge that arms a left/right half snap.
const SNAP_EDGE = 28;

function enableDrag(win, handle) {
  handle.addEventListener("pointerdown", (e) => {
    if (
      e.target.closest(".light") || e.target.closest(".pin-btn") ||
      e.button !== 0
    ) return;
    if (win.maximized) toggleMax(win); // un-maximize and grab
    focusWindow(win.id);

    const r = win.el.getBoundingClientRect();
    const offX = e.clientX - r.left;
    const offY = e.clientY - r.top;
    // Grabbing a tiled window floats it again; remember where to restore to so
    // a later snap can undo back to the original floating geometry.
    const wasSnapped = win.snapped;
    const startRect = {
      left: win.el.offsetLeft,
      top: win.el.offsetTop,
      width: win.el.offsetWidth,
      height: win.el.offsetHeight,
    };
    win.snapped = null;
    let snapSide = null;
    capture(handle, e.pointerId);
    handle.classList.add("grabbing");
    document.body.classList.add("wm-busy");

    const move = (ev) => {
      const d = deskRect();
      let x = ev.clientX - d.left - offX;
      let y = ev.clientY - d.top - offY;
      const w = win.el.offsetWidth;
      x = Math.min(d.width - 60, Math.max(60 - w, x));
      y = Math.min(d.height - 44, Math.max(0, y));
      win.el.style.left = x + "px";
      win.el.style.top = y + "px";
      // Arm a half-snap when the pointer reaches a side edge.
      const px = ev.clientX - d.left;
      snapSide = px <= SNAP_EDGE
        ? "left"
        : px >= d.width - SNAP_EDGE
        ? "right"
        : null;
      if (snapSide) showSnapPreview(win, snapSide);
      else hideSnapPreview();
    };
    // Listeners live on globalThis (not `handle`) so a window closed mid-drag
    // still gets its teardown — no leaked listeners, no stuck wm-busy cursor.
    const end = (ev) => {
      release(handle, ev ? ev.pointerId : e.pointerId);
      handle.classList.remove("grabbing");
      document.body.classList.remove("wm-busy");
      hideSnapPreview();
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", end);
      globalThis.removeEventListener("pointercancel", end);
      win._endGesture = null;
      if (snapSide) {
        snapWindow(
          win,
          snapSide,
          wasSnapped && win.prevRect ? win.prevRect : startRect,
        );
      }
    };
    win._endGesture = end;
    globalThis.addEventListener("pointermove", move);
    globalThis.addEventListener("pointerup", end);
    globalThis.addEventListener("pointercancel", end);
  });
}

function enableResize(win, handle) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (win.maximized) return;
    win.snapped = null; // a hand-resized window is no longer cleanly tiled
    focusWindow(win.id);

    const startW = win.el.offsetWidth;
    const startH = win.el.offsetHeight;
    const startX = e.clientX;
    const startY = e.clientY;
    capture(handle, e.pointerId);
    document.body.classList.add("wm-busy");

    const move = (ev) => {
      const d = deskRect();
      const min = minSize(d);
      const maxW = d.width - win.el.offsetLeft - 6;
      const maxH = d.height - win.el.offsetTop - 6;
      win.el.style.width =
        Math.min(maxW, Math.max(min.w, startW + (ev.clientX - startX))) + "px";
      win.el.style.height =
        Math.min(maxH, Math.max(min.h, startH + (ev.clientY - startY))) + "px";
    };
    const end = (ev) => {
      release(handle, ev ? ev.pointerId : e.pointerId);
      document.body.classList.remove("wm-busy");
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", end);
      globalThis.removeEventListener("pointercancel", end);
      win._endGesture = null;
    };
    win._endGesture = end;
    globalThis.addEventListener("pointermove", move);
    globalThis.addEventListener("pointerup", end);
    globalThis.addEventListener("pointercancel", end);
  });
}

/* --------------------------------------------------------------- dock -- */

// The window (if any) currently holding the shared scanner status dock tile.
function scannerDockOwner() {
  return [...windows.values()]
    .find((w) => w.dockEl && w.dockEl.id === "dock-scanner") || null;
}

function addDockItem(win) {
  // The FIRST Scanner instance forgoes the standard dock tile for the shared
  // scanner status indicator (LED + connected count) — see bindScannerDock().
  // Further Scanner instances dock as normal tiles.
  if (win.app === "scanner" && !scannerDockOwner()) {
    bindScannerDock(win);
    return;
  }
  const item = document.createElement("button");
  item.type = "button";
  item.className = "dock-item running";
  item.innerHTML =
    `${win.icon}<span class="dock-dot"></span><span class="dock-tip">${
      esc(win.title)
    }</span>`;
  item.setAttribute("aria-label", win.title);
  item.addEventListener("click", () => {
    if (win.minimized) {
      setMinimized(win, false);
    } else if (zidx(win) === zTop) {
      setMinimized(win, true); // already front → minimize
    } else {
      focusWindow(win.id);
      focusChrome(win);
    }
  });
  dock.appendChild(item);
  win.dockEl = item;
}

/* ------------------------------------------------------------- pinning -- */

// Pin/Save: a pinned app window is stored (per-device) in localStorage under
// lpos.pins.v1 as {app, url, title, at} and re-opened at boot before the
// role's default_home layout. Per-user Postgres pins are the follow-on once
// real auth exists.
const PINS_KEY = "lpos.pins.v1";

function loadPins() {
  try {
    const raw = JSON.parse(localStorage.getItem(PINS_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((p) =>
      p && typeof p.app === "string" && typeof p.url === "string"
    );
  } catch {
    return [];
  }
}

function savePins(pins) {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch { /* storage full/blocked — pin just won't persist */ }
}

// Best-effort capture of where the app currently is. Same-origin frames yield
// their live URL (stored relative so it survives a host change and passes the
// frame-URL allowlist); cross-origin frames fall back to the launch URL.
function currentFrameUrl(win) {
  const frame = windowFrame(win);
  if (!frame) return win.launchUrl || "";
  try {
    const loc = frame.contentWindow.location;
    if (loc.href && loc.href !== "about:blank") {
      return loc.origin === location.origin
        ? loc.pathname + loc.search
        : loc.href;
    }
  } catch { /* cross-origin */ }
  return frame.getAttribute("src") || win.launchUrl || "";
}

function attachPinButton(win) {
  const traffic = win.el.querySelector(".traffic");
  if (!traffic) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pin-btn";
  btn.textContent = "📌";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePin(win);
  });
  traffic.appendChild(btn);
  win.pinBtn = btn;
  updatePinButton(win);
}

function togglePin(win) {
  if (win.pin) {
    const { app, url, at } = win.pin;
    savePins(
      loadPins().filter((p) =>
        !(p.app === app && p.url === url && p.at === at)
      ),
    );
    win.pin = null;
    flashStatus(`Unpinned ${win.title}`);
  } else {
    const pin = {
      app: win.app,
      url: currentFrameUrl(win),
      title: win.title,
      at: Date.now(),
    };
    const pins = loadPins();
    pins.push(pin);
    savePins(pins);
    win.pin = pin;
    flashStatus(`Pinned ${win.title}`);
  }
  updatePinButton(win);
}

function updatePinButton(win) {
  if (!win.pinBtn) return;
  const pinned = !!win.pin;
  win.pinBtn.classList.toggle("pinned", pinned);
  win.pinBtn.setAttribute("aria-pressed", pinned ? "true" : "false");
  const label = pinned
    ? `Unpin ${win.title}`
    : `Pin ${win.title} (reopens at boot)`;
  win.pinBtn.setAttribute("aria-label", label);
  win.pinBtn.title = label;
}

// Re-open every saved pin (skipping apps this user's role can't see). Runs at
// boot BEFORE the default_home layout, so pins occupy the lowest z-order.
function restorePinnedWindows() {
  for (const pin of loadPins()) {
    const item = appItemById(pin.app);
    if (!item || !allows(item.flag) || !itemConfigured(item)) {
      console.warn(`LP-OS: skipping pin for unavailable app "${pin.app}"`);
      continue;
    }
    const win = openApp({ ...item, url: pin.url || item.url });
    if (win) {
      win.pin = pin; // adopt the saved entry so its button toggles to unpin
      updatePinButton(win);
    }
  }
}

/* ------------------------------------------------------- open windows -- */

// Monotonic per-app instance counter — window ids are app:<item.id>#<n>.
const appInstanceCounters = new Map();
function nextInstance(appId) {
  const n = (appInstanceCounters.get(appId) || 0) + 1;
  appInstanceCounters.set(appId, n);
  return n;
}

// ALWAYS opens a new instance (multi-instance): each call mints a new
// app:<id>#<n> window with its own dock tile. Folders and browser windows
// stay single-instance — folders are pickers; apps are workspaces.
function openApp(item) {
  if (!itemConfigured(item) || !item.url) {
    flashStatus(`${item.name} is not configured`);
    return null;
  }
  // Attribution ride-along: the Inventory tracker and the Warehouse dashboard
  // both act as the shell's current mocked user, so their windows get ?user=
  // appended — the tracker forwards it to the bulk API, keeping the operator
  // consistent across shell, tracker, and Postgres audit rows. The Settings
  // window rides along too so it resolves the signed-in user (its People &
  // Access self-lockout guard).
  if (
    item.id === "inventory" || item.id === "warehouse" ||
    item.id === "settings"
  ) {
    const withUser = urlWithParams(item.url, { user: currentUserId() });
    if (withUser) item = { ...item, url: withUser };
  }
  const instance = nextInstance(item.id);
  const id = `app:${item.id}#${instance}`;
  // Displayed ordinal counts the windows CURRENTLY open, so reopening an
  // app's only window reads plain "Name" (not an ever-inflating "Name · 3").
  // The window ID keeps the monotonic counter — ids are never reused.
  const ordinal = windowsForApp(item.id).length + 1;
  const launcher = document.activeElement;
  const win = createWindow({
    id,
    app: item.id,
    title: item.name,
    instance: ordinal,
    icon: item.icon,
    bodyHTML:
      `<div class="window-loader"><div class="spinner"></div><span></span></div>`,
    width: item.width || 1024,
    height: item.height || 720,
    mobile: item.mobile,
    launcher,
  });
  win.launchUrl = item.url;
  win.el.querySelector(".window-loader span").textContent =
    `Opening ${item.name}…`;
  attachPinButton(win);

  // Build the iframe with the DOM API (setAttribute never parses HTML) and a
  // same-origin/HTTPS URL allowlist (plus loopback HTTP for dev), so a stray
  // javascript:/data: url can't slip in.
  const iframe = document.createElement("iframe");
  iframe.setAttribute("title", item.name);
  iframe.setAttribute("allow", item.allow || "fullscreen");
  iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  if (item.external) {
    // Let the third-party app run + keep its own origin, but block it from
    // navigating the top-level kiosk away from the OS shell.
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms",
    );
  }
  if (allowedFrameUrl(item.url)) {
    iframe.setAttribute("src", item.url);
  }

  const loader = win.el.querySelector(".window-loader");
  const hide = () => loader && loader.classList.add("hidden");
  iframe.addEventListener("load", hide);
  win.loaderTimer = setTimeout(hide, 8000); // safety net for cross-origin loads
  win.el.querySelector(".window-body").appendChild(iframe);

  // Apps can request a full-screen window (e.g. the E2E demo). Still draggable:
  // the title-bar zoom button / Ctrl+Alt+Down restores it to the floating rect.
  if (item.maximized) toggleMax(win);

  // Launching the Scanner builds the scan workspace: Scanner tiled LEFT,
  // Inventory summoned (if not already running) and tiled RIGHT.
  if (item.id === "scanner") layoutScannerWorkspace(win);

  flashStatus(`Opening ${item.name}`);
  return win;
}

// Scanner workspace tiling: the Scanner fills the LEFT half; Apps/Inventory is
// launched if no instance is running and parked on the RIGHT half. Reuses the
// same openApp/snapWindow primitives as the default_home boot layout.
function layoutScannerWorkspace(scannerWin) {
  if (scannerWin.snapped !== "left") snapWindow(scannerWin, "left");
  let inv = windowsForApp("inventory")[0];
  if (!inv) {
    const inventory = appItemById("inventory");
    if (inventory && allows(inventory.flag)) inv = openApp(inventory);
  }
  if (inv) {
    if (inv.minimized) setMinimized(inv, false);
    if (inv.snapped !== "right") snapWindow(inv, "right");
  }
  // The operator's next tap is the scanner camera — keep it frontmost.
  focusWindow(scannerWin.id);
}

function openFolder(folder) {
  const id = "folder:" + folder.id;
  const existing = windows.get(id);
  if (existing) {
    if (existing.minimized) setMinimized(existing, false);
    else {
      focusWindow(id);
      focusChrome(existing);
    }
    return;
  }
  const launcher = document.activeElement;
  const bodyHTML = `<div class="folder-grid">${
    folder.items.length
      ? ""
      : `<p class="folder-empty">This folder is empty.</p>`
  }</div>`;

  const win = createWindow({
    id,
    title: folder.name,
    icon: folder.icon,
    bodyHTML,
    width: 520,
    height: 360,
    launcher,
  });

  const grid = win.el.querySelector(".folder-grid");
  for (const item of folder.items) {
    grid.appendChild(makeIcon(item.name, item.icon, () => openApp(item)));
  }
  flashStatus(folder.name);
}

// Hosts that refuse to be iframed (X-Frame-Options / CSP frame-ancestors), so a
// browser window must offer "open in a new tab" instead of a blank frame.
const UNFRAMEABLE =
  /(^|\.)(tiktok\.com|tiktokv\.[a-z]+|instagram\.com|youtube\.com|google\.com|facebook\.com|amazon\.[a-z.]+)$/i;

// Open a URL in a draggable LP-OS "browser" window. Used when a link inside an
// app (e.g. a TikTok affiliate link in the Kiosk) wants to leave the app's own
// frame. Single-instance per URL.
function openBrowser(url) {
  let host = url;
  let frameHost = "";
  try {
    const u = new URL(url);
    frameHost = u.hostname;
    host = u.hostname.replace(/^www\./, "");
  } catch { /* keep url as host fallback */ }

  const id = "browser:" + url;
  const existing = windows.get(id);
  if (existing) {
    if (existing.minimized) setMinimized(existing, false);
    else {
      focusWindow(id);
      focusChrome(existing);
    }
    return;
  }

  const blocked = UNFRAMEABLE.test(frameHost);
  const launcher = document.activeElement;
  const bodyHTML = `
    <div class="browser">
      <div class="browser-bar">
        <span class="browser-dot"></span>
        <span class="browser-url"></span>
        <button class="browser-open" type="button">Open ↗</button>
      </div>
      <div class="browser-view">${
    blocked
      ? `<div class="browser-blocked"><p></p><button class="browser-open-lg" type="button">Open in a new tab ↗</button></div>`
      : `<div class="window-loader"><div class="spinner"></div><span>Loading…</span></div>`
  }</div>
    </div>`;

  const win = createWindow({
    id,
    title: host,
    icon: ICONS.browser,
    bodyHTML,
    width: 1024,
    height: 720,
    launcher,
  });

  win.el.querySelector(".browser-url").textContent = url;
  for (
    const btn of win.el.querySelectorAll(".browser-open, .browser-open-lg")
  ) {
    btn.addEventListener(
      "click",
      () => globalThis.open(url, "_blank", "noopener,noreferrer"),
    );
  }

  if (blocked) {
    win.el.querySelector(".browser-blocked p").textContent =
      `${host} can't be displayed inside LP-OS — it blocks embedding. Open it in a new browser tab:`;
  } else {
    const view = win.el.querySelector(".browser-view");
    const loader = view.querySelector(".window-loader");
    const iframe = document.createElement("iframe");
    iframe.setAttribute("src", url);
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups",
    );
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    iframe.addEventListener(
      "load",
      () => loader && loader.classList.add("hidden"),
    );
    win.loaderTimer = setTimeout(
      () => loader && loader.classList.add("hidden"),
      8000,
    );
    view.appendChild(iframe);
  }
  flashStatus(`Opening ${host}`);
}

/* ------------------------------------------------------- chrome / boot -- */

function tickClock() {
  const clock = document.getElementById("clock");
  const now = new Date();
  const date = now.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = now.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  clock.textContent = `${date}   ${time}`;
}

// Keep maximized windows fitted and stray windows fully in view (position AND
// size) when the viewport changes — a window can never end up bigger than,
// or pushed off, a shrunken desktop.
let resizeRAF = 0;
globalThis.addEventListener("resize", () => {
  cancelAnimationFrame(resizeRAF);
  resizeRAF = requestAnimationFrame(() => {
    const d = deskRect();
    const min = minSize(d);
    const dockH = dockClearance();
    for (const win of windows.values()) {
      if (win.maximized) {
        win.el.style.width = d.width + "px";
        win.el.style.height = d.height - dockH + "px";
      } else if (!win.minimized) {
        win.el.style.width =
          Math.max(min.w, Math.min(win.el.offsetWidth, d.width - 16)) + "px";
        win.el.style.height =
          Math.max(min.h, Math.min(win.el.offsetHeight, d.height - 16)) + "px";
        clampIntoView(win);
      }
    }
  });
});

// Esc minimizes the focused window (state-preserving) — only when focus is
// actually inside that window, so it never fires from the dock/desktop or
// destroys in-progress iframe state.
globalThis.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const front = frontWindow(null);
  if (front && front.el.contains(document.activeElement)) {
    setMinimized(front, true);
  }
});

// Embedded apps post a message to ask the OS to open an external link in a
// browser window instead of leaving their own frame. Trust same-origin senders
// AND the configured Kiosk origin — the deployed kiosk bundle is the known
// open-url sender and now runs cross-origin (thirsty.store) under LP-OS. The
// URL shape is validated either way. NOTE: the "thirsty-os" source string is a
// wire protocol shared with already-deployed apps (kiosk, scan-client) — kept
// verbatim for compatibility, not a branding leftover.
globalThis.addEventListener("message", (e) => {
  const kiosk = appItemById("kiosk");
  const trusted = e.origin === location.origin ||
    (kiosk && e.origin === appOrigin(kiosk));
  if (!trusted) return;
  const data = e.data;
  if (!data || data.source !== "thirsty-os" || data.type !== "open-url") return;
  if (typeof data.url !== "string" || !/^https?:\/\//i.test(data.url)) return;
  openBrowser(data.url);
});

// Cross-origin relay: when the LEFT pane (Samples-Import, easierbycode.com)
// finishes an import batch it posts {source:"samples-import",type:"imported"}
// up to this shell; relay a refresh into every Inventory pane so their tables
// re-fetch and the new rows appear. The shell is the only window that can
// reach both panes (they can't see each other). Origins are validated
// explicitly at both hops — never "*".
const SAMPLES_IMPORT_ORIGIN = "https://easierbycode.com"; // demos item "samples-import"
globalThis.addEventListener("message", (e) => {
  if (e.origin !== SAMPLES_IMPORT_ORIGIN) return;
  const data = e.data;
  if (!data || data.source !== "samples-import" || data.type !== "imported") {
    return;
  }
  // The window-state object only holds `el`; reach the iframes via the DOM.
  // The DEPLOYED tracker only accepts refresh-inventory from the shell origin
  // https://thirsty.store; a same-origin pane accepts its own origin. From any
  // other shell origin the postMessage would be silently discarded, so reload
  // the pane instead — the tracker refetches its table on boot.
  const refreshViaMessage = INVENTORY_ORIGIN === location.origin ||
    location.origin === "https://thirsty.store";
  const postRefresh = () => {
    for (const inv of windowsForApp("inventory")) {
      const frame = inv.el.querySelector("iframe");
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(
          { source: "thirsty-os", type: "refresh-inventory" },
          INVENTORY_ORIGIN,
        );
      }
    }
  };
  if (refreshViaMessage) {
    postRefresh();
    // The Inventory pane is a separate-origin SPA; if its listener isn't wired
    // yet (still booting in the workspace launch), re-post once shortly after.
    setTimeout(postRefresh, 2500);
  } else {
    for (const inv of windowsForApp("inventory")) {
      const frame = inv.el.querySelector("iframe");
      // Re-setting src navigates the frame (a reload) → refetch on boot.
      if (frame) frame.src = frame.getAttribute("src") || frame.src;
    }
  }
  flashStatus("Refreshing Inventory");
});

// Same-origin relay from the Marketplace window (/marketplace): a listing was
// created/changed (on-demand or an auto-list pass) → toast it and refresh
// every Inventory pane, exactly like the samples-import import relay above.
globalThis.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  const data = e.data;
  if (!data || data.source !== "lp-os-marketplace") return;
  if (data.type !== "listing-updated") return;
  const refreshViaMessage = INVENTORY_ORIGIN === location.origin ||
    location.origin === "https://thirsty.store";
  if (refreshViaMessage) {
    for (const inv of windowsForApp("inventory")) {
      const frame = inv.el.querySelector("iframe");
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(
          { source: "thirsty-os", type: "refresh-inventory" },
          INVENTORY_ORIGIN,
        );
      }
    }
  } else {
    for (const inv of windowsForApp("inventory")) {
      const frame = inv.el.querySelector("iframe");
      if (frame) frame.src = frame.getAttribute("src") || frame.src;
    }
  }
  const note = typeof data.message === "string" && data.message
    ? data.message.slice(0, 80)
    : "Marketplace listing updated";
  flashStatus(note);
});

/* ------------------------------------------------- warehouse dashboard -- */

// Walking the 3D warehouse (/warehouse) drives the OS: each step announces
// itself and the shell launches/focuses the matching apps beside it — the
// "virtual screens" of the warehouse tour. Same-origin only, and only the
// actual Warehouse window's iframe is trusted (source-window match).
const WAREHOUSE_STEP_APPS = {
  receiving: [{ app: "inventory", path: "/scan" }],
  inventory: [{ app: "inventory", path: "/" }], // tracker root = Dashboard
  studio: [{ app: "samples-import" }],
  marketplace: [{ app: "kiosk" }, { app: "marketplace" }],
  overview: [],
};

// Steer an already-open tour pane to the step's path. Panes can be cross-origin
// (the tracker), so navigation is a src swap — the trick routeScanToInventory
// uses — and the ?user= attribution the inventory/warehouse windows carry is
// re-applied. No-op when the pane is already there, so revisiting a step doesn't
// needlessly reload it.
function navigateStepWindow(win, appId, path) {
  const item = appItemById(appId);
  if (!item || !item.url) return;
  let target = item.url + path;
  if (item.id === "inventory" || item.id === "warehouse") {
    target = urlWithParams(target, { user: currentUserId() }) || target;
  }
  if (!allowedFrameUrl(target)) return;
  const frame = windowFrame(win);
  if (!frame || frame.getAttribute("src") === target) return;
  frame.src = target;
}

globalThis.addEventListener("message", (e) => {
  if (e.origin !== location.origin) return;
  const data = e.data;
  if (!data || data.source !== "lp-os-warehouse") return;
  if (data.type !== "warehouse-step") return;
  const whWin = windowsForApp("warehouse").find((w) => {
    const frame = windowFrame(w);
    return frame && frame.contentWindow === e.source;
  });
  if (!whWin) return;

  const step = String(data.step || "");
  const wanted = WAREHOUSE_STEP_APPS[step];
  if (!wanted) return;

  const opened = [];
  for (const { app: appId, path } of wanted) {
    let win = windowsForApp(appId)[0];
    if (!win) {
      const item = appItemById(appId);
      if (!item || !allows(item.flag) || !itemConfigured(item) || !item.url) {
        continue;
      }
      // Fresh windows deep-link the step's path (e.g. Inventory /scan for
      // receiving, / — the Dashboard — for inventory).
      win = openApp(path ? { ...item, url: item.url + path } : item);
      if (!win) continue;
    } else if (path) {
      // Reused pane: steer it to the step's path so revisiting an app lands on
      // the step's screen rather than wherever an earlier step left it — the
      // inventory step pulls Inventory back to the Dashboard (/) after the
      // receiving step deep-linked it to /scan.
      navigateStepWindow(win, appId, path);
    }
    if (win.minimized) setMinimized(win, false);
    opened.push({ app: appId, winId: win.id });
  }

  // Tile the tour: warehouse LEFT, the step's primary app RIGHT (the same
  // split the scanner workspace uses). Overview leaves the layout alone.
  if (opened.length) {
    if (whWin.snapped !== "left") snapWindow(whWin, "left");
    const primary = windows.get(opened[0].winId);
    if (primary && primary.snapped !== "right") snapWindow(primary, "right");
    // Raise the step's windows above earlier steps' — an already-open window
    // skips openApp/snapWindow, so nothing else brings it forward. Secondary
    // windows first, then warehouse, then the primary: the tour's two tiled
    // panes stay frontmost with the current step's app on top.
    for (let i = opened.length - 1; i >= 1; i--) {
      focusWindow(opened[i].winId);
    }
    focusWindow(whWin.id);
    focusWindow(opened[0].winId);
    flashStatus(`Warehouse → ${step}`);
  }

  const frame = windowFrame(whWin);
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage(
      {
        source: "thirsty-os",
        type: "warehouse-ack",
        step,
        opened: opened.map((o) => o.app),
      },
      location.origin,
    );
  }
});

/* ------------------------------------------------------------ scan link -- */

// Companion-scanner plumbing. Handheld Scanner devices (the Scanner app, or
// BLE scanner hardware) stream scan events into the OS over the scan-relay
// WebSocket — plus a same-window postMessage fast path when the Scanner runs
// embedded in this shell (dedup'd by scanId).
//
// Routing:
//   TikTok productID (18–19 digits)    → Apps/Kiosk, straight into Checkout
//   retail barcode (UPC/EAN, 8/12–14)  → Apps/Inventory, straight into Scan
//   anything else                      → every open, non-minimized window, as
//                                        close to plain HID input as an iframe
//                                        allows (type + submit / postMessage)
// Graylog windows follow EVERY scan with a product_id search — it's a log
// tail, so it always chases what was just scanned.

const SCAN_PRODUCT_ID_RE = /^\d{18,19}$/;
const SCAN_BARCODE_RE = /^(\d{8}|\d{12,14})$/;

// BLE GATT identity shared with the Scanner app (packages/relay client). A
// Cordova scanner advertises this service; the OS subscribes as a Web
// Bluetooth central and notifications carry the scans.
const SCAN_BLE_SERVICE = "c0de5ca0-ba7c-4de1-9a0d-2b5a3f1c9e01";
const SCAN_BLE_CHARACTERISTIC = "c0de5ca1-ba7c-4de1-9a0d-2b5a3f1c9e01";

// A scan can arrive twice (embedded postMessage + relay echo) — first one wins.
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

function appItemById(id) {
  for (const folder of FOLDERS) {
    const hit = (folder.items || []).find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

function windowFrame(win) {
  return win ? win.el.querySelector("iframe") : null;
}

function frameOrigin(frame) {
  try {
    return new URL(frame.getAttribute("src") || frame.src, location.href)
      .origin;
  } catch {
    return "";
  }
}

// The origin an app item's URL resolves to (relative URLs → this shell's own
// origin) — the postMessage target for windows of that app.
function appOrigin(item) {
  try {
    return new URL(item.url, location.href).origin;
  } catch {
    return "";
  }
}

function allowedFrameUrl(url) {
  return /^https:\/\//i.test(url) ||
    /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(url) ||
    url.startsWith("/");
}

// Post into a window's iframe now and again on a spaced schedule — an app
// still cold-booting can take many seconds to attach its listener, and
// receivers dedupe by scanId so the repeats are harmless.
const SCAN_POST_RETRIES_MS = [500, 2000, 5000, 10000];
function postScanToWindow(win, message, targetOrigin) {
  const send = () => {
    const frame = windowFrame(win);
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage(message, targetOrigin);
    }
  };
  send();
  for (const delay of SCAN_POST_RETRIES_MS) setTimeout(send, delay);
}

// productID → Kiosk Checkout. A fresh window boots straight into
// <kiosk>/checkout?code=…; a live SAME-ORIGIN one (newest-focused instance)
// gets a postMessage that scan-client.js turns into a client-side route
// change. The DEPLOYED kiosk's scan-client only accepts postMessages whose
// origin equals ITS OWN origin and skips its relay subscription when embedded,
// so a cross-origin shell (any host other than thirsty.store) cannot reach it
// cooperatively — navigate the frame to the checkout deep link instead (the
// same technique graylogFollow uses).
function routeScanToKiosk(value, scanId) {
  const kiosk = appItemById("kiosk");
  const win = windowsForApp("kiosk")[0];
  const checkout = kiosk
    ? `${kiosk.url.replace(/\/+$/, "")}/checkout?code=${
      encodeURIComponent(value)
    }`
    : "";
  if (!win) {
    if (!kiosk || !allows(kiosk.flag)) return;
    openApp({ ...kiosk, url: checkout });
    return;
  }
  if (win.minimized) setMinimized(win, false);
  focusWindow(win.id);
  const kioskOrigin = kiosk ? appOrigin(kiosk) : "";
  if (checkout && kioskOrigin && kioskOrigin !== location.origin) {
    const frame = windowFrame(win);
    if (frame) {
      frame.src = checkout;
      return;
    }
  }
  postScanToWindow(
    win,
    { source: "thirsty-os", type: "scan", kind: "productId", value, scanId },
    kioskOrigin || location.origin,
  );
}

// The DEPLOYED Inventory tracker's scan-intake only trusts postMessages from
// a same-origin pane, a https://thirsty.store shell, or a localhost dev shell
// (its trustedShellOrigin allowlist). Any other shell origin must fall back to
// navigating the pane — the message would be silently discarded.
function inventoryTrustsShellMessages() {
  return INVENTORY_ORIGIN === location.origin ||
    location.origin === "https://thirsty.store" ||
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(
      location.origin,
    );
}

// barcode → Inventory Scan. Same pattern (newest-focused instance wins);
// Inventory can be cross-origin, so the deep link / postMessage target its
// real origin — and when the deployed tracker won't trust our origin, the
// live pane is deep-linked to /scan instead of postMessage'd.
function routeScanToInventory(value, scanId) {
  const scanUrl = `${INVENTORY_APP_URL}/scan?code=${encodeURIComponent(value)}`;
  const win = windowsForApp("inventory")[0];
  if (!win) {
    const inventory = appItemById("inventory");
    if (!inventory || !allows(inventory.flag)) return;
    openApp({ ...inventory, url: scanUrl });
    return;
  }
  if (win.minimized) setMinimized(win, false);
  focusWindow(win.id);
  if (!inventoryTrustsShellMessages()) {
    const frame = windowFrame(win);
    if (frame) {
      frame.src = scanUrl;
      return;
    }
  }
  postScanToWindow(
    win,
    { source: "thirsty-os", type: "scan", kind: "barcode", value, scanId },
    INVENTORY_ORIGIN,
  );
}

// Graylog chases every scan: navigate the newest visible Graylog window to
// the matching search. The iframe is cross-origin, so navigation IS our
// "focus the input and submit".
function graylogFollow(value) {
  if (!GRAYLOG_BASE) return;
  const win = windowsForApp("graylog").find((w) => !w.minimized);
  if (!win) return;
  const frame = windowFrame(win);
  if (!frame) return;
  const q = SCAN_PRODUCT_ID_RE.test(value)
    ? `product_id:"${value}"`
    : `"${value.replace(/(["\\])/g, "\\$1")}"`;
  const url = new URL(GRAYLOG_BASE);
  if (!url.pathname.endsWith("/search")) {
    url.pathname = url.pathname.replace(/\/+$/, "") + "/search";
  }
  url.searchParams.set("q", q);
  url.searchParams.set("rangetype", "relative");
  url.searchParams.set("relative", "0");
  frame.src = url.href;
}

// React-controlled inputs ignore direct .value writes; go through the native
// setter so the framework sees the change like real typing.
function setNativeValue(input, value) {
  const proto = input.tagName === "TEXTAREA"
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) desc.set.call(input, value);
  else input.value = value;
}

// Deliver a scan to one window the way a USB wedge scanner would: type into
// the focused (or first) text field and hit Enter. Same-origin frames get real
// synthetic typing; cross-origin frames get a cooperative postMessage instead
// (the browser gives us nothing better there).
function deliverHidToWindow(win, value) {
  const frame = windowFrame(win);
  if (!frame) return;
  let doc = null;
  try {
    doc = frame.contentDocument;
  } catch { /* cross-origin */ }
  if (!doc) {
    const targetOrigin = frameOrigin(frame);
    if (frame.contentWindow && targetOrigin) {
      frame.contentWindow.postMessage({
        source: "thirsty-os",
        type: "hid-scan",
        value,
      }, targetOrigin);
    }
    return;
  }
  const isField = (el) =>
    !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") &&
    !el.disabled && !el.readOnly;
  const active = doc.activeElement;
  const input = isField(active) ? active : doc.querySelector(
    'input:not([type]):not([disabled]), input[type="text"]:not([disabled]), input[type="search"]:not([disabled]), textarea:not([disabled])',
  );
  if (!input) return;
  input.focus();
  setNativeValue(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  // A wedge scanner ends every code with Enter.
  if (input.form) {
    if (input.form.requestSubmit) input.form.requestSubmit();
    else input.form.submit();
  } else {
    for (const type of ["keydown", "keyup"]) {
      input.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
        }),
      );
    }
  }
}

function scanShort(value) {
  return value.length > 28 ? value.slice(0, 25) + "…" : value;
}

/* ------------------------------------------------- workbench batch mode -- */

// While the Inventory workbench has batch-scan mode ON, that specific window
// owns every UPC/EAN AND TikTok product-id scan — the default kiosk/intake
// routing is bypassed until the workbench turns the mode off or the window
// closes. Announced by the tracker via postMessage (see listener below).
let batchScan = null; // { winId, sessionId } | null

function batchScanWindow() {
  if (!batchScan) return null;
  const win = windows.get(batchScan.winId);
  if (!win) batchScan = null; // window vanished without a close event
  return win;
}

function postScannerPresence(win) {
  const frame = windowFrame(win);
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage(
      {
        source: "thirsty-os",
        type: "scanner-presence",
        count: totalScanners(),
        devices: scannerState.devices,
      },
      INVENTORY_ORIGIN || location.origin,
    );
  }
}

globalThis.addEventListener("message", (e) => {
  if (e.origin !== INVENTORY_ORIGIN && e.origin !== location.origin) return;
  const data = e.data;
  if (!data || data.source !== "lp-os-inventory") return;
  if (data.type !== "batch-scan-mode") return;
  // Bind the mode to the exact Inventory window that asked for it — several
  // may be open; e.source disambiguates. Prefer topmost on a stale tie.
  const win = windowsForApp("inventory").find((w) => {
    const frame = windowFrame(w);
    return frame && frame.contentWindow === e.source;
  });
  if (!win) return;
  if (data.enabled) {
    batchScan = { winId: win.id, sessionId: String(data.sessionId || "") };
    flashStatus("Batch scan ON — scans go to the workbench");
    postScannerPresence(win);
  } else if (batchScan && batchScan.winId === win.id) {
    batchScan = null;
    flashStatus("Batch scan off");
  }
});

// The router: classify the scanned value and fan it out.
function routeScan(evt) {
  const value = String((evt && evt.value) || "").trim();
  if (!value) return;
  if (!rememberScan(evt.scanId)) return;
  flashStatus(`Scan · ${scanShort(value)}`);
  // Batch mode intercept: both scan shapes go to the owning workbench window.
  // Unrecognized values still fall through to the HID path below.
  if (
    batchScan &&
    (SCAN_PRODUCT_ID_RE.test(value) || SCAN_BARCODE_RE.test(value))
  ) {
    const win = batchScanWindow();
    if (win) {
      if (win.minimized) setMinimized(win, false);
      postScanToWindow(
        win,
        {
          source: "thirsty-os",
          type: "scan",
          kind: SCAN_PRODUCT_ID_RE.test(value) ? "productId" : "barcode",
          value,
          scanId: evt.scanId,
          sessionId: batchScan.sessionId,
        },
        INVENTORY_ORIGIN || location.origin,
      );
      return; // batch scans stay workbench-local (no graylogFollow chase)
    }
  }
  if (SCAN_PRODUCT_ID_RE.test(value)) {
    routeScanToKiosk(value, evt.scanId);
  } else if (SCAN_BARCODE_RE.test(value)) {
    routeScanToInventory(value, evt.scanId);
  } else {
    // Plain HID: whatever is open and visible receives the keystrokes. The
    // Scanner itself produced the value and Graylog is driven below.
    for (const win of windows.values()) {
      if (win.minimized) continue;
      if (win.app === "scanner" || win.app === "graylog") continue;
      deliverHidToWindow(win, value);
    }
  }
  graylogFollow(value);
}

/* -------------------------------------------------- scanner dock status -- */

// Instead of a plain taskbar tile, the Scanner shows a live status indicator:
// an LED that lights when at least one scanner is connected, with a count
// badge when there are several (relay scanners + locally paired BLE units).
const scannerState = { count: 0, devices: [], ble: 0 };

function totalScanners() {
  return scannerState.count + scannerState.ble;
}

function scannerDockEl() {
  return document.getElementById("dock-scanner");
}

function ensureScannerDock() {
  let el = scannerDockEl();
  if (el) return el;
  el = document.createElement("div");
  el.id = "dock-scanner";
  el.className = "dock-item dock-scanner";
  el.innerHTML = `
    <button class="scan-main" type="button" aria-label="Scanner">
      <span class="scan-led"></span>
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="currentColor">
        <rect x="3" y="6" width="1.7" height="12" rx="0.6"/>
        <rect x="6.2" y="6" width="1.1" height="12" rx="0.5"/>
        <rect x="9" y="6" width="2.4" height="12" rx="0.7"/>
        <rect x="13" y="6" width="1.1" height="12" rx="0.5"/>
        <rect x="15.8" y="6" width="1.7" height="12" rx="0.6"/>
        <rect x="19.2" y="6" width="1.3" height="12" rx="0.5"/>
      </svg>
      <span class="scan-count" hidden></span>
    </button>
    <button class="scan-ble" type="button" title="Pair a BLE scanner" aria-label="Pair a BLE scanner">⌁</button>
    <span class="dock-tip"></span>`;
  el.querySelector(".scan-main").addEventListener("click", () => {
    const win = windowsForApp("scanner")[0];
    if (win) {
      if (win.minimized) setMinimized(win, false);
      else if (zidx(win) === zTop) setMinimized(win, true);
      else {
        focusWindow(win.id);
        focusChrome(win);
      }
      return;
    }
    const item = appItemById("scanner");
    if (item && allows(item.flag)) openApp(item);
  });
  const bleBtn = el.querySelector(".scan-ble");
  if (navigator.bluetooth) bleBtn.addEventListener("click", pairBleScanner);
  else bleBtn.hidden = true;
  dock.prepend(el);
  return el;
}

function updateScannerDock() {
  // Every presence mutation funnels through here, so this is also where a
  // batch-mode workbench hears about scanners connecting/disconnecting.
  const batchWin = batchScanWindow();
  if (batchWin) postScannerPresence(batchWin);
  const win = windowsForApp("scanner")[0];
  const total = totalScanners();
  if (!win && total === 0) {
    const idle = scannerDockEl();
    if (idle) idle.remove();
    return;
  }
  const el = ensureScannerDock();
  el.classList.toggle("connected", total > 0);
  el.classList.toggle("running", !!win);
  const count = el.querySelector(".scan-count");
  count.hidden = total < 2;
  count.textContent = String(total);
  const names = scannerState.devices.map((d) => d.name || d.id).filter(Boolean);
  const label = total === 0
    ? "Scanner — none connected"
    : `${total} scanner${total === 1 ? "" : "s"} connected${
      names.length ? " · " + names.join(", ") : ""
    }`;
  el.querySelector(".dock-tip").textContent = label;
  el.querySelector(".scan-main").setAttribute("aria-label", label);
}

// The Scanner window adopts the shared status element as its dock presence…
function bindScannerDock(win) {
  win.dockEl = ensureScannerDock();
  updateScannerDock();
}

// …and hands it back on close (the status stays while scanners are connected).
function releaseScannerDock(win) {
  const el = scannerDockEl();
  if (el) el.classList.remove("focused", "minimized", "running");
  win.dockEl = null;
  updateScannerDock();
}

/* --------------------------------------------------- relay + BLE intake -- */

function connectScanRelay() {
  const relayUrl = configuredScanRelayUrl();
  let retryMs = 1000;

  const open = () => {
    let socket;
    let pingTimer = 0;
    const schedule = () => {
      clearInterval(pingTimer);
      // A dead relay means no live presence: clear the count so the dock LED
      // can't claim a scanner is connected while we're blind. (Guard on the
      // prior count so repeated failed reconnects don't spam the status line.)
      if (scannerState.count > 0) {
        scannerState.count = 0;
        scannerState.devices = [];
        updateScannerDock();
        if (totalScanners() === 0) flashStatus("Scanner disconnected");
      }
      setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
    try {
      socket = new WebSocket(relayUrl);
    } catch {
      schedule();
      return;
    }
    socket.addEventListener("open", () => {
      retryMs = 1000;
      socket.send(
        JSON.stringify({
          type: "hello",
          role: "listener",
          name: "LP-OS shell",
        }),
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
      if (!msg) return;
      if (msg.type === "scan") {
        routeScan(msg);
      } else if (msg.type === "scanners") {
        const before = totalScanners();
        scannerState.count = Number(msg.count) || 0;
        scannerState.devices = Array.isArray(msg.devices) ? msg.devices : [];
        updateScannerDock();
        const after = totalScanners();
        if (before === 0 && after > 0) flashStatus("Scanner connected");
        else if (before > 0 && after === 0) flashStatus("Scanner disconnected");
      }
    });
    socket.addEventListener("close", schedule, { once: true });
  };
  open();
}

// Pair a BLE scanner directly (Cordova Scanner app advertising, or scanner
// hardware speaking our GATT service). Chrome-only; the button hides itself
// where Web Bluetooth is missing.
const pairedBle = new Set(); // device.id — re-selecting a live device must not double-subscribe
async function pairBleScanner() {
  if (!navigator.bluetooth) return;
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SCAN_BLE_SERVICE] }],
    });
    if (pairedBle.has(device.id) && device.gatt.connected) {
      flashStatus("BLE scanner already paired");
      return;
    }
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SCAN_BLE_SERVICE);
    const characteristic = await service.getCharacteristic(
      SCAN_BLE_CHARACTERISTIC,
    );
    await characteristic.startNotifications();
    const decoder = new TextDecoder();
    characteristic.addEventListener("characteristicvaluechanged", (e) => {
      const raw = decoder.decode(e.target.value).trim();
      if (!raw) return;
      let evt = null;
      try {
        evt = JSON.parse(raw);
      } catch { /* bare-text scan */ }
      routeScan({
        value: evt && typeof evt.value === "string" ? evt.value : raw,
        format: (evt && evt.format) || "ble",
        scanId: (evt && evt.scanId) || crypto.randomUUID(),
        deviceName: device.name || "BLE scanner",
      });
    });
    pairedBle.add(device.id);
    scannerState.ble++;
    updateScannerDock();
    flashStatus(`BLE scanner paired${device.name ? " · " + device.name : ""}`);
    device.addEventListener("gattserverdisconnected", () => {
      pairedBle.delete(device.id);
      scannerState.ble = Math.max(0, scannerState.ble - 1);
      updateScannerDock();
      flashStatus("BLE scanner disconnected");
    }, { once: true });
  } catch {
    flashStatus("BLE pairing cancelled"); // chooser dismissed / no device
  }
}

// Fast path from an embedded Scanner window (cross-origin) — the same scans
// also echo back via the relay; scanId dedupes. "thirsty-scanner" is the wire
// source string the deployed Scanner app sends — kept for compatibility.
globalThis.addEventListener("message", (e) => {
  if (!SCANNER_APP_ORIGIN || e.origin !== SCANNER_APP_ORIGIN) return;
  const data = e.data;
  if (!data || data.source !== "thirsty-scanner" || data.type !== "scan") {
    return;
  }
  routeScan(data);
});

/* --------------------------------------------------- default_home boot -- */

// Resolve a default_home appPath ("Folder/Item", case-insensitive, with an
// optional ?query appended to the item URL) to a launchable item, or null.
function resolveAppPath(appPath) {
  const raw = String(appPath || "");
  const qIndex = raw.indexOf("?");
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const query = qIndex === -1 ? "" : raw.slice(qIndex + 1);
  const parts = path.split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const folder = FOLDERS.find((f) =>
    f.name.toLowerCase() === parts[0].toLowerCase()
  );
  if (!folder) return null;
  const item = (folder.items || []).find((i) =>
    i.name.toLowerCase() === parts[1].toLowerCase()
  );
  if (!item) return null;
  if (!query) return item;
  return {
    ...item,
    url: item.url + (item.url.includes("?") ? "&" : "?") + query,
  };
}

// Apply the current user's role default_home: [[appPath, side], …] where side
// is "left" | "right" (snap) or "none" (free placement). Unresolvable or
// RBAC-hidden entries are skipped with a warning. Replaces the old hardcoded
// warehouse boot block.
function applyDefaultHome() {
  const role = roleById(ROLE);
  const layout = (role && Array.isArray(role.default_home))
    ? role.default_home
    : [];
  let openedAny = false;
  for (const entry of layout) {
    const [appPath, side] = Array.isArray(entry) ? entry : [entry, "none"];
    const item = resolveAppPath(appPath);
    if (!item) {
      console.warn(`LP-OS: default_home entry not found: "${appPath}"`);
      continue;
    }
    if (!allows(item.flag) || !itemConfigured(item)) {
      console.warn(
        `LP-OS: default_home entry not available to this user: "${appPath}"`,
      );
      continue;
    }
    const win = openApp(item);
    if (!win) continue;
    openedAny = true;
    if (side === "left" || side === "right") snapWindow(win, side);
  }
  if (openedAny && statusEl) {
    statusEl.textContent = (USER && USER.name) || (role && role.name) || "";
  }
}

/* --------------------------------------------------------------- boot -- */

document.body.insertAdjacentHTML("afterbegin", ICON_GRADIENTS);
renderDesktop();
tickClock();
setInterval(tickClock, 15000);
connectScanRelay();

// User switcher (per-device; ?user= wins for this load). Lists USERS — the
// role is derived from the selected user. Options are rebuilt from RBAC.users
// so the shell also works if the server rendered none.
const userSwitch = document.getElementById("user-switch") ||
  document.getElementById("role-switch");
if (userSwitch) {
  userSwitch.innerHTML = "";
  for (const u of RBAC.users || []) {
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = u.name || u.id;
    userSwitch.appendChild(opt);
  }
  userSwitch.value = USER_ID;
  userSwitch.addEventListener("change", () => {
    localStorage.setItem(USER_KEY, userSwitch.value);
    // Keep ?user= in sync — it outranks localStorage, and the merged Chrome
    // extension reads it off the shell tab to resolve its mode.
    const url = new URL(location.href);
    url.searchParams.set("user", userSwitch.value);
    location.href = url.href; // reload so the boot layout re-applies cleanly
  });
}

// Boot order: pinned windows first, then the role's default_home layout on
// top of them, then (optionally) the E2E workspace.
restorePinnedWindows();
applyDefaultHome();

// E2E / demo workspace: ?workspace=samples-import[&ids=...&creator=@x&autostart=1]
// tiles the Samples-Import app (LEFT, auto-replaying the run's product ids) and
// Apps/Inventory (RIGHT, the imported rows in a table, editable/enhanceable via
// "Fetch from API"). The visual half of the sample-e2e skill. Reuses openApp +
// snapWindow; the ids/creator pass straight through to the import app's demo mode.
const wsParams = new URLSearchParams(location.search);
if (wsParams.get("workspace") === "samples-import") {
  const demos = (FOLDERS.find((f) => f.id === "demos") || {}).items || [];
  const importApp = demos.find((i) => i.id === "samples-import");
  const inventory = appItemById("inventory");
  if (importApp) {
    const q = new URLSearchParams();
    ["ids", "creator", "autostart", "api"].forEach((k) => {
      if (wsParams.get(k)) q.set(k, wsParams.get(k));
    });
    const qs = q.toString();
    const w = openApp({
      ...importApp,
      url: importApp.url + (qs ? "?" + qs : ""),
    });
    if (w) snapWindow(w, "left");
  }
  // Reuse an Inventory pane opened by pins/default_home rather than stacking a
  // second instance into the same two-pane workspace.
  let inv = windowsForApp("inventory")[0];
  if (!inv && inventory) inv = openApp(inventory);
  if (inv) snapWindow(inv, "right");
  if (statusEl) statusEl.textContent = "Samples-Import · e2e";
}
