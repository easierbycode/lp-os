// LP-OS shell server (apps/shell) — the wiring layer that turns the packages
// into the running core app. Fresh 2.x App used as the router (programmatic
// routes only — no islands/JSX, so no vite build step is needed; static assets
// are served by a tiny middleware below because Fresh's staticFiles() only
// works from a vite build cache).
//
// Every route degrades gracefully without DATABASE_URL: the shell page, static
// assets, relay/kiosk endpoints and stubs keep working; DB-backed APIs return
// 503 {error: "DATABASE_URL not configured"} instead of crashing.

import "./core/fresh-no-build.ts"; // before "fresh": hides DENO_DEPLOYMENT_ID
import { App } from "fresh";
import { fromFileUrl } from "@std/path";
import * as db from "@lp-os/db";
import { createScanRelay, type ScanRelayServer } from "@lp-os/relay";
import {
  CORS_HEADERS,
  createGraylogStore,
  type GraylogStore,
  handleGelfRequest,
  handleSearchRequest,
  handleSessionsStub,
  handleViewsStub,
} from "@lp-os/graylog";
import {
  createLifecycle,
  type Lifecycle,
  type LifecycleReads,
  listSampleStatuses,
} from "@lp-os/lifecycle";
import {
  accountConnected,
  computeEbayPrice,
  createListingService,
  type EbayPriceInput,
  type ListingService,
  type ListSampleInput,
  markdownLadder,
  startAutoLister,
} from "@lp-os/marketplace";
import {
  applyRolesConfig,
  DEFAULT_USER_ID,
  parseRolesConfig,
  persistRolesConfig,
  rbacClientConfig,
} from "./core/roles.ts";
import { APP_CATALOG } from "./core/catalog.ts";
import { createProductAnalysis } from "./core/product-analysis.ts";
import { createSampleImage } from "./core/sample-image.ts";
import {
  ExternalApiDisabledError,
  externalApiEnabled,
  externalApiStates,
} from "./core/external-apis.ts";

/* ------------------------------------------------------------------ env -- */

function envValue(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined; // no --allow-env: run on defaults
  }
}

const hasDb = Boolean((envValue("DATABASE_URL") ?? "").trim());

function ebayEnvCredentials(): Record<string, unknown> {
  const pairs = [
    ["clientId", "EBAY_CLIENT_ID"],
    ["clientSecret", "EBAY_CLIENT_SECRET"],
    ["refreshToken", "EBAY_REFRESH_TOKEN"],
    ["accessToken", "EBAY_ACCESS_TOKEN"],
  ] as const;
  const credentials: Record<string, unknown> = {};
  for (const [key, name] of pairs) {
    const value = (envValue(name) ?? "").trim();
    if (value) credentials[key] = value;
  }
  return credentials;
}

function emptyMarketplaceAccount(marketplace: string): db.MarketplaceAccount {
  return {
    marketplace,
    environment: marketplace === "ebay" &&
        envValue("EBAY_ENVIRONMENT") === "production"
      ? "production"
      : "sandbox",
    credentials: marketplace === "ebay" ? ebayEnvCredentials() : {},
    settings: {},
    connected_at: null,
    updated_at: new Date(0).toISOString(),
    updated_by: null,
  };
}

/** Merge server-side credential fallbacks with the database row without ever
 * persisting or exposing secret values. Values saved in Marketplace win. */
async function effectiveMarketplaceAccount(
  marketplace: string,
): Promise<db.MarketplaceAccount> {
  const fallback = emptyMarketplaceAccount(marketplace);
  const stored = await db.getMarketplaceAccount(marketplace);
  if (!stored) return fallback;
  return {
    ...stored,
    credentials: { ...fallback.credentials, ...(stored.credentials ?? {}) },
  };
}

async function effectiveMarketplaceAccounts(): Promise<
  db.MarketplaceAccount[]
> {
  const stored = await db.listMarketplaceAccounts();
  const names = new Set(stored.map((account) => account.marketplace));
  names.add("ebay");
  return await Promise.all([...names].sort().map(effectiveMarketplaceAccount));
}

/* ----------------------------------------------------------- singletons -- */

// Origins allowed on the scan-relay WebSocket. data-pimp baked in the two
// production hosts (the kiosk lives at thirsty.store, the scanner/Inventory
// companions at admin.thirsty.store); keep them, plus the origins of every
// configured companion app URL, so the default deployment accepts the
// scanner page's cross-origin socket without extra env.
const SCAN_RELAY_DEFAULT_ORIGINS = [
  "https://thirsty.store",
  "https://admin.thirsty.store",
];

function scanRelayAllowedOrigins(): string[] {
  const cfg = osClientConfig();
  const origins = new Set<string>(SCAN_RELAY_DEFAULT_ORIGINS);
  for (
    const value of [cfg.scannerAppUrl, cfg.inventoryAppUrl, cfg.memberAppUrl]
  ) {
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // malformed companion URL — the relay's own-origin/localhost rules apply
    }
  }
  return [...origins];
}

// Lazy so importing main.ts (tests) doesn't start the relay's prune timer or
// the pg bridge; the boot path below initializes it eagerly before listen.
let relayInstance: ScanRelayServer | null = null;
function relay(): ScanRelayServer {
  relayInstance ??= createScanRelay({
    allowedOrigins: scanRelayAllowedOrigins(),
    ...(hasDb ? { pool: db.getPool() } : {}),
  });
  return relayInstance;
}

const store: GraylogStore | null = hasDb
  ? createGraylogStore(db.getPool())
  : null;

// @lp-os/lifecycle's GraylogStore interface uses the same param names as the
// real store (`rangeSeconds`), so the store satisfies it directly — no adapter.
const lifecycle: (Lifecycle & LifecycleReads) | null = store
  ? createLifecycle({
    db,
    store,
    // Atomic Inventory Workbench writes (PATCH /api/samples/bulk).
    inventory: { applyBatch: (request) => db.applyInventoryBatch(request) },
  })
  : null;

// Real marketplace listings (eBay first). Saved credentials/settings live in
// marketplace_accounts; EBAY_* environment variables are safe fallbacks.
const listingService: ListingService | null = store && lifecycle
  ? createListingService({
    db,
    store,
    lifecycle,
    getAccount: effectiveMarketplaceAccount,
    listAccounts: effectiveMarketplaceAccounts,
  })
  : null;

/* -------------------------------------------------------------- helpers -- */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// Same permissive CORS the data-pimp routes carried (sample-sold/import are
// POSTed cross-origin by the tracker and the Samples-Import demo).
function corsJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

function dbUnavailable(cors = false): Response {
  const body = { error: "DATABASE_URL not configured" };
  return cors ? corsJson(body, 503) : json(body, 503);
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Expected a JSON object body");
  }
  return body as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Escape a value for interpolation into HTML text / double-quoted attributes.
