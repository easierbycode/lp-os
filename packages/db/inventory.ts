// inventory.ts — atomic Inventory Workbench bulk mutations + barcode lookup.
//
// The generic TableApi in mod.ts issues one independent statement per call,
// which is exactly the partial-success failure mode warehouse batch edits
// cannot tolerate. runInventoryBatch runs the whole batch inside a single
// BEGIN … COMMIT on one checked-out client: every requested row is locked
// (FOR UPDATE, ordered by id to keep lock order deterministic), versions are
// verified, referenced bundles validated, samples updated, one audit
// transaction row inserted per changed sample, and the replayable result
// stored in inventory_batches — or none of it happens. A repeated requestId
// returns the stored result (replayed: true) and never reapplies.
//
// Kept free of pg/pool imports so the transaction logic tests against a
// scripted fake client (test/inventory_test.ts); mod.ts wires the real pool.

import { safeIdent, serializeRow } from "./builders.ts";

/** Structural subset of pg's PoolClient/Pool that this module needs. */
export interface SqlClient {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Fields the workbench may edit. Everything else is rejected by name. */
export type InventoryPatch = {
  status?: string;
  location?: string | null;
  checked_out_to?: string | null;
  bundle_id?: number | null;
  quantity?: number;
  current_price?: number | null;
  fire_sale?: string | null;
  notes?: string | null;
};

export type InventoryMutation = {
  sampleId: number;
  expectedVersion: number;
  patch: InventoryPatch;
};

export type InventoryBatchRequest = {
  requestId: string;
  operator: string;
  note?: string;
  mutations: InventoryMutation[];
};

export type InventorySampleChange = {
  sampleId: number;
  action: "check_out" | "check_in" | "custom";
  name: string | null;
  qr_code: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export type InventoryBatchOutcome = {
  batchId: string;
  requestId: string;
  replayed: boolean;
  rows: Record<string, unknown>[];
  changes: InventorySampleChange[];
};

/**
 * Typed failure so the HTTP layer can map kinds to status codes
 * (validation → 400, not_found → 404, conflict → 409) without importing
 * this class — checking the `kind` property is enough.
 */
export class InventoryBatchError extends Error {
  kind: "validation" | "not_found" | "conflict";
  details?: unknown;

  constructor(
    kind: "validation" | "not_found" | "conflict",
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "InventoryBatchError";
    this.kind = kind;
    this.details = details;
  }
}

const MAX_MUTATIONS = 250;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EDITABLE_FIELDS = new Set([
  "status",
  "location",
  "checked_out_to",
  "bundle_id",
  "quantity",
  "current_price",
  "fire_sale",
  "notes",
]);

// samples.status values the workbench may write. `sold` must go through the
// dedicated sold lifecycle so creator revenue is attributed; badge values
// (fire_sale / lowest_price) are not statuses.
const WRITABLE_STATUSES = new Set([
  "available",
  "checked_out",
  "reserved",
  "cleared_to_sell",
  "discontinued",
]);

function bad(message: string, details?: unknown): never {
  throw new InventoryBatchError("validation", message, details);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    bad(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asPositiveInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    bad(`${what} must be a positive integer`);
  }
  return value as number;
}

/** Normalize one patch: validate types, reject forbidden fields. */
function parsePatch(raw: unknown, sampleId: number): InventoryPatch {
  const source = asRecord(raw, `mutations[${sampleId}].patch`);
  const patch: InventoryPatch = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!EDITABLE_FIELDS.has(key)) {
      bad(
        `Field "${key}" cannot be edited through the bulk endpoint`,
        { sampleId, field: key },
      );
    }
    switch (key) {
      case "status": {
        if (typeof value !== "string" || !value.trim()) {
          bad(`status must be a non-empty string (sample ${sampleId})`);
        }
        const status = (value as string).trim();
        if (status === "sold") {
          bad(
            "Use the sold flow (POST /api/sample-sold) to mark a sample " +
              "sold, so the resale revenue is attributed to a creator account.",
            { sampleId },
          );
        }
        if (!WRITABLE_STATUSES.has(status)) {
          bad(`"${status}" is not a writable sample status`, { sampleId });
        }
        patch.status = status;
        break;
      }
      case "location": {
        if (value === null) {
          patch.location = null;
        } else if (typeof value === "string" && value.trim()) {
          patch.location = (value as string).trim();
        } else {
          bad(
            `location must be a non-empty string or null (sample ${sampleId})`,
          );
        }
        break;
      }
      case "checked_out_to": {
        // Non-empty string = assignment; null/"" = check-in (clear assignee).
        if (value === null) {
          patch.checked_out_to = null;
        } else if (typeof value === "string") {
          const handle = (value as string).trim();
          patch.checked_out_to = handle || null;
        } else {
          bad(`checked_out_to must be a string or null (sample ${sampleId})`);
        }
        break;
      }
      case "bundle_id": {
        if (value === null) patch.bundle_id = null;
        else {patch.bundle_id = asPositiveInt(
            value,
            `bundle_id (sample ${sampleId})`,
          );}
        break;
      }
      case "quantity": {
        if (
          typeof value !== "number" || !Number.isInteger(value) || value < 0
        ) {
          bad(`quantity must be an integer >= 0 (sample ${sampleId})`);
        }
        patch.quantity = value as number;
        break;
      }
      case "current_price": {
        if (value === null) patch.current_price = null;
        else if (
          typeof value === "number" && Number.isFinite(value) && value >= 0
        ) {
          patch.current_price = value as number;
        } else {
          bad(
            `current_price must be a number >= 0 or null (sample ${sampleId})`,
          );
        }
        break;
      }
      case "fire_sale": {
        // Column is TEXT (badge). Booleans are accepted for client convenience.
        if (value === null || value === false || value === "") {
          patch.fire_sale = null;
        } else if (value === true) patch.fire_sale = "true";
        else if (typeof value === "string") {
          patch.fire_sale = (value as string).trim();
        } else {bad(
            `fire_sale must be a boolean, string, or null (sample ${sampleId})`,
          );}
        break;
      }
      case "notes": {
        if (value === null) patch.notes = null;
        else if (typeof value === "string") patch.notes = value as string;
        else bad(`notes must be a string or null (sample ${sampleId})`);
        break;
      }
    }
  }

