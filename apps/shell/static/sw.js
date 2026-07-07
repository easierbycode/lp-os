// LP-OS shell service worker — makes the OS shell installable and gives it an
// offline fallback. The server already marks everything no-cache/no-store, so
// this cache is a last-known-good copy for offline/flaky networks, never a
// freshness layer: every same-origin GET goes network-first.
//
// Bump SW_VERSION to drop all previously cached copies on the next deploy.
// v2: first thirsty.store deploy (LP-OS replacing data-pimp).
// v3: /member (SvelteKit member app) served same-origin — its SW owns scope
//     /member/; the shell SW must never answer for member URLs.
const SW_VERSION = "v3";
const CACHE_NAME = `lpos-shell-${SW_VERSION}`;

const PRECACHE = [
  "/",
  "/os.js",
  "/os.css",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// Live surfaces the SW must never answer for: inventory/lifecycle APIs, the
// scan-socket upgrade, GELF ingest, graylog search, health, and the member
// app (its own SW owns scope /member/, but that scope excludes bare /member).
const NETWORK_ONLY = [/^\/api\//, /^\/gelf$/, /^\/health$/, /^\/member(\/|$)/];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
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
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
