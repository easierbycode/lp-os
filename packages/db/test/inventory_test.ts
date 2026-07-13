// Tests for inventory.ts — the atomic Inventory Workbench bulk edit.
//
// runInventoryBatch is written against the structural SqlClient interface, so
// the transaction CONTRACT tests run against a scripted in-memory client that
// dispatches on the exact SQL the helper issues (BEGIN/COMMIT/ROLLBACK are
// simulated with a snapshot, the samples touch-trigger is simulated on
// UPDATE). Real-SQL semantics are additionally covered by the
// DATABASE_URL-gated integration test in inventory_integration_test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  InventoryBatchError,
  type InventoryBatchRequest,
  lookupByCode,
  runInventoryBatch,
  type SqlClient,
  validateInventoryBatchRequest,
} from "../inventory.ts";

const REQ_ID = "11111111-2222-4333-8444-555555555555";
const REQ_ID_2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

type Row = Record<string, unknown>;

/** Scripted fake client: enough SQL understanding for inventory.ts. */
class FakeClient implements SqlClient {
  samples: Row[];
  bundles: Row[];
  transactions: Row[] = [];
  batches = new Map<string, Row>();
  log: string[] = [];
  /** Throw on the Nth transactions insert (1-based) to simulate a mid-batch
   * failure. */
  failOnTransactionInsert: number | null = null;
  /** When set, the replay SELECT returns this stored batch row only after
   * the inventory_batches insert has raised a unique violation (simulates a
   * concurrent duplicate committing while we held no lock). */
  raceStoredResult: Row | null = null;
  private raceTripped = false;
  private snapshot: {
    samples: Row[];
    transactions: Row[];
    batches: Map<string, Row>;
  } | null = null;
  private txnInserts = 0;

  constructor(samples: Row[], bundles: Row[] = []) {
    this.samples = samples.map((s) => ({ ...s }));
    this.bundles = bundles.map((b) => ({ ...b }));
  }

  // deno-lint-ignore require-await
  async query(text: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    const sql = text.trim().toLowerCase().replace(/\s+/g, " ");
    this.log.push(sql.split(" ")[0]);

    if (sql === "begin") {
      this.snapshot = {
        samples: this.samples.map((s) => ({ ...s })),
        transactions: this.transactions.map((t) => ({ ...t })),
        batches: new Map(this.batches),
      };
      return { rows: [] };
    }
    if (sql === "commit") {
      this.snapshot = null;
      return { rows: [] };
    }
    if (sql === "rollback") {
      if (this.snapshot) {
        this.samples = this.snapshot.samples;
        this.transactions = this.snapshot.transactions;
        this.batches = this.snapshot.batches;
        this.snapshot = null;
      }
      return { rows: [] };
    }

    if (sql.startsWith("select result from public.inventory_batches")) {
      if (this.raceStoredResult && this.raceTripped) {
        return { rows: [this.raceStoredResult] };
      }
      const found = this.batches.get(String(params[0]));
      return { rows: found ? [found] : [] };
    }

    if (sql.startsWith("select * from public.samples where id = any")) {
      const ids = params[0] as number[];
      const rows = this.samples
        .filter((s) => ids.includes(Number(s.id)))
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map((s) => ({ ...s }));
      return { rows };
    }

    if (sql.startsWith("select id from public.bundles where id = any")) {
      const ids = params[0] as number[];
      return {
        rows: this.bundles
          .filter((b) => ids.includes(Number(b.id)))
          .map((b) => ({ id: b.id })),
      };
    }

    if (sql.startsWith("update public.samples set")) {
      const id = Number(params[params.length - 1]);
      const cols = [...text.matchAll(/"([^"]+)" = \$\d+/g)].map((m) => m[1]);
      const row = this.samples.find((s) => Number(s.id) === id);
      if (!row) return { rows: [] };
      let changed = false;
      cols.forEach((col, i) => {
        if (row[col] !== params[i]) changed = true;
        row[col] = params[i];
      });
      if (changed) {
        // Simulate the samples_touch_version BEFORE UPDATE trigger.
        row.version = Number(row.version ?? 1) + 1;
        row.updated_at = new Date().toISOString();
      }
      return { rows: [{ ...row }] };
    }

    if (sql.startsWith("insert into public.transactions")) {
      this.txnInserts++;
      if (this.failOnTransactionInsert === this.txnInserts) {
        throw new Error("injected mid-batch failure");
      }
      const [
        action,
        sample_id,
        scanned_code,
        operator,
        checked_out_to,
        notes,
        batch_id,
        request_id,
        changes,
      ] = params;
      this.transactions.push({
        id: this.transactions.length + 1,
        action,
        sample_id,
        scanned_code,
        operator,
        checked_out_to,
        notes,
        batch_id,
        request_id,
        changes: JSON.parse(String(changes)),
      });
      return { rows: [] };
    }

    if (sql.startsWith("insert into public.inventory_batches")) {
      const [batch_id, request_id, operator, mutation_count, result] = params;
      if (this.batches.has(String(request_id)) || this.raceStoredResult) {
        this.raceTripped = true;
        const err = new Error(
          "duplicate key value violates unique constraint",
        ) as Error & { code: string; constraint: string };
        err.code = "23505";
        err.constraint = "inventory_batches_request_id_key";
        throw err;
      }
      this.batches.set(String(request_id), {
        batch_id,
        request_id,
        operator,
        mutation_count,
        result: JSON.parse(String(result)),
      });
      return { rows: [] };
    }

    if (sql.startsWith("select * from public.samples where qr_code = $1")) {
      const code = String(params[0]);
      return {
        rows: this.samples
          .filter((s) =>
            s.qr_code === code ||
            (Array.isArray(s.related_upc) && s.related_upc.includes(code))
          )
          .sort((a, b) => Number(a.id) - Number(b.id))
          .map((s) => ({ ...s })),
      };
    }
    if (sql.startsWith("select * from public.bundles where qr_code = $1")) {
      const code = String(params[0]);
      return {
        rows: this.bundles.filter((b) => b.qr_code === code).map((b) => ({
          ...b,
        })),
      };
    }

    throw new Error(`FakeClient: unhandled SQL: ${text}`);
  }
}