  if (Object.keys(patch).length === 0) {
    bad(`mutation for sample ${sampleId} has no editable fields`);
  }
  if (
    typeof patch.checked_out_to === "string" &&
    patch.status !== undefined && patch.status !== "checked_out"
  ) {
    bad(
      `assigning a sample sets status to checked_out; do not combine an ` +
        `assignee with status "${patch.status}" (sample ${sampleId})`,
    );
  }
  if (patch.checked_out_to === null && patch.status === "checked_out") {
    bad(
      `clearing the assignee is a check-in; it cannot set status to ` +
        `checked_out (sample ${sampleId})`,
    );
  }
  return patch;
}

/** Validate an untrusted request body into a canonical batch request. */
export function validateInventoryBatchRequest(
  body: unknown,
): InventoryBatchRequest {
  const root = asRecord(body, "request body");

  const requestId = typeof root.requestId === "string" ? root.requestId : "";
  if (!UUID_RE.test(requestId)) bad("requestId must be a UUID");

  const operator = typeof root.operator === "string"
    ? root.operator.trim()
    : "";
  if (!operator) bad("operator is required");

  const note = typeof root.note === "string" && root.note.trim()
    ? root.note.trim()
    : undefined;

  if (!Array.isArray(root.mutations) || root.mutations.length === 0) {
    bad("mutations must be a non-empty array");
  }
  if (root.mutations.length > MAX_MUTATIONS) {
    bad(`a batch may mutate at most ${MAX_MUTATIONS} samples`);
  }

  const seen = new Set<number>();
  const mutations: InventoryMutation[] = root.mutations.map((raw, i) => {
    const m = asRecord(raw, `mutations[${i}]`);
    const sampleId = asPositiveInt(m.sampleId, `mutations[${i}].sampleId`);
    if (seen.has(sampleId)) {
      bad(`sample ${sampleId} appears more than once in the batch`);
    }
    seen.add(sampleId);
    const expectedVersion = asPositiveInt(
      m.expectedVersion,
      `mutations[${i}].expectedVersion`,
    );
    return { sampleId, expectedVersion, patch: parsePatch(m.patch, sampleId) };
  });

  return { requestId, operator, note, mutations };
}

