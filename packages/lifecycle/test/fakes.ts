// In-memory fakes for the injected deps: a TableApi over arrays, a
// GraylogStore that records every logEvent call, and an InventoryWriter that
// records every applyBatch request and returns a canned outcome.

import type {
  GraylogSearchParams,
  GraylogSearchResult,
  GraylogStore,
  InventoryBatchOutcome,
  InventoryWriter,
  LifecycleDb,
  TableApi,
} from "../types.ts";

type Row = Record<string, unknown>;

export class FakeTable implements TableApi {
  rows: Row[] = [];
  #nextId = 1;
  failNextCreate = false;

  constructor(seed: Row[] = []) {
    for (const row of seed) this.#insert(row);
  }

  #insert(data: Row): Row {
    const row: Row = { created_at: new Date().toISOString(), ...data };
    if (row.id == null) row.id = this.#nextId;
    this.#nextId = Math.max(this.#nextId, Number(row.id) + 1);
    this.rows.push(row);
    return row;
  }

  list(orderBy?: string): Promise<Row[]> {
    return this.filter({}, orderBy);
  }

  filter(filters: Row, orderBy?: string, limit?: number): Promise<Row[]> {
    let out = this.rows.filter((row) =>
      Object.entries(filters).every(([k, v]) => String(row[k]) === String(v))
    );
    if (orderBy) {
      const desc = orderBy.startsWith("-");
      const col = desc ? orderBy.slice(1) : orderBy;
      out = [...out].sort((a, b) => {
        const av = String(a[col] ?? "");
        const bv = String(b[col] ?? "");
        return desc ? bv.localeCompare(av) : av.localeCompare(bv);
      });
    }
    if (limit && limit > 0) out = out.slice(0, limit);
    return Promise.resolve(out.map((r) => ({ ...r })));
  }

  create(data: Row): Promise<Row> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      return Promise.reject(new Error("fake create failure"));
    }
    return Promise.resolve({ ...this.#insert(data) });
  }

  update(id: string | number, data: Row): Promise<Row | null> {
    const row = this.rows.find((r) => String(r.id) === String(id));
    if (!row) return Promise.resolve(null);
    Object.assign(row, data);
    return Promise.resolve({ ...row });
  }

  delete(id: string | number): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => String(r.id) !== String(id));
    return Promise.resolve(this.rows.length < before);
  }
}

export class FakeDb implements LifecycleDb {
  Samples = new FakeTable();
  Bundles = new FakeTable();
  Transactions = new FakeTable();
}

export type LoggedEvent = {
  shortMessage: string;
  fields: Record<string, unknown>;
};

export class FakeStore implements GraylogStore {
  events: LoggedEvent[] = [];
  logEventResult = true;
  // Route search queries: first matcher whose substring appears in the query
  // wins; otherwise empty results.
  searchRoutes: Array<
    { match: string; messages: Record<string, unknown>[] }
  > = [];
  searches: GraylogSearchParams[] = [];

  logEvent(
    shortMessage: string,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    this.events.push({ shortMessage, fields });
    return Promise.resolve(this.logEventResult);
  }

  search(params: GraylogSearchParams): Promise<GraylogSearchResult> {
    this.searches.push(params);
    for (const route of this.searchRoutes) {
      if (params.query.includes(route.match)) {
        return Promise.resolve({
          messages: route.messages.map((message) => ({
            message,
            index: "graylog_pg",
          })),
          total_results: route.messages.length,
        });
      }
    }
    return Promise.resolve({ messages: [], total_results: 0 });
  }

  eventsWithField(field: string): LoggedEvent[] {
    return this.events.filter((e) => field in e.fields);
  }
}

// The applyBatch request shape (declared inline on InventoryWriter) —
// extracted so the fake can record requests with the exact structural type.
export type InventoryBatchRequest = Parameters<
  InventoryWriter["applyBatch"]
>[0];

// Records every applyBatch call verbatim and returns a canned outcome. Tests
// must set `nextOutcome` before exercising a path that reaches the writer —
// an unset outcome throws so a test can't silently pass on a default shape.
export class FakeInventoryWriter implements InventoryWriter {
  requests: InventoryBatchRequest[] = [];
  nextOutcome: InventoryBatchOutcome | null = null;

  applyBatch(request: InventoryBatchRequest): Promise<InventoryBatchOutcome> {
    this.requests.push(request);
    if (!this.nextOutcome) {
      return Promise.reject(
        new Error("FakeInventoryWriter.nextOutcome is not set"),
      );
    }
    return Promise.resolve(this.nextOutcome);
  }
}

export function makeDeps(): { db: FakeDb; store: FakeStore } {
  return { db: new FakeDb(), store: new FakeStore() };
}

// makeDeps plus an inventory writer, for the bulk-edit path. A separate helper
// (rather than widening makeDeps) so existing callers keep constructing
// lifecycles WITHOUT the optional inventory dep.
export function makeInventoryDeps(): {
  db: FakeDb;
  store: FakeStore;
  inventory: FakeInventoryWriter;
} {
  return {
    db: new FakeDb(),
    store: new FakeStore(),
    inventory: new FakeInventoryWriter(),
  };
}