function sampleRow(id: number, extra: Row = {}): Row {
  return {
    id,
    name: `Sample ${id}`,
    qr_code: `qr-${id}`,
    status: "available",
    location: "INTAKE",
    checked_out_to: null,
    checked_out_at: null,
    checked_in_at: null,
    bundle_id: null,
    quantity: 1,
    current_price: null,
    fire_sale: null,
    notes: null,
    related_upc: null,
    version: 1,
    ...extra,
  };
}

function request(
  mutations: InventoryBatchRequest["mutations"],
  overrides: Partial<InventoryBatchRequest> = {},
): InventoryBatchRequest {
  return {
    requestId: REQ_ID,
    operator: "ka",
    mutations,
    ...overrides,
  };
}

/* ------------------------------------------------ validation (pure) ----- */

Deno.test("validate: accepts a canonical request and normalizes fields", () => {
  const parsed = validateInventoryBatchRequest({
    requestId: REQ_ID,
    operator: " ka ",
    note: " Saturday intake ",
    mutations: [{
      sampleId: 42,
      expectedVersion: 7,
      patch: {
        status: "cleared_to_sell",
        location: " SHELF B ",
        checked_out_to: null,
        fire_sale: true,
      },
    }],
  });
  assertEquals(parsed.operator, "ka");
  assertEquals(parsed.note, "Saturday intake");
  assertEquals(parsed.mutations[0].patch.location, "SHELF B");
  assertEquals(parsed.mutations[0].patch.fire_sale, "true");
});

Deno.test("validate: rejects malformed requests", () => {
  const cases: [unknown, string][] = [
    [{ operator: "ka", mutations: [] }, "requestId"],
    [{ requestId: "nope", operator: "ka", mutations: [] }, "requestId"],
    [{ requestId: REQ_ID, mutations: [{}] }, "operator"],
    [{ requestId: REQ_ID, operator: "ka", mutations: [] }, "mutations"],
    [
      {
        requestId: REQ_ID,
        operator: "ka",
        mutations: Array.from({ length: 251 }, (_, i) => ({
          sampleId: i + 1,
          expectedVersion: 1,
          patch: { location: "BIN A" },
        })),
      },
      "at most 250",
    ],
    [
      {
        requestId: REQ_ID,
        operator: "ka",
        mutations: [
          { sampleId: 1, expectedVersion: 1, patch: { location: "BIN A" } },
          { sampleId: 1, expectedVersion: 1, patch: { location: "BIN B" } },
        ],
      },
      "more than once",
    ],
  ];
  for (const [body, needle] of cases) {
    try {
      validateInventoryBatchRequest(body);
      throw new Error(`expected rejection containing "${needle}"`);
    } catch (e) {
      assert(e instanceof InventoryBatchError, `typed error for ${needle}`);
      assertEquals(e.kind, "validation");
      assert(
        e.message.includes(needle),
        `"${e.message}" should mention "${needle}"`,
      );
    }
  }
});

