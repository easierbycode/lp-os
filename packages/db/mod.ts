// @lp-os/db — consolidated Postgres data layer (docs/CONTRACTS.md "Database").
// Driver: npm:pg Pool, lazy singleton, Neon-compatible TLS. Query building
// follows data-pimp's proven column-cache pattern: every list/filter/insert/
// update validates identifiers against information_schema.columns before any
// SQL is interpolated; values always travel as $N parameters.

// @deno-types="@types/pg"
import { Pool, type QueryResult } from "pg";
import { databaseUrlError, getDatabaseUrl, sslConfigFor } from "./db-url.ts";
import {
  buildWhere,
  parseOrderBy,
  safeIdent,
  safeLimit,
  serializeRow,
} from "./builders.ts";
import { SCHEMA_SQL } from "./schema.ts";

export type { Pool, QueryResult };

let pool: Pool | null = null;

/** Lazy singleton Pool from DATABASE_URL. Throws a clear config error when the
 * value is unset or malformed, instead of pg's cryptic `ENOTFOUND base`. */
export function getPool(): Pool {
  if (pool) return pool;
  const url = getDatabaseUrl();
  if (!url) throw new Error("DATABASE_URL is not set");
  const err = databaseUrlError(url);
  if (err) throw new Error(err);

  const rawSize = Number(Deno.env.get("PG_POOL_SIZE") ?? "3");
  pool = new Pool({
    connectionString: url,
    max: Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 3,
    ssl: sslConfigFor(url),
    // Bound a stalled connection so a dead DB eventually rejects a request
    // instead of hanging it forever. connectionTimeoutMillis also covers time
    // queued waiting for a free client, so it must be >= statement_timeout.
    statement_timeout: 30_000,
    connectionTimeoutMillis: 35_000,
  });
  return pool;
}

/** Run a parameterized query on the shared pool. */
export function query(text: string, params?: unknown[]): Promise<QueryResult> {
  return getPool().query(text, params);
}

// Cache table columns so filters/order_by validate against real identifiers.
// Empty results (table not created yet) are NOT cached, so ensureSchema() /
// migrate can create tables after a failed early lookup.
const columnCache = new Map<string, Set<string>>();

async function getColumns(table: string): Promise<Set<string>> {
  const cached = columnCache.get(table);
  if (cached) return cached;

  const r = await query(
    `select column_name
     from information_schema.columns
     where table_schema = 'public' and table_name = $1
     order by ordinal_position`,
    [table],
  );
  const cols = new Set<string>(
    r.rows.map((row) => String((row as Record<string, unknown>).column_name)),
  );
  if (cols.size > 0) columnCache.set(table, cols);
  return cols;
}

type Row = Record<string, unknown>;

async function listTable(table: string, orderBy?: string): Promise<Row[]> {
  const cols = await getColumns(table);
  const orderSql = parseOrderBy(orderBy || null, cols);
  const r = await query(`select * from public.${table} order by ${orderSql}`);
  return (r.rows as Row[]).map(serializeRow);
}

async function filterTable(
  table: string,
  filters: Row,
  orderBy?: string,
  limit?: number,
): Promise<Row[]> {
  const cols = await getColumns(table);
  const orderSql = parseOrderBy(orderBy || null, cols);
  const { clause, values } = buildWhere(filters, cols);
  const lim = safeLimit(limit);

  const sql = `select * from public.${table} ${clause} order by ${orderSql}` +
    (lim ? ` limit ${lim}` : "");
  const r = await query(sql, values);
  return (r.rows as Row[]).map(serializeRow);
}

async function insertRow(table: string, data: Row): Promise<Row> {
  const cols = await getColumns(table);

  const keys = Object.keys(data).filter((k) => cols.has(k) && k !== "id");
  if (keys.length === 0) throw new Error(`No insertable fields for ${table}`);

  const values = keys.map((k) => data[k]);
  const colSql = keys.map(safeIdent).join(", ");
  const valSql = keys.map((_, i) => `$${i + 1}`).join(", ");

  const r = await query(
    `insert into public.${table} (${colSql}) values (${valSql}) returning *`,
    values,
  );
  return serializeRow(r.rows[0] as Row);
}

async function updateRow(
  table: string,
  id: string | number,
  data: Row,
): Promise<Row | null> {
  const cols = await getColumns(table);

  const keys = Object.keys(data).filter((k) => cols.has(k) && k !== "id");
  if (keys.length === 0) throw new Error(`No updatable fields for ${table}`);

  const values: unknown[] = keys.map((k) => data[k]);
  values.push(id);

  const setSql = keys.map((k, i) => `${safeIdent(k)} = $${i + 1}`).join(", ");
  const r = await query(
    `update public.${table} set ${setSql} where ${
      safeIdent("id")
    } = $${values.length} returning *`,
    values,
  );
  const row = r.rows[0] as Row | undefined;
  return row ? serializeRow(row) : null;
}

