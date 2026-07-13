// recordBulkSampleEdit (Inventory Workbench PATCH /api/samples/bulk).
//
// The atomic Postgres work is delegated to the injected InventoryWriter, so
// these tests pin down what THIS layer owns: the status-vocabulary guard
// before any write, the exact per-change Graylog event routing (assignment vs
// status vs inventory-edit), replay short-circuiting, and honest warnings when
// the best-effort Graylog writes fail after the commit.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createLifecycle } from "../mod.ts";
import type { InventoryBatchOutcome, InventorySampleChange } from "../mod.ts";
import { makeDeps, makeInventoryDeps } from "./fakes.ts";

// Change/outcome builders — every InventorySampleChange field is required by
// the type, so default the boilerplate and let each test state only what the
// scenario is about.
function change(
  overrides: Partial<InventorySampleChange> & { sampleId: number },
): InventorySampleChange {
  return {
    action: "custom",
    name: null,
    qr_code: null,
    before: {},
    after: {},
    ...overrides,
  };
}

function outcome(
  changes: InventorySampleChange[],
  overrides: Partial<InventoryBatchOutcome> = {},
): InventoryBatchOutcome {
  return {
    batchId: "batch-test-1",
    requestId: "req-test-1",
    replayed: false,
    rows: [],
    changes,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Event routing per change
// ---------------------------------------------------------------------------

Deno.test("bulk edit: status change emits one sample_status_json event", async () => {
  const deps = makeInventoryDeps();
  deps.inventory.nextOutcome = outcome([
    change({
      sampleId: 1,
      name: "Cupids Desire Drops",
      qr_code: "1729876543210",
      before: { status: "available" },
      after: { status: "cleared_to_sell" },
    }),
  ]);
  const lc = createLifecycle(deps);

  const result = await lc.recordBulkSampleEdit({
    requestId: "req-test-1",
    operator: "dj",
    mutations: [
      { sampleId: 1, expectedVersion: 2, patch: { status: "cleared_to_sell" } },
    ],
  });

  assertEquals(result.ok, true);
  assertEquals(result.graylog, true);
  assertEquals(result.warnings, []);
  assertEquals(result.batchId, "batch-test-1");
  assertEquals(result.requestId, "req-test-1");
  assertEquals(result.replayed, false);

  // Exactly one event total: the status event, no assignment, no edit event
  // (nothing in `after` touches the editable inventory fields).
  assertEquals(deps.store.events.length, 1);
  const [event] = deps.store.eventsWithField("sample_status_json");
  assert(event, "sample_status_json event emitted");
  assertEquals(event.fields.batch_id, "batch-test-1");
  assertEquals(event.fields.sample_source, "workbench-bulk-edit");
  assertEquals(event.fields.sample_status, "cleared_to_sell");
  assertEquals(event.fields.sample_id, "1"); // stringified, like all events
  assertEquals(event.fields.product_id, "1729876543210");

  const inner = JSON.parse(String(event.fields.sample_status_json));
  assertEquals(inner.status, "cleared_to_sell");
  assertEquals(inner.previousStatus, "available");
  assertEquals(inner.source, "workbench-bulk-edit");
  assertEquals(inner.batchId, "batch-test-1");
});

Deno.test("bulk edit: check_out change emits assignment event, not a status event", async () => {
  const deps = makeInventoryDeps();
  deps.inventory.nextOutcome = outcome([
    change({
      sampleId: 4,
      action: "check_out",
      name: "Glow Serum",
      qr_code: "555",
      before: { status: "available", checked_out_to: null },
      after: {
        checked_out_to: "@boosteddealsdaily",
        status: "checked_out",
        checked_out_at: "2026-07-12T00:00:00.000Z",
      },
    }),
  ]);
  const lc = createLifecycle(deps);

  const result = await lc.recordBulkSampleEdit({
    requestId: "req-co",
    operator: "dj",
    mutations: [
      {
        sampleId: 4,
        expectedVersion: 1,
        patch: { status: "checked_out", checked_out_to: "@boosteddealsdaily" },
      },
    ],
  });

  assertEquals(result.ok, true);
  // The assignment event REPLACES the status event for a check-out — the
  // creator attribution lives on sample_assignment_json.
  assertEquals(deps.store.eventsWithField("sample_status_json").length, 0);
  const [event] = deps.store.eventsWithField("sample_assignment_json");
  assert(event, "sample_assignment_json event emitted");
  assertEquals(event.fields.creator, "@boosteddealsdaily");
  assertEquals(event.fields.sample_status, "checked_out");
  assertEquals(event.fields.sample_event, "assigned");
  assertEquals(event.fields.batch_id, "batch-test-1");
  assertEquals(event.fields.sample_source, "workbench-bulk-edit");

  const inner = JSON.parse(String(event.fields.sample_assignment_json));
  assertEquals(inner.creator, "@boosteddealsdaily");
  assertEquals(inner.fromStatus, "available");
  assertEquals(inner.batchId, "batch-test-1");
});

Deno.test("bulk edit: inventory field edit — exact flat fields and inner JSON keys", async () => {
  const deps = makeInventoryDeps();
  deps.inventory.nextOutcome = outcome([
    change({
      sampleId: 21,
      name: "Glow Serum",
      qr_code: "888",
      before: { location: "SHELF A", quantity: 1 },
      after: { location: "SHELF B", quantity: 3 },
    }),
  ]);
  const lc = createLifecycle(deps);

  await lc.recordBulkSampleEdit({
    requestId: "req-edit",
    mutations: [
      {
        sampleId: 21,
        expectedVersion: 5,
        patch: { location: "SHELF B", quantity: 3 },
      },
    ],
  });

  // No status in `after` → the edit event is the only one.
  assertEquals(deps.store.events.length, 1);
  const [event] = deps.store.eventsWithField("sample_inventory_edit_json");
  assert(event, "sample_inventory_edit_json event emitted");
  // Exact flat field set — dashboards/skills query these verbatim. sendEvent
  // adds "source" and strips null/undefined/empty-string values.
  assertEquals(
    Object.keys(event.fields).sort(),
    [
      "batch_id",
      "product_id",
      "sample_event",
      "sample_id",
      "sample_inventory_edit_json",
      "sample_source",
      "source",
    ],
  );
  assertEquals(event.fields.source, "thirsty-store-kiosk");
  assertEquals(event.fields.sample_event, "inventory_edited");
  assertEquals(event.fields.product_id, "888");
  assertEquals(event.fields.sample_id, "21");
  assertEquals(event.fields.batch_id, "batch-test-1");
  assertEquals(event.fields.sample_source, "workbench-bulk-edit");
  assertEquals(
    event.shortMessage,
    "thirsty sample edited: Glow Serum (location, quantity)",
  );

  // Exact inner container keys — note/operator omitted here (undefined values
  // are dropped by JSON.stringify).
  const inner = JSON.parse(String(event.fields.sample_inventory_edit_json));
  assertEquals(
    Object.keys(inner).sort(),
    [
      "after",
      "batchId",
      "before",
      "editedAt",
      "fields",
      "name",
      "productId",
      "sampleId",
    ],
  );
  assertEquals(inner.fields, ["location", "quantity"]);
  assertEquals(inner.before, { location: "SHELF A", quantity: 1 });
  assertEquals(inner.after, { location: "SHELF B", quantity: 3 });
  assertEquals(inner.sampleId, 21);
  assertEquals(inner.productId, "888");
  assertEquals(inner.name, "Glow Serum");
  assertEquals(inner.batchId, "batch-test-1");
});

Deno.test("bulk edit: check_in emits BOTH a status event and an inventory-edit event", async () => {
  const deps = makeInventoryDeps();
  deps.inventory.nextOutcome = outcome([
    change({
      sampleId: 33,
      action: "check_in",
      name: "Widget",
      qr_code: "999",
      before: { status: "checked_out", checked_out_to: "@boosteddealsdaily" },
      after: {
        checked_out_to: null,
        checked_in_at: "2026-07-12T00:00:00.000Z",
        status: "available",
      },
    }),
  ]);
  const lc = createLifecycle(deps);

  await lc.recordBulkSampleEdit({
    requestId: "req-ci",
    operator: "dj",
    note: "returned by creator",
    mutations: [
      {
        sampleId: 33,
        expectedVersion: 2,
        patch: { status: "available", checked_out_to: null },
      },
    ],
  });

  assertEquals(deps.store.events.length, 2);
  const [status] = deps.store.eventsWithField("sample_status_json");
  assert(status, "sample_status_json event emitted");
  assertEquals(status.fields.sample_status, "available");
  assertEquals(status.fields.batch_id, "batch-test-1");

  // The cleared checked_out_to is not an "editable field" in `after`, but a
  // check-in always counts as an inventory edit on that column.
  const [edit] = deps.store.eventsWithField("sample_inventory_edit_json");
  assert(edit, "sample_inventory_edit_json event emitted");
  const inner = JSON.parse(String(edit.fields.sample_inventory_edit_json));
  assertEquals(inner.fields, ["checked_out_to"]);
  assertEquals(inner.note, "returned by creator");
  assertEquals(inner.operator, "dj");
  assertEquals(inner.before.checked_out_to, "@boosteddealsdaily");
  assertEquals(inner.after.checked_out_to, null);
});

Deno.test("bulk edit: every event of a multi-change batch shares the batch_id", async () => {
  const deps = makeInventoryDeps();
  deps.inventory.nextOutcome = outcome(
    [
      change({
        sampleId: 1,
        before: { status: "available" },
        after: { status: "cleared_to_sell" },
      }),
      change({
        sampleId: 2,
        action: "check_out",
        after: { checked_out_to: "@boosteddealsdaily", status: "checked_out" },
      }),
      change({
        sampleId: 3,
        after: { location: "BIN 4" },
      }),
    ],
    { batchId: "batch-multi" },
  );
  const lc = createLifecycle(deps);

  const result = await lc.recordBulkSampleEdit({
    requestId: "req-multi",
    mutations: [
      { sampleId: 1, expectedVersion: 1, patch: { status: "cleared_to_sell" } },
      { sampleId: 2, expectedVersion: 1, patch: { status: "checked_out" } },
      { sampleId: 3, expectedVersion: 1, patch: { location: "BIN 4" } },
    ],
  });

  assertEquals(result.batchId, "batch-multi");
  // One event per change: status + assignment + inventory edit.
  assertEquals(deps.store.events.length, 3);
  assertEquals(deps.store.eventsWithField("sample_status_json").length, 1);
  assertEquals(deps.store.eventsWithField("sample_assignment_json").length, 1);
  assertEquals(
    deps.store.eventsWithField("sample_inventory_edit_json").length,
    1,
  );
  for (const event of deps.store.events) {
    assertEquals(event.fields.batch_id, "batch-multi");
    assertEquals(event.fields.sample_source, "workbench-bulk-edit");
  }
});

// ---------------------------------------------------------------------------
// Graylog failure and replay
// ---------------------------------------------------------------------------

Deno.test("bulk edit: Graylog failure never rolls back the commit — surfaced as warnings", async () => {
  const deps = makeInventoryDeps();
  deps.store.logEventResult = false;
  deps.inventory.nextOutcome = outcome([
    change({
      sampleId: 5,
      before: { status: "available" },
      after: { status: "cleared_to_sell" },
    }),
  ]);
  const lc = createLifecycle(deps);

  const result = await lc.recordBulkSampleEdit({
    requestId: "req-warn",
    mutations: [
      { sampleId: 5, expectedVersion: 1, patch: { status: "cleared_to_sell" } },
    ],
  });

  // The inventory write committed, so the call still succeeds…
  assertEquals(result.ok, true);
  // …but the analytics miss is honest: graylog false + a warning naming the
  // sample whose event was dropped.
  assertEquals(result.graylog, false);
  assert(result.warnings.length > 0, "warnings recorded");
  assertStringIncludes(result.warnings.join("; "), "sample 5");
  assertStringIncludes(result.message, "WARNING");
});

Deno.test("bulk edit: replayed outcome emits no events", async () => {
  const deps = makeInventoryDeps();
  deps.inventory.nextOutcome = outcome(
    [
      change({
        sampleId: 6,
        before: { status: "available" },
        after: { status: "cleared_to_sell" },
      }),
    ],
    { replayed: true },
  );
  const lc = createLifecycle(deps);

  const result = await lc.recordBulkSampleEdit({
    requestId: "req-replay",
    mutations: [
      { sampleId: 6, expectedVersion: 1, patch: { status: "cleared_to_sell" } },
    ],
  });

  // The original request already emitted the events — replaying must not
  // double-log them (Graylog is append-only).
  assertEquals(result.ok, true);
  assertEquals(result.replayed, true);
  assertEquals(deps.store.events.length, 0);
  assertStringIncludes(result.message, "Replayed batch");
});

// ---------------------------------------------------------------------------
// Vocabulary guard (before any write reaches the writer)
// ---------------------------------------------------------------------------

Deno.test("bulk edit: status 'sold' rejected before the writer is called", async () => {
  const deps = makeInventoryDeps();
  const lc = createLifecycle(deps);

  const err = await assertRejects(
    () =>
      lc.recordBulkSampleEdit({
        requestId: "req-sold",
        mutations: [
          { sampleId: 1, expectedVersion: 1, patch: { status: "sold" } },
        ],
      }),
    Error,
  );
  assertStringIncludes(err.message, "sold flow");
  assertEquals(deps.inventory.requests.length, 0);
});

Deno.test("bulk edit: badge values rejected as statuses before the writer is called", async () => {
  const deps = makeInventoryDeps();
  const lc = createLifecycle(deps);

  const err = await assertRejects(
    () =>
      lc.recordBulkSampleEdit({
        requestId: "req-badge",
        mutations: [
          { sampleId: 1, expectedVersion: 1, patch: { status: "fire_sale" } },
        ],
      }),
    Error,
  );
  assertStringIncludes(err.message, "not a valid sample status");
  assertEquals(deps.inventory.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

Deno.test("bulk edit: rejects when no inventory writer is configured", async () => {
  // makeDeps has no `inventory` — the optional dep is genuinely absent.
  const lc = createLifecycle(makeDeps());
  const err = await assertRejects(
    () =>
      lc.recordBulkSampleEdit({
        requestId: "req-none",
        mutations: [
          { sampleId: 1, expectedVersion: 1, patch: { location: "A" } },
        ],
      }),
    Error,
  );
  assertStringIncludes(err.message, "no inventory writer configured");
});

Deno.test("bulk edit: request forwarded to the writer verbatim", async () => {
  const deps = makeInventoryDeps();
  // Empty changes: this test is only about what reaches the writer.
  deps.inventory.nextOutcome = outcome([]);
  const lc = createLifecycle(deps);

  await lc.recordBulkSampleEdit({
    requestId: "req-42",
    operator: "dj",
    note: "batch move",
    mutations: [
      { sampleId: 7, expectedVersion: 3, patch: { location: "BIN 9" } },
    ],
  });

  assertEquals(deps.inventory.requests.length, 1);
  assertEquals(deps.inventory.requests[0], {
    requestId: "req-42",
    operator: "dj",
    note: "batch move",
    mutations: [
      { sampleId: 7, expectedVersion: 3, patch: { location: "BIN 9" } },
    ],
  });
});