Deno.test("validate: field restrictions", () => {
  const mut = (patch: Record<string, unknown>) => ({
    requestId: REQ_ID,
    operator: "ka",
    mutations: [{ sampleId: 1, expectedVersion: 1, patch }],
  });

  // Forbidden columns are rejected by name.
  for (
    const field of [
      "name",
      "brand",
      "qr_code",
      "related_upc",
      "product_json",
      "tiktok_affiliate_link",
      "sold_price",
      "sold_to",
      "sold_at",
      "version",
    ]
  ) {
    try {
      validateInventoryBatchRequest(mut({ [field]: "x" }));
      throw new Error(`expected "${field}" to be rejected`);
    } catch (e) {
      assert(e instanceof InventoryBatchError);
      assert(e.message.includes(`"${field}"`), e.message);
    }
  }

  // sold is rejected with a pointer at the sold flow.
  try {
    validateInventoryBatchRequest(mut({ status: "sold" }));
    throw new Error("expected sold to be rejected");
  } catch (e) {
    assert(e instanceof InventoryBatchError);
    assert(e.message.includes("sold"), e.message);
  }

  // Badges are not statuses.
  try {
    validateInventoryBatchRequest(mut({ status: "fire_sale" }));
    throw new Error("expected badge status to be rejected");
  } catch (e) {
    assert(e instanceof InventoryBatchError);
    assert(e.message.includes("not a writable sample status"), e.message);
  }

  // Assignment cannot be combined with a contradictory status.
  try {
    validateInventoryBatchRequest(
      mut({ checked_out_to: "@x", status: "available" }),
    );
    throw new Error("expected assignee+status combo to be rejected");
  } catch (e) {
    assert(e instanceof InventoryBatchError);
    assert(e.message.includes("checked_out"), e.message);
  }

  // Clearing the assignee (check-in) cannot set status checked_out.
  try {
    validateInventoryBatchRequest(
      mut({ checked_out_to: null, status: "checked_out" }),
    );
    throw new Error("expected check-in+checked_out combo to be rejected");
  } catch (e) {
    assert(e instanceof InventoryBatchError);
    assert(e.message.includes("check-in"), e.message);
  }

  // Scalar validation.
  for (
    const patch of [
      { quantity: -1 },
      { quantity: 1.5 },
      { current_price: -2 },
      { bundle_id: 0 },
      { location: "" },
      {},
    ]
  ) {
    try {
      validateInventoryBatchRequest(mut(patch));
      throw new Error(`expected ${JSON.stringify(patch)} to be rejected`);
    } catch (e) {
      assert(e instanceof InventoryBatchError, JSON.stringify(patch));
    }
  }
});

/* --------------------------------------------- transaction behavior ----- */

Deno.test("batch: all rows commit, audit rows share batch/request ids", async () => {
  const client = new FakeClient([sampleRow(1), sampleRow(2)]);
  const outcome = await runInventoryBatch(
    client,
    request([
      {
        sampleId: 1,
        expectedVersion: 1,
        patch: { status: "cleared_to_sell", location: "SHELF B" },
      },
      { sampleId: 2, expectedVersion: 1, patch: { quantity: 5 } },
    ], { note: "Moved the Saturday intake batch" }),
  );

  assertEquals(outcome.replayed, false);
  assertEquals(outcome.rows.length, 2);
  assertEquals(outcome.changes.length, 2);

  // Rows really changed and the simulated trigger bumped versions.
  assertEquals(client.samples[0].status, "cleared_to_sell");
  assertEquals(client.samples[0].location, "SHELF B");
  assertEquals(client.samples[0].version, 2);
  assertEquals(client.samples[1].quantity, 5);

  // Before/after audit data is correct and minimal.
  assertEquals(outcome.changes[0].before, {
    status: "available",
    location: "INTAKE",
  });
  assertEquals(outcome.changes[0].after, {
    status: "cleared_to_sell",
    location: "SHELF B",
  });

  // One canonical transaction row per changed sample, shared ids.
  assertEquals(client.transactions.length, 2);
  for (const txn of client.transactions) {
    assertEquals(txn.batch_id, outcome.batchId);
    assertEquals(txn.request_id, REQ_ID);
    assertEquals(txn.operator, "ka");
    assert(String(txn.notes).includes("Moved the Saturday intake batch"));
  }
  assertEquals(client.transactions[0].action, "custom");

  // The replayable result was stored and the txn committed.
  assert(client.batches.has(REQ_ID));
  assert(client.log.includes("commit"));
});