function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function publicHttpBaseUrl(value: string | undefined): string {
  const raw = (value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// MEMBER_APP_URL: absolute URL (split deploy) or "/"-prefixed same-origin
// path. Default: the mounted /member handler; standalone-dev fallback moves
// to http://localhost:8080/member (kit.paths.base applies in dev too).
function memberBaseValue(value: string | undefined): string {
  const raw = (value || "").trim();
  if (raw.startsWith("/")) return raw.replace(/\/+$/, "") || "/member";
  return publicHttpBaseUrl(raw) ||
    (memberHandler ? "/member" : "http://localhost:8080/member");
}

/* ------------------------------------------------------------- OS shell -- */

// globalThis.LPOS_OS_CONFIG — keys read by static/os.js. scanRelay stays ""
// (same-origin): os.js derives ws(s)://<host>/api/scan-socket itself.
function osClientConfig(): Record<string, string> {
  return {
    scanRelay: "",
    memberAppUrl: memberBaseValue(envValue("MEMBER_APP_URL")),
    memberWebUrl: publicHttpBaseUrl(envValue("MEMBER_WEB_URL")) ||
      "https://data-pimp.easierbycode.deno.net/member",
    scannerAppUrl: publicHttpBaseUrl(envValue("SCANNER_APP_URL")),
    inventoryAppUrl: publicHttpBaseUrl(envValue("INVENTORY_APP_URL")) ||
      "https://admin.thirsty.store",
    // Lifepreneur member site (lifepreneur-v1). Override with
    // LIFEPRENEUR_URL to point at a locally running instance.
    lifepreneurUrl: publicHttpBaseUrl(envValue("LIFEPRENEUR_URL")) ||
      "https://www.lifepreneur.io",
    graylogBase: publicHttpBaseUrl(
      envValue("GRAYLOG_UI_URL") || envValue("GRAYLOG_SEARCH_URL"),
    ),
  };
}

function resolveUserId(url: URL): string {
  return (url.searchParams.get("user") || "").trim() || DEFAULT_USER_ID;
}

// Ported from data-pimp renderOSShell (rebranded LP-OS). The taskbar renders a
// USER switcher (os.js rebuilds its options from RBAC.users, but the initial
// paint is server-side). `<` is escaped in inlined JSON so config values can't
// break out of the <script>.
function renderOSShell(url: URL): Response {
  const rbac = rbacClientConfig(resolveUserId(url));
  const userOptions = rbac.users
    .map((u) =>
      `<option value="${escapeHtml(u.id)}"${
        u.id === rbac.currentUser.id ? " selected" : ""
      }>${escapeHtml(u.name)}</option>`
    )
    .join("\n          ");
  const rbacJson = JSON.stringify(rbac).replace(/</g, "\\u003c");
  const osConfigJson = JSON.stringify(osClientConfig()).replace(
    /</g,
    "\\u003c",
  );
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>LP-OS</title>
    <meta name="theme-color" content="#0b0d11">
    <link rel="manifest" href="/manifest.webmanifest">
    <link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/icons/icon-192.png">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&amp;family=Figtree:wght@400;500;600;700;800&amp;display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/os.css">
  </head>
  <body>
    <main id="desktop" class="desktop" aria-label="Desktop">
      <div id="desktop-icons" class="desktop-icons" aria-label="Desktop items"></div>
    </main>
    <footer id="taskbar" class="taskbar" aria-label="Taskbar">
      <div class="taskbar-left">
        <span class="brand"><span class="brand-mark">◆</span> LP-OS</span>
        <span id="active-app" class="active-app" aria-live="polite" aria-atomic="true">Finder</span>
        <span id="menubar-status" class="mb-status"></span>
        <select id="user-switch" class="user-switch" aria-label="User" title="Switch user">
          ${userOptions}
        </select>
      </div>
      <div id="dock" class="dock" aria-label="Dock"></div>
      <div class="taskbar-right">
        <span id="clock" class="clock tnum"></span>
      </div>
    </footer>
    <script>globalThis.LPOS_RBAC = ${rbacJson};
    globalThis.LPOS_OS_CONFIG = ${osConfigJson};
    globalThis.LPOS_SCAN_RELAY = globalThis.LPOS_OS_CONFIG.scanRelay || "";</script>
    <script type="module" src="/os.js"></script>
    <script>
    if ("serviceWorker" in navigator) {
      addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      });
    }
    </script>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/* --------------------------------------------------------------- static -- */

const STATIC_ROOT = new URL("./static/", import.meta.url);
const MIME_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
};

// apps/shell/static served at root paths (/os.js, /os.css, icons, ...).
async function serveStatic(
  pathname: string,
  method: string,
): Promise<Response | null> {
  if (method !== "GET" && method !== "HEAD") return null;
  const rel = pathname.replace(/^\/+/, "");
  if (!rel || rel.includes("..") || rel.includes("\\")) return null;
  let fileUrl: URL;
  try {
    fileUrl = new URL(rel, STATIC_ROOT);
  } catch {
    return null;
  }
  if (!fileUrl.href.startsWith(STATIC_ROOT.href)) return null;
  try {
    const bytes = await Deno.readFile(fileUrl);
    const dot = rel.lastIndexOf(".");
    const type = (dot >= 0 ? MIME_TYPES[rel.slice(dot).toLowerCase()] : null) ??
      "application/octet-stream";
    return new Response(method === "HEAD" ? null : bytes, {
      headers: { "content-type": type, "cache-control": "no-cache" },
    });
  } catch {
    return null; // missing file or directory → fall through to routes
  }
}

// /scan-client.js — built from @lp-os/relay's browser client on first request
// (contract: "built from @lp-os/relay client or a thin re-export"). Cached for
// the process lifetime; needs --allow-run (dev/start tasks run with -A).
let scanClientCache:
  | { ok: true; code: string }
  | { ok: false; error: string }
  | null = null;

async function buildScanClient(): Promise<
  { ok: true; code: string } | { ok: false; error: string }
