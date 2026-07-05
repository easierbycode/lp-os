import { assert, assertEquals, assertFalse, assertMatch } from "@std/assert";
import { astToSql, parseQuery } from "../lucene.ts";

function sqlFor(q: string) {
  return astToSql(parseQuery(q));
}

Deno.test("astToSql: '*' compiles to TRUE with no params", () => {
  assertEquals(sqlFor("*"), { clause: "TRUE", values: [] });
});

Deno.test("astToSql: source maps to the source column", () => {
  const { clause, values } = sqlFor("source:tiktok-affiliate-export");
  assertEquals(clause, "source = $1");
  assertEquals(values, ["tiktok-affiliate-export"]);
});

Deno.test("astToSql: message term maps to the message column", () => {
  const { clause, values } = sqlFor('message:"thirsty sample sold: Foo"');
  assertEquals(clause, "message = $1");
  assertEquals(values, ["thirsty sample sold: Foo"]);
});

Deno.test("astToSql: timestamp term maps to the timestamp column", () => {
  const { clause, values } = sqlFor('timestamp:"2026-06-20T18:45:12.000Z"');
  assertEquals(clause, `"timestamp" = $1::timestamptz`);
  assertEquals(values, ["2026-06-20T18:45:12.000Z"]);
});

Deno.test("astToSql: unparseable timestamp term compiles to FALSE", () => {
  assertEquals(sqlFor("timestamp:garbage"), { clause: "FALSE", values: [] });
});

Deno.test("astToSql: other fields go through fields->>'key' with both key and value parameterized", () => {
  const { clause, values } = sqlFor('creator:"@boosteddealsdaily"');
  assertEquals(clause, "COALESCE(fields->>$1, '') = $2");
  assertEquals(values, ["creator", "@boosteddealsdaily"]);
});

Deno.test("astToSql: numeric range uses NULLIF-guarded cast and numeric-shape regex", () => {
  const { clause, values } = sqlFor("gmv_num:[100 TO 200]");
  assert(clause.includes("fields->>$1 ~ '"));
  assert(clause.includes("NULLIF(fields->>$1, '')::double precision >= $2"));
  assert(clause.includes("NULLIF(fields->>$1, '')::double precision <= $3"));
  assertEquals(values, ["gmv_num", 100, 200]);
});

Deno.test("astToSql: star bounds drop that constraint but keep the numeric guard", () => {
  const lo = sqlFor("gmv_num:[100 TO *]");
  assert(lo.clause.includes(">= $2"));
  assertFalse(lo.clause.includes("<="));
  assertEquals(lo.values, ["gmv_num", 100]);

  const none = sqlFor("gmv_num:[* TO *]");
  assertFalse(none.clause.includes(">="));
  assertFalse(none.clause.includes("<="));
  assert(none.clause.includes("~")); // guard alone: field must exist and be numeric
  assertEquals(none.values, ["gmv_num"]);
});

Deno.test("astToSql: range on timestamp / stray bare token compile to FALSE", () => {
  assertEquals(sqlFor("timestamp:[0 TO 1]").clause, "FALSE");
  assertEquals(sqlFor("banana").clause, "FALSE");
});

Deno.test("astToSql: and/or nest with parens and sequential params", () => {
  const { clause, values } = sqlFor(
    '(source:x) AND (creator:"@y" OR creator.keyword:"@y")',
  );
  assertEquals(
    clause,
    "(source = $1 AND (COALESCE(fields->>$2, '') = $3 OR COALESCE(fields->>$4, '') = $5))",
  );
  assertEquals(values, ["x", "creator", "@y", "creator", "@y"]);
});

Deno.test("astToSql: user input NEVER appears in the SQL text", () => {
  const hostile = [
    `creator:"Robert'); DROP TABLE graylog_messages;--"`,
    `source:'--`,
    `evil'field:"x' OR '1'='1"`,
    `gmv_num:[1 TO 9999]`,
  ];
  for (const q of hostile) {
    const { clause, values } = sqlFor(q);
    assertFalse(clause.includes("DROP"), `clause leaked value: ${clause}`);
    assertFalse(clause.includes("'--"), `clause leaked value: ${clause}`);
    assertFalse(clause.includes("evil"), `clause leaked field: ${clause}`);
    // Clause text is only SQL skeleton + placeholders: every quoted region is
    // one of ours (the numeric-guard regex literal or the '' empty string).
    for (const v of values) {
      if (typeof v === "string" && v.length > 2) {
        assertFalse(clause.includes(v), `clause contains param value "${v}"`);
      }
    }
    // placeholders are numbered $1..$n exactly
    const placeholders = clause.match(/\$\d+/g) ?? [];
    assertEquals(new Set(placeholders).size, values.length);
  }
});

Deno.test("astToSql: numeric guard regex matches JS Number()-compatible shapes", () => {
  const { clause } = sqlFor("x:[* TO *]");
  const m = clause.match(/~ '([^']+)'/);
  assert(m, "guard regex missing");
  const re = new RegExp(m![1]);
  for (
    const good of ["40", "31.5", "-2", "+3", ".5", "5.", "1e3", "2.5E-2", " 7 "]
  ) {
    assertMatch(good, re);
  }
  for (const bad of ["", "abc", "12abc", "1.2.3", "--5", "$40"]) {
    assertFalse(re.test(bad), `guard regex wrongly matches "${bad}"`);
  }
});

Deno.test("astToSql: field:* compiles to a non-empty existence check", () => {
  const { clause, values } = sqlFor("sample_sold_json:*");
  assertEquals(clause, "COALESCE(fields->>$1, '') <> ''");
  assertEquals(values, ["sample_sold_json"]);
});

Deno.test("astToSql: exists on real columns / stray field", () => {
  assertEquals(sqlFor("source:*").clause, "COALESCE(source, '') <> ''");
  assertEquals(sqlFor("message:*").clause, "COALESCE(message, '') <> ''");
  assertEquals(sqlFor("timestamp:*").clause, "TRUE");
  assertEquals(sqlFor(":*").clause, "FALSE");
});

Deno.test('astToSql: quoted "*" stays literal equality, not existence', () => {
  const { clause, values } = sqlFor('creator:"*"');
  assertEquals(clause, "COALESCE(fields->>$1, '') = $2");
  assertEquals(values, ["creator", "*"]);
});

Deno.test("astToSql: lifecycle assignment query compiles with exists nodes", () => {
  const { clause, values } = sqlFor(
    'creator:* AND sample_assignment_json:* AND sample_id:"42"',
  );
  assertEquals(
    clause,
    "(COALESCE(fields->>$1, '') <> '' AND COALESCE(fields->>$2, '') <> '' AND COALESCE(fields->>$3, '') = $4)",
  );
  assertEquals(values, [
    "creator",
    "sample_assignment_json",
    "sample_id",
    "42",
  ]);
});