Deno.test("batch: assignment derives status, stamps, and audit action", async () => {
  const client = new FakeClient([sampleRow(1)]);
  const outcome = await runInventoryBatch(
    client,
    request([{
      sampleId: 1,
      expectedVersion: 1,
      patch: { checked_out_to: "@boosteddealsdaily" },
    }]),
  );

  const row = client.samples[0];
  assertEquals(row.status, "checked_out");
  assertEquals(row.checked_out_to, "@boosteddealsdaily");
  assert(row.checked_out_at, "checked_out_at stamped");
  assertEquals(outcome.changes[0].action, "check_out");
  assertEquals(client.transactions[0].action, "check_out");
  assertEquals(client.transactions[0].checked_out_to, "@boosteddealsdaily");
});

Deno.test("batch: check-in clears assignee and stamps checked_in_at", async () => {
  const client = new FakeClient([
    sampleRow(1, { status: "checked_out", checked_out_to: "@x" }),
  ]);
  const outcome = await runInventoryBatch(
    client,
    request([{
      sampleId: 1,
      expectedVersion: 1,
      patch: { checked_out_to: null, status: "available" },
    }]),
  );

  const row = client.samples[0];
  assertEquals(row.checked_out_to, null);
  assertEquals(row.status, "available");
  assert(row.checked_in_at, "checked_in_at stamped");
  assertEquals(outcome.changes[0].action, "check_in");
});

Deno.test("batch: location-only change never alters status", async () => {
  const client = new FakeClient([
    sampleRow(1, { status: "reserved" }),
  ]);
  await runInventoryBatch(
    client,
    request([{
      sampleId: 1,
      expectedVersion: 1,
      patch: { location: "BIN Q" },
    }]),
  );
  assertEquals(client.samples[0].status, "reserved");
  assertEquals(client.samples[0].location, "BIN Q");
});

Deno.test("batch: direct checked_out without an assignee is rejected", async () => {
  const client = new FakeClient([sampleRow(1)]);
  const err = await assertRejects(
    () =>
      runInventoryBatch(
        client,
        request([{
          sampleId: 1,
          expectedVersion: 1,
          patch: { status: "checked_out" },
        }]),
      ),
    InventoryBatchError,
  );
  assertEquals(err.kind, "validation");
  // Nothing persisted.
  assertEquals(client.samples[0].status, "available");
  assertEquals(client.transactions.length, 0);
  assert(client.log.includes("rollback"));
});

Deno.test("batch: version mismatch returns conflict and changes nothing", async () => {
  const client = new FakeClient([
    sampleRow(1, { version: 3 }),
    sampleRow(2, { version: 1 }),
  ]);
  const err = await assertRejects(
    () =>
      runInventoryBatch(
        client,
        request([
          { sampleId: 1, expectedVersion: 2, patch: { location: "BIN A" } },
          { sampleId: 2, expectedVersion: 1, patch: { location: "BIN B" } },
        ]),
      ),
    InventoryBatchError,
  );
  assertEquals(err.kind, "conflict");
  assertEquals(
    (err.details as { conflicts: { sampleId: number }[] }).conflicts[0]
      .sampleId,
    1,
  );
  // Neither row changed — even the one whose version matched.
  assertEquals(client.samples[0].location, "INTAKE");
  assertEquals(client.samples[1].location, "INTAKE");
  assertEquals(client.transactions.length, 0);
  assertEquals(client.batches.size, 0);
});

Deno.test("batch: missing sample rolls back the whole batch", async () => {
  const client = new FakeClient([sampleRow(1)]);
  const err = await assertRejects(
    () =>
      runInventoryBatch(
        client,
        request([
          { sampleId: 1, expectedVersion: 1, patch: { location: "BIN A" } },
          { sampleId: 999, expectedVersion: 1, patch: { location: "BIN B" } },
        ]),
      ),
    InventoryBatchError,
  );
  assertEquals(err.kind, "not_found");
  assertEquals((err.details as { missing: number[] }).missing, [999]);
  assertEquals(client.samples[0].location, "INTAKE");
});

Deno.test("batch: unknown bundle is rejected before any write", async () => {
  const client = new FakeClient([sampleRow(1)], [{ id: 12, name: "Lot" }]);
  const err = await assertRejects(
    () =>
      runInventoryBatch(
        client,
        request([{
          sampleId: 1,
          expectedVersion: 1,
          patch: { bundle_id: 99 },
        }]),
      ),
    InventoryBatchError,
  );
  assertEquals(err.kind, "validation");
  assert(err.message.includes("bundle"));

  // A valid bundle passes.
  const ok = await runInventoryBatch(
    client,
    request([{ sampleId: 1, expectedVersion: 1, patch: { bundle_id: 12 } }]),
  );
  assertEquals(ok.changes[0].after.bundle_id, 12);
});

