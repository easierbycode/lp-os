import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  buildWhere,
  parseOrderBy,
  pickFallbackColumn,
  safeIdent,
  safeLimit,
  serializeRow,
} from "../builders.ts";

const SAMPLE_COLS = new Set([
  "id",
  "name",
  "qr_code",
  "status",
  "quantity",
  "created_at",
]);

Deno.test("safeIdent quotes plain identifiers", () => {
  assertEquals(safeIdent("name"), '"name"');
  assertEquals(safeIdent("created_at"), '"created_at"');
});

Deno.test("safeIdent escapes embedded double quotes (SQLi attempt)", () => {
  assertEquals(safeIdent('a"b'), '"a""b"');
  assertEquals(
    safeIdent('x"; drop table samples; --'),
    '"x""; drop table samples; --"',
  );
});

Deno.test("pickFallbackColumn prefers created_at, then created_on/created/id", () => {
  assertEquals(pickFallbackColumn(SAMPLE_COLS), "created_at");
  assertEquals(pickFallbackColumn(new Set(["id", "created_on"])), "created_on");
  assertEquals(pickFallbackColumn(new Set(["id", "created"])), "created");
  assertEquals(pickFallbackColumn(new Set(["id", "name"])), "id");
  assertEquals(pickFallbackColumn(new Set(["foo"])), "foo");
  assertEquals(pickFallbackColumn(new Set()), "id");
});

Deno.test("parseOrderBy: empty input falls back to created_at DESC", () => {
  assertEquals(parseOrderBy(undefined, SAMPLE_COLS), '"created_at" DESC');
  assertEquals(parseOrderBy(null, SAMPLE_COLS), '"created_at" DESC');
  assertEquals(parseOrderBy("  ", SAMPLE_COLS), '"created_at" DESC');
});

Deno.test("parseOrderBy: col = ASC, -col = DESC", () => {
  assertEquals(parseOrderBy("name", SAMPLE_COLS), '"name" ASC');
  assertEquals(parseOrderBy("-name", SAMPLE_COLS), '"name" DESC');
});

Deno.test("parseOrderBy: legacy created_date aliases to created_at", () => {
  assertEquals(parseOrderBy("-created_date", SAMPLE_COLS), '"created_at" DESC');
  assertEquals(parseOrderBy("created_date", SAMPLE_COLS), '"created_at" ASC');
  // …but only when created_date itself is absent.
  const withReal = new Set(["id", "created_date", "created_at"]);
  assertEquals(parseOrderBy("created_date", withReal), '"created_date" ASC');
});

Deno.test("parseOrderBy: unknown columns fall back (direction preserved)", () => {
  assertEquals(parseOrderBy("nope", SAMPLE_COLS), '"created_at" ASC');
  assertEquals(parseOrderBy("-nope", SAMPLE_COLS), '"created_at" DESC');
  assertEquals(
    parseOrderBy('-"; drop table samples; --', SAMPLE_COLS),
    '"created_at" DESC',
  );
});

Deno.test("buildWhere: builds parameterized clause for known columns", () => {
  const { clause, values } = buildWhere(
    { status: "available", qr_code: "12345" },
    SAMPLE_COLS,
  );
  assertEquals(clause, 'where "status" = $1 and "qr_code" = $2');
  assertEquals(values, ["available", "12345"]);
});

Deno.test("buildWhere: ignores unknown keys (SQLi prevention)", () => {
  const { clause, values } = buildWhere(
    { 'evil"; drop table samples; --': "x", status: "sold" },
    SAMPLE_COLS,
  );
  assertEquals(clause, 'where "status" = $1');
  assertEquals(values, ["sold"]);
});

Deno.test("buildWhere: skips null/undefined but keeps falsy real values", () => {
  const { clause, values } = buildWhere(
    { name: null, status: undefined, quantity: 0 },
    SAMPLE_COLS,
  );
  assertEquals(clause, 'where "quantity" = $1');
  assertEquals(values, [0]);
});

Deno.test("buildWhere: empty/absent filters produce empty clause", () => {
  assertEquals(buildWhere(null, SAMPLE_COLS), { clause: "", values: [] });
  assertEquals(buildWhere({}, SAMPLE_COLS), { clause: "", values: [] });
});

Deno.test("safeLimit clamps to [1, 500]", () => {
  assertEquals(safeLimit(undefined), undefined);
  assertEquals(safeLimit(NaN), undefined);
  assertEquals(safeLimit(Infinity), undefined);
  assertEquals(safeLimit(0), 1);
  assertEquals(safeLimit(-5), 1);
  assertEquals(safeLimit(1), 1);
  assertEquals(safeLimit(42), 42);
  assertEquals(safeLimit(42.9), 42);
  assertEquals(safeLimit(500), 500);
  assertEquals(safeLimit(501), 500);
});

Deno.test("serializeRow converts Date values to ISO strings", () => {
  const row = {
    id: 1,
    name: "x",
    created_at: new Date("2026-01-02T03:04:05.678Z"),
    sold_at: null,
    related_upc: ["012345678905"],
    product_json: { title: "x" },
  };
  const out = serializeRow(row);
  assertEquals(out.created_at, "2026-01-02T03:04:05.678Z");
  assertEquals(out.sold_at, null);
  assertEquals(out.related_upc, ["012345678905"]);
  assertEquals(out.product_json, { title: "x" });
  // Original row untouched.
  assertEquals(row.created_at instanceof Date, true);
});

Deno.test("serializeRow returns the same object when no Dates present", () => {
  const row = { id: 1, name: "x", created_at: "2026-01-02T03:04:05.678Z" };
  assertStrictEquals(serializeRow(row), row);
});
