// LP-OS shell service worker — makes the OS shell installable and gives it an
// offline fallback. The server already marks everything no-cache/no-store, so
// this cache is a last-known-good copy for offline/flaky networks, never a
// freshness layer: every same-origin GET goes network-first.
//
// Bump SW_VERSION to drop all previously cached copies on the next deploy.
// v2: first thirsty.store deploy (LP-OS replacing data-pimp).
// v3: /member (SvelteKit member app) served same-origin — its SW owns scope
//     /member/; the shell SW must never answer for member URLs.
// v4: resilient precache (one missing asset no longer empties the cache) +
//     query-insensitive offline fallback, so a transient network blip on a
//     deep-linked demo (e.g. /demos/ebay-pricing?product=…) degrades to the
//     cached document instead of surfacing a bare network-error response.
const SW_VERSION = "v4";
const CACHE_NAME = `lpos-shell-${SW_VERSION}`;

const PRECACHE = [
  "/",
  "/os.js",
  "/os.css",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  // Precached so a deep-linked /demos/ebay-pricing?product=… (Marketplace
  // Ask-price note, demo launcher) has a cached base document to fall back on
  // via ignoreSearch even on a first, offline, or cache-evicted visit — the
  // eviction case that otherwise dead-ends the navigation at the offline page.
  "/demos/ebay-pricing",
];

// Live surfaces the SW must never answer for: inventory/lifecycle APIs, the
// scan-socket upgrade, GELF ingest, graylog search, health, and the member
// app (its own SW owns scope /member/, but that scope excludes bare /member).
const NETWORK_ONLY = [/^\/api\//, /^\/gelf$/, /^\/health$/, /^\/member(\/|$)/];

// Last-resort body for a document navigation when the network is down and
// nothing (not even the shell "/") is cached. Returning a real 503 response —
// instead of Response.error() — keeps Chrome from logging the request as a bare
// "network error response" and leaves the tab/iframe with a legible message.
const OFFLINE_HTML =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" ' +
  'content="width=device-width, initial-scale=1"><title>Offline · LP-OS</title>' +
  '<body style="margin:0;display:grid;place-items:center;min-height:100vh;' +
  'font:15px/1.5 system-ui,sans-serif;background:#0b0d11;color:#e6e8ee">' +
  '<div style="text-align:center;padding:2rem"><h1 style="margin:0 0 .5rem;' +
  'font-size:1.25rem">Offline</h1><p style="margin:0;opacity:.7">LP-OS could ' +
  "not reach the network. Reconnect and reload.</p></div>";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // Per-item add, not cache.addAll(): addAll is atomic, so a single asset
      // 404ing on a given deploy would reject the whole precache and leave even
      // the shell "/" uncached — which strands later offline navigations on
      // Response.error(). allSettled keeps every asset that IS available so the
      // navigation fallback below always has the shell to fall back to.
      .then((cache) =>
        Promise.allSettled(PRECACHE.map((path) => cache.add(path)))
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        )
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NETWORK_ONLY.some((re) => re.test(url.pathname))) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        // ignoreSearch: a deep-linked demo (/demos/ebay-pricing?product=…) is
        // the same base document for every product id — the id is read
        // client-side from the URL — so a cached copy under any query answers
        // it. cache.put keys entries with their query string, which a plain
        // match would otherwise miss for a never-before-seen ?product= value.
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
          // Nothing cached for this navigation — hand back a legible offline
          // page rather than Response.error() (which blanks the tab/iframe and
          // logs a network error). Gated on navigate so genuine subresource
          // failures still reject, which their own callers expect.
          return new Response(OFFLINE_HTML, {
            status: 503,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return Response.error();
      }),
  );
});