Deno.test("batch: injected mid-batch failure rolls back every row", async () => {
  const client = new FakeClient([sampleRow(1), sampleRow(2), sampleRow(3)]);
  client.failOnTransactionInsert = 3;
  await assertRejects(() =>
    runInventoryBatch(
      client,
      request([
        { sampleId: 1, expectedVersion: 1, patch: { location: "BIN A" } },
        { sampleId: 2, expectedVersion: 1, patch: { location: "BIN B" } },
        { sampleId: 3, expectedVersion: 1, patch: { location: "BIN C" } },
      ]),
    )
  );
  // ROLLBACK restored all three rows and dropped the partial audit rows.
  for (const row of client.samples) {
    assertEquals(row.location, "INTAKE");
    assertEquals(row.version, 1);
  }
  assertEquals(client.transactions.length, 0);
  assertEquals(client.batches.size, 0);
});

Deno.test("batch: repeated requestId replays the stored result", async () => {
  const client = new FakeClient([sampleRow(1)]);
  const first = await runInventoryBatch(
    client,
    request([{ sampleId: 1, expectedVersion: 1, patch: { quantity: 9 } }]),
  );
  assertEquals(first.replayed, false);
  assertEquals(client.samples[0].version, 2);

  // Same requestId again — e.g. a network retry. Nothing reapplies.
  const second = await runInventoryBatch(
    client,
    request([{ sampleId: 1, expectedVersion: 1, patch: { quantity: 9 } }]),
  );
  assertEquals(second.replayed, true);
  assertEquals(second.batchId, first.batchId);
  assertEquals(second.changes, first.changes);
  assertEquals(client.samples[0].version, 2, "no second version bump");
  assertEquals(client.transactions.length, 1, "no duplicate audit rows");

  // A different requestId applies normally.
  const third = await runInventoryBatch(
    client,
    request(
      [{ sampleId: 1, expectedVersion: 2, patch: { quantity: 10 } }],
      { requestId: REQ_ID_2 },
    ),
  );
  assertEquals(third.replayed, false);
  assertEquals(client.samples[0].quantity, 10);
});

Deno.test("batch: losing a duplicate-request race replays instead of erroring", async () => {
  const client = new FakeClient([sampleRow(1)]);
  const stored = {
    result: {
      batchId: "b-1",
      requestId: REQ_ID,
      replayed: false,
      rows: [],
      changes: [],
    },
  };
  client.raceStoredResult = stored;

  const outcome = await runInventoryBatch(
    client,
    request([{ sampleId: 1, expectedVersion: 1, patch: { quantity: 2 } }]),
  );
  assertEquals(outcome.replayed, true);
  assertEquals(outcome.batchId, "b-1");
  // Our own attempt was rolled back.
  assertEquals(client.samples[0].quantity, 1);
});

Deno.test("batch: no-op mutations produce no audit row and no version bump", async () => {
  const client = new FakeClient([sampleRow(1, { location: "SHELF B" })]);
  const outcome = await runInventoryBatch(
    client,
    request([
      { sampleId: 1, expectedVersion: 1, patch: { location: "SHELF B" } },
    ]),
  );
  assertEquals(outcome.changes.length, 0);
  assertEquals(outcome.rows.length, 1);
  assertEquals(client.samples[0].version, 1);
  assertEquals(client.transactions.length, 0);
});

/* --------------------------------------------------------- lookup ------- */

Deno.test("lookup: matches qr_code and related_upc, returns all rows", async () => {
  const client = new FakeClient(
    [
      sampleRow(1, { qr_code: "12345" }),
      sampleRow(2, { qr_code: "other", related_upc: ["12345", "777"] }),
      sampleRow(3, { qr_code: "12345" }),
      sampleRow(4, { qr_code: "unrelated" }),
    ],
    [{ id: 1, name: "Lot A", qr_code: "12345" }],
  );

  const result = await lookupByCode(client, " 12345 ");
  assertEquals(result.code, "12345");
  assertEquals(result.samples.map((s) => s.id), [1, 2, 3]);
  assertEquals(result.bundles.length, 1);

  const upcOnly = await lookupByCode(client, "777");
  assertEquals(upcOnly.samples.map((s) => s.id), [2]);
  assertEquals(upcOnly.bundles.length, 0);
});
