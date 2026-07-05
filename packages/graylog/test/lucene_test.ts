import { assert, assertEquals, assertFalse } from "@std/assert";
import { type Ast, evalNode, parseQuery } from "../lucene.ts";

// ───────────────────────────── parser ─────────────────────────────

Deno.test("parse: '*' and empty input match all", () => {
  assertEquals(parseQuery("*"), { t: "all" });
  assertEquals(parseQuery(""), { t: "all" });
  assertEquals(parseQuery("   "), { t: "all" });
});

Deno.test("parse: bareword term", () => {
  assertEquals(parseQuery("source:tiktok-affiliate-export"), {
    t: "term",
    field: "source",
    value: "tiktok-affiliate-export",
  });
});

Deno.test("parse: quoted phrase with spaces", () => {
  assertEquals(parseQuery('creator:"@pretty plug.x"'), {
    t: "term",
    field: "creator",
    value: "@pretty plug.x",
  });
});

Deno.test("parse: quoted phrase with escaped quote", () => {
  assertEquals(parseQuery('note:"say \\"hi\\" now"'), {
    t: "term",
    field: "note",
    value: 'say "hi" now',
  });
});

Deno.test("parse: field.keyword collapses to field", () => {
  assertEquals(parseQuery('creator.keyword:"@x"'), {
    t: "term",
    field: "creator",
    value: "@x",
  });
});

Deno.test("parse: numeric ranges incl. * bounds", () => {
  assertEquals(parseQuery("gmv_num:[100 TO *]"), {
    t: "range",
    field: "gmv_num",
    lo: 100,
    hi: null,
  });
  assertEquals(parseQuery("gmv_num:[* TO 100]"), {
    t: "range",
    field: "gmv_num",
    lo: null,
    hi: 100,
  });
  assertEquals(parseQuery("gmv_num:[12.5 TO 99.75]"), {
    t: "range",
    field: "gmv_num",
    lo: 12.5,
    hi: 99.75,
  });
  assertEquals(parseQuery("gmv_num:[* TO *]"), {
    t: "range",
    field: "gmv_num",
    lo: null,
    hi: null,
  });
});

Deno.test("parse: range TO is case-insensitive; keyword collapse applies", () => {
  assertEquals(parseQuery("gmv_num.keyword:[1 to 2]"), {
    t: "range",
    field: "gmv_num",
    lo: 1,
    hi: 2,
  });
});

Deno.test("parse: explicit AND / OR are case-insensitive", () => {
  const expected: Ast = {
    t: "and",
    kids: [
      { t: "term", field: "a", value: "1" },
      { t: "term", field: "b", value: "2" },
    ],
  };
  assertEquals(parseQuery("a:1 AND b:2"), expected);
  assertEquals(parseQuery("a:1 and b:2"), expected);
  assertEquals(parseQuery("a:1 OR b:2"), {
    t: "or",
    kids: [
      { t: "term", field: "a", value: "1" },
      { t: "term", field: "b", value: "2" },
    ],
  });
});

Deno.test("parse: implicit adjacency is AND", () => {
  assertEquals(parseQuery("a:1 b:2"), {
    t: "and",
    kids: [
      { t: "term", field: "a", value: "1" },
      { t: "term", field: "b", value: "2" },
    ],
  });
});

Deno.test("parse: AND binds tighter than OR", () => {
  assertEquals(parseQuery("a:1 OR b:2 AND c:3"), {
    t: "or",
    kids: [
      { t: "term", field: "a", value: "1" },
      {
        t: "and",
        kids: [
          { t: "term", field: "b", value: "2" },
          { t: "term", field: "c", value: "3" },
        ],
      },
    ],
  });
});

Deno.test("parse: parens override precedence", () => {
  assertEquals(parseQuery("(a:1 OR b:2) AND c:3"), {
    t: "and",
    kids: [
      {
        t: "or",
        kids: [
          { t: "term", field: "a", value: "1" },
          { t: "term", field: "b", value: "2" },
        ],
      },
      { t: "term", field: "c", value: "3" },
    ],
  });
});

Deno.test("parse: nested parens as clients emit them", () => {
  assertEquals(
    parseQuery('(source:x) AND (creator:"@y" OR creator.keyword:"@y")'),
    {
      t: "and",
      kids: [
        { t: "term", field: "source", value: "x" },
        {
          t: "or",
          kids: [
            { t: "term", field: "creator", value: "@y" },
            { t: "term", field: "creator", value: "@y" },
          ],
        },
      ],
    },
  );
});

Deno.test("parse: stray bare token becomes inert empty-field term", () => {
  assertEquals(parseQuery("banana"), { t: "term", field: "", value: "banana" });
});

Deno.test("parse: star combines with terms via implicit AND", () => {
  assertEquals(parseQuery("* source:x"), {
    t: "and",
    kids: [{ t: "all" }, { t: "term", field: "source", value: "x" }],
  });
});

// ───────────────────────────── evaluator ─────────────────────────────

const doc = {
  source: "thirsty-store-kiosk",
  message: "thirsty sample sold: Foo",
  creator: "@boosteddealsdaily",
  gmv_num: 40,
  net_num: "31.5",
  empty: "",
  timestamp: "2026-06-20T18:45:12.000Z",
};

