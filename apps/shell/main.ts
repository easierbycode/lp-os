// LP-OS shell server (apps/shell) — the wiring layer that turns the packages
// into the running core app. Fresh 2.x App used as the router (programmatic
// routes only — no islands/JSX, so no vite build step is needed; static assets
// are served by a tiny middleware below because Fresh's staticFiles() only
// works from a vite build cache).
//
// Every route degrades gracefully without DATABASE_URL: the shell page, static
// assets, relay/kiosk endpoints and stubs keep working; DB-backed APIs return
// 503 {error: "DATABASE_URL not configured"} instead of crashing.

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
  createListingService,
  type ListingService,
  type ListSampleInput,
  startAutoLister,
} from "@lp-os/marketplace";
import { DEFAULT_USER_ID, rbacClientConfig } from "./core/roles.ts";

/* ------------------------------------------------------------------ env -- */

function envValue(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined; // no --allow-env: run on defaults
  }
}

const hasDb = Boolean((envValue("DATABASE_URL") ?? "").trim());

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
  ? createLifecycle({ db, store })
  : null;

// Real marketplace listings (eBay first). Credentials/settings live in the
// marketplace_accounts table, filled in through the Marketplace window.
const listingService: ListingService | null = store && lifecycle
  ? createListingService({
    db,
    store,
    lifecycle,
    getAccount: (marketplace) => db.getMarketplaceAccount(marketplace),
    listAccounts: () => db.listMarketplaceAccounts(),
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
      "access-control-allow-methods": "GET, POST, OPTIONS",
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

/* ------------------------------------------------------------- OS shell -- */

// globalThis.LPOS_OS_CONFIG — keys read by static/os.js. scanRelay stays ""
// (same-origin): os.js derives ws(s)://<host>/api/scan-socket itself.
function osClientConfig(): Record<string, string> {
  return {
    scanRelay: "",
    memberAppUrl: publicHttpBaseUrl(envValue("MEMBER_APP_URL")) ||
      "http://localhost:8080",
    scannerAppUrl: publicHttpBaseUrl(envValue("SCANNER_APP_URL")),
    inventoryAppUrl: publicHttpBaseUrl(envValue("INVENTORY_APP_URL")) ||
      "https://admin.thirsty.store",
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
  if (!store) return json({ ok: true, db: false, newestStoredMs: null });
  try {
    return json({
      ok: true,
      db: true,
      newestStoredMs: await store.newestTimestampMs(),
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

app.get("/api/sample-statuses", () => json(listSampleStatuses()));

app.get("/api/creators", async (ctx) => {
  if (!lifecycle) return dbUnavailable();
  try {
    const raw = Number(ctx.url.searchParams.get("limit"));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 1000;
    return json({ creators: await lifecycle.fetchKnownCreators(limit) });
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});

app.get("/api/roles", (ctx) => json(rbacClientConfig(resolveUserId(ctx.url))));

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
  return {
    marketplace: account.marketplace,
    environment: account.environment,
    connected: accountConnected(account),
    credentialKeys,
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
    const accounts = await db.listMarketplaceAccounts();
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
      const account = await db.getMarketplaceAccount(marketplace);
      if (!account) return json({ error: "not configured" }, 404);
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
      const account = await db.upsertMarketplaceAccount(marketplace, {
        environment,
        credentials,
        settings,
        connected_at: current?.connected_at ?? null,
        updated_by: String(body.operator ?? "").trim() || null,
      });
      return json({ ok: true, account: publicMarketplaceView(account) });
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
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
  if (listingService) {
    // Automatic listing: fires due auto-list schedules and (where opted in)
    // lists cleared_to_sell samples. In-process interval — no new systems.
    const intervalMs = Number(envValue("AUTO_LIST_INTERVAL_MS") ?? "300000") ||
      300_000;
    startAutoLister({
      service: listingService,
      intervalMs,
      logger: (message) => console.log(`[lp-os] ${message}`),
    });
  }
  const port = Number(envValue("PORT") ?? "8000") || 8000;
  await app.listen({ port });
}