type DerivedUpdate = {
  update: Record<string, unknown>;
  action: InventorySampleChange["action"];
};

/**
 * Apply the lifecycle transition rules on top of the raw patch:
 * assignment forces checked_out + stamps checked_out_at; clearing the
 * assignee is a check-in that stamps checked_in_at; location-only changes
 * never alter status.
 */
function deriveUpdate(
  row: Record<string, unknown>,
  patch: InventoryPatch,
  nowIso: string,
): DerivedUpdate {
  const update: Record<string, unknown> = {};
  for (
    const key of [
      "location",
      "bundle_id",
      "quantity",
      "current_price",
      "fire_sale",
      "notes",
    ] as const
  ) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }

  let action: InventorySampleChange["action"] = "custom";
  if (typeof patch.checked_out_to === "string") {
    // Assignment: requires the (already validated) nonempty assignee.
    update.checked_out_to = patch.checked_out_to;
    update.status = "checked_out";
    update.checked_out_at = nowIso;
    action = "check_out";
  } else if (patch.checked_out_to === null) {
    // Check-in: clear assignee, stamp checked_in_at, optional new status.
    update.checked_out_to = null;
    update.checked_in_at = nowIso;
    if (patch.status !== undefined) update.status = patch.status;
    action = "check_in";
  } else if (patch.status !== undefined) {
    if (patch.status === "checked_out") {
      const current = String(row.checked_out_to ?? "").trim();
      if (!current) {
        bad(
          `sample ${row.id} cannot be set to checked_out without an ` +
            `assignee — use the Assign action instead`,
        );
      }
      update.checked_out_at = nowIso;
    }
    update.status = patch.status;
  }

  return { update, action };
}

function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

/**
 * Run one atomic bulk edit. Owns BEGIN/COMMIT/ROLLBACK on the given client;
 * the caller owns checkout/release. Throws InventoryBatchError for
 * validation / not_found / conflict; anything else is a server error.
 */
