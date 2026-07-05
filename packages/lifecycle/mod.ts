// Sample lifecycle write path: status changes and resale ("sold") events.
// Faithful port of data-pimp core/lifecycle.ts with dependencies injected.
//
// Two write targets per the design decisions:
//   1. Postgres (`public.samples` + `transactions`) — the inventory source of
//      truth. Reached via the injected @lp-os/db table APIs.
//   2. Graylog — the durable analytics spine. Each event is one JSON-string
//      container field (lossless round-trip) plus flat scalar fields so the
//      read-side `graylog-query` skill can filter/range/aggregate without
//      parsing JSON. Empty values are stripped before logEvent so field shapes
//      match the original GELF writer exactly.
//
// The resale event deliberately reuses graylog-query's revenue vocabulary —
// `creator` + `gmv_num` (gross) — so a creator's resale revenue is queryable
// the moment it's written. `net_num` (and the fee/shipping/cost breakdown) are
// additive for profit views.
//
// Join key across the whole lifecycle is the TikTok productId, which is the
// sample's `qr_code` in Postgres and `product_id` on Graylog events.
// `sample_id` is stamped alongside so the two systems reconcile even when a
// qr_code holds a barcode instead of a real id.

import sampleStatuses from "./sample-statuses.json" with { type: "json" };
import campaignConfig from "./campaign-config.json" with { type: "json" };
import type {
  AgencyIntakeInput,
  AgencyIntakeResult,
  AssignmentInput,
  AssignmentResult,
  BulkSoldInput,
  BulkSoldResult,
  CampaignEntry,
  DueListingSchedule,
  ImportInput,
  ImportResult,
  Lifecycle,
  LifecycleDeps,
  LifecycleReads,
  ListingInput,
  ListingResult,
  SampleRef,
  SampleStatusEntry,
  ScheduledListing,
  SoldInput,
  SoldResult,
  StatusUpdateInput,
  StatusUpdateResult,
} from "./types.ts";

export * from "./types.ts";

type SampleRow = Record<string, unknown>;

const STATUSES = sampleStatuses as SampleStatusEntry[];

// Kept for continuity of existing Graylog queries (was the GELF `host`).
const GRAYLOG_SOURCE = "thirsty-store-kiosk";

const FIVE_YEARS = 60 * 60 * 24 * 365 * 5;
const TWO_YEARS = 60 * 60 * 24 * 365 * 2;
const ONE_YEAR = 60 * 60 * 24 * 365;

// The full synced status vocabulary (statuses + badges) — served verbatim so
// the MCP/skill validate against the same single source the tracker uses.
export function listSampleStatuses(): SampleStatusEntry[] {
  return STATUSES;
}

const CAMPAIGNS = campaignConfig as {
  defaultDailyVideoGoal?: number;
  campaigns?: CampaignEntry[];
};

// Match a product to a configured campaign by exact productId or a case-
// insensitive name substring. CONFIG-driven — a match only tells the enrichment
// note which goal/promo text to show.
function matchCampaign(
  productId: string | null,
  name: string | null,
): CampaignEntry | null {
  const pid = String(productId || "").trim();
  const nm = String(name || "").toLowerCase();
  for (const c of CAMPAIGNS.campaigns ?? []) {
    if (pid && Array.isArray(c.productIds) && c.productIds.includes(pid)) {
      return c;
    }
    if (
      nm && Array.isArray(c.productMatch) &&
      c.productMatch.some((t) => nm.includes(String(t).toLowerCase()))
    ) return c;
  }
  return null;
}

function daysUntil(iso: string): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - Date.now()) / 86_400_000);
}

// Only `kind:"status"` values can live in the single `samples.status` column;
// badges (fire_sale, lowest_price) are non-exclusive and tracked elsewhere.
function statusValues(): string[] {
  return STATUSES.filter((entry) => entry.kind === "status").map((e) =>
    e.value
  );
}

