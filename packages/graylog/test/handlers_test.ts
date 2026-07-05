import { assert, assertEquals } from "@std/assert";
import {
  handleGelfRequest,
  handleSearchRequest,
  handleSessionsStub,
  handleViewsStub,
} from "../handlers.ts";
import type { GraylogStore, SearchResult } from "../store.ts";

function emptyResult(windowMinMs: number | null): SearchResult {
  return {
    messages: [],
    total_results: 0,
    from: new Date(0).toISOString(),
    to: new Date().toISOString(),
    fields: [],
    used_indices: ["graylog_pg"],
    time: 1,
    windowMinMs,
  };
}

function fakeStore(overrides: Partial<GraylogStore> = {}): GraylogStore {
  return {
    ingestGelf: () => Promise.resolve({ ok: true, id: "x" }),
    logEvent: () => Promise.resolve(true),
    search: () => Promise.resolve(emptyResult(null)),
    newestTimestampMs: () => Promise.resolve(null),
    ...overrides,
  };
}

const SEARCH_URL = "http://localhost/api/search/universal/relative";

Deno.test("handlers: OPTIONS preflight gets 204 with CORS headers", async () => {
  for (
    const res of [
      await handleGelfRequest(
        fakeStore(),
        new Request("http://localhost/gelf", { method: "OPTIONS" }),
      ),
      await handleSearchRequest(
        fakeStore(),
        new Request(SEARCH_URL, { method: "OPTIONS" }),
      ),
      handleSessionsStub(
        new Request("http://localhost/api/system/sessions", {
          method: "OPTIONS",
        }),
      ),
      handleViewsStub(
        new Request("http://localhost/api/views", { method: "OPTIONS" }),
      ),
    ]
  ) {
    assertEquals(res.status, 204);
    assertEquals(res.headers.get("access-control-allow-origin"), "*");
    assertEquals(
      res.headers.get("access-control-allow-headers"),
      "Authorization, Accept, Content-Type, X-Requested-By",
    );
  }
});

Deno.test("gelf: 202 with empty body on success", async () => {
  const seen: unknown[] = [];
  const store = fakeStore({
    ingestGelf: (b) => {
      seen.push(b);
      return Promise.resolve({ ok: true, id: "1" });
    },
  });
  const res = await handleGelfRequest(
    store,
    new Request("http://localhost/gelf", {
      method: "POST",
      body: JSON.stringify({ version: "1.1", host: "h", short_message: "m" }),
    }),
  );
  assertEquals(res.status, 202);
  assertEquals(await res.text(), "");
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(seen.length, 1);
});

Deno.test("gelf: bad json is a 400", async () => {
  const res = await handleGelfRequest(
    fakeStore(),
    new Request("http://localhost/gelf", { method: "POST", body: "{nope" }),
  );
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("gelf: 403 when GRAYLOG_INGEST_TOKEN set and _graylog_key mismatched (shim parity)", async () => {
  Deno.env.set("GRAYLOG_INGEST_TOKEN", "sekret");
  try {
    let ingested = 0;
    const store = fakeStore({
      ingestGelf: () => {
        ingested++;
        return Promise.resolve({ ok: true });
      },
    });
    const post = (body: unknown) =>
      handleGelfRequest(
        store,
        new Request("http://localhost/gelf", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );

    const missing = await post({ host: "h", short_message: "m" });
    assertEquals(missing.status, 403);
    await missing.body?.cancel();

    const wrong = await post({
      host: "h",
      short_message: "m",
      _graylog_key: "nope",
    });
    assertEquals(wrong.status, 403);
    await wrong.body?.cancel();
    assertEquals(ingested, 0);

    const right = await post({
      host: "h",
      short_message: "m",
      _graylog_key: "sekret",
    });
    assertEquals(right.status, 202);
    assertEquals(ingested, 1);
  } finally {
    Deno.env.delete("GRAYLOG_INGEST_TOKEN");
  }
});

Deno.test("search: empty window strictly newer than newest doc → 500 sentinel", async () => {
  const newest = Date.parse("2026-01-01T00:00:00Z");
  const store = fakeStore({
    search: () => Promise.resolve(emptyResult(newest + 60_000)), // lower bound newer than newest
    newestTimestampMs: () => Promise.resolve(newest),
  });
  const res = await handleSearchRequest(
    store,
    new Request(`${SEARCH_URL}?query=*&range=60`),
  );
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.type, "ApiError");
  assert(String(body.message).includes("index_not_found_exception"));
});

Deno.test("search: zero results with window covering data → 200 with total 0 and non-empty used_indices", async () => {
  const newest = Date.parse("2026-01-01T00:00:00Z");
  const store = fakeStore({
    search: () => Promise.resolve(emptyResult(newest - 60_000)), // lower bound older than newest
    newestTimestampMs: () => Promise.resolve(newest),
  });
  const res = await handleSearchRequest(
    store,
    new Request(`${SEARCH_URL}?query=*&range=3600`),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.total_results, 0);
  assertEquals(body.messages, []);
  assertEquals(body.used_indices, ["graylog_pg"]);
});

Deno.test("search: zero results on an unbounded window → 200, never the sentinel", async () => {
  const store = fakeStore({
    search: () => Promise.resolve(emptyResult(null)),
    newestTimestampMs: () => Promise.resolve(null),
  });
  const res = await handleSearchRequest(
    store,
    new Request(`${SEARCH_URL}?query=*&range=0`),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.total_results, 0);
});

Deno.test("search: response body has exactly the contract keys", async () => {
  const store = fakeStore({
    search: () =>
      Promise.resolve({
        ...emptyResult(null),
        messages: [{
          message: { source: "s", timestamp: "t" },
          index: "graylog_pg",
        }],
        total_results: 1,
        fields: ["source", "timestamp"],
      }),
  });
  const res = await handleSearchRequest(
    store,
    new Request(`${SEARCH_URL}?query=*`),
  );
  const body = await res.json();
  assertEquals(
    Object.keys(body).sort(),
    [
      "fields",
      "from",
      "messages",
      "time",
      "to",
      "total_results",
      "used_indices",
    ],
  );
  assertEquals(body.messages[0].index, "graylog_pg");
});

Deno.test("sessions stub: session id + valid_until + cookie", async () => {
  const res = handleSessionsStub(
    new Request("http://localhost/api/system/sessions", { method: "POST" }),
  );
  assertEquals(res.status, 200);
  assert(res.headers.get("set-cookie")?.includes("authentication=stub"));
  const body = await res.json();
  assert(typeof body.session_id === "string" && body.session_id.length > 0);
  assert(Date.parse(body.valid_until) > Date.now());
});

Deno.test("views stub: empty views list", async () => {
  const res = handleViewsStub(new Request("http://localhost/api/views"));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { views: [], total: 0 });
});

Deno.test("gelf: 500 when the store rejects every item (not a silent 202)", async () => {
  const store = fakeStore({
    ingestGelf: () => Promise.resolve({ ok: false, error: "db down" }),
  });
  const res = await handleGelfRequest(
    store,
    new Request("http://localhost/gelf", {
      method: "POST",
      body: JSON.stringify({ version: "1.1", host: "h", short_message: "m" }),
    }),
  );
  assertEquals(res.status, 500);
  await res.body?.cancel();
});
