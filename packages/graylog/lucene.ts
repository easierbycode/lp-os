// Mini-Lucene subset parser/evaluator, ported nearly verbatim from
// tok-scrape/graylog-shim/lucene.ts, plus astToSql() which compiles the same
// AST to a parameterized Postgres WHERE clause over graylog_messages.
//
// Clients (extension api.js, graylog_query script, bookmarklets) emit ONLY a
// small, fixed grammar — not real full-text search.
//
// Grammar (exhaustive — the set of shapes clients actually produce):
//   expr      := or
//   or        := and ( OR and )*
//   and       := primary ( (AND)? primary )*        // implicit adjacency = AND
//   primary   := '(' or ')' | '*' | term
//   term      := FIELD ':' ( phrase | range | exists | bareword )
//   phrase    := '"' chars-with-\"-escape '"'       // creator:"@prettyplug.x"
//   range     := '[' bound 'TO' bound ']'           // gmv_num:[100 TO *]
//   bound     := number | '*'
//   exists    := '*'                                 // creator:* = "field exists"
//   bareword  := non-space, non-paren run           // source:tiktok-affiliate-export
//
// `field:*` matches real-Graylog/Elasticsearch existence semantics: the field
// is present with a non-empty value. (A QUOTED "*" stays literal equality.)
// The lifecycle package and the sample-lifecycle skill docs rely on it
// (`creator:*`, `sample_sold_json:*`, `sample_schedule_json:*`, …).
//
// `field.keyword` collapses to `field` (no analyzer here; the two are always
// OR'd by api.js, so equality on either satisfies the clause).
// AND binds tighter than OR. Field/value matching is string equality except
// ranges, which are inclusive numeric with a strict null/"" guard.

export type Ast =
  | { t: "all" }
  | { t: "term"; field: string; value: string }
  | { t: "exists"; field: string }
  | { t: "range"; field: string; lo: number | null; hi: number | null }
  | { t: "and"; kids: Ast[] }
  | { t: "or"; kids: Ast[] };

// ───────────────────────────── tokenizer ─────────────────────────────

type Tok =
  | { k: "lp" }
  | { k: "rp" }
  | { k: "and" }
  | { k: "or" }
  | { k: "star" }
  | { k: "term"; node: Ast };

const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";

function collapseField(field: string): string {
  return field.endsWith(".keyword")
    ? field.slice(0, -".keyword".length)
    : field;
}

function parseRange(field: string, inner: string): Ast {
  // inner looks like "100 TO *", "* TO 100", "100 TO 200" (TO is case-insensitive).
  const m = inner.split(/\s+TO\s+/i);
  const lo = m[0]?.trim() ?? "*";
  const hi = m[1]?.trim() ?? "*";
  const bound = (b: string): number | null =>
    (b === "*" || b === "") ? null : Number(b);
  return {
    t: "range",
    field: collapseField(field),
    lo: bound(lo),
    hi: bound(hi),
  };
}

function tokenize(input: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const c = input[i];
    if (isWs(c)) {
      i++;
      continue;
    }
    if (c === "(") {
      toks.push({ k: "lp" });
      i++;
      continue;
    }
    if (c === ")") {
      toks.push({ k: "rp" });
      i++;
      continue;
    }

    // Read a "head" run up to ws / paren / ':'.
    let head = "";
    while (
      i < n && !isWs(input[i]) && input[i] !== "(" && input[i] !== ")" &&
      input[i] !== ":"
    ) {
      head += input[i++];
    }

    if (i < n && input[i] === ":") {
      // FIELD ':' value
      i++; // consume ':'
      const field = head;
      if (input[i] === '"') {
        // quoted phrase with \" escape
        i++; // opening quote
        let v = "";
        while (i < n) {
          const ch = input[i];
          if (ch === "\\" && i + 1 < n && input[i + 1] === '"') {
            v += '"';
            i += 2;
            continue;
          }
          if (ch === '"') {
            i++;
            break;
          }
          v += ch;
          i++;
        }
        toks.push({
          k: "term",
          node: { t: "term", field: collapseField(field), value: v },
        });
      } else if (input[i] === "[") {
        i++; // '['
        let inner = "";
        while (i < n && input[i] !== "]") inner += input[i++];
        if (i < n) i++; // ']'
        toks.push({ k: "term", node: parseRange(field, inner) });
      } else {
        // bareword value: read up to ws / paren
        let v = "";
        while (
          i < n && !isWs(input[i]) && input[i] !== "(" && input[i] !== ")"
        ) v += input[i++];
        // A bare `*` value is an existence query (real-Graylog semantics),
        // not equality with the literal "*". Quoted "*" stays literal.
        toks.push({
          k: "term",
          node: v === "*"
            ? { t: "exists", field: collapseField(field) }
            : { t: "term", field: collapseField(field), value: v },
        });
      }
      continue;
    }

    // No colon: head is a bareword operator / star / stray token.
    if (head === "*") {
      toks.push({ k: "star" });
      continue;
    }
    const up = head.toUpperCase();
    if (up === "AND") {
      toks.push({ k: "and" });
      continue;
    }
    if (up === "OR") {
      toks.push({ k: "or" });
      continue;
    }
    // Unknown bare token — clients never emit this. Treat as a term that can
    // never match (field "" is absent on every doc) so it's inert rather than
    // accidentally matching everything.
    toks.push({ k: "term", node: { t: "term", field: "", value: head } });
  }
  return toks;
}