Deno.test("eval: all matches everything", () => {
  assert(evalNode(parseQuery("*"), doc));
  assert(evalNode(parseQuery("*"), {}));
});

Deno.test("eval: term equality is string equality", () => {
  assert(evalNode(parseQuery("source:thirsty-store-kiosk"), doc));
  assertFalse(evalNode(parseQuery("source:other"), doc));
  assert(evalNode(parseQuery('creator:"@boosteddealsdaily"'), doc));
  assert(evalNode(parseQuery("gmv_num:40"), doc)); // String(40) === "40"
});

Deno.test("eval: missing field equals empty string", () => {
  assert(evalNode(parseQuery('missing:""'), doc));
  assertFalse(evalNode(parseQuery("missing:x"), doc));
});

Deno.test("eval: range is inclusive and guards null/empty/NaN", () => {
  assert(evalNode(parseQuery("gmv_num:[40 TO 40]"), doc)); // inclusive
  assert(evalNode(parseQuery("gmv_num:[* TO 100]"), doc));
  assert(evalNode(parseQuery("net_num:[31 TO 32]"), doc)); // numeric string
  assertFalse(evalNode(parseQuery("gmv_num:[41 TO *]"), doc));
  // missing / empty / non-numeric fields must NOT match [* TO x] or [0 TO *]
  assertFalse(evalNode(parseQuery("missing:[* TO 100]"), doc));
  assertFalse(evalNode(parseQuery("missing:[0 TO *]"), doc));
  assertFalse(evalNode(parseQuery("empty:[* TO 100]"), doc));
  assertFalse(evalNode(parseQuery("source:[0 TO *]"), doc)); // Number(str) = NaN
});

Deno.test("eval: and/or/precedence", () => {
  assert(
    evalNode(
      parseQuery("source:thirsty-store-kiosk AND gmv_num:[10 TO *]"),
      doc,
    ),
  );
  assert(evalNode(parseQuery("source:nope OR gmv_num:40"), doc));
  assertFalse(evalNode(parseQuery("source:nope AND gmv_num:40"), doc));
  // a OR b AND c === a OR (b AND c)
  assert(
    evalNode(
      parseQuery("source:thirsty-store-kiosk OR source:nope AND missing:x"),
      doc,
    ),
  );
  assertFalse(
    evalNode(
      parseQuery("(source:thirsty-store-kiosk OR source:nope) AND missing:x"),
      doc,
    ),
  );
});

Deno.test("eval: stray bare token never matches", () => {
  assertFalse(evalNode(parseQuery("banana"), doc));
  assertFalse(evalNode(parseQuery("banana"), {}));
});

// ───────────────────────────── existence (field:*) ─────────────────────────────

Deno.test("parse: field:* is an exists node (keyword collapse applies)", () => {
  assertEquals(parseQuery("creator:*"), { t: "exists", field: "creator" });
  assertEquals(parseQuery("creator.keyword:*"), {
    t: "exists",
    field: "creator",
  });
  // Quoted "*" stays literal equality.
  assertEquals(parseQuery('creator:"*"'), {
    t: "term",
    field: "creator",
    value: "*",
  });
});

Deno.test("eval: exists matches present non-empty values only", () => {
  assert(evalNode(parseQuery("creator:*"), doc));
  assert(evalNode(parseQuery("gmv_num:*"), doc)); // numbers count
  assertFalse(evalNode(parseQuery("missing:*"), doc));
  assertFalse(evalNode(parseQuery("empty:*"), doc)); // "" counts as absent
  assertFalse(evalNode(parseQuery('creator:"*"'), doc)); // literal "*" ≠ handle
});

// The exact read queries @lp-os/lifecycle issues (ported verbatim from
// data-pimp, where they ran against real Graylog's `field:*` existence
// semantics). They MUST match the docs those events produce.
Deno.test("eval: lifecycle read queries match their event docs", () => {
  const assignment = {
    source: "thirsty-store-kiosk",
    creator: "@boosteddealsdaily",
    sample_assignment_json: '{"productId":"172","sampleId":42}',
    sample_id: "42",
    product_id: "172",
  };
  const sold = {
    source: "thirsty-store-kiosk",
    creator: "@boosteddealsdaily",
    sample_sold_json: '{"salePrice":40}',
    sample_source: "tracker-resale",
    sample_id: "42",
  };
  const schedule = {
    source: "thirsty-store-kiosk",
    sample_schedule_json: '{"scheduleId":"sch-1"}',
  };

  assert(evalNode(parseQuery("creator:*"), assignment)); // fetchKnownCreators
  assert(
    evalNode(
      parseQuery('creator:* AND sample_assignment_json:* AND sample_id:"42"'),
      assignment,
    ),
    "fetchAssignedCreatorForSample query must match assignment events",
  );
  assert(
    evalNode(
      parseQuery(
        'sample_sold_json:* AND sample_source:"tracker-resale" AND sample_id:"42"',
      ),
      sold,
    ),
    "hasResaleEventForSample query must match resale events",
  );
  assertFalse(
    evalNode(
      parseQuery(
        'sample_sold_json:* AND sample_source:"tracker-resale" AND sample_id:"42"',
      ),
      assignment,
    ),
  );
  assert(
    evalNode(parseQuery("sample_schedule_json:*"), schedule),
    "fetchScheduleRecords query must match schedule intents",
  );
});
