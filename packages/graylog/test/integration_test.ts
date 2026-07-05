// DATABASE_URL-gated integration tests. Skip cleanly when unset:
//   DATABASE_URL=postgres://… deno test -A packages/graylog
// All rows live in a scratch schema (lpos_graylog_test) that is created and
// dropped by the test — the real graylog_messages table is never touched.

import { assert, assertEquals, assertFalse } from "@std/assert";
// @ts-types="@types/pg"
import pg from "pg";
import { createGraylogStore } from "../store.ts";
import { ensureGraylogSchema } from "../schema.ts";
import { handleSearchRequest } from "../handlers.ts";
import { evalNode, parseQuery } from "../lucene.ts";
import { backfill } from "../scripts/backfill.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const SCHEMA = "lpos_graylog_test";
const FIXTURE = new URL("./fixtures/sample-messages.ndjson", import.meta.url)
  .pathname
  .replace(/^\/([A-Za-z]:)/, "$1"); // strip the leading slash on Windows drive paths

const SEARCH_URL = "http://localhost/api/search/universal/relative";

Deno.test({
  name: "graylog store integration (Postgres)",
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();

    const pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 2,
      options: `-c search_path=${SCHEMA}`,
    });
    const store = createGraylogStore(pool);
    Deno.env.delete("GRAYLOG_INGEST_TOKEN"); // unauthenticated ingest for this suite

    try {
      await ensureGraylogSchema(pool);

      await t.step(
        "ingest → search roundtrip with GELF field mapping",
        async () => {
          // 2026-06-30T00:00:00Z as fractional unix seconds
          const secs = Date.parse("2026-06-30T00:00:00.500Z") / 1000;
          const r = await store.ingestGelf({
            version: "1.1",
            host: "it-source-a",
            short_message: "integration hello",
            timestamp: secs,
            level: 6,
            _id: "it-0001",
            _product_id: "999000111",
            _gmv_num: 42.5,
            _creator: "@boosteddealsdaily",
            _graylog_key: "should-not-be-stored",
          });
          assert(r.ok, r.error);
          assertEquals(r.id, "it-0001");

          const res = await store.search({ query: "source:it-source-a" });
          assertEquals(res.total_results, 1);
          const m = res.messages[0].message;
          assertEquals(m.source, "it-source-a");
          assertEquals(m.message, "integration hello");
          assertEquals(m.timestamp, "2026-06-30T00:00:00.500Z");
          assertEquals(m.product_id, "999000111"); // underscore prefix stripped
          assertEquals(m.gmv_num, 42.5);
          assertEquals(m.id, "it-0001");
          assertFalse(
            "graylog_key" in m,
            "_graylog_key must be consumed, not stored",
          );
          assertFalse("_graylog_key" in m);
          assertFalse("version" in m);
          assertFalse("level" in m);
          assertEquals(res.messages[0].index, "graylog_pg");
          assertEquals(res.used_indices, ["graylog_pg"]);
        },
      );

      await t.step("ingest is idempotent on _id", async () => {
        const again = await store.ingestGelf({
          version: "1.1",
          host: "it-source-a",
          short_message: "integration hello DUPLICATE",
          timestamp: Date.parse("2026-06-30T00:00:00.500Z") / 1000,
          _id: "it-0001",
        });
        assert(again.ok);
        const res = await store.search({ query: "source:it-source-a" });
        assertEquals(res.total_results, 1);
        assertEquals(res.messages[0].message.message, "integration hello");
      });

      await t.step(
        "backfill fixture: imported/skipped counts and re-run idempotency",
        async () => {
          const first = await backfill(pool, FIXTURE);
          assertEquals(first, { lines: 10, imported: 9, skipped: 1 }); // one duplicate _id collapses
          const second = await backfill(pool, FIXTURE);
          assertEquals(second, { lines: 10, imported: 0, skipped: 10 });
        },
      );

      await t.step(
        "backfill parses space-separated timestamps as UTC",
        async () => {
          const res = await pool.query(
            `SELECT "timestamp" FROM graylog_messages WHERE message_id = 'bf-0001'`,
          );
          const got = res.rows[0].timestamp as Date;
          assertEquals(got.getTime(), Date.parse("2026-05-28T03:17:37.000Z"));
        },
      );

      await t.step("newest-first ordering and limit clamp", async () => {
        const res = await store.search({ query: "*", limit: 3 });
        assertEquals(res.total_results, 10); // 1 ingested + 9 backfilled
        assertEquals(res.messages.length, 3);
        const ts = res.messages.map((m) =>
          Date.parse(String(m.message.timestamp))
        );
        assertEquals([...ts].sort((a, b) => b - a), ts);
        assertEquals(ts[0], Date.parse("2026-06-30T00:00:00.500Z"));

        const bogus = await store.search({ query: "*", limit: -5 });
        assertEquals(bogus.messages.length, 10); // falls back to default (150) > corpus
      });

      await t.step(
        "fields whitelist always includes timestamp + source",
        async () => {
          const res = await store.search({
            query: 'creator:"@boosteddealsdaily" AND sample_status:sold',
            fields: ["gmv_num", "marketplace", "nope"],
          });
          assertEquals(res.total_results, 1);
          const m = res.messages[0].message;
          assertEquals(
            Object.keys(m).sort(),
            ["gmv_num", "marketplace", "source", "timestamp"],
          );
          assertEquals(m.gmv_num, 40);
          assertEquals(m.marketplace, "ebay");
          assertEquals(m.source, "thirsty-store-kiosk");
        },
      );

      await t.step(
        "range window semantics + empty-window 500 rule (real store)",
        async () => {
          // Newest stored doc is 2026-06-30; a 60s window is strictly newer → 500.
          const sentinel = await handleSearchRequest(
            store,
            new Request(`${SEARCH_URL}?query=*&range=60`),
          );
          assertEquals(sentinel.status, 500);
          const body = await sentinel.json();
          assertEquals(body.type, "ApiError");
          assert(String(body.message).includes("index_not_found_exception"));

          // Window reaches back past the newest doc but the query matches nothing → 200 / 0.
          const ok = await handleSearchRequest(
            store,
            new Request(
              `${SEARCH_URL}?query=source:does-not-exist&range=${
                400 * 24 * 3600
              }`,
            ),
          );
          assertEquals(ok.status, 200);
          const okBody = await ok.json();
          assertEquals(okBody.total_results, 0);
          assertEquals(okBody.used_indices, ["graylog_pg"]);

          // range=0 and huge ranges are all-time.
          const all = await store.search({ query: "*", rangeSeconds: 0 });
          assertEquals(all.total_results, 10);
          const fiveYears = await store.search({
            query: "*",
            rangeSeconds: 157_680_000,
          });
          assertEquals(fiveYears.total_results, 10);
        },
      );

      await t.step(
        "astToSql agrees with the pure evaluator on the whole corpus",
        async () => {
          const allRows = await pool.query(
            `SELECT fields FROM graylog_messages`,
          );
          const corpus = allRows.rows.map((r) =>
            r.fields as Record<string, unknown>
          );
          const queries = [
            "*",
            "source:thirsty-store-kiosk",
            'creator:"@boosteddealsdaily"',
            'creator.keyword:"@wizardofdealz"',
            "gmv_num:[50 TO 1000]",
            "gmv_num:[* TO 50] AND source:thirsty-store-kiosk",
            "(source:lifepreneur-extension OR source:tiktok-affiliate-export) AND product_id:1729587769570529799",
            "missing_num:[0 TO *]",
            "gmv_num:0",
            'message:"probe"',
            "sample_status:sold OR sample_status:checked_out",
            "views_num:[10000 TO *] banana",
          ];
          for (const q of queries) {
            const ast = parseQuery(q);
            const expected = corpus
              .filter((f) => evalNode(ast, f))
              .map((f) => JSON.stringify(f))
              .sort();
            const got = await store.search({ query: q, limit: 1000 });
            assertEquals(
              got.total_results,
              expected.length,
              `count mismatch for: ${q}`,
            );
            const gotSet = got.messages.map((m) => JSON.stringify(m.message))
              .sort();
            assertEquals(gotSet, expected, `row mismatch for: ${q}`);
          }
        },
      );

      await t.step(
        "logEvent writes an lp-os-sourced row (runs last: uses now())",
        async () => {
          const ok = await store.logEvent("lp-os event: test", {
            creator: "@boosteddealsdaily",
            sample_event: "test",
          });
          assert(ok);
          const res = await store.search({ query: "source:lp-os" });
          assertEquals(res.total_results, 1);
          assertEquals(res.messages[0].message.message, "lp-os event: test");
          assertEquals(res.messages[0].message.sample_event, "test");

          const withSource = await store.logEvent("kiosk event", {
            source: "thirsty-store-kiosk",
            sample_event: "test2",
          });
          assert(withSource);
          const kiosk = await store.search({
            query: "source:thirsty-store-kiosk AND sample_event:test2",
          });
          assertEquals(kiosk.total_results, 1);

          const newest = await store.newestTimestampMs();
          assert(newest !== null && Date.now() - newest < 60_000);
        },
      );
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(
        () => {},
      );
      await pool.end();
    }
  },
});