> {
  try {
    const entry = fromFileUrl(
      new URL("../../packages/relay/client.ts", import.meta.url),
    );
    const cwd = fromFileUrl(new URL("../..", import.meta.url));
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["bundle", "--platform", "browser", entry],
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!out.success) {
      return { ok: false, error: new TextDecoder().decode(out.stderr) };
    }
    return { ok: true, code: new TextDecoder().decode(out.stdout) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/* ---------------------------------------------------------------- app ---- */

export const app: App<unknown> = new App();

// Static assets first — only claims requests whose file actually exists.
app.use(async (ctx) => {
  const res = await serveStatic(ctx.url.pathname, ctx.req.method);
  return res ?? await ctx.next();
});

app.get("/", (ctx) => renderOSShell(ctx.url));

// Extension install help (Apps → Install Extension / the samples-import
// skill). Extensionless path, so the static middleware can't claim it.
app.get("/install", async (ctx) => {
  const res = await serveStatic("/install.html", ctx.req.method);
  return res ?? json({ error: "install page missing" }, 500);
});

// Marketplace window (eBay credentials + listings). Same pattern as /install.
app.get("/marketplace", async (ctx) => {
  const res = await serveStatic("/marketplace.html", ctx.req.method);
  return res ?? json({ error: "marketplace page missing" }, 500);
});

// Admin window (users, roles, capability flags, per-role boot layout). Static
// page; it fetches /api/roles + /api/catalog and saves back via POST /api/roles.
app.get("/admin", async (ctx) => {
  const res = await serveStatic("/admin.html", ctx.req.method);
  return res ?? json({ error: "admin page missing" }, 500);
});

// CSS-3D warehouse dashboard (Apps → Warehouse). Same pattern as /install.
// Walking its steps posts warehouse-step messages to os.js, which opens the
// matching app windows beside it.
app.get("/warehouse", async (ctx) => {
  const res = await serveStatic("/warehouse.html", ctx.req.method);
  return res ?? json({ error: "warehouse page missing" }, 500);
});

// One-click sample-lifecycle demo (Demos/E2E), ported from data-pimp. Same
// pattern as /install; its APIs live in the demos/e2e section below.
app.get("/e2e", async (ctx) => {
  const res = await serveStatic("/e2e.html", ctx.req.method);
  return res ?? json({ error: "e2e page missing" }, 500);
});

// Interactive eBay pricing-formula demo (Demos → eBay Pricing), product-first
// over the live catalog. Data-pimp served this at the same path; kept so old
// links keep working. Backed by /api/products + /api/ebay-price below.
app.get("/demos/ebay-pricing", async (ctx) => {
  const res = await serveStatic("/ebay-pricing.html", ctx.req.method);
  return res ?? json({ error: "ebay-pricing page missing" }, 500);
});

// /extension.zip — the merged Chrome extension zipped for the /install page's
// download. The static middleware serves the prebuilt static/extension.zip
// when the build task has run; this fallback zips the repo's extension/
// folder on first request (dev servers), cached for the process lifetime.
let extensionZipCache: Uint8Array | null = null;
app.get("/extension.zip", async () => {
  if (!extensionZipCache) {
    try {
      const { buildExtensionZip } = await import(
        "./scripts/build-extension-zip.ts"
      );
      extensionZipCache = await buildExtensionZip();
    } catch (error) {
      return json(
        { error: "extension zip unavailable", detail: errorMessage(error) },
        503,
      );
    }
  }
  return new Response(extensionZipCache.slice(), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="lp-os-extension.zip"',
      "cache-control": "no-cache",
    },
  });
});

app.get("/scan-client.js", async () => {
  scanClientCache ??= await buildScanClient();
  if (!scanClientCache.ok) {
    return json({
      error: "scan-client bundle failed",
      detail: scanClientCache.error,
    }, 503);
  }
  return new Response(scanClientCache.code, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
});

/* ----------------------------------------------------------- member app -- */
// apps/member builds (deno task --cwd apps/member build, or root build:deploy)
// into apps/member/.deno-deploy with kit.paths.base = "/member". The adapter
// handler is a plain Deno.ServeHandler; the built SvelteKit server strips the
// /member base itself, so requests pass through UNSTRIPPED. Computed-URL
// dynamic import so `deno check` never follows it and dev boots fine without
// the build (503 on /member instead). Runtime bare specifiers
// (@sveltejs/kit/internal/server, clsx, cookie, devalue, set-cookie-parser)
// resolve via the ROOT deno.json import map — exact pins, keep in lockstep
// with apps/member/package.json.
const MEMBER_DD = new URL("../member/.deno-deploy/", import.meta.url);

type MemberHandler = (
  req: Request,
  info: Deno.ServeHandlerInfo,
) => Response | Promise<Response>;

async function loadMemberHandler(): Promise<MemberHandler | null> {
  try {
    const [{ prepareServer }, deployConfig, svelteData] = await Promise.all([
      import(new URL("handler.ts", MEMBER_DD).href),
      Deno.readTextFile(new URL("deploy.json", MEMBER_DD)).then(JSON.parse),
      Deno.readTextFile(new URL("svelte.json", MEMBER_DD)).then(JSON.parse),
    ]);
    // 3rd arg: the root deploy.json's relative ".deno-deploy/..." destinations
    // resolve against — must be apps/member, NOT Deno.cwd().
    return prepareServer(
      svelteData,
      deployConfig,
      fromFileUrl(new URL("../member/", import.meta.url)),
    );
  } catch (error) {
    console.warn(
      `[lp-os] member app not mounted (${errorMessage(error)}); ` +
        "set MEMBER_APP_URL or run: deno task --cwd apps/member build",
    );
    return null;
  }
}

const memberHandler = await loadMemberHandler();

const memberRoute = async (
  ctx: { req: Request; info: Deno.ServeHandlerInfo },
) =>
  memberHandler
    ? await memberHandler(ctx.req, ctx.info)
    : json({ error: "member app not built" }, 503);
app.all("/member", memberRoute); // "/member/*" alone doesn't match the bare path
app.all("/member/*", memberRoute);

/* ------------------------------------------------- relay + kiosk fleet -- */

app.get("/api/scan-socket", (ctx) => relay().handleUpgrade(ctx.req));

app.post("/api/heartbeat", async (ctx) => {
  let body: Record<string, unknown> = {};
  try {
    const parsed = await ctx.req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // empty/non-JSON body: legacy kiosks send only the x-kiosk-id header
  }
  if (body.id == null && body.kioskId == null) {
    const headerId = ctx.req.headers.get("x-kiosk-id");
    if (headerId) body.id = headerId;
  }
  const info = relay().heartbeat(body);
  return json({ ok: true, disabled: info.disabled });
});

app.get("/api/kiosks", () => json(relay().kiosks()));

function kioskToggle(disabled: boolean) {
  return (ctx: { params: Record<string, string> }) => {
    const id = decodeURIComponent(ctx.params.id || "");
    const info = relay().setKioskDisabled(id, disabled);
    return json({ ok: true, id: info?.id ?? id, disabled });
  };
}
app.post("/api/kiosks/:id/disable", kioskToggle(true));
app.patch("/api/kiosks/:id/disable", kioskToggle(true));
app.post("/api/kiosks/:id/enable", kioskToggle(false));
app.patch("/api/kiosks/:id/enable", kioskToggle(false));

/* ------------------------------------------------------ graylog surface -- */

// OPTIONS preflights must work even without a DB (the handlers' own CORS).
function graylogPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

app.all("/gelf", async (ctx) => {
  if (ctx.req.method === "OPTIONS") return graylogPreflight();
  if (ctx.req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!store) return dbUnavailable();
  return await handleGelfRequest(store, ctx.req);
});

app.all("/api/search/universal/relative", async (ctx) => {
  if (ctx.req.method === "OPTIONS") return graylogPreflight();
  if (ctx.req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!store) return dbUnavailable();
  return await handleSearchRequest(store, ctx.req);
});

app.all("/api/system/sessions", (ctx) => handleSessionsStub(ctx.req));
app.all("/api/views", (ctx) => handleViewsStub(ctx.req));

app.get("/health", async () => {
  const externalApis = externalApiStates(envValue);
  if (!store) {
    return json({ ok: true, db: false, newestStoredMs: null, externalApis });
  }
  try {
    return json({
      ok: true,
      db: true,
      newestStoredMs: await store.newestTimestampMs(),
      externalApis,
    });
  } catch (error) {
    return json({ ok: false, db: true, error: errorMessage(error) }, 500);
  }
});

/* ------------------------------------------------------ inventory CRUD -- */
// Param conventions ported from data-pimp: `order_by` (default -created_date,
// aliased to created_at by @lp-os/db), `limit`, every other query param is a
// filter. 201 on create, 204 on delete, PATCH returns the row (null on miss).

function parseLimit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  return raw ? parseInt(raw, 10) : undefined;
}