export async function runInventoryBatch(
  client: SqlClient,
  request: InventoryBatchRequest,
): Promise<InventoryBatchOutcome> {
  const { requestId, operator, note, mutations } = request;
  const ids = mutations.map((m) => m.sampleId).sort((a, b) => a - b);

  const replayQuery = () =>
    client.query(
      `select result from public.inventory_batches where request_id = $1`,
      [requestId],
    );

  const storedOutcome = (
    rows: Record<string, unknown>[],
  ): InventoryBatchOutcome | null => {
    if (!rows.length) return null;
    const result = rows[0].result as InventoryBatchOutcome | null;
    if (!result) return null;
    return { ...result, replayed: true };
  };

  try {
    await client.query("BEGIN");

    // Fast-path idempotency check before taking any row locks.
    let prior = storedOutcome((await replayQuery()).rows);
    if (prior) {
      await client.query("ROLLBACK");
      return prior;
    }

    // Lock every requested sample in deterministic id order.
    const locked = await client.query(
      `select * from public.samples where id = any($1::int[]) order by id for update`,
      [ids],
    );

    // Re-check idempotency now that we hold the locks: a concurrent duplicate
    // request that committed while we waited must replay, not conflict.
    prior = storedOutcome((await replayQuery()).rows);
    if (prior) {
      await client.query("ROLLBACK");
      return prior;
    }

    const byId = new Map<number, Record<string, unknown>>();
    for (const row of locked.rows) byId.set(Number(row.id), row);

    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new InventoryBatchError(
        "not_found",
        `sample(s) not found: ${missing.join(", ")}`,
        { missing },
      );
    }

    const conflicts = mutations
      .map((m) => ({
        sampleId: m.sampleId,
        expectedVersion: m.expectedVersion,
        actualVersion: Number(byId.get(m.sampleId)!.version ?? 1),
      }))
      .filter((c) => c.expectedVersion !== c.actualVersion);
    if (conflicts.length) {
      throw new InventoryBatchError(
        "conflict",
        `inventory changed elsewhere; no rows were changed (sample(s) ` +
          `${conflicts.map((c) => c.sampleId).join(", ")})`,
        { conflicts },
      );
    }

    // Validate referenced bundles exist before writing anything.
    const bundleIds = [
      ...new Set(
        mutations
          .map((m) => m.patch.bundle_id)
          .filter((b): b is number => typeof b === "number"),
      ),
    ];
    if (bundleIds.length) {
      const found = await client.query(
        `select id from public.bundles where id = any($1::int[])`,
        [bundleIds],
      );
      const have = new Set(found.rows.map((r) => Number(r.id)));
      const gone = bundleIds.filter((b) => !have.has(b));
      if (gone.length) {
        bad(`bundle(s) not found: ${gone.join(", ")}`, { bundles: gone });
      }
    }

    const nowIso = new Date().toISOString();
    const batchId = crypto.randomUUID();
    const rows: Record<string, unknown>[] = [];
    const changes: InventorySampleChange[] = [];

    for (const mutation of mutations) {
      const row = byId.get(mutation.sampleId)!;
      const { update, action } = deriveUpdate(row, mutation.patch, nowIso);

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(update)) {
        const prev = comparable(row[key]);
        const next = comparable(value);
        if (prev === next) continue;
        before[key] = prev;
        after[key] = next;
      }

      if (Object.keys(after).length === 0) {
        // No effective change: keep the row in the response, skip the write
        // so version does not bump and no audit row is produced.
        rows.push(serializeRow(row));
        continue;
      }

      const cols = Object.keys(after);
      const sets = cols.map((c, i) => `${safeIdent(c)} = $${i + 1}`);
      const updated = await client.query(
        `update public.samples set ${sets.join(", ")} where id = $${
          cols.length + 1
        } returning *`,
        [...cols.map((c) => after[c]), mutation.sampleId],
      );
      const freshRow = updated.rows[0];
      rows.push(serializeRow(freshRow));

      const change: InventorySampleChange = {
        sampleId: mutation.sampleId,
        action,
        name: (row.name as string | null) ?? null,
        qr_code: (row.qr_code as string | null) ?? null,
        before,
        after,
      };
      changes.push(change);

      const summary = `Workbench bulk edit: ${cols.join(", ")}`;
      await client.query(
        `insert into public.transactions
           (action, sample_id, scanned_code, operator, checked_out_to, notes,
            batch_id, request_id, changes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          action,
          mutation.sampleId,
          change.qr_code,
          operator,
          action === "check_out" ? update.checked_out_to : null,
          note ? `${note} | ${summary}` : summary,
          batchId,
          requestId,
          JSON.stringify({ before, after }),
        ],
      );
    }

    const outcome: InventoryBatchOutcome = {
      batchId,
      requestId,
      replayed: false,
      rows,
      changes,
    };

    await client.query(
      `insert into public.inventory_batches
         (batch_id, request_id, operator, mutation_count, result)
       values ($1, $2, $3, $4, $5)`,
      [batchId, requestId, operator, mutations.length, JSON.stringify(outcome)],
    );

    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    // Unique violation on inventory_batches.request_id: a concurrent
    // duplicate won the race — return its stored result as a replay.
    const pgError = error as { code?: string; constraint?: string };
    if (
      pgError?.code === "23505" &&
      String(pgError.constraint ?? "").includes("request_id")
    ) {
      const prior = storedOutcome((await replayQuery()).rows);
      if (prior) return prior;
    }
    throw error;
  }
}

/**
 * Find every sample whose primary code or related UPC matches a scan, plus
 * any bundle whose QR matches. Returns ALL matching rows — multiple physical
 * units can share a retail barcode.
 */
export async function lookupByCode(
  client: SqlClient,
  code: string,
): Promise<{
  code: string;
  samples: Record<string, unknown>[];
  bundles: Record<string, unknown>[];
}> {
  const needle = code.trim();
  const samples = await client.query(
    `select * from public.samples
      where qr_code = $1 or $1 = any(related_upc)
      order by id`,
    [needle],
  );
  const bundles = await client.query(
    `select * from public.bundles where qr_code = $1 order by id`,
    [needle],
  );
  return {
    code: needle,
    samples: samples.rows.map(serializeRow),
    bundles: bundles.rows.map(serializeRow),
  };
}