// ───────────────────────────── parser ─────────────────────────────

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.p];
  }
  private next(): Tok | undefined {
    return this.toks[this.p++];
  }

  parse(): Ast {
    if (this.toks.length === 0) return { t: "all" };
    return this.parseOr();
  }

  private parseOr(): Ast {
    const kids = [this.parseAnd()];
    while (this.peek()?.k === "or") {
      this.next();
      kids.push(this.parseAnd());
    }
    return kids.length === 1 ? kids[0] : { t: "or", kids };
  }

  private parseAnd(): Ast {
    const kids = [this.parsePrimary()];
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.k === "and") {
        this.next();
        kids.push(this.parsePrimary());
        continue;
      }
      // implicit AND: another primary with no operator between
      if (t.k === "lp" || t.k === "star" || t.k === "term") {
        kids.push(this.parsePrimary());
        continue;
      }
      break; // 'or' or 'rp' → let the caller handle it
    }
    return kids.length === 1 ? kids[0] : { t: "and", kids };
  }

  private parsePrimary(): Ast {
    const t = this.next();
    if (!t) return { t: "all" };
    if (t.k === "lp") {
      const e = this.parseOr();
      if (this.peek()?.k === "rp") this.next();
      return e;
    }
    if (t.k === "star") return { t: "all" };
    if (t.k === "term") return t.node;
    // stray AND/OR/RP at primary position — be lenient
    return { t: "all" };
  }
}

export function parseQuery(query: string): Ast {
  const q = (query ?? "").trim();
  if (q === "" || q === "*") return { t: "all" };
  return new Parser(tokenize(q)).parse();
}

// ───────────────────────────── evaluator ─────────────────────────────

// Pure in-memory evaluator over a flat fields map. Kept alongside astToSql so
// tests can assert SQL ≡ evaluator on the same documents.
export function evalNode(n: Ast, f: Record<string, unknown>): boolean {
  switch (n.t) {
    case "all":
      return true;
    case "and":
      return n.kids.every((k) => evalNode(k, f));
    case "or":
      return n.kids.some((k) => evalNode(k, f));
    case "term":
      return String(f[n.field] ?? "") === n.value;
    case "exists": {
      // Present with a non-empty value — mirrors the SQL compiler's
      // COALESCE(fields->>key,'') <> '' (empty string counts as absent, the
      // same convention the term case uses in reverse).
      const raw = f[n.field];
      return raw != null && raw !== "";
    }
    case "range": {
      const raw = f[n.field];
      // CRITICAL: null/undefined/"" are NON-numeric. Number(null)===0 would make
      // a missing gmv_num match [* TO 100] / [0 TO *] as if GMV were 0.
      if (raw == null || raw === "") return false;
      const v = Number(raw);
      if (Number.isNaN(v)) return false;
      if (n.lo != null && v < n.lo) return false; // inclusive
      if (n.hi != null && v > n.hi) return false;
      return true;
    }
  }
}

// ───────────────────────────── SQL compiler ─────────────────────────────