function isStatusValue(value: string): boolean {
  return statusValues().includes(value);
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.replace(/[$,]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function numOrZero(value: unknown): number {
  const n = toNumber(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function productIdOf(row: SampleRow | null, ref: SampleRef): string | null {
  if (row) {
    const fromRow = String(row.qr_code ?? "").trim();
    if (fromRow) return fromRow;
  }
  const fromRef = String(ref.productId ?? ref.qrCode ?? "").trim();
  return fromRef || null;
}

// Human-readable outcome line. Honest about partial success: a Graylog write
// can silently fail (logEvent returns false), so we never report success that
// didn't happen.
function describe(
  kind: "status" | "sold",
  o: {
    updated: boolean;
    graylog: boolean;
    name: string | null;
    productId: string | null;
    status?: string;
    creator?: string;
    salePrice?: number;
    marketplace?: string;
    warnings?: string[];
  },
): string {
  const label = o.name ?? o.productId ?? "sample";
  const targets: string[] = [];
  if (o.updated) targets.push("Postgres");
  if (o.graylog) targets.push("Graylog");
  const where = targets.length ? targets.join(" + ") : "nothing";

  const base = kind === "status"
    ? `Set ${label} to "${o.status}" (persisted to ${where}).`
    : `Sold ${label} for $${
      (o.salePrice ?? 0).toFixed(2)
    } via ${o.marketplace}, attributed to ${o.creator} (persisted to ${where}).`;

  const warnings = o.warnings ?? [];
  return warnings.length ? `${base} WARNING: ${warnings.join("; ")}.` : base;
}

export function createLifecycle(
  deps: LifecycleDeps,
): Lifecycle & LifecycleReads {
  const { db, store } = deps;

  // Mirrors data-pimp sendGelfMessage: strip null/undefined/empty-string field
  // values so the stored field set is identical, stamp the continuity source,
  // and never throw (best-effort analytics write).
  async function sendEvent(
    shortMessage: string,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    const clean: Record<string, unknown> = { source: GRAYLOG_SOURCE };
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === "") continue;
      clean[name] = value;
    }
    try {
      return await store.logEvent(shortMessage, clean);
    } catch {
      return false;
    }
  }

  // Mirrors data-pimp searchGraylog: same query strings, flat field records,
  // newest first. Errors degrade to empty (reads are best-effort).
  async function searchFlat(
    query: string,
    rangeSeconds: number,
    limit: number,
    fields: string[],
  ): Promise<Record<string, unknown>[]> {
    try {
      const result = await store.search({
        query,
        rangeSeconds,
        limit,
        fields,
      });
      const messages = Array.isArray(result?.messages) ? result.messages : [];
      return messages
        .map((m) => (isRecord(m?.message) ? m.message : null))
        .filter((m): m is Record<string, unknown> => m !== null);
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Graylog-backed reads (query strings identical to data-pimp core/graylog.ts)
  // -------------------------------------------------------------------------

  function sortCreators(seen: Set<string>): string[] {
    return [...seen].sort((a, b) => {
      const aRank = a.startsWith("@") ? 0 : 1;
      const bRank = b.startsWith("@") ? 0 : 1;
      return aRank - bRank || a.localeCompare(b);
    });
  }

  async function fetchKnownCreators(limit = 1000): Promise<string[]> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 1000;
    const messages = await searchFlat(
      "creator:*",
      FIVE_YEARS,
      Math.max(200, Math.min(safeLimit, 1000)),
      ["timestamp", "creator"],
    );
    const seen = new Set<string>();
    for (const message of messages) {
      const creator = typeof message.creator === "string"
        ? message.creator.trim()
        : "";
      if (creator) seen.add(creator);
    }
    return sortCreators(seen);
  }

  async function fetchCreatorsForProduct(
    productId: string,
    limit = 1000,
  ): Promise<string[]> {
    const pid = String(productId || "").trim();
    if (!pid) return [];
    const escaped = pid.replace(/"/g, '\\"');
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 1000;
    const messages = await searchFlat(
      `source:tiktok-affiliate-export AND (product_id:"${escaped}" OR product_id.keyword:"${escaped}")`,
      FIVE_YEARS,
      Math.max(200, Math.min(safeLimit, 1000)),
      ["timestamp", "creator", "product_id"],
    );
    const seen = new Set<string>();
    for (const message of messages) {
      const creator = typeof message.creator === "string"
        ? message.creator.trim()
        : "";
      if (creator) seen.add(creator);
    }
    return sortCreators(seen);
  }

  // Resolve which creator a physical sample was assigned to, from its
  // assignment history. Prefers an exact sample_id match, then the most recent.
  async function fetchAssignedCreatorForSample(
    sampleId?: string | number,
    productId?: string,
  ): Promise<string | null> {
    const sid = String(sampleId ?? "").trim();
    const pid = String(productId ?? "").trim();
    if (!sid && !pid) return null;

    const idClauses: string[] = [];
    if (sid) idClauses.push(`sample_id:"${sid.replace(/"/g, '\\"')}"`);
    if (pid) idClauses.push(`product_id:"${pid.replace(/"/g, '\\"')}"`);
    const idClause = idClauses.length > 1
      ? `(${idClauses.join(" OR ")})`
      : idClauses[0];

    const messages = await searchFlat(
      `creator:* AND sample_assignment_json:* AND ${idClause}`,
      TWO_YEARS,
      200,
      ["timestamp", "creator", "sample_id", "product_id"],
    );
    let best: { creator: string; ts: string; sidMatch: boolean } | null = null;
    for (const message of messages) {
      const creator = typeof message.creator === "string"
        ? message.creator.trim()
        : "";
      if (!creator) continue;
      const ts = typeof message.timestamp === "string" ? message.timestamp : "";
      const sidMatch = !!sid && String(message.sample_id ?? "") === sid;
      if (
        !best ||
        (sidMatch && !best.sidMatch) ||
        (sidMatch === best.sidMatch && ts > best.ts)
      ) {
        best = { creator, ts, sidMatch };
      }
    }
    return best ? best.creator : null;
  }

  // Idempotency backstop for recordSampleSold's graylogOnly mode.
  async function hasResaleEventForSample(
    sampleId?: string | number,
  ): Promise<boolean> {
    const sid = String(sampleId ?? "").trim();
    if (!sid) return false;
    const messages = await searchFlat(
      `sample_sold_json:* AND sample_source:"tracker-resale" AND sample_id:"${
        sid.replace(/"/g, '\\"')
      }"`,
      TWO_YEARS,
      1,
      ["timestamp", "sample_id"],
    );
    return messages.length > 0;
  }

  // Scheduled-listing intents paired with their fired markers.
  async function fetchScheduleRecords(): Promise<
    { scheduled: Record<string, unknown>[]; done: Set<string> }
  > {
    const sched = await searchFlat("sample_schedule_json:*", ONE_YEAR, 500, [
      "timestamp",
      "sample_schedule_json",
    ]);
    const doneMsgs = await searchFlat(
      "sample_schedule_done_json:*",
      ONE_YEAR,
      500,
      ["timestamp", "sample_schedule_done_json"],
    );
    const scheduled = sched
      .map((m) => parseJsonValue(m.sample_schedule_json))
      .filter(isRecord);
    const done = new Set<string>();
    for (const m of doneMsgs) {
      const rec = parseJsonValue(m.sample_schedule_done_json);
      if (isRecord(rec) && rec.scheduleId) done.add(String(rec.scheduleId));
    }
    return { scheduled, done };
  }

  // Find scheduled-listing intents that are due (list_at <= now) and not yet
  // fired, for the auto-list cron.
  async function fetchDueListingSchedules(): Promise<DueListingSchedule[]> {
    const records = await fetchScheduleRecords();
    const nowMs = Date.now();
    const due: DueListingSchedule[] = [];
    for (const r of records.scheduled) {
      const id = String(r.scheduleId || "").trim();
      if (!id || records.done.has(id)) continue;
      const listAt = String(r.listAt || "");
      const t = Date.parse(listAt);
      if (!Number.isFinite(t) || t > nowMs) continue;
      due.push({
        scheduleId: id,
        productId: String(r.productId || ""),
        sampleId: r.sampleId != null ? Number(r.sampleId) : null,
        name: String(r.name || ""),
        creator: String(r.creator || ""),
        marketplace: String(r.marketplace || "ebay"),
        askPrice: numOrZero(r.askPrice),
        listAt,
      });
    }
    return due;
  }

  // Mark a scheduled listing as fired so the at-least-once cron doesn't
  // re-list it.
  async function markListingScheduleDone(scheduleId: string): Promise<void> {
    await sendEvent(`thirsty sample listing fired: ${scheduleId}`, {
      sample_schedule_done_json: JSON.stringify({
        scheduleId,
        firedAt: new Date().toISOString(),
      }),
      sample_event: "listing_fired",
      schedule_id: scheduleId,
      sample_source: "skill-cron",
    });
  }

  // -------------------------------------------------------------------------
  // Shared write helpers
  // -------------------------------------------------------------------------

  // Best-effort audit transaction (the sample-row write is the source of truth).
  async function safeTxn(
    sampleId: unknown,
    recipient: string,
    operator: string,
    scannedCode: string,
    notes: string,
    action: string,
  ): Promise<void> {
    try {
      await db.Transactions.create({
        action,
        sample_id: sampleId,
        operator: operator || null,
        checked_out_to: recipient || null,
        scanned_code: scannedCode || null,
        notes,
      });
    } catch {
      // audit only — never block the status write on it
    }
  }

  // "Nice-to-know" lines for an assignment. Bundle membership is REAL
  // (samples.bundle_id → bundles + siblings); the daily-video goal and promo
  // are CONFIG from campaign-config.json and are labelled so nobody mistakes
  // them for measured data.
  async function buildEnrichment(
    row: SampleRow | null,
    campaign: CampaignEntry | null,
  ): Promise<string[]> {
    const lines: string[] = [];

    const bundleId = row?.bundle_id;
    if (bundleId !== undefined && bundleId !== null) {
      try {
        const bundles = await db.Bundles.filter(
          { id: String(bundleId) },
          undefined,
          1,
        ) as SampleRow[];
        const bundle = bundles[0];
        if (bundle) {
          const siblings = await db.Samples.filter(
            { bundle_id: String(bundleId) },
            undefined,
            50,
          ) as SampleRow[];
          const extra = siblings.length > 1
            ? ` (${siblings.length} items)`
            : "";
          lines.push(
            `Heads up: this sample is part of the "${
              String(bundle.name ?? "").trim() || "?"
            }" bundle${extra}.`,
          );
        }
      } catch {
        // bundle enrichment is best-effort
      }
    }

    if (campaign) {
      const goal = campaign.dailyVideoGoal ?? CAMPAIGNS.defaultDailyVideoGoal ??
        3;
      const left = campaign.endsAt ? daysUntil(campaign.endsAt) : null;
      let goalLine = `Campaign "${campaign.name}": aim for ${goal} video${
        goal === 1 ? "" : "s"
      }/day to hit goal`;
      if (left !== null && left >= 0) {
        goalLine += ` — ends ${campaign.endsAt} (~${left} day${
          left === 1 ? "" : "s"
        } left)`;
      }
      lines.push(`${goalLine}. [goal from campaign-config]`);
      if (campaign.promo) {
        lines.push(
          `Offer: want to join the ${campaign.promo}? [promo from campaign-config]`,
        );
      }
    }

    return lines;
  }

  // Resolve a sample by explicit id, else by productId/qr_code. A qr_code can
  // be shared by several physical samples of one product, so when resolving by
  // that key for a sale we prefer a not-yet-sold row (newest first).
  async function resolveSampleRow(
    ref: SampleRef,
    opts: { preferUnsold?: boolean; preferReserved?: boolean } = {},
  ): Promise<SampleRow | null> {
    const id = String(ref.sampleId ?? "").trim();
    if (id) {
      const rows = await db.Samples.filter({ id }, undefined, 1) as SampleRow[];
      if (rows[0]) return rows[0];
    }

    const key = String(ref.productId ?? ref.qrCode ?? "").trim();
    if (key) {
      const rows = await db.Samples.filter(
        { qr_code: key },
        "-created_at",
        25,
      ) as SampleRow[];
      if (!rows.length) return null;
      const statusOf = (r: SampleRow) => String(r.status ?? "").trim();
      // Fulfillment pulls from the agency bucket first (a `reserved` unit),
      // then any not-yet-sold unit, then whatever's newest.
      if (opts.preferReserved) {
        return rows.find((r) => statusOf(r) === "reserved") ??
          rows.find((r) => statusOf(r) !== "sold") ?? rows[0];
      }
      if (opts.preferUnsold) {
        return rows.find((r) => statusOf(r) !== "sold") ?? rows[0];
      }
      return rows[0];
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // recordSampleStatus
  // -------------------------------------------------------------------------

  // Update a sample's exclusive status. `sold` is rejected on purpose: it must
  // go through the sold flow so resale revenue is attributed to a creator.
  async function recordSampleStatus(
    input: StatusUpdateInput,
  ): Promise<StatusUpdateResult> {
    const status = String(input.status || "").trim();
    if (!status) throw new Error("status is required");
    if (!isStatusValue(status)) {
      throw new Error(
        `Unknown status "${status}". Valid statuses: ${
          statusValues().join(", ")
        }`,
      );
    }
    if (status === "sold") {
      throw new Error(
        "Use the sold flow (mark_sample_sold / POST /api/sample-sold) to mark a " +
          "sample sold, so the resale revenue is attributed to a creator account.",
      );
    }

    const row = await resolveSampleRow(input);
    const sampleId = row ? Number(row.id) : null;
    const productId = productIdOf(row, input);
    const name = row ? String(row.name ?? "").trim() || null : null;
    const previousStatus = row ? String(row.status ?? "").trim() || null : null;
    const now = new Date().toISOString();
    const source = String(input.source || "skill").trim() || "skill";
    const note = String(input.note || "").trim();

    let updated = false;
    let reason: string | undefined;
    if (row) {
      try {
        // Stamp the checkout clock when a plain status flip enters
        // `checked_out` so the stale-checkout alert can age the row.
        const patch: Record<string, unknown> = { status };
        if (status === "checked_out") patch.checked_out_at = now;
        await db.Samples.update(String(row.id), patch);
        updated = true;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    } else {
      reason =
        "no matching sample row in Postgres (Graylog event still written)";
    }

    const graylog = await sendEvent(
      `thirsty sample status: ${name ?? productId ?? "unknown"}`,
      {
        sample_status_json: JSON.stringify({
          productId,
          sampleId,
          status,
          previousStatus,
          qrCode: productId,
          name,
          source,
          note: note || undefined,
          updatedAt: now,
        }),
        sample_status: status,
        product_id: productId ?? undefined,
        sample_id: sampleId != null ? String(sampleId) : undefined,
        sample_source: source,
      },
    );

    return {
      ok: updated || graylog,
      sampleId,
      productId,
      name,
      status,
      previousStatus,
      postgres: { updated, reason },
      graylog,
      message: describe("status", {
        updated,
        graylog,
        name,
        productId,
        status,
        warnings: graylog ? [] : ["Graylog event was NOT written"],
      }),
    };
  }

  // -------------------------------------------------------------------------
  // recordSampleSold
  // -------------------------------------------------------------------------

  // Mark a sample sold and attribute the resale revenue to a creator. Writes
  // the inventory truth to Postgres (status=sold + sale columns + a `sold`
  // transaction) and the analytics event to Graylog.
  async function recordSampleSold(input: SoldInput): Promise<SoldResult> {
    const graylogOnly = input.graylogOnly === true;
    const salePrice = toNumber(input.salePrice);
    if (!(salePrice > 0)) {
      throw new Error("salePrice must be a positive number");
    }
    const marketplace = String(input.marketplace || "").trim();
    if (!marketplace) {
      throw new Error(
        "marketplace is required (e.g. ebay, offerup, fbmarketplace)",
      );
    }

    const fees = numOrZero(input.fees);
    const shipping = numOrZero(input.shipping);
    const costBasis = numOrZero(input.costBasis);
    const net = round2(salePrice - fees - shipping - costBasis);

    const row = await resolveSampleRow(input, { preferUnsold: !graylogOnly });
    const sampleId = row ? Number(row.id) : null;
    const productId = productIdOf(row, input);
    const name = row ? String(row.name ?? "").trim() || null : null;
    const previousStatus = row ? String(row.status ?? "").trim() || null : null;

    // Creator is required for attribution. In graylogOnly mode the caller (the
    // tracker dashboard) often can't supply one — checked_out_to is cleared on
    // check-in — so resolve it from the sample's assignment history, then fall
    // back to a still-present checked_out_to on the row.
    let creator = String(input.creator || "").trim();
    if (!creator && graylogOnly) {
      creator = (await fetchAssignedCreatorForSample(
        sampleId ?? undefined,
        productId ?? undefined,
      )) ||
        (row && row.checked_out_to ? String(row.checked_out_to).trim() : "");
    }
    if (!creator) {
      throw new Error(
        "creator is required — which creator account should this resale revenue " +
          "be attributed to?",
      );
    }

    // Idempotency backstop for graylogOnly: that mode skips the double-sell
    // guard below (the caller owns Postgres state), so refuse to re-emit a
    // resale event for a sample that already has one — GELF is append-only and
    // gmv_num is summed client-side. force:true re-attributes on purpose.
    if (
      graylogOnly && input.force !== true && sampleId != null &&
      (await hasResaleEventForSample(sampleId))
    ) {
      return {
        ok: true,
        sampleId,
        productId,
        name,
        creator,
        marketplace,
        salePrice,
        fees,
        shipping,
        costBasis,
        net,
        postgres: {
          updated: false,
          transactionId: null,
          reason: "graylogOnly: caller owns the sale",
        },
        graylog: false,
        message:
          `Resale revenue for sample ${sampleId} was already attributed — skipped ` +
          "to avoid double-counting (pass force:true to re-attribute).",
      };
    }

    // Guard against double-selling. GELF revenue events are append-only and
    // the read side sums `gmv_num` client-side, so a second sale permanently
    // inflates the creator's attributed revenue.
    if (!graylogOnly && previousStatus === "sold" && input.force !== true) {
      const soldAt = row ? String(row.sold_at ?? "").trim() : "";
      throw new Error(
        `Sample ${row?.id ?? productId ?? "?"} is already sold${
          soldAt ? ` (sold_at=${soldAt})` : ""
        } — re-attributing would double-count the creator's resale revenue. Pass ` +
          "force:true to override.",
      );
    }

    const now = new Date().toISOString();
    const buyer = String(input.buyer || "").trim();
    const orderRef = String(input.orderRef || "").trim();
    const note = String(input.note || "").trim();
    const operator = String(input.operator || "").trim();

    let updated = false;
    let transactionId: number | null = null;
    const reasons: string[] = [];
    if (graylogOnly) {
      // The caller owns the Postgres sale + audit transaction; we only emit
      // the analytics event below. Nothing to write here.
      reasons.push(
        "graylogOnly: Postgres update + audit transaction skipped (caller owns the sale)",
      );
    } else if (row) {
      try {
        await db.Samples.update(String(row.id), {
          status: "sold",
          sold_price: salePrice,
          sold_at: now,
          sold_to: buyer || null,
        });
        updated = true;
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }
      try {
        const summary = `Resale via ${marketplace} → ${creator} | gross $${
          salePrice.toFixed(2)
        }${net !== salePrice ? ` | net $${net.toFixed(2)}` : ""}${
          note ? ` | ${note}` : ""
        }`;
        const tx = await db.Transactions.create({
          action: "sold",
          sample_id: row.id,
          checked_out_to: buyer || null,
          operator: operator || null,
          scanned_code: productId || null,
          notes: summary,
        }) as SampleRow | undefined;
        transactionId = tx && tx.id != null ? Number(tx.id) : null;
      } catch (error) {
        reasons.push(
          `transaction: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      reasons.push(
        "no matching sample row in Postgres (Graylog event still written)",
      );
    }

    // Bulk-lot provenance (only present when called from recordBulkSampleSold).
    const bulkId = String(input.bulkId || "").trim();
    const bulkTotalNum = toNumber(input.bulkTotal);
    const bulkTotal = Number.isFinite(bulkTotalNum) ? bulkTotalNum : null;

    const graylog = await sendEvent(
      `thirsty sample sold: ${name ?? productId ?? "sample"} $${
        salePrice.toFixed(2)
      } via ${marketplace} → ${creator}`,
      {
        sample_sold_json: JSON.stringify({
          productId,
          sampleId,
          name,
          creator,
          marketplace,
          salePrice,
          fees,
          shipping,
          costBasis,
          net,
          buyer: buyer || undefined,
          orderRef: orderRef || undefined,
          soldAt: now,
          note: note || undefined,
          bulkId: bulkId || undefined,
          bulkTotal: bulkTotal ?? undefined,
        }),
        creator,
        gmv_num: salePrice,
        sale_price_num: salePrice,
        fee_num: fees,
        shipping_num: shipping,
        cost_num: costBasis,
        net_num: net,
        marketplace,
        product_id: productId ?? undefined,
        sample_id: sampleId != null ? String(sampleId) : undefined,
        sample_status: "sold",
        sample_source: graylogOnly
          ? "tracker-resale"
          : (bulkId ? "skill-bulk-resale" : "skill-resale"),
        bulk_id: bulkId || undefined,
        bulk_total_num: bulkTotal ?? undefined,
      },
    );

    // Honest headline: the sample UPDATE and the audit-transaction INSERT can
    // fail independently, and the GELF write can fail silently — surface each.
    const warnings: string[] = [];
    if (!graylog) warnings.push("Graylog revenue event was NOT written");
    if (updated && transactionId === null) {
      warnings.push("the inventory audit transaction was NOT recorded");
    }

    return {
      ok: updated || graylog,
      sampleId,
      productId,
      name,
      creator,
      marketplace,
      salePrice,
      fees,
      shipping,
      costBasis,
      net,
      postgres: {
        updated,
        transactionId,
        reason: reasons.length ? reasons.join("; ") : undefined,
      },
      graylog,
      message: describe("sold", {
        updated,
        graylog,
        name,
        productId,
        creator,
        salePrice,
        marketplace,
        warnings,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // recordBulkSampleSold
  // -------------------------------------------------------------------------

  // Mark a BULK lot sold: one marketplace sale spread across N samples, each
  // attributed to a (possibly different) creator. Allocates the lot total
  // across items (explicit per-item `price`, else an equal split of the
  // remainder) and allocates lot-level fees/shipping/costBasis proportionally
  // to each item's gross, then writes ONE per-sample sale via recordSampleSold
  // stamped with a shared bulk_id. Per-item failures are collected, not fatal.
  async function recordBulkSampleSold(
    input: BulkSoldInput,
  ): Promise<BulkSoldResult> {
    const items = Array.isArray(input.items) ? input.items : [];
    if (!items.length) {
      throw new Error("items is required — the samples in the bulk lot");
    }
    const marketplace = String(input.marketplace || "").trim();
    if (!marketplace) {
      throw new Error(
        "marketplace is required (e.g. ebay, offerup, fbmarketplace)",
      );
    }
    const totalPrice = toNumber(input.totalPrice);
    if (!(totalPrice > 0)) {
      throw new Error("totalPrice must be a positive number");
    }
    const lotCreator = String(input.creator || "").trim();

    // Validate creator + explicit price for every item up front, so a bad
    // input never writes a partial lot.
    const prepared = items.map((it, i) => {
      const creator = String(it.creator || lotCreator || "").trim();
      if (!creator) {
        throw new Error(
          `item ${
            i + 1
          }: creator is required (set item.creator or a lot-level creator)`,
        );
      }
      let explicit: number | null = null;
      if (it.price !== undefined) {
        const p = toNumber(it.price);
        if (!Number.isFinite(p) || p < 0) {
          throw new Error(`item ${i + 1}: price must be a non-negative number`);
        }
        explicit = p;
      }
      return { it, creator, explicit };
    });

    // Allocate gross: honor explicit prices, split the remainder equally
    // across the rest (last unpriced item absorbs the rounding remainder).
    const explicitSum = round2(
      prepared.reduce((sum, p) => sum + (p.explicit ?? 0), 0),
    );
    const remaining = round2(totalPrice - explicitSum);
    const unpricedCount = prepared.filter((p) => p.explicit === null).length;
    if (remaining < -0.001) {
      throw new Error(
        `explicit item prices ($${
          explicitSum.toFixed(2)
        }) exceed totalPrice ($${totalPrice.toFixed(2)})`,
      );
    }
    if (unpricedCount === 0 && Math.abs(remaining) > 0.01) {
      throw new Error(
        `explicit item prices ($${
          explicitSum.toFixed(2)
        }) do not sum to totalPrice ($${totalPrice.toFixed(2)})`,
      );
    }
    const per = unpricedCount
      ? Math.floor((remaining / unpricedCount) * 100) / 100
      : 0;
    let unpricedSeen = 0;
    const grosses = prepared.map((p) => {
      if (p.explicit !== null) return p.explicit;
      unpricedSeen++;
      return unpricedSeen === unpricedCount
        ? round2(remaining - per * (unpricedCount - 1))
        : per;
    });
    if (grosses.some((g) => !(g > 0))) {
      throw new Error(
        "allocation produced a non-positive per-item price — give explicit item " +
          "prices or a larger totalPrice",
      );
    }

    const allocatedTotal = round2(grosses.reduce((sum, g) => sum + g, 0));
    const fees = numOrZero(input.fees);
    const shipping = numOrZero(input.shipping);
    const costBasis = numOrZero(input.costBasis);
    const bulkId = String(input.bulkId || "").trim() ||
      `bulk-${crypto.randomUUID()}`;

    const results: SoldResult[] = [];
    const failures: { item: number; ref: string; error: string }[] = [];
    for (let i = 0; i < prepared.length; i++) {
      const { it, creator } = prepared[i];
      const gross = grosses[i];
      const share = allocatedTotal > 0 ? gross / allocatedTotal : 0;
      try {
        const result = await recordSampleSold({
          sampleId: it.sampleId,
          productId: it.productId,
          qrCode: it.qrCode,
          creator,
          salePrice: gross,
          marketplace,
          fees: round2(fees * share),
          shipping: round2(shipping * share),
          costBasis: round2(costBasis * share),
          buyer: input.buyer,
          orderRef: input.orderRef,
          note: [input.note, it.note].map((n) => String(n || "").trim())
            .filter(Boolean).join(" | ") || undefined,
          force: input.force,
          operator: input.operator,
          bulkId,
          bulkTotal: totalPrice,
        });
        results.push(result);
      } catch (error) {
        failures.push({
          item: i + 1,
          ref: String(it.sampleId ?? it.productId ?? it.qrCode ?? i + 1),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const netTotal = round2(results.reduce((sum, r) => sum + r.net, 0));
    const tail = failures.length
      ? ` WARNING: ${failures.length} item(s) failed: ${
        failures.map((f) => `#${f.item} (${f.ref}): ${f.error}`).join("; ")
      }.`
      : "";
    return {
      ok: failures.length === 0 && results.length > 0,
      bulkId,
      marketplace,
      totalPrice,
      allocatedTotal,
      itemCount: items.length,
      soldCount: results.length,
      netTotal,
      items: results,
      failures,
      message: `Bulk-sold ${results.length}/${items.length} sample(s) for $${
        totalPrice.toFixed(2)
      } via ${marketplace} (net $${
        netTotal.toFixed(2)
      }, lot ${bulkId}).${tail}`,
    };
  }

  // -------------------------------------------------------------------------
  // recordSampleListing
  // -------------------------------------------------------------------------

  // Record that a sample has been LISTED for resale on a marketplace.
  // Analytics-only on purpose: a listing is intent-to-sell, not an
  // inventory-status change, so this emits a Graylog event and does NOT
  // mutate Postgres.
  async function recordSampleListing(
    input: ListingInput,
  ): Promise<ListingResult> {
    const creator = String(input.creator || "").trim();
    if (!creator) {
      throw new Error(
        "creator is required — which creator account is this listing attributed to?",
      );
    }
    const marketplace = String(input.marketplace || "").trim();
    if (!marketplace) {
      throw new Error(
        "marketplace is required (e.g. ebay, offerup, fbmarketplace)",
      );
    }
    const askPrice = toNumber(input.askPrice);
    if (!(askPrice > 0)) {
      throw new Error("askPrice must be a positive number");
    }

    const row = await resolveSampleRow(input, { preferUnsold: true });
    const sampleId = row ? Number(row.id) : null;
    const productId = productIdOf(row, input);
    const name = row ? String(row.name ?? "").trim() || null : null;
    const listingUrl = String(input.listingUrl || "").trim() || null;
    const note = String(input.note || "").trim();
    const now = new Date().toISOString();

    const graylog = await sendEvent(
      `thirsty sample listed: ${name ?? productId ?? "sample"} @ $${
        askPrice.toFixed(2)
      } on ${marketplace} → ${creator}`,
      {
        sample_listing_json: JSON.stringify({
          productId,
          sampleId,
          name,
          creator,
          marketplace,
          askPrice,
          listingUrl: listingUrl || undefined,
          listedAt: now,
          note: note || undefined,
        }),
        creator,
        ask_price_num: askPrice,
        marketplace,
        product_id: productId ?? undefined,
        sample_id: sampleId != null ? String(sampleId) : undefined,
        sample_event: "listed",
        sample_source: "skill-listing",
      },
    );

    const where = graylog ? "Graylog" : "nothing";
    const warning = graylog
      ? ""
      : " WARNING: Graylog listing event was NOT written.";
    return {
      ok: graylog,
      sampleId,
      productId,
      name,
      creator,
      marketplace,
      askPrice,
      listingUrl,
      graylog,
      message: `Listed ${name ?? productId ?? "sample"} at $${
        askPrice.toFixed(2)
      } on ${marketplace} for ${creator} (recorded to ${where}).${warning}`,
    };
  }

  // -------------------------------------------------------------------------
  // recordAgencyIntake
  // -------------------------------------------------------------------------

  // Agency intake — credit a bulk lot of one product to an agency bucket
  // BEFORE any creator is assigned. Units sit in `reserved` with
  // checked_out_to = the bucket.
  async function recordAgencyIntake(
    input: AgencyIntakeInput,
  ): Promise<AgencyIntakeResult> {
    const agencyBucket = String(input.agencyBucket || "").trim();
    if (!agencyBucket) {
      throw new Error(
        "agencyBucket is required — which agency/admin bucket to credit (e.g. kyle)",
      );
    }
    const explicitIds = Array.isArray(input.sampleIds)
      ? input.sampleIds.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const productId = String(input.productId ?? input.qrCode ?? "").trim();
    if (!explicitIds.length && !productId) {
      throw new Error("productId (or sampleIds) is required");
    }

    const now = new Date().toISOString();
    const note = String(input.note || "").trim();
    const operator = String(input.operator || "").trim();

    // Name: explicit, else borrowed from an existing row for this productId.
    let name = String(input.name || "").trim();
    if (!name && productId) {
      try {
        const existing = await db.Samples.filter(
          { qr_code: productId },
          "-created_at",
          1,
        ) as SampleRow[];
        name = existing[0] ? String(existing[0].name ?? "").trim() : "";
      } catch {
        // fall through to productId as the name
      }
    }
    if (!name) name = productId || "sample";

    const sampleIds: number[] = [];
    let created = 0;
    let updated = 0;
    const reasons: string[] = [];

    if (explicitIds.length) {
      for (const id of explicitIds) {
        try {
          const r = await db.Samples.update(id, {
            status: "reserved",
            checked_out_to: agencyBucket,
            checked_out_at: now,
          }) as SampleRow | null;
          if (r?.id != null) {
            sampleIds.push(Number(r.id));
            updated++;
            await safeTxn(
              r.id,
              agencyBucket,
              operator,
              productId || String(r.qr_code ?? ""),
              `agency intake: credited to ${agencyBucket}${
                note ? ` | ${note}` : ""
              }`,
              "agency_intake",
            );
          }
        } catch (error) {
          reasons.push(error instanceof Error ? error.message : String(error));
        }
      }
    } else {
      const qty = Math.max(
        1,
        Math.min(200, Math.trunc(numOrZero(input.qty) || 1)),
      );
      for (let i = 0; i < qty; i++) {
        try {
          const r = await db.Samples.create({
            name,
            qr_code: productId,
            status: "reserved",
            checked_out_to: agencyBucket,
            checked_out_at: now,
            notes: `agency intake → ${agencyBucket}${note ? ` | ${note}` : ""}`,
          }) as SampleRow | undefined;
          if (r?.id != null) {
            sampleIds.push(Number(r.id));
            created++;
            await safeTxn(
              r.id,
              agencyBucket,
              operator,
              productId,
              `agency intake: credited to ${agencyBucket}`,
              "agency_intake",
            );
          }
        } catch (error) {
          reasons.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    const qty = sampleIds.length;
    const graylog = await sendEvent(
      `thirsty agency intake: ${name} ×${qty} → bucket ${agencyBucket}`,
      {
        sample_intake_json: JSON.stringify({
          productId: productId || null,
          sampleIds,
          name,
          agencyBucket,
          qty,
          note: note || undefined,
          intakeAt: now,
        }),
        sample_event: "agency_intake",
        agency_bucket: agencyBucket,
        product_id: productId || undefined,
        qty_num: qty,
        sample_source: "skill-agency-intake",
      },
    );

    const where = [qty ? "Postgres" : "", graylog ? "Graylog" : ""]
      .filter(Boolean).join(" + ") || "nothing";
    const warn = reasons.length
      ? ` WARNING: ${reasons.length} unit(s) failed: ${reasons.join("; ")}.`
      : "";
    return {
      ok: qty > 0 || graylog,
      productId: productId || null,
      name,
      agencyBucket,
      qty,
      sampleIds,
      postgres: {
        created,
        updated,
        reason: reasons.length ? reasons.join("; ") : undefined,
      },
      graylog,
      message:
        `Agency intake: ${qty} × ${name} credited to bucket "${agencyBucket}" (recorded to ${where}).${warn}`,
    };
  }

  // -------------------------------------------------------------------------
  // recordSampleAssignment
  // -------------------------------------------------------------------------

  // Fulfillment — assign one unit to a creator: moves it to CHECKED OUT,
  // attaches a matched campaign, records a `check_out` transaction, emits a
  // `sample_assignment_json` Graylog event, and returns an enrichment note.
  async function recordSampleAssignment(
    input: AssignmentInput,
  ): Promise<AssignmentResult> {
    const creator = String(input.creator || "").trim();
    if (!creator) {
      throw new Error(
        "creator is required — which creator to assign this sample to?",
      );
    }

    const row = await resolveSampleRow(input, { preferReserved: true });
    const sampleId = row ? Number(row.id) : null;
    const productId = productIdOf(row, input);
    const name = row ? String(row.name ?? "").trim() || null : null;
    const fromStatus = row ? String(row.status ?? "").trim() || null : null;
    const agencyBucket = String(input.agencyBucket || "").trim() ||
      (fromStatus === "reserved" && row
        ? String(row.checked_out_to ?? "").trim() || null
        : null);
    const now = new Date().toISOString();
    const note = String(input.note || "").trim();
    const operator = String(input.operator || "").trim();

    const campaignEntry = matchCampaign(productId, name);
    const campaign = String(input.campaign || "").trim() ||
      (campaignEntry ? campaignEntry.name : null);
    const campaignId = String(input.campaignId || "").trim() ||
      (campaignEntry ? campaignEntry.id : "");

    let updated = false;
    let transactionId: number | null = null;
    const reasons: string[] = [];
    if (row) {
      try {
        await db.Samples.update(String(row.id), {
          status: "checked_out",
          checked_out_to: creator,
          checked_out_at: now,
        });
        updated = true;
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }
    } else {
      reasons.push(
        "no matching sample row in Postgres (Graylog event still written)",
      );
    }

    const enrichment = await buildEnrichment(row, campaignEntry);

    if (row) {
      try {
        const summary = `assigned to ${creator}${
          agencyBucket ? ` from bucket ${agencyBucket}` : ""
        }${campaign ? ` | campaign ${campaign}` : ""}${
          note ? ` | ${note}` : ""
        }${enrichment.length ? ` | ${enrichment.join(" ")}` : ""}`;
        const tx = await db.Transactions.create({
          action: "check_out",
          sample_id: row.id,
          operator: operator || null,
          checked_out_to: creator,
          scanned_code: productId || null,
          notes: summary,
        }) as SampleRow | undefined;
        transactionId = tx && tx.id != null ? Number(tx.id) : null;
      } catch (error) {
        reasons.push(
          `transaction: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const graylog = await sendEvent(
      `thirsty sample assigned: ${name ?? productId ?? "sample"} → ${creator}`,
      {
        sample_assignment_json: JSON.stringify({
          productId,
          sampleId,
          name,
          creator,
          agencyBucket: agencyBucket || undefined,
          campaign: campaign || undefined,
          campaignId: campaignId || undefined,
          fromStatus,
          assignedAt: now,
          note: note || undefined,
        }),
        creator,
        sample_status: "checked_out",
        sample_event: "assigned",
        product_id: productId ?? undefined,
        sample_id: sampleId != null ? String(sampleId) : undefined,
        agency_bucket: agencyBucket || undefined,
        campaign: campaign || undefined,
        campaign_id: campaignId || undefined,
        sample_source: "skill-assignment",
      },
    );

    const targets: string[] = [];
    if (updated) targets.push("Postgres");
    if (graylog) targets.push("Graylog");
    const where = targets.length ? targets.join(" + ") : "nothing";
    const warnings: string[] = [];
    if (!graylog) warnings.push("Graylog assignment event was NOT written");
    if (updated && transactionId === null) {
      warnings.push("the check-out transaction was NOT recorded");
    }
    const warn = warnings.length ? ` WARNING: ${warnings.join("; ")}.` : "";

    return {
      ok: updated || graylog,
      sampleId,
      productId,
      name,
      creator,
      fromStatus,
      agencyBucket: agencyBucket || null,
      campaign: campaign || null,
      enrichment,
      postgres: {
        updated,
        transactionId,
        reason: reasons.length ? reasons.join("; ") : undefined,
      },
      graylog,
      message: `Assigned ${
        name ?? productId ?? "sample"
      } to ${creator} — checked out${
        campaign ? `, campaign "${campaign}"` : ""
      } (persisted to ${where}).${warn}${
        enrichment.length ? " " + enrichment.join(" ") : ""
      }`,
    };
  }

  // -------------------------------------------------------------------------
  // recordSampleImport
  // -------------------------------------------------------------------------

  // Import a product as a NEW inventory sample assigned directly to a creator.
  // Creates a Postgres row in `checked_out`, logs a `check_out` transaction,
  // matches a campaign, emits `sample_assignment_json` (sample_event
  // "imported"), and returns the enrichment note. Optionally schedules a
  // (stub) marketplace listing after N days via a `sample_schedule_json` event.
  async function recordSampleImport(
    input: ImportInput,
  ): Promise<ImportResult> {
    const creator = String(input.creator || "").trim();
    if (!creator) {
      throw new Error("creator is required — assign the import to a creator");
    }
    const productId = String(input.productId ?? input.qrCode ?? "").trim();
    if (!productId) throw new Error("productId is required");
    const dryRun = input.dryRun === true;

    const now = new Date().toISOString();
    const name = String(input.name || "").trim() || productId;
    const price = numOrZero(input.price);
    const image = String(input.image || "").trim();
    const seller = String(input.seller || "").trim();
    const note = String(input.note || "").trim();
    const operator = String(input.operator || "").trim();

    // Build the row with only present columns (insertRow keeps undefined keys,
    // so omit them rather than insert nulls for optional fields).
    const createData: Record<string, unknown> = {
      name,
      qr_code: productId,
      status: "checked_out",
      checked_out_to: creator,
      checked_out_at: now,
      notes: `imported & assigned to ${creator}${note ? ` | ${note}` : ""}`,
    };
    if (seller) createData.brand = seller;
    if (image) createData.picture_url = image;
    if (price > 0) createData.current_price = price;

    let sampleId: number | null = null;
    let created = false;
    let bundleRow: SampleRow | null = null;
    let transactionId: number | null = null;
    const reasons: string[] = [];
    if (dryRun) {
      reasons.push("dry-run: nothing written");
    } else {
      try {
        const row = await db.Samples.create(createData) as
          | SampleRow
          | undefined;
        if (row?.id != null) {
          sampleId = Number(row.id);
          created = true;
          bundleRow = row;
        }
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }
    }

    const campaignEntry = matchCampaign(productId, name);
    const campaign = String(input.campaign || "").trim() ||
      (campaignEntry ? campaignEntry.name : null);
    const campaignId = campaignEntry ? campaignEntry.id : "";

    // Optional auto-listing schedule (stub — records intent for the cron).
    let scheduledListing: ScheduledListing | null = null;
    const days = numOrZero(input.autoListAfterDays);
    if ((created || dryRun) && days > 0) {
      const marketplace = String(input.marketplace || "ebay").trim() || "ebay";
      const askNum = numOrZero(input.askPrice);
      const askPrice = askNum > 0 ? askNum : (price > 0 ? round2(price) : 0);
      const listAt = new Date(Date.now() + days * 86_400_000).toISOString();
      const scheduleId = `sched-${crypto.randomUUID()}`;
      const ok = dryRun ? true : await sendEvent(
        `thirsty sample listing scheduled: ${name} → ${marketplace} in ${days}d`,
        {
          sample_schedule_json: JSON.stringify({
            scheduleId,
            productId,
            sampleId,
            name,
            creator,
            marketplace,
            askPrice,
            listAt,
            scheduledAt: now,
          }),
          sample_event: "listing_scheduled",
          schedule_id: scheduleId,
          list_at: listAt,
          product_id: productId,
          sample_id: sampleId != null ? String(sampleId) : undefined,
          creator,
          marketplace,
          ask_price_num: askPrice,
          sample_source: "skill-import",
        },
      );
      if (ok) scheduledListing = { scheduleId, listAt, marketplace, askPrice };
    }

    const enrichment = await buildEnrichment(bundleRow, campaignEntry);
    if (scheduledListing) {
      enrichment.push(
        `Auto-listing: a draft ${scheduledListing.marketplace} listing is scheduled ` +
          `for ${scheduledListing.listAt.slice(0, 10)} (~${days} day(s)). ` +
          "[stub — records intent, does not post to eBay yet]",
      );
    }

    if (created) {
      try {
        const summary = `imported & assigned to ${creator}${
          campaign ? ` | campaign ${campaign}` : ""
        }${
          scheduledListing
            ? ` | auto-list ${scheduledListing.listAt.slice(0, 10)}`
            : ""
        }${note ? ` | ${note}` : ""}`;
        const tx = await db.Transactions.create({
          action: "check_out",
          sample_id: sampleId,
          operator: operator || null,
          checked_out_to: creator,
          scanned_code: productId,
          notes: summary,
        }) as SampleRow | undefined;
        transactionId = tx && tx.id != null ? Number(tx.id) : null;
      } catch (error) {
        reasons.push(
          `transaction: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const graylog = dryRun ? false : await sendEvent(
      `thirsty sample imported: ${name} → ${creator}`,
      {
        sample_assignment_json: JSON.stringify({
          productId,
          sampleId,
          name,
          creator,
          campaign: campaign || undefined,
          campaignId: campaignId || undefined,
          price: price || undefined,
          image: image || undefined,
          seller: seller || undefined,
          importedAt: now,
          note: note || undefined,
        }),
        creator,
        sample_status: "checked_out",
        sample_event: "imported",
        product_id: productId,
        sample_id: sampleId != null ? String(sampleId) : undefined,
        campaign: campaign || undefined,
        campaign_id: campaignId || undefined,
        sample_source: "skill-import",
      },
    );

    const targets: string[] = [];
    if (created) targets.push("Postgres");
    if (graylog) targets.push("Graylog");
    const where = targets.length ? targets.join(" + ") : "nothing";
    const warnings: string[] = [];
    if (!created) {
      warnings.push(
        `Postgres row was NOT created${
          reasons.length ? ` (${reasons.join("; ")})` : ""
        }`,
      );
    } else if (transactionId === null) {
      warnings.push("the check-out transaction was NOT recorded");
    }
    if (!graylog) warnings.push("Graylog event was NOT written");
    const warn = warnings.length ? ` WARNING: ${warnings.join("; ")}.` : "";

    return {
      ok: dryRun || created || graylog,
      sampleId,
      productId,
      name,
      creator,
      campaign: campaign || null,
      enrichment,
      scheduledListing,
      postgres: {
        created,
        transactionId,
        reason: reasons.length ? reasons.join("; ") : undefined,
      },
      graylog,
      dryRun: dryRun || undefined,
      message: dryRun
        ? `DRY-RUN — would import ${name} → assign to ${creator}${
          campaign ? `, campaign "${campaign}"` : ""
        } (nothing written).${
          enrichment.length ? " " + enrichment.join(" ") : ""
        }`
        : `Imported ${name} → assigned to ${creator}${
          campaign ? `, campaign "${campaign}"` : ""
        } (persisted to ${where}).${warn}${
          enrichment.length ? " " + enrichment.join(" ") : ""
        }`,
    };
  }

  return {
    recordSampleStatus,
    recordSampleSold,
    recordBulkSampleSold,
    recordSampleListing,
    recordAgencyIntake,
    recordSampleAssignment,
    recordSampleImport,
    listSampleStatuses,
    fetchKnownCreators,
    fetchCreatorsForProduct,
    fetchAssignedCreatorForSample,
    hasResaleEventForSample,
    fetchDueListingSchedules,
    markListingScheduleDone,
  };
}
