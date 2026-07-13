// DATABASE_URL-gated integration test for the atomic Inventory Workbench
// batch (packages/db/inventory.ts). Skips cleanly when the env var is unset.
// When set, it verifies the REAL SQL semantics the scripted fake in
// inventory_test.ts can only simulate: the samples_touch_version trigger,
// FOR UPDATE row locking, jsonb result replay, and rollback on conflict.
// Creates only its own marker rows and deletes them afterwards.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  applyInventoryBatch,
  Bundles,
  ensureSchema,
  getPool,
  InventoryBatchError,
  lookupSamplesByCode,
  query,
  Samples,
} from "../mod.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");

Deno.test({
  name: "integration: atomic inventory batch + trigger + replay + lookup",
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await ensureSchema();

    const marker = `lp-os-wb-test-${crypto.randomUUID()}`;
    const ids: number[] = [];
    let bundleId: number | null = null;
    try {
      const a = await Samples.create({
        name: `${marker}-a`,
        qr_code: `${marker}-qr`,
        status: "available",
        location: "INTAKE",
      });
      const b = await Samples.create({
        name: `${marker}-b`,
        qr_code: "other",
        related_upc: [`${marker}-qr`],
        status: "available",
      });
      ids.push(a.id as number, b.id as number);
      const bundle = await Bundles.create({ name: marker });
      bundleId = bundle.id as number;

      // New columns exist with defaults.
      assertEquals(a.version, 1);
      assert(typeof a.updated_at === "string");

      // The touch trigger bumps version on ANY writer (generic TableApi).
      await Samples.update(ids[0], { notes: "touched by tracker" });
      const touched = await Samples.filter({ id: ids[0] });
      assertEquals(touched[0].version, 2);

      // Atomic batch: assignment + bundle/quantity edit.
      const requestId = crypto.randomUUID();
      const outcome = await applyInventoryBatch({
        requestId,
        operator: "int-test",
        note: marker,
        mutations: [
          {
            sampleId: ids[0],
            expectedVersion: 2,
            patch: { checked_out_to: "@int-test" },
          },
          {
            sampleId: ids[1],
            expectedVersion: 1,
            patch: { bundle_id: bundleId, quantity: 4 },
          },
        ],
      });
      assertEquals(outcome.replayed, false);
      assertEquals(outcome.changes.length, 2);
      assertEquals(outcome.changes[0].action, "check_out");
      // RETURNING rows reflect the trigger's version bump.
      assertEquals(outcome.rows[0].version, 3);
      assertEquals(outcome.rows[0].status, "checked_out");

      // Audit rows share the batch id and carry before/after jsonb.
      const txns = await query(
        `select * from public.transactions where batch_id = $1 order by id`,
        [outcome.batchId],
      );
      assertEquals(txns.rows.length, 2);
      const changes = txns.rows[0].changes as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
      assertEquals(changes.after.status, "checked_out");

      // Idempotent replay: stored jsonb result comes back, nothing reapplies.
      const replay = await applyInventoryBatch({
        requestId,
        operator: "int-test",
        mutations: [
          {
            sampleId: ids[0],
            expectedVersion: 2,
            patch: { checked_out_to: "@int-test" },
          },
        ],
      });
      assertEquals(replay.replayed, true);
      assertEquals(replay.batchId, outcome.batchId);
      const after = await Samples.filter({ id: ids[0] });
      assertEquals(after[0].version, 3, "replay must not bump version");

      // Version conflict: whole batch rejected, nothing changes.
      const err = await assertRejects(
        () =>
          applyInventoryBatch({
            requestId: crypto.randomUUID(),
            operator: "int-test",
            mutations: [
              {
                sampleId: ids[0],
                expectedVersion: 1, // stale
                patch: { location: "BIN Z" },
              },
              {
                sampleId: ids[1],
                expectedVersion: 2,
                patch: { location: "BIN Z" },
              },
            ],
          }),
        InventoryBatchError,
      );
      assertEquals(err.kind, "conflict");
      const unchanged = await Samples.filter({ id: ids[1] });
      assert(unchanged[0].location !== "BIN Z");

      // Lookup matches qr_code and related_upc across rows.
      const lookup = await lookupSamplesByCode(`${marker}-qr`);
      assertEquals(lookup.samples.map((s) => s.id), ids);
    } finally {
      for (const id of ids) await Samples.delete(id);
      if (bundleId != null) await Bundles.delete(bundleId);
      await query(`delete from public.inventory_batches where operator = $1`, [
        "int-test",
      ]);
      await getPool().end();
    }
  },
});
