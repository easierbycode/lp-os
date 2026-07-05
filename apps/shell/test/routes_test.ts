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