function collectFilters(url: URL, exclude: string[]): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (!exclude.includes(key)) filters[key] = value;
  }
  return filters;
}

app.all("/api/samples", async (ctx) => {
  if (!hasDb) return dbUnavailable();
  try {
    if (ctx.req.method === "GET") {
      const orderBy = ctx.url.searchParams.get("order_by") || "-created_date";
      const filters = collectFilters(ctx.url, ["order_by", "limit"]);
      const data = Object.keys(filters).length > 0
        ? await db.Samples.filter(filters, orderBy, parseLimit(ctx.url))
        : await db.Samples.list(orderBy);
      return json(data);
    }
    if (ctx.req.method === "POST") {
      const created = await db.Samples.create(await ctx.req.json());
      return json(created, 201);
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

// Atomic Inventory Workbench bulk edit — MUST be registered before
// /api/samples/:id so "bulk" is never captured as an :id. All-or-nothing:
// either every mutation commits (rows + audit transactions + batch record)
// or none do. Idempotent by requestId. CORS: the tracker at
// admin.thirsty.store PATCHes this cross-origin.
app.all("/api/samples/bulk", async (ctx) => {
  if (ctx.req.method === "OPTIONS") return corsPreflight();
  if (ctx.req.method !== "PATCH") {
    return corsJson({ ok: false, error: "Method not allowed" }, 405);
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(ctx.req) as Record<string, unknown>;
  } catch (error) {
    return corsJson({ ok: false, error: errorMessage(error) }, 400);
  }
  if (!lifecycle) return dbUnavailable(true);
  try {
    // Operator attribution comes from the shell's mocked ?user= profile —
    // a client-supplied operator label never overrides it.
    const result = await lifecycle.recordBulkSampleEdit({
      requestId: typeof body.requestId === "string" ? body.requestId : "",
      note: typeof body.note === "string" ? body.note : undefined,
      mutations: Array.isArray(body.mutations)
        ? body.mutations as {
          sampleId?: number;
          expectedVersion?: number;
          patch?: Record<string, unknown>;
        }[]
        : [],
      operator: resolveUserId(ctx.url),
    });
    return corsJson(result);
  } catch (error) {
    const kind = (error as { kind?: string }).kind;
    const details = (error as { details?: unknown }).details;
    const status = kind === "validation"
      ? 400
      : kind === "not_found"
      ? 404
      : kind === "conflict"
      ? 409
      : errorMessage(error).includes("not a valid sample status") ||
          errorMessage(error).includes("sold flow")
      ? 400
      : 500;
    return corsJson(
      { ok: false, error: errorMessage(error), details: details ?? undefined },
      status,
    );
  }
});

// Barcode lookup for the workbench batch-scan mode: every sample whose
// qr_code or related_upc matches, plus bundles sharing the QR. Registered
// before /api/samples/:id for the same literal-segment reason as /bulk.
app.all("/api/samples/lookup", async (ctx) => {
  if (ctx.req.method === "OPTIONS") return corsPreflight();
  if (ctx.req.method !== "GET") {
    return corsJson({ error: "Method not allowed" }, 405);
  }
  const code = (ctx.url.searchParams.get("code") || "").trim();
  if (!code) return corsJson({ error: "code query param required" }, 400);
  if (!hasDb) return dbUnavailable(true);
  try {
    return corsJson(await db.lookupSamplesByCode(code));
  } catch (error) {
    return corsJson({ error: errorMessage(error) }, 500);
  }
});

app.all("/api/samples/:id", async (ctx) => {
  if (!hasDb) return dbUnavailable();
  try {
    if (ctx.req.method === "PATCH") {
      const updated = await db.Samples.update(
        ctx.params.id,
        await ctx.req.json(),
      );
      return json(updated);
    }
    if (ctx.req.method === "DELETE") {
      await db.Samples.delete(ctx.params.id);
      return new Response(null, { status: 204 });
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

app.all("/api/bundles", async (ctx) => {
  if (!hasDb) return dbUnavailable();
  try {
    if (ctx.req.method === "GET") {
      const orderBy = ctx.url.searchParams.get("order_by") || "-created_date";
      // data-pimp quirk kept: bundles only excludes order_by, and a filtered
      // read doesn't apply order/limit.
      const filters = collectFilters(ctx.url, ["order_by"]);
      const data = Object.keys(filters).length > 0
        ? await db.Bundles.filter(filters)
        : await db.Bundles.list(orderBy);
      return json(data);
    }
    if (ctx.req.method === "POST") {
      const created = await db.Bundles.create(await ctx.req.json());
      return json(created, 201);
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

app.all("/api/bundles/:id", async (ctx) => {
  if (!hasDb) return dbUnavailable();
  try {
    if (ctx.req.method === "PATCH") {
      const updated = await db.Bundles.update(
        ctx.params.id,
        await ctx.req.json(),
      );
      return json(updated);
    }
    if (ctx.req.method === "DELETE") {
      await db.Bundles.delete(ctx.params.id);
      return new Response(null, { status: 204 });
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

app.all("/api/transactions", async (ctx) => {
  if (!hasDb) return dbUnavailable();
  try {
    if (ctx.req.method === "GET") {
      const orderBy = ctx.url.searchParams.get("order_by") || "-created_date";
      const filters = collectFilters(ctx.url, ["order_by", "limit"]);
      const data = await db.Transactions.filter(
        filters,
        orderBy,
        parseLimit(ctx.url),
      );
      return json(data);
    }
    if (ctx.req.method === "POST") {
      const created = await db.Transactions.create(await ctx.req.json());
      return json(created, 201);
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

app.all("/api/transactions/:id", async (ctx) => {
  if (!hasDb) return dbUnavailable();
  try {
    if (ctx.req.method === "DELETE") {
      await db.Transactions.delete(ctx.params.id);
      return new Response(null, { status: 204 });
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

/* --------------------------------------------------- lifecycle endpoints -- */
// Thin wrappers over @lp-os/lifecycle. Validation failures return a clean 400
// {ok:false, error} (data-pimp convention) so the MCP/skills surface reasons.
// sample-sold and sample-import carry CORS (POSTed cross-origin).

type LifecycleCall = (
  lc: Lifecycle & LifecycleReads,
  // deno-lint-ignore no-explicit-any
  body: any,
) => Promise<unknown>;

function lifecycleRoute(cors: boolean, call: LifecycleCall) {
  return async (ctx: { req: Request }) => {
    if (cors && ctx.req.method === "OPTIONS") return corsPreflight();
    const respond = cors ? corsJson : json;
    if (ctx.req.method !== "POST") {
      return respond({ ok: false, error: "Method not allowed" }, 405);
    }
    if (!lifecycle) return dbUnavailable(cors);
    try {
      return respond(await call(lifecycle, await readJsonBody(ctx.req)));
    } catch (error) {
      return respond({ ok: false, error: errorMessage(error) }, 400);
    }
  };
}

app.all(
  "/api/sample-status",
  lifecycleRoute(false, (lc, b) => lc.recordSampleStatus(b)),
);
app.all(
  "/api/sample-sold",
  lifecycleRoute(true, (lc, b) => lc.recordSampleSold(b)),
);
app.all(
  "/api/sample-listing",
  lifecycleRoute(false, (lc, b) => lc.recordSampleListing(b)),
);
app.all(
  "/api/sample-bulk-sold",
  lifecycleRoute(false, (lc, b) => lc.recordBulkSampleSold(b)),
);
app.all(
  "/api/agency-intake",
  lifecycleRoute(false, (lc, b) => lc.recordAgencyIntake(b)),
);
app.all(
  "/api/sample-assign",
  lifecycleRoute(false, (lc, b) => lc.recordSampleAssignment(b)),
);
app.all(
  "/api/sample-import",
  lifecycleRoute(true, (lc, b) => lc.recordSampleImport(b)),
);

/* --------------------------------------------------- vocab/config reads -- */
// Read-only vocab/config, carrying the same permissive CORS as /api/products:
// the Inventory companion (admin.thirsty.store) reads these cross-origin, so a
// plain json() with no access-control-allow-origin gets blocked by the browser.

app.all("/api/sample-statuses", (ctx) => {
  if (ctx.req.method === "OPTIONS") return corsPreflight();
  if (ctx.req.method !== "GET") {
    return corsJson({ error: "Method not allowed" }, 405);
  }
  return corsJson(listSampleStatuses());
});

app.all("/api/creators", async (ctx) => {
  if (ctx.req.method === "OPTIONS") return corsPreflight();
  if (ctx.req.method !== "GET") {
    return corsJson({ error: "Method not allowed" }, 405);
  }
  if (!lifecycle) return dbUnavailable(true);
  try {
    const raw = Number(ctx.url.searchParams.get("limit"));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 1000;
    return corsJson({ creators: await lifecycle.fetchKnownCreators(limit) });
  } catch (error) {
    return corsJson({ error: errorMessage(error) }, 500);
  }
});

app.all("/api/roles", async (ctx) => {
  if (ctx.req.method === "OPTIONS") return corsPreflight();
  if (ctx.req.method === "GET") {
    return corsJson(rbacClientConfig(resolveUserId(ctx.url)));
  }
  // Save from the Admin window (static/admin.js): validate the whole config,
  // swap it in-memory (the OS shell picks it up on its next paint), then
  // best-effort rewrite roles.json. Not an auth boundary — like every RBAC
  // flag, this is UX gating on a mock-login OS (see core/roles.ts).
  if (ctx.req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(ctx.req);
    } catch (error) {
      return corsJson({ ok: false, error: errorMessage(error) }, 400);
    }
    const parsed = parseRolesConfig(body.config ?? body);
    if (!parsed.ok || !parsed.config) {
      return corsJson(
        { ok: false, error: parsed.error ?? "invalid config" },
        400,
      );
    }
    applyRolesConfig(parsed.config);
    const { persisted, error } = await persistRolesConfig();
    // A read-only FS (Deno Deploy) means the edit is live but won't survive a
    // restart — report it so the UI can say so, but the save still "succeeded".
    return corsJson({
      ok: true,
      persisted,
      ...(persisted ? {} : { persistError: error }),
      config: rbacClientConfig(resolveUserId(ctx.url)),
    });
  }
  return corsJson({ error: "Method not allowed" }, 405);
});

// The desktop launcher catalog the Admin window edits against (folders/apps a
// role's flags gate, and the names its boot layout may point at). Read-only
// mirror of os.js FOLDERS; CORS like the other vocab reads.
app.all("/api/catalog", (ctx) => {
  if (ctx.req.method === "OPTIONS") return corsPreflight();
  if (ctx.req.method !== "GET") {
    return corsJson({ error: "Method not allowed" }, 405);
  }
  return corsJson(APP_CATALOG);
});

/* ------------------------------------------------------------- demos/e2e -- */
// APIs behind the /e2e demo page, ported from data-pimp. All carry CORS like
// data-pimp's did (the tracker and Demos pages consume them cross-origin), and
// all fail soft — the page falls back to its built-in demo batch.

// Kiosk-catalog shape the /e2e page (and the tracker's audit search) expects.
// data-pimp additionally merged Graylog-only samples into this catalog; the
// Postgres samples table is the whole catalog here (revisit with /inventory).
function sampleRowToKioskProduct(row: Record<string, unknown>) {
  const price = Number(row.current_price) || 0;
  const creator = String(row.creator ?? row.creator_handle ?? "").trim() ||
    null;
  return {
    productId: String(row.qr_code ?? "").trim(),
    name: String(row.name ?? "").trim(),
    priceRange: price > 0 ? `$${price.toFixed(2)}` : "",
    min_sku_original_price: price,
    category: "",
    seller: row.brand ? String(row.brand) : "Unknown seller",
    sampleCount: 0,
    estimatedRetailValue: 0,
    lastSeen: row.created_at
      ? new Date(String(row.created_at)).toISOString()
      : null,
    image: row.picture_url ? String(row.picture_url) : null,
    creator,
    creatorHandle: creator,
    creator_handle: creator,
  };
}

app.all("/api/products", async (ctx) => {
  if (ctx.req.method === "OPTIONS") return corsPreflight();
  if (ctx.req.method !== "GET") {
    return corsJson({ error: "Method not allowed" }, 405);
  }
  if (!hasDb) return corsJson([]); // demo page falls back to its own batch
  try {
    const rows = await db.Samples.list("-created_at") as Record<
      string,
      unknown
    >[];
    return corsJson(
      rows.map(sampleRowToKioskProduct).filter((p) => p.productId && p.name),
    );
  } catch (error) {
    return corsJson({ error: errorMessage(error) }, 500);
  }
});

// Exact TikTok PDP hydration for Samples-Import and Inventory. This is the
// pre-migration /api/product-lookup contract, now backed by the same
// ScrapeCreators client as Product Analysis.
app.all("/api/product-lookup/:id", async (ctx) => {
  if (ctx.req.method === "OPTIONS") return corsPreflight();
  if (ctx.req.method !== "GET") {
    return corsJson({ ok: false, error: "Method not allowed" }, 405);
  }
  try {
    const product = await productAnalysis.lookupProductDetails(
      decodeURIComponent(ctx.params.id || ""),
      ctx.url.searchParams.get("name") || undefined,
    );
    return corsJson(product);
  } catch (error) {
    if (error instanceof ExternalApiDisabledError) {
      return corsJson({ ok: false, error: error.message }, 503);
    }
    return corsJson({ ok: false, error: errorMessage(error) }, 502);
  }
});

// Context for the one-click E2E demo: the latest creator to post plus a few of
// their recent product_ids. Ported from data-pimp's fetchE2EContext, asking
// the graylog_messages store instead of an external Graylog. Priority: latest
// order_list creator → latest sold creator → any known creator → static
// default. Always returns something usable.
const E2E_DEFAULT_PRODUCT_ID = "1729527400425427463";
const E2E_RANGE_SECONDS = 60 * 60 * 24 * 365 * 2;

async function fetchE2EContext(
  defaultId: string,
): Promise<{ creator: string; ids: string[]; source: string }> {
  const fallback = {
    creator: "@e2e-demo",
    ids: [defaultId],
    source: "default",
  };
  if (!store || !lifecycle) {
    return { ...fallback, source: "default (db unconfigured)" };
  }

  // The most recent up-to-3 distinct product_ids belonging to `creator`.
  // store.search orders newest-first, so index 0 is the latest message.
  const recentIdsFor = (
    messages: { message: Record<string, unknown> }[],
    creator: string,
  ): string[] => {
    const ids: string[] = [];
    for (const { message: m } of messages) {
      if (String(m.creator ?? "").trim() !== creator) continue;
      const pid = String(m.product_id ?? "").trim();
      if (pid && !ids.includes(pid)) ids.push(pid);
      if (ids.length >= 3) break;
    }
    return ids;
  };

  try {
    // "Latest creator to post" = most recent order_list scrape.
    const orders = await store.search({
      query: "source:tiktok-bookmarklet-orders AND creator:*",
      rangeSeconds: E2E_RANGE_SECONDS,
      limit: 100,
      fields: ["timestamp", "creator", "product_id"],
    });
    if (orders.messages.length) {
      const creator = String(orders.messages[0].message.creator ?? "").trim();
      if (creator) {
        const ids = recentIdsFor(orders.messages, creator);
        if (ids.length) {
          return {
            creator,
            ids,
            source: "graylog: latest creator order_list items",
          };
        }
      }
    }
    // Fallback: latest resale (sold) creator + their sold items.
    const sold = await store.search({
      query: "sample_sold_json:* AND creator:*",
      rangeSeconds: E2E_RANGE_SECONDS,
      limit: 100,
      fields: ["timestamp", "creator", "product_id"],
    });
    if (sold.messages.length) {
      const creator = String(sold.messages[0].message.creator ?? "").trim();
      if (creator) {
        const ids = recentIdsFor(sold.messages, creator);
        if (ids.length) {
          return { creator, ids, source: "graylog: latest creator sold items" };
        }
        return {
          creator,
          ids: [defaultId],
          source: "graylog: latest sold creator + default id",
        };
      }
    }
    // Fallback: any known creator + the default product.
    const known = await lifecycle.fetchKnownCreators(1);
    if (known.length) {
      return {
        creator: known[0],
        ids: [defaultId],
        source: "graylog: known creator + default id",
      };
    }
  } catch {
    return { ...fallback, source: "default (graylog error)" };
  }
  return fallback;
}

app.all("/api/e2e-context", async (ctx) => {
  if (ctx.req.method === "OPTIONS") return corsPreflight();
  const def = (ctx.url.searchParams.get("id") || E2E_DEFAULT_PRODUCT_ID)
    .trim();
  return corsJson(await fetchE2EContext(def));
});

// eBay pricing formula (packages/marketplace/ebay-pricing.ts) — pure and
// stateless, so it must work without DATABASE_URL. data-pimp's optional
// autoComps=1 live-eBay comps path is not ported (its scraper + file cache
// don't fit Deploy); with no comps supplied the formula anchors on retail,
// exactly as data-pimp degrades when eBay is unreachable.
app.all("/api/ebay-price", async (ctx) => {
  if (ctx.req.method === "OPTIONS") return corsPreflight();
  try {
    const q = ctx.url.searchParams;
    const body = ctx.req.method === "POST" ? await readJsonBody(ctx.req) : {};
    // Coerce any picked value (body value or query string) to string | number
    // | undefined — the formula parses "$25.00"-style strings itself.
    const pick = (k: string): string | number | undefined => {
      const v = body[k];
      if (typeof v === "number" || typeof v === "string") return v;
      if (v !== undefined && v !== null) return String(v);
      const qv = q.get(k);
      return qv === null ? undefined : qv;
    };
    // Comps: JSON body array, a comma-separated string body, or a
    // comma-separated ?comps=25,28,30 query.
    const comps: Array<string | number> = Array.isArray(body.comps)
      ? (body.comps as unknown[]).map((x) =>
        typeof x === "number" ? x : String(x)
      )
      : (typeof body.comps === "string" ? body.comps : (q.get("comps") || ""))
        .split(",").map((s) => s.trim()).filter(Boolean);
    const input: EbayPriceInput = {
      retail: pick("retail"),
      costBasis: pick("costBasis"),
      comps,
      condition: typeof pick("condition") === "string"
        ? pick("condition") as string
        : undefined,
      daysListed: pick("daysListed"),
      feePct: pick("feePct"),
      fixedFee: pick("fixedFee"),
      shipping: pick("shipping"),
      minMarginAbs: pick("minMarginAbs"),
      minMarginPct: pick("minMarginPct"),
      undercutPct: pick("undercutPct"),
      markdownSchedule: (body.markdownSchedule ?? undefined) as EbayPriceInput[
        "markdownSchedule"
      ],
    };
    const result = computeEbayPrice(input);
    const wantLadder = q.get("ladder") === "1" || body.ladder === true;
    return corsJson({
      ...result,
      compsSource: comps.length ? "provided" : "none",
      ...(wantLadder ? { ladder: markdownLadder(input) } : {}),
    });
  } catch (error) {
    return corsJson({ ok: false, error: errorMessage(error) }, 400);
  }
});

/* -------------------------------------------------- marketplace listings -- */
// Real listings (eBay first): the listings table is the current-status truth
// UIs render; the Graylog "listed"/"listing_failed" events remain the
// analytics history. Credentials never leave the server — GET views expose
// which credential KEYS are set, never their values.

function publicMarketplaceView(account: db.MarketplaceAccount) {
  const credentials = account.credentials ?? {};
  const credentialKeys = Object.keys(credentials)
    .filter((k) => String(credentials[k] ?? "").trim())
    .sort();
  const envCredentialKeys = account.marketplace === "ebay"
    ? Object.keys(ebayEnvCredentials()).sort()
    : [];
  const hasAccessToken = Boolean(String(credentials.accessToken ?? "").trim());
  const missingCredentialKeys = account.marketplace === "ebay" &&
      !hasAccessToken
    ? ["clientId", "clientSecret", "refreshToken"].filter((key) =>
      !String(credentials[key] ?? "").trim()
    )
    : [];
  return {
    marketplace: account.marketplace,
    environment: account.environment,
    connected: accountConnected(account),
    credentialKeys,
    envCredentialKeys,
    missingCredentialKeys,
    settings: account.settings ?? {},
    connected_at: account.connected_at,
    updated_at: account.updated_at,
    updated_by: account.updated_by,
  };
}

function marketplaceParam(params: Record<string, string>): string {
  return decodeURIComponent(params.marketplace || "").trim().toLowerCase();
}

app.all("/api/listings", async (ctx) => {
  // The eBay kill switch outranks DB state — "we turned it off" must not be
  // masked by "DATABASE_URL not configured". GET stays available: reading the
  // listings table is a DB read, not an eBay call.
  if (
    ctx.req.method === "POST" && !externalApiEnabled(envValue, "ebay")
  ) {
    return json({ ok: false, error: "ebay disabled" }, 503);
  }
  if (!hasDb) return dbUnavailable();
  if (ctx.req.method === "GET") {
    try {
      const p = ctx.url.searchParams;
      const rows = await db.listListingsWithSamples({
        sample_id: p.get("sample_id") ?? undefined,
        marketplace: p.get("marketplace") ?? undefined,
        status: p.get("status") ?? undefined,
      }, parseLimit(ctx.url));
      return json(rows);
    } catch (error) {
      return json({ error: errorMessage(error) }, 500);
    }
  }
  if (ctx.req.method === "POST") {
    // On-demand listing: publishes through the marketplace API, then records
    // the listings row + Graylog event. Validation problems → 400; a publish
    // attempt that failed remotely → 200 {ok:false, error, listing}.
    if (!listingService) return dbUnavailable();
    try {
      const body = await readJsonBody(ctx.req);
      return json(await listingService.listSample(body as ListSampleInput));
    } catch (error) {
      return json({ ok: false, error: errorMessage(error) }, 400);
    }
  }
  return json({ error: "Method not allowed" }, 405);
});

// Trigger one auto-list pass now (the same pass the boot cron runs): fires
// due schedules and, where opted in, lists cleared_to_sell samples.
app.all("/api/listings/run-due", async (ctx) => {
  if (ctx.req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }
  if (!externalApiEnabled(envValue, "ebay")) {
    return json({ ok: false, error: "ebay disabled" }, 503);
  }
  if (!listingService) return dbUnavailable();
  try {
    return json(await listingService.runAutoListPass());
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, 500);
  }
});

app.all("/api/marketplaces", async (ctx) => {
  if (ctx.req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!hasDb) return dbUnavailable();
  try {
    const accounts = await effectiveMarketplaceAccounts();
    return json(accounts.map(publicMarketplaceView));
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

// Live credential check against the marketplace API; a pass stamps
// connected_at so the UI can show when the connection last verified.
app.all("/api/marketplaces/:marketplace/verify", async (ctx) => {
  if (ctx.req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }
  if (!externalApiEnabled(envValue, "ebay")) {
    return json({ ok: false, detail: "ebay disabled" }, 503);
  }
  if (!listingService) return dbUnavailable();
  const marketplace = marketplaceParam(ctx.params);
  try {
    const result = await listingService.verifyMarketplace(marketplace);
    if (result.ok) await db.touchMarketplaceAccountVerified(marketplace);
    return json(result);
  } catch (error) {
    return json({ ok: false, detail: errorMessage(error) }, 500);
  }
});

app.all("/api/marketplaces/:marketplace", async (ctx) => {
  if (!hasDb) return dbUnavailable();
  const marketplace = marketplaceParam(ctx.params);
  if (!marketplace) return json({ error: "marketplace required" }, 400);
  try {
    if (ctx.req.method === "GET") {
      const account = await effectiveMarketplaceAccount(marketplace);
      return json(publicMarketplaceView(account));
    }
    if (ctx.req.method === "POST") {
      // Upsert credentials/settings. Merge semantics so the UI can save
      // settings without re-typing secrets: credential keys overwrite
      // individually (empty string deletes a key); settings shallow-merge
      // (null deletes a key).
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(ctx.req);
      } catch (error) {
        return json({ ok: false, error: errorMessage(error) }, 400);
      }
      const current = await db.getMarketplaceAccount(marketplace);
      const environment =
        String(body.environment ?? current?.environment ?? "sandbox") ===
            "production"
          ? "production"
          : "sandbox";
      const credentials = { ...(current?.credentials ?? {}) };
      if (
        body.credentials && typeof body.credentials === "object" &&
        !Array.isArray(body.credentials)
      ) {
        for (
          const [k, v] of Object.entries(
            body.credentials as Record<string, unknown>,
          )
        ) {
          const value = String(v ?? "").trim();
          if (value) credentials[k] = value;
          else delete credentials[k];
        }
      }
      const settings = { ...(current?.settings ?? {}) };
      if (
        body.settings && typeof body.settings === "object" &&
        !Array.isArray(body.settings)
      ) {
        Object.assign(settings, body.settings as Record<string, unknown>);
        for (const k of Object.keys(settings)) {
          if (settings[k] === null) delete settings[k];
        }
      }
      await db.upsertMarketplaceAccount(marketplace, {
        environment,
        credentials,
        settings,
        connected_at: current?.connected_at ?? null,
        updated_by: String(body.operator ?? "").trim() || null,
      });
      const effective = await effectiveMarketplaceAccount(marketplace);
      return json({ ok: true, account: publicMarketplaceView(effective) });
    }
    if (ctx.req.method === "DELETE") {
      await db.deleteMarketplaceAccount(marketplace);
      return new Response(null, { status: 204 });
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

/* ------------------------------------------------------ product analysis -- */
// The Product Analysis dashboard (/inventory), ported from data-pimp: a static
// page (static/inventory.html + inventory.css/js) over five Graylog-backed
// endpoints. Reads parse product scrapes (rows_json/core_data_json/summary_json)
// out of the graylog_messages store; price edits persist back as
// sample_edit_json events (core/product-analysis.ts). Without a DB everything
// degrades the way data-pimp degraded without GRAYLOG_*: health reports
// graylogConfigured:false (the page shows its setup banner), lists come back
// empty, and per-product routes 404 — no hard 503s.

const productAnalysis = createProductAnalysis({ store, env: envValue });

app.get("/inventory", async (ctx) => {
  const res = await serveStatic("/inventory.html", ctx.req.method);
  return res ?? json({ error: "inventory page missing" }, 500);
});

// Setup/health shim for the dashboard (the OS-level /health above is separate):
// the page reads only .graylogConfigured to decide on its setup banner.
app.get("/api/health", () =>
  json({
    ok: true,
    graylogConfigured: Boolean(store),
    scrapeCreatorsConfigured: productAnalysis.scrapeCreatorsConfigured(),
    externalApis: externalApiStates(envValue),
  }));

app.get("/api/product/:id", async (ctx) => {
  try {
    const id = decodeURIComponent(ctx.params.id || "");
    const product = await productAnalysis.fetchProductWithEdits(id);
    if (!product) {
      return json({ ok: false, error: "Product not found in Graylog" }, 404);
    }
    return json(product);
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

app.all("/api/unpriced-samples", async (ctx) => {
  if (ctx.req.method !== "GET") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }
  try {
    // The user's ?query= is matched in JS (matchesQuery), never in SQL.
    return json(
      await productAnalysis.listUnpricedSamples(
        ctx.url.searchParams.get("query") || "",
        Number(ctx.url.searchParams.get("limit") || 100),
      ),
    );
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

app.all("/api/unpriced-samples/:id", async (ctx) => {
  if (ctx.req.method !== "PATCH") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }
  try {
    return json(
      await productAnalysis.updateSamplePrice(
        decodeURIComponent(ctx.params.id || ""),
        await readJsonBody(ctx.req),
      ),
    );
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

app.all("/api/unpriced-samples/:id/fetch-price", async (ctx) => {
  if (ctx.req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }
  try {
    return json(
      await productAnalysis.fetchPriceForSample(
        decodeURIComponent(ctx.params.id || ""),
      ),
    );
  } catch (error) {
    // Operator kill switch (EXTERNAL_API_SCRAPECREATORS=off) → 503, distinct
    // from a real upstream failure so "we turned it off" and "ScrapeCreators
    // is down" stay distinguishable.
    if (error instanceof ExternalApiDisabledError) {
      return json({ ok: false, error: error.message }, 503);
    }
    // A ScrapeCreators miss/outage, a missing API key, or a product missing
    // from Graylog surfaces as a clean 502 {ok:false, error} — never a raw 500
    // stack trace — so the row simply stays unpriced (data-pimp convention).
    return json({ ok: false, error: errorMessage(error) }, 502);
  }
});

app.get("/api/comparison", async () => {
  try {
    return json(await productAnalysis.fetchComparisonWithEdits());
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

/* ------------------------------------------------------------------ kiosk -- */
// The Inventory Manager kiosk, rebuilt vanilla from data-pimp's React SPA
// (static/kiosk.html + kiosk.js). Routing is client-side, so the bare path
// and every subpath serve the same shell. /kiosk/checkout?code= deep links
// are wire contract with os.js routeScanToKiosk and the scan relay.

const sampleImage = createSampleImage({ db, env: envValue });

app.get("/kiosk", async (ctx) => {
  const res = await serveStatic("/kiosk.html", ctx.req.method);
  return res ?? json({ error: "kiosk page missing" }, 500);
});
app.get("/kiosk/*", async (ctx) => {
  const res = await serveStatic("/kiosk.html", ctx.req.method);
  return res ?? json({ error: "kiosk page missing" }, 500);
});

// Resolve (and backfill) a sample's product image via ScrapeCreators.
// data-pimp contract: 200 {id, picture_url} with picture_url null on a miss.
app.all("/api/samples/:id/image", async (ctx) => {
  if (ctx.req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!hasDb) return dbUnavailable();
  try {
    const id = ctx.params.id;
    const resolved = await sampleImage.resolve({ sampleId: id });
    return json({ id, picture_url: resolved?.url ?? null });
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

// Unknown /api/* → JSON 404 (data-pimp convention), not the HTML default.
app.all("/api/*", () => json({ error: "API endpoint not found" }, 404));

export default app;

/* ----------------------------------------------------------------- boot -- */

// Desktop bundles (`deno desktop`) should open at full screen size. The
// desktop runtime exposes Deno.BrowserWindow, and the first construction
// adopts the auto-created startup window; there is no maximize/fullscreen
// API (deno 2.9 / laufey 0.5), so size the window to the screen's available
// area, which the webview reports once it has a document. Adoption must wait
// until the server is actually up: constructing during boot races the
// runtime's own navigate-and-reveal of the startup window and strands it on
// the placeholder page.
async function maximizeDesktopWindow() {
  const BrowserWindow = (Deno as unknown as {
    BrowserWindow?: new () => {
      executeJs(script: string): Promise<unknown>;
      setPosition(x: number, y: number): void;
      setSize(width: number, height: number): void;
    };
  }).BrowserWindow;
  if (!BrowserWindow) return; // plain `deno run`, not the desktop runtime
  // The desktop runtime overrides the listen address via DENO_SERVE_ADDRESS
  // ("tcp:127.0.0.1:<port>"); wait until the server answers there.
  const port = Deno.env.get("DENO_SERVE_ADDRESS")?.split(":").pop();
  if (!port) return;
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      await res.body?.cancel();
      if (res.ok) break;
    } catch {
      // server not bound yet
    }
    await sleep(250);
  }
  const win = new BrowserWindow();
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const result = await win.executeJs(
        "[screen.availWidth, screen.availHeight]",
      );
      // CEF resolves with the value wrapped as { ok, value }; unwrap either.
      const dims = (result && typeof result === "object" && "value" in result)
        ? (result as { value: unknown }).value
        : result;
      if (
        Array.isArray(dims) && typeof dims[0] === "number" && dims[0] > 0 &&
        typeof dims[1] === "number" && dims[1] > 0
      ) {
        win.setPosition(0, 0);
        win.setSize(dims[0], dims[1]);
        return;
      }
    } catch {
      // webview not ready to execute JS yet
    }
    await sleep(250);
  }
}

if (import.meta.main) {
  maximizeDesktopWindow();
  relay(); // start presence pruning + pg bridge (when DATABASE_URL is set)
  if (!hasDb) {
    console.warn(
      "[lp-os] DATABASE_URL not set — DB-backed APIs will return 503",
    );
  }
  if (listingService && externalApiEnabled(envValue, "ebay")) {
    // Automatic listing: fires due auto-list schedules and (where opted in)
    // lists cleared_to_sell samples. In-process interval — no new systems.
    const intervalMs = Number(envValue("AUTO_LIST_INTERVAL_MS") ?? "300000") ||
      300_000;
    startAutoLister({
      service: listingService,
      intervalMs,
      logger: (message) => console.log(`[lp-os] ${message}`),
    });
  } else if (listingService) {
    console.log("[lp-os] auto-lister off (EXTERNAL_API_EBAY=off)");
  }
  const port = Number(envValue("PORT") ?? "8000") || 8000;
  await app.listen({ port });
}
