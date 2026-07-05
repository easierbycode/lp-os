// builders.ts — pure query-builder internals ported from data-pimp db.ts.
// Deliberately free of pg/env/IO so every function unit-tests without a
// database (see test/builders_test.ts).

/** Quote a column identifier, escaping embedded double quotes (anti-SQLi). */
export function safeIdent(col: string): string {
  return `"${col.replace(/"/g, '""')}"`;
}

/** Order-by fallback when no (valid) sort column is requested. */
export function pickFallbackColumn(cols: Set<string>): string {
  if (cols.has("created_at")) return "created_at";
  if (cols.has("created_on")) return "created_on";
  if (cols.has("created")) return "created";
  if (cols.has("id")) return "id";
  return Array.from(cols)[0] || "id";
}

/**
 * Parse an order-by spec (`col` asc / `-col` desc) against the table's real
 * columns. Unknown columns fall back to pickFallbackColumn; empty input sorts
 * by the fallback DESC (i.e. `-created_at` on every LP-OS table). Legacy alias
 * kept: `created_date` → `created_at`.
 */
export function parseOrderBy(
  orderBy: string | null | undefined,
  cols: Set<string>,
): string {
  const raw = (orderBy || "").trim();
  if (!raw) {
    const fb = pickFallbackColumn(cols);
    return `${safeIdent(fb)} DESC`;
  }

  const desc = raw.startsWith("-");
  const requested = (desc ? raw.slice(1) : raw).trim();

  let col = requested;
  if (
    col === "created_date" && !cols.has("created_date") &&
    cols.has("created_at")
  ) {
    col = "created_at";
  }

  if (!cols.has(col)) col = pickFallbackColumn(cols);
  return `${safeIdent(col)} ${desc ? "DESC" : "ASC"}`;
}

/**
 * Build a parameterized WHERE clause from a filter map. Keys not present in
 * the table's columns are ignored (prevents SQLi via filter names); null and
 * undefined values are skipped (falsy-but-real values like 0/''/false are
 * kept).
 */
export function buildWhere(
  filters: Record<string, unknown> | null | undefined,
  cols: Set<string>,
): { clause: string; values: unknown[] } {
  const values: unknown[] = [];
  const parts: string[] = [];

  if (filters) {
    for (const [k, v] of Object.entries(filters)) {
      if (v === undefined || v === null) continue;
      if (!cols.has(k)) continue;
      values.push(v);
      parts.push(`${safeIdent(k)} = $${values.length}`);
    }
  }

  const clause = parts.length ? `where ${parts.join(" and ")}` : "";
  return { clause, values };
}

/** Clamp a limit to [1, 500]; undefined/non-finite means "no limit". */
export function safeLimit(limit?: number): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit)) return undefined;
  return Math.max(1, Math.min(500, Math.trunc(limit)));
}

/**
 * Serialize a returned row for the module API: timestamptz columns come back
 * from pg as JS Date — convert them to ISO strings so ported callers (which
 * historically stored ISO TEXT) see the same shape. Non-Date values (jsonb
 * objects, text[] arrays, …) pass through untouched; rows without any Date
 * are returned as-is.
 */
export function serializeRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) {
      if (!out) out = { ...row };
      out[k] = v.toISOString();
    }
  }
  return out ?? row;
}
