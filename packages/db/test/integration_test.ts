// DATABASE_URL-gated integration test: skips cleanly when the env var is
// unset. When set, it runs ensureSchema() and a full Samples/Transactions
// round-trip against the real database, creating only its own marker rows and
// deleting them afterwards.
import { assert, assertEquals } from "@std/assert";
import {
  Bundles,
  ensureSchema,
  getPool,
  query,
  Samples,
  Transactions,
} from "../mod.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");

Deno.test({
  name: "integration: ensureSchema + seeds + TableApi round-trip",
  ignore: !DATABASE_URL,
  // pg keeps sockets/timers alive inside the pool; we end() it in finally but
  // the driver's internal handles trip Deno's strict sanitizers regardless.
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await ensureSchema();
    await ensureSchema(); // idempotent re-run

    // Seeds present.
    const roles = await query("select name from public.roles order by name");
    const roleNames = roles.rows.map((r) => (r as { name: string }).name);
    for (const expected of ["admin", "creator", "warehouse"]) {
      assert(roleNames.includes(expected), `missing seed role ${expected}`);
    }
    const users = await query(
      "select username, role from public.users where username in ('dj','ka','@boosteddealsdaily')",
    );
    assertEquals(users.rows.length, 3);

    const marker = `lp-os-int-test-${crypto.randomUUID()}`;
    let sampleId: number | null = null;
    try {
      // create: accepts ISO strings for timestamptz, ignores unknown keys.
      const created = await Samples.create({
        name: marker,
        qr_code: "1729000000000000042",
        status: "available",
        quantity: 2,
        checked_out_at: "2026-01-02T03:04:05.678Z",
        not_a_column: "ignored",
      });
      sampleId = created.id as number;
      assert(typeof sampleId === "number" && sampleId > 0);
      assertEquals(created.name, marker);
      // timestamptz values come back as ISO strings, not Dates.
      assertEquals(typeof created.created_at, "string");
      assert(!Number.isNaN(Date.parse(created.created_at as string)));
      assertEquals(created.checked_out_at, "2026-01-02T03:04:05.678Z");

      // filter honors filters + order_by + limit.
      const rows = await Samples.filter({ name: marker }, "-created_at", 5);
      assertEquals(rows.length, 1);
      assertEquals(rows[0].id, sampleId);

      // legacy order_by alias still accepted end-to-end.
      const aliased = await Samples.filter(
        { name: marker },
        "-created_date",
        5,
      );
      assertEquals(aliased.length, 1);

      // update returns the updated row; missing id returns null.
      const updated = await Samples.update(sampleId, {
        status: "checked_out",
        checked_out_to: "@lp-os-int-test",
      });
      assertEquals(updated?.status, "checked_out");
      assertEquals(await Samples.update(2147483647, { status: "x" }), null);

      // transactions table exists under its reconciled name.
      const txn = await Transactions.create({
        action: "check_out",
        sample_id: sampleId,
        operator: "int-test",
        notes: marker,
      });
      assertEquals(typeof txn.created_at, "string");
      assertEquals(await Transactions.delete(txn.id as number), true);

      // list works on bundles (empty or not — just must not throw).
      await Bundles.list("-created_at");
    } finally {
      if (sampleId != null) {
        assertEquals(await Samples.delete(sampleId), true);
        assertEquals(await Samples.delete(sampleId), false); // already gone
      }
      await getPool().end();
    }
  },
});