// Compiles an AST to a parameterized WHERE fragment over graylog_messages.
// source/timestamp/message map to their real columns; every other field goes
// through the flat jsonb map (fields->>'key'). No user input ever lands in the
// SQL text itself — field names and values are ALL bind parameters.

// Mirrors the value shapes JS Number() accepts, so the ::float8 cast below can
// never throw on non-numeric field values (they simply don't match).
const NUM_RE = "^\\s*[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?\\s*$";

export function astToSql(ast: Ast): { clause: string; values: unknown[] } {
  const values: unknown[] = [];
  const clause = build(ast, values);
  return { clause, values };
}

function param(values: unknown[], v: unknown): string {
  values.push(v);
  return `$${values.length}`;
}

function build(n: Ast, values: unknown[]): string {
  switch (n.t) {
    case "all":
      return "TRUE";
    case "and":
      return `(${n.kids.map((k) => build(k, values)).join(" AND ")})`;
    case "or":
      return `(${n.kids.map((k) => build(k, values)).join(" OR ")})`;
    case "term":
      return buildTerm(n, values);
    case "exists":
      return buildExists(n, values);
    case "range":
      return buildRange(n, values);
  }
}

function buildExists(
  n: Extract<Ast, { t: "exists" }>,
  values: unknown[],
): string {
  // Stray unfielded `:*`: inert, like the evaluator's field-"" check.
  if (n.field === "") return "FALSE";
  // Real columns: present on every row, but mirror the evaluator's non-empty
  // check so `source:*` ≡ evalNode over the flat fields map.
  if (n.field === "source") return `COALESCE(source, '') <> ''`;
  if (n.field === "message") return `COALESCE(message, '') <> ''`;
  // timestamp is NOT NULL and always mapped into the flat fields copy.
  if (n.field === "timestamp") return "TRUE";
  return `COALESCE(fields->>${param(values, n.field)}, '') <> ''`;
}

function buildTerm(n: Extract<Ast, { t: "term" }>, values: unknown[]): string {
  // Stray unfielded bare token: inert (matches the evaluator's field-"" term).
  if (n.field === "") return "FALSE";
  if (n.field === "source") return `source = ${param(values, n.value)}`;
  // The message column holds short_message; fields.message is its verbatim
  // copy, so column equality ≡ the evaluator's fields-map equality.
  if (n.field === "message") return `message = ${param(values, n.value)}`;
  if (n.field === "timestamp") {
    // Compare as an instant on the real column. Unparseable input can never
    // match (build-time guard keeps the SQL cast from throwing).
    const ms = Date.parse(n.value);
    if (Number.isNaN(ms)) return "FALSE";
    return `"timestamp" = ${
      param(values, new Date(ms).toISOString())
    }::timestamptz`;
  }
  // COALESCE mirrors the evaluator's `String(f[field] ?? "") === value`
  // (missing field matches the empty string).
  return `COALESCE(fields->>${param(values, n.field)}, '') = ${
    param(values, n.value)
  }`;
}

function buildRange(
  n: Extract<Ast, { t: "range" }>,
  values: unknown[],
): string {
  if (n.field === "") return "FALSE";
  // Evaluator does Number(ISO timestamp) → NaN → never matches; mirror that.
  if (n.field === "timestamp") return "FALSE";
  let expr: string;
  if (n.field === "source") expr = "source";
  else if (n.field === "message") expr = "message";
  else expr = `fields->>${param(values, n.field)}`;
  // Guard mirrors the evaluator: NULL fails the regex (NULL ~ … IS NULL), ""
  // and non-numeric strings fail it outright, and NULLIF keeps the cast
  // null-safe — so null/empty/non-numeric values never match a range.
  const parts = [`${expr} ~ '${NUM_RE}'`];
  const cast = `NULLIF(${expr}, '')::double precision`;
  // A NaN bound (malformed number in the query) behaves like '*' — the
  // evaluator's `v < NaN` is always false, so it never rejects.
  if (n.lo != null && !Number.isNaN(n.lo)) {
    parts.push(`${cast} >= ${param(values, n.lo)}`);
  }
  if (n.hi != null && !Number.isNaN(n.hi)) {
    parts.push(`${cast} <= ${param(values, n.hi)}`);
  }
  return `(${parts.join(" AND ")})`;
}