async function deleteRow(table: string, id: string | number): Promise<boolean> {
  const r = await query(
    `delete from public.${table} where ${safeIdent("id")} = $1`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

export type TableApi = {
  list(orderBy?: string): Promise<Record<string, unknown>[]>;
  filter(
    filters: Record<string, unknown>,
    orderBy?: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]>;
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(
    id: string | number,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  delete(id: string | number): Promise<boolean>;
};

function makeTableApi(table: string): TableApi {
  return {
    list: (orderBy?: string) => listTable(table, orderBy),
    filter: (filters: Row, orderBy?: string, limit?: number) =>
      filterTable(table, filters, orderBy, limit),
    create: (data: Row) => insertRow(table, data),
    update: (id: string | number, data: Row) => updateRow(table, id, data),
    delete: (id: string | number) => deleteRow(table, id),
  };
}

export const Samples: TableApi = makeTableApi("samples");
export const Bundles: TableApi = makeTableApi("bundles");
export const Transactions: TableApi = makeTableApi("transactions");
export const Listings: TableApi = makeTableApi("listings");

/* ------------------------------------------------- marketplace accounts -- */
// marketplace_accounts is keyed by marketplace name (no serial id), so it gets
// dedicated helpers instead of a TableApi (whose update/delete assume an `id`
// column). credentials/settings are stored whole — merge semantics belong to
// the caller, which reads the row, merges, and upserts the full objects.

export type MarketplaceAccount = {
  marketplace: string;
  environment: string;
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
  connected_at: string | null;
  updated_at: string;
  updated_by: string | null;
};

function toMarketplaceAccount(row: Row): MarketplaceAccount {
  return serializeRow(row) as unknown as MarketplaceAccount;
}

export async function getMarketplaceAccount(
  marketplace: string,
): Promise<MarketplaceAccount | null> {
  const r = await query(
    `select * from public.marketplace_accounts where marketplace = $1`,
    [marketplace],
  );
  const row = r.rows[0] as Row | undefined;
  return row ? toMarketplaceAccount(row) : null;
}

export async function listMarketplaceAccounts(): Promise<MarketplaceAccount[]> {
  const r = await query(
    `select * from public.marketplace_accounts order by marketplace`,
  );
  return (r.rows as Row[]).map(toMarketplaceAccount);
}

export async function upsertMarketplaceAccount(
  marketplace: string,
  data: {
    environment: string;
    credentials: Record<string, unknown>;
    settings: Record<string, unknown>;
    connected_at?: string | null;
    updated_by?: string | null;
  },
): Promise<MarketplaceAccount> {
  const r = await query(
    `insert into public.marketplace_accounts
       (marketplace, environment, credentials, settings, connected_at, updated_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (marketplace) do update set
       environment  = excluded.environment,
       credentials  = excluded.credentials,
       settings     = excluded.settings,
       connected_at = excluded.connected_at,
       updated_by   = excluded.updated_by,
       updated_at   = now()
     returning *`,
    [
      marketplace,
      data.environment,
      JSON.stringify(data.credentials ?? {}),
      JSON.stringify(data.settings ?? {}),
      data.connected_at ?? null,
      data.updated_by ?? null,
    ],
  );
  return toMarketplaceAccount(r.rows[0] as Row);
}

/** Stamp a successful live credential check WITHOUT rewriting the row —
 * a read-modify-write here could silently revert a concurrent credential
 * save from the Marketplace window. */
export async function touchMarketplaceAccountVerified(
  marketplace: string,
): Promise<MarketplaceAccount | null> {
  const r = await query(
    `update public.marketplace_accounts
     set connected_at = now(), updated_at = now()
     where marketplace = $1
     returning *`,
    [marketplace],
  );
  const row = r.rows[0] as Row | undefined;
  return row ? toMarketplaceAccount(row) : null;
}

export async function deleteMarketplaceAccount(
  marketplace: string,
): Promise<boolean> {
  const r = await query(
    `delete from public.marketplace_accounts where marketplace = $1`,
    [marketplace],
  );
  return (r.rowCount ?? 0) > 0;
}

/* -------------------------------------------------- listings joined read -- */

/** Listing rows joined with the sample columns UIs render alongside them.
 * Filters are equality matches; limit is clamped like every other read. */
export async function listListingsWithSamples(
  filters: {
    sample_id?: number | string;
    marketplace?: string;
    status?: string;
  } = {},
  limit?: number,
): Promise<Row[]> {
  const values: unknown[] = [];
  const parts: string[] = [];
  if (filters.sample_id !== undefined && filters.sample_id !== null) {
    values.push(filters.sample_id);
    parts.push(`l.sample_id = $${values.length}`);
  }
  if (filters.marketplace) {
    values.push(filters.marketplace);
    parts.push(`l.marketplace = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    parts.push(`l.status = $${values.length}`);
  }
  const where = parts.length ? `where ${parts.join(" and ")}` : "";
  const lim = safeLimit(limit) ?? 200;
  const r = await query(
    `select l.*,
            s.name       as sample_name,
            s.qr_code    as sample_qr_code,
            s.picture_url as sample_picture_url,
            s.status     as sample_status
     from public.listings l
     left join public.samples s on s.id = l.sample_id
     ${where}
     order by l.created_at desc, l.id desc
     limit ${lim}`,
    values,
  );
  return (r.rows as Row[]).map(serializeRow);
}

let schemaPromise: Promise<void> | null = null;

/** Idempotent: creates every LP-OS table/index and seed row if missing.
 * Mirrors migrations/0001_init.sql (all IF NOT EXISTS / ON CONFLICT DO
 * NOTHING). Concurrent callers share one in-flight run; a failed run clears
 * the memo so the next call retries. */
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = query(SCHEMA_SQL).then(() => undefined).catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}
