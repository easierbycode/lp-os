// In-process route smoke tests (no DB, no network listener). The handler is
// exercised directly; DATABASE_URL-dependent assertions skip when it is set
// because main.ts bakes the no-DB gating at import time.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { app } from "../main.ts";

const hasDb = Boolean((Deno.env.get("DATABASE_URL") ?? "").trim());
const handler = app.handler();

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:8000${path}`, init);
}

Deno.test("GET / renders the OS shell with injected globals", async () => {
  const res = await handler(req("/"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  const html = await res.text();
  assertStringIncludes(html, "LPOS_RBAC");
  assertStringIncludes(html, "LPOS_OS_CONFIG");
  assertStringIncludes(html, "LPOS_SCAN_RELAY");
  assertStringIncludes(html, 'id="user-switch"');
  assertStringIncludes(html, 'id="desktop"');
  assertStringIncludes(html, "/os.js");
});

Deno.test("GET /?user=ka resolves the warehouse user", async () => {
  const res = await handler(req("/?user=ka"));
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, '"currentUser":{"id":"ka"');
});

Deno.test("GET /health → 200 without DB", async () => {
  const res = await handler(req("/health"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
});

Deno.test({
  name: "GET /api/samples → 503 without DATABASE_URL",
  ignore: hasDb,
  fn: async () => {
    const res = await handler(req("/api/samples"));
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.error, "DATABASE_URL not configured");
  },
});

Deno.test("OPTIONS /gelf → 204 CORS preflight (works without DB)", async () => {
  const res = await handler(req("/gelf", { method: "OPTIONS" }));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assert(
    (res.headers.get("access-control-allow-methods") ?? "").includes("POST"),
  );
  await res.body?.cancel();
});

Deno.test("GET /os.css served from static at root path", async () => {
  const res = await handler(req("/os.css"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/css");
  await res.body?.cancel();
});

Deno.test("GET /manifest.webmanifest → PWA manifest with icons", async () => {
  const res = await handler(req("/manifest.webmanifest"));
  assertEquals(res.status, 200);
  assertStringIncludes(
    res.headers.get("content-type") ?? "",
    "application/manifest+json",
  );
  const manifest = await res.json();
  assertEquals(manifest.name, "LP-OS");
  assertEquals(manifest.display, "standalone");
  assert(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
});

Deno.test("GET /sw.js → service worker as JavaScript", async () => {
  const res = await handler(req("/sw.js"));
  assertEquals(res.status, 200);
  assertStringIncludes(
    res.headers.get("content-type") ?? "",
    "text/javascript",
  );
  const body = await res.text();
  assertStringIncludes(body, "lpos-shell-");
});

Deno.test("shell page links the manifest and registers the SW", async () => {
  const res = await handler(req("/"));
  const html = await res.text();
  assertStringIncludes(
    html,
    '<link rel="manifest" href="/manifest.webmanifest">',
  );
  assertStringIncludes(html, 'serviceWorker.register("/sw.js")');
});

Deno.test("GET /api/sample-statuses → vocabulary without DB", async () => {
  const res = await handler(req("/api/sample-statuses"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body) && body.length > 0);
});

Deno.test("unknown /api/* → JSON 404", async () => {
  const res = await handler(req("/api/nope"));
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "API endpoint not found");
});

Deno.test("GET /marketplace serves the Marketplace window page", async () => {
  const res = await handler(req("/marketplace"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  const html = await res.text();
  assertStringIncludes(html, "eBay");
});

Deno.test("GET /e2e serves the E2E demo page", async () => {
  const res = await handler(req("/e2e"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  const html = await res.text();
  assertStringIncludes(html, "e2e");
});

Deno.test({
  name: "GET /api/products → empty catalog without DATABASE_URL",
  ignore: hasDb,
  fn: async () => {
    const res = await handler(req("/api/products"));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("access-control-allow-origin"), "*");
    const body = await res.json();
    assert(Array.isArray(body) && body.length === 0);
  },
});

Deno.test({
  name: "GET /api/e2e-context → usable fallback without DATABASE_URL",
  ignore: hasDb,
  fn: async () => {
    const res = await handler(req("/api/e2e-context?id=42"));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.creator, "@e2e-demo");
    assertEquals(body.ids, ["42"]);
    assertStringIncludes(body.source, "default");
  },
});

Deno.test("POST /api/ebay-price prices without DB (pure formula)", async () => {
  const res = await handler(req("/api/ebay-price", {
    method: "POST",
    body: JSON.stringify({
      retail: 89.99,
      costBasis: 0,
      condition: "new",
      comps: [58, 62, 65],
    }),
  }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  const body = await res.json();
  assert(typeof body.price === "number" && body.price > 0);
  assertEquals(body.compsSource, "provided");
  assert(body.price < 89.99); // undercuts the comp anchor, never above retail
});

Deno.test("GET /extension.zip → a zip of the merged extension", async () => {
  const res = await handler(req("/extension.zip"));
  assertEquals(res.status, 200);
  assertStringIncludes(
    res.headers.get("content-type") ?? "",
    "application/zip",
  );
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Zip local-file-header magic "PK\x03\x04".
  assertEquals([...bytes.slice(0, 2)], [0x50, 0x4b]);
});

Deno.test({
  name: "marketplace APIs → 503 without DATABASE_URL",
  ignore: hasDb,
  fn: async () => {
    for (
      const [path, init] of [
        ["/api/listings", undefined],
        ["/api/listings", {
          method: "POST",
          body: JSON.stringify({ sampleId: 1 }),
        }],
        ["/api/listings/run-due", { method: "POST" }],
        ["/api/marketplaces", undefined],
        ["/api/marketplaces/ebay", undefined],
        ["/api/marketplaces/ebay", {
          method: "POST",
          body: JSON.stringify({ credentials: { accessToken: "x" } }),
        }],
        ["/api/marketplaces/ebay/verify", { method: "POST" }],
      ] as [string, RequestInit | undefined][]
    ) {
      const res = await handler(req(path, init));
      assertEquals(res.status, 503, `${init?.method ?? "GET"} ${path}`);
      const body = await res.json();
      assertEquals(body.error, "DATABASE_URL not configured");
    }
  },
});

Deno.test("GET /inventory serves the Product Analysis page", async () => {
  const res = await handler(req("/inventory"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  const html = await res.text();
  assertStringIncludes(html, "Product Analysis");
  assertStringIncludes(html, "/inventory.css");
  assertStringIncludes(html, "/inventory.js");
});

Deno.test({
  name: "GET /api/health → graylogConfigured false without DATABASE_URL",
  ignore: hasDb,
  fn: async () => {
    const res = await handler(req("/api/health"));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    assertEquals(body.graylogConfigured, false);
  },
});

Deno.test({
  name: "GET /api/unpriced-samples → empty list shape without DATABASE_URL",
  ignore: hasDb,
  fn: async () => {
    const res = await handler(req("/api/unpriced-samples?limit=1000"));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.items, []);
    assertEquals(body.total, 0);
    assertEquals(body.unpricedCount, 0);
    assertEquals(body.pricedCount, 0);
  },
});

Deno.test({
  name: "GET /api/comparison → empty rows without DATABASE_URL",
  ignore: hasDb,
  fn: async () => {
    const res = await handler(req("/api/comparison"));
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(Array.isArray(body) && body.length === 0);
  },
});

Deno.test({
  name: "GET /api/product/:id → 404 without DATABASE_URL",
  ignore: hasDb,
  fn: async () => {
    const res = await handler(req("/api/product/1729527400425427463"));
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.ok, false);
    assertEquals(body.error, "Product not found in Graylog");
  },
});

Deno.test({
  name:
    "POST fetch-price on an unknown product → clean 502 without DATABASE_URL",
  ignore: hasDb,
  fn: async () => {
    const res = await handler(
      req("/api/unpriced-samples/42/fetch-price", { method: "POST" }),
    );
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.ok, false);
    assertStringIncludes(body.error, "was not found in Graylog");
  },
});

Deno.test("unpriced-samples routes enforce methods regardless of DB", async () => {
  const post = await handler(req("/api/unpriced-samples", { method: "POST" }));
  assertEquals(post.status, 405);
  await post.body?.cancel();

  const get = await handler(req("/api/unpriced-samples/42"));
  assertEquals(get.status, 405);
  await get.body?.cancel();

  const fetchGet = await handler(req("/api/unpriced-samples/42/fetch-price"));
  assertEquals(fetchGet.status, 405);
  await fetchGet.body?.cancel();
});

Deno.test("GET /kiosk serves the kiosk shell", async () => {
  const res = await handler(req("/kiosk"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  const html = await res.text();
  assertStringIncludes(html, "Inventory Manager");
  assertStringIncludes(html, "/kiosk.css");
  assertStringIncludes(html, "/kiosk.js");
});

Deno.test("GET /kiosk/checkout?code= serves the same shell (client routing)", async () => {
  const res = await handler(req("/kiosk/checkout?code=1729527400425427463"));
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "/kiosk.js"); // deep links must never 404
});

Deno.test({
  name: "GET /api/samples/:id/image → 503 without DATABASE_URL",
  ignore: hasDb,
  fn: async () => {
    const res = await handler(req("/api/samples/42/image"));
    assertEquals(res.status, 503);
    assertEquals((await res.json()).error, "DATABASE_URL not configured");
  },
});

Deno.test("POST /api/samples/:id/image → 405", async () => {
  const res = await handler(req("/api/samples/42/image", { method: "POST" }));
  assertEquals(res.status, 405);
  await res.body?.cancel();
});

Deno.test("GET /member → member app (redirect or HTML), 503 when unbuilt", async () => {
  const res = await handler(req("/member"));
  if (res.status === 503) {
    // fresh checkout: apps/member/.deno-deploy absent
    assertEquals((await res.json()).error, "member app not built");
    return;
  }
  if (res.status === 308) {
    // Kit normalizes the bare base path to /member/.
    assertEquals(res.headers.get("location"), "/member/");
    await res.body?.cancel();
    const followed = await handler(req("/member/"));
    assertEquals(followed.status, 200);
    assertStringIncludes(
      (await followed.text()).toLowerCase(),
      "<!doctype html",
    );
    return;
  }
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  assertStringIncludes((await res.text()).toLowerCase(), "<!doctype html");
});

Deno.test("GET /member/web renders only /member-scoped links", async () => {
  const res = await handler(req("/member/web"));
  if (res.status === 503) return await res.body?.cancel(); // unbuilt
  const html = await res.text();
  for (const m of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
    const url = new URL(m[1], "http://localhost:8000/member/web");
    if (url.origin !== "http://localhost:8000") continue;
    assertEquals(url.pathname.startsWith("/member"), true, `leak: ${m[1]}`);
  }
});

Deno.test("member immutable assets get immutable cache headers", async () => {
  let entry = "";
  try {
    const dir = new URL(
      "../../member/.deno-deploy/static/member/_app/immutable/entry/",
      import.meta.url,
    );
    for (const e of Deno.readDirSync(dir)) {
      if (e.isFile) {
        entry = e.name;
        break;
      }
    }
  } catch {
    // member not built
  }
  if (!entry) return;
  const res = await handler(
    req(`/member/_app/immutable/entry/${entry}`),
  );
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("cache-control") ?? "", "immutable");
  await res.body?.cancel();
});

Deno.test("GET /member/service-worker.js → 200 JS when built", async () => {
  const res = await handler(req("/member/service-worker.js"));
  if (res.status === 503) return await res.body?.cancel();
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
  await res.body?.cancel();
});

Deno.test("health payloads expose external-API kill-switch states", async () => {
  const res = await handler(req("/api/health"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.externalApis, {
    scrapecreators: "on",
    ebay: "on",
    barcodelookup: "off", // expired key — off by default until re-enabled
  });

  const os = await handler(req("/health"));
  const osBody = await os.json();
  assertEquals(osBody.externalApis.barcodelookup, "off");
});

Deno.test("EXTERNAL_API_SCRAPECREATORS=off → fetch-price 503, health off", async () => {
  Deno.env.set("EXTERNAL_API_SCRAPECREATORS", "off");
  try {
    const res = await handler(
      req("/api/unpriced-samples/123/fetch-price", { method: "POST" }),
    );
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body, { ok: false, error: "scrapecreators disabled" });

    const health = await (await handler(req("/api/health"))).json();
    assertEquals(health.scrapeCreatorsConfigured, false);
    assertEquals(health.externalApis.scrapecreators, "off");
  } finally {
    Deno.env.delete("EXTERNAL_API_SCRAPECREATORS");
  }
});

Deno.test("EXTERNAL_API_EBAY=off → listing routes 503", async () => {
  Deno.env.set("EXTERNAL_API_EBAY", "off");
  try {
    const runDue = await handler(
      req("/api/listings/run-due", { method: "POST" }),
    );
    assertEquals(runDue.status, 503);
    assertEquals((await runDue.json()).error, "ebay disabled");

    const publish = await handler(req("/api/listings", {
      method: "POST",
      body: JSON.stringify({ sampleId: 1 }),
    }));
    assertEquals(publish.status, 503);
    assertEquals((await publish.json()).error, "ebay disabled");

    const verify = await handler(
      req("/api/marketplaces/ebay/verify", { method: "POST" }),
    );
    assertEquals(verify.status, 503);
    assertEquals((await verify.json()).detail, "ebay disabled");
  } finally {
    Deno.env.delete("EXTERNAL_API_EBAY");
  }
});

Deno.test("marketplace APIs enforce methods regardless of DB", async () => {
  const runDue = await handler(req("/api/listings/run-due"));
  assertEquals(runDue.status, 405);
  await runDue.body?.cancel();

  const verify = await handler(req("/api/marketplaces/ebay/verify"));
  assertEquals(verify.status, 405);
  await verify.body?.cancel();

  const del = await handler(req("/api/marketplaces", { method: "DELETE" }));
  assertEquals(del.status, 405);
  await del.body?.cancel();
});
