// kiosk-payments.ts — self-serve kiosk checkout state (kiosk_payments table).
//
// A "quote" is one kiosk checkout. Creating it locks every scanned sample
// (FOR UPDATE), checks it is still for sale, locks in the total from
// samples.current_price and moves the samples to status 'reserved' — all in
// one BEGIN … COMMIT, so two kiosks can never sell the same sample. Each item
// keeps the sample's prior status, so a cancelled, expired or rejected quote
// puts it back exactly as it was. Completing a quote marks every sample sold
// and writes one `sold` audit row per sample in the same transaction.
//
// Status machine (see migrations/0004_kiosk_payments.sql):
//   pending ─▶ charging ─▶ paid          (square: token charged server-side)
//      │          └──────▶ pending/error (declined / unknown outcome)
//      ├──▶ claimed ─▶ paid | rejected   (cashapp_link: customer says paid,
//      │                                  staff confirm in Cash App)
//      └──▶ cancelled | expired          (samples released)
//
// Like inventory.ts this module only needs the structural SqlClient, so it
// runs against a checked-out pg PoolClient (mod.ts) or any compatible client.

import { serializeRow } from "./builders.ts";
import type { SqlClient } from "./inventory.ts";

export type KioskPaymentMethod = "cashapp_link" | "square";

export type KioskPaymentStatus =
  | "pending"
  | "charging"
  | "claimed"
  | "paid"
  | "cancelled"
  | "expired"
  | "rejected"
  | "error";

export type KioskPaymentItem = {
  sample_id: number;
  name: string | null;
  brand: string | null;
  price_cents: number;
  /** false when the sample had no current_price and the default was used. */
  priced: boolean;
  prior_status: string;
};

export type KioskPayment = {
  id: string;
  kiosk_id: string | null;
  method: KioskPaymentMethod;
  status: KioskPaymentStatus;
  items: KioskPaymentItem[];
  amount_cents: number;
  currency: string;
  pay_url: string | null;
  idempotency_key: string | null;
  attempts: number;
  provider_payment_id: string | null;
  receipt_url: string | null;
  receipt_number: string | null;
  confirmed_by: string | null;
  last_error: string | null;
  expires_at: string;
  claimed_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Typed failure; the HTTP layer maps kind → status code. */
export class KioskPaymentError extends Error {
  kind: "validation" | "not_found" | "conflict";
  details?: unknown;

  constructor(
    kind: "validation" | "not_found" | "conflict",
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "KioskPaymentError";
    this.kind = kind;
    this.details = details;
  }
}

export const KIOSK_MAX_ITEMS = 25;

export type CreateKioskQuoteInput = {
  id: string;
  kioskId?: string | null;
  method: KioskPaymentMethod;
  sampleIds: number[];
  /** Sample statuses that may be sold at the kiosk. */
  sellableStatuses: string[];
  /** Price for a sample with no current_price; null refuses unpriced items. */
  defaultPriceCents: number | null;
  ttlSeconds: number;
  /** Builds the cash.app link for the locked-in total (cashapp_link only). */
  payUrlFor?: (amountCents: number) => string | null;
};

type Row = Record<string, unknown>;

function toPayment(row: Row): KioskPayment {
  const r = serializeRow(row) as Row;
  let items = r.items;
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      items = [];
    }
  }
  return {
    ...(r as unknown as KioskPayment),
    items: Array.isArray(items) ? items as KioskPaymentItem[] : [],
    amount_cents: Number(r.amount_cents),
    attempts: Number(r.attempts ?? 0),
  };
}

/** Validates the scanned sample ids: positive integers, unique, bounded. */
export function validateSampleIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new KioskPaymentError(
      "validation",
      "sampleIds must be a non-empty array",
    );
  }
  if (value.length > KIOSK_MAX_ITEMS) {
    throw new KioskPaymentError(
      "validation",
      `at most ${KIOSK_MAX_ITEMS} items per checkout`,
    );
  }
  const ids = value.map((v) => Number(v));
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new KioskPaymentError(
      "validation",
      "sampleIds must be positive integers",
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new KioskPaymentError("validation", "each sample can be bought once");
  }
  return ids;
}

/** Price in cents for a sample row, or null when it has no usable price. */
export function samplePriceCents(currentPrice: unknown): number | null {
  if (
    currentPrice === null || currentPrice === undefined || currentPrice === ""
  ) {
    return null;
  }
  const n = Number(currentPrice);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

async function rollback(client: SqlClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => {});
}

/** Lock the samples, check them, reserve them and store the quote. */
export async function createKioskQuote(
  client: SqlClient,
  input: CreateKioskQuoteInput,
): Promise<KioskPayment> {
  const ids = validateSampleIds(input.sampleIds);
  await client.query("BEGIN");
  try {
    const found = await client.query(
      `select id, name, brand, status, current_price from public.samples
        where id = any($1::int[]) order by id for update`,
      [ids],
    );
    const byId = new Map(found.rows.map((r) => [Number(r.id), r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new KioskPaymentError("not_found", "some items were not found", {
        missing,
      });
    }
    const unavailable: number[] = [];
    const unpriced: number[] = [];
    const items: KioskPaymentItem[] = ids.map((id) => {
      const row = byId.get(id) as Row;
      const status = String(row.status ?? "available");
      if (!input.sellableStatuses.includes(status)) unavailable.push(id);
      const cents = samplePriceCents(row.current_price);
      if (cents === null && input.defaultPriceCents === null) unpriced.push(id);
      return {
        sample_id: id,
        name: row.name == null ? null : String(row.name),
        brand: row.brand == null ? null : String(row.brand),
        price_cents: cents ?? input.defaultPriceCents ?? 0,
        priced: cents !== null,
        prior_status: status,
      };
    });
    if (unavailable.length > 0) {
      throw new KioskPaymentError("conflict", "some items are not for sale", {
        unavailable,
      });
    }
    if (unpriced.length > 0) {
      throw new KioskPaymentError("conflict", "some items have no price", {
        unpriced,
      });
    }
    const amount = items.reduce((sum, item) => sum + item.price_cents, 0);
    if (!(amount > 0)) {
      throw new KioskPaymentError("conflict", "the total must be more than $0");
    }
    await client.query(
      `update public.samples set status = 'reserved' where id = any($1::int[])`,
      [ids],
    );
    const payUrl = input.payUrlFor ? input.payUrlFor(amount) : null;
    const inserted = await client.query(
      `insert into public.kiosk_payments
         (id, kiosk_id, method, status, items, amount_cents, pay_url, expires_at)
       values ($1, $2, $3, 'pending', $4::jsonb, $5, $6,
               now() + make_interval(secs => $7))
       returning *`,
      [
        input.id,
        input.kioskId ?? null,
        input.method,
        JSON.stringify(items),
        amount,
        payUrl,
        Math.max(30, Math.floor(input.ttlSeconds)),
      ],
    );
    await client.query("COMMIT");
    return toPayment(inserted.rows[0]);
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

export async function getKioskPayment(
  client: SqlClient,
  id: string,
): Promise<KioskPayment | null> {
  const r = await client.query(
    `select * from public.kiosk_payments where id = $1`,
    [id],
  );
  return r.rows[0] ? toPayment(r.rows[0]) : null;
}

export async function listKioskPayments(
  client: SqlClient,
  statuses: KioskPaymentStatus[],
  limit = 50,
): Promise<KioskPayment[]> {
  const r = await client.query(
    `select * from public.kiosk_payments where status = any($1::text[])
      order by created_at desc limit $2`,
    [statuses, Math.min(Math.max(1, Math.floor(limit)), 200)],
  );
  return r.rows.map(toPayment);
}

async function lockPayment(
  client: SqlClient,
  id: string,
): Promise<KioskPayment> {
  const r = await client.query(
    `select * from public.kiosk_payments where id = $1 for update`,
    [id],
  );
  if (!r.rows[0]) {
    throw new KioskPaymentError("not_found", "checkout not found");
  }
  return toPayment(r.rows[0]);
}

/**
 * Release a quote's samples back to their prior status and close it.
 * Idempotent: a quote not in one of `from` is returned unchanged.
 */
export async function releaseKioskQuote(
  client: SqlClient,
  id: string,
  to: "cancelled" | "expired" | "rejected",
  from: KioskPaymentStatus[] = ["pending"],
  operator?: string | null,
): Promise<KioskPayment> {
  await client.query("BEGIN");
  try {
    const payment = await lockPayment(client, id);
    if (!from.includes(payment.status)) {
      await client.query("COMMIT");
      return payment;
    }
    await client.query(
      `update public.samples s set status = i.prior_status
         from jsonb_to_recordset($1::jsonb) as i(sample_id int, prior_status text)
        where s.id = i.sample_id and s.status = 'reserved'`,
      [JSON.stringify(payment.items)],
    );
    const r = await client.query(
      `update public.kiosk_payments
          set status = $2, confirmed_by = coalesce($3, confirmed_by),
              updated_at = now()
        where id = $1 returning *`,
      [id, to, operator ?? null],
    );
    await client.query("COMMIT");
    return toPayment(r.rows[0]);
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

/** Expire every pending quote past its expires_at. Returns how many. */
export async function releaseExpiredKioskQuotes(
  client: SqlClient,
): Promise<number> {
  const r = await client.query(
    `select id from public.kiosk_payments
      where status = 'pending' and expires_at <= now()
      order by created_at limit 100`,
  );
  let count = 0;
  for (const row of r.rows) {
    const released = await releaseKioskQuote(client, String(row.id), "expired");
    if (released.status === "expired") count++;
  }
  return count;
}

function conflictFor(payment: KioskPayment | null): KioskPaymentError {
  if (!payment) return new KioskPaymentError("not_found", "checkout not found");
  if (payment.status === "pending") {
    return new KioskPaymentError("conflict", "this checkout has expired", {
      status: "expired",
    });
  }
  return new KioskPaymentError(
    "conflict",
    `this checkout is already ${payment.status}`,
    { status: payment.status },
  );
}

/**
 * Atomically move a live square quote from pending to charging, stamping a
 * fresh idempotency key. Only one caller can win, so a token is never
 * charged twice for the same quote.
 */
export async function beginKioskCharge(
  client: SqlClient,
  id: string,
  idempotencyKey: string,
): Promise<KioskPayment> {
  const r = await client.query(
    `update public.kiosk_payments
        set status = 'charging', attempts = attempts + 1,
            idempotency_key = $2, last_error = null, updated_at = now()
      where id = $1 and method = 'square' and status = 'pending'
        and expires_at > now()
      returning *`,
    [id, idempotencyKey],
  );
  if (r.rows[0]) return toPayment(r.rows[0]);
  const current = await getKioskPayment(client, id);
  if (current && current.method !== "square") {
    throw new KioskPaymentError(
      "conflict",
      "this checkout is not a Square payment",
    );
  }
  throw conflictFor(current);
}

/** A declined charge: back to pending so the customer can try again. */
export async function resetKioskCharge(
  client: SqlClient,
  id: string,
  error: string,
): Promise<KioskPayment | null> {
  const r = await client.query(
    `update public.kiosk_payments
        set status = 'pending', last_error = $2, updated_at = now()
      where id = $1 and status = 'charging' returning *`,
    [id, error.slice(0, 500)],
  );
  return r.rows[0] ? toPayment(r.rows[0]) : null;
}

/** Outcome unknown (network error mid-charge): keep the samples reserved
 * and leave it for staff to check in the Square Dashboard. */
export async function markKioskPaymentError(
  client: SqlClient,
  id: string,
  error: string,
): Promise<KioskPayment | null> {
  const r = await client.query(
    `update public.kiosk_payments
        set status = 'error', last_error = $2, updated_at = now()
      where id = $1 returning *`,
    [id, error.slice(0, 500)],
  );
  return r.rows[0] ? toPayment(r.rows[0]) : null;
}

/** Customer tapped "I've paid" on a cash.app link quote. */
export async function claimKioskPayment(
  client: SqlClient,
  id: string,
): Promise<KioskPayment> {
  const r = await client.query(
    `update public.kiosk_payments
        set status = 'claimed', claimed_at = now(), updated_at = now()
      where id = $1 and method = 'cashapp_link' and status = 'pending'
      returning *`,
    [id],
  );
  if (r.rows[0]) return toPayment(r.rows[0]);
  const current = await getKioskPayment(client, id);
  if (current?.status === "claimed") return current; // double tap
  if (current && current.method !== "cashapp_link") {
    throw new KioskPaymentError(
      "conflict",
      "this checkout is not a Cash App link payment",
    );
  }
  // A claim is accepted even just past expiry: the customer may have paid
  // while the countdown ran out, and staff still check Cash App.
  if (current?.status === "expired") {
    throw new KioskPaymentError(
      "conflict",
      "this checkout expired; please ask staff for help",
      { status: "expired" },
    );
  }
  throw conflictFor(current);
}

export type CompleteKioskPaymentInput = {
  /** Statuses this completion may start from. */
  from: KioskPaymentStatus[];
  providerPaymentId?: string | null;
  receiptUrl?: string | null;
  receiptNumber?: string | null;
  operator?: string | null;
};

/**
 * Mark the quote paid and every sample sold, with one `sold` transaction per
 * sample, all-or-nothing. Replays (already paid) return the stored row.
 */
export async function completeKioskPayment(
  client: SqlClient,
  id: string,
  input: CompleteKioskPaymentInput,
): Promise<{ payment: KioskPayment; replayed: boolean }> {
  await client.query("BEGIN");
  try {
    const payment = await lockPayment(client, id);
    if (payment.status === "paid") {
      await client.query("COMMIT");
      return { payment, replayed: true };
    }
    if (!input.from.includes(payment.status)) {
      throw new KioskPaymentError(
        "conflict",
        `this checkout is ${payment.status}`,
        { status: payment.status },
      );
    }
    const via = payment.method === "square"
      ? "Cash App Pay (Square)"
      : "Cash App link";
    for (const item of payment.items) {
      const dollars = item.price_cents / 100;
      await client.query(
        `update public.samples
            set status = 'sold', sold_price = $2, sold_at = now(), sold_to = $3
          where id = $1`,
        [item.sample_id, dollars, "kiosk"],
      );
      await client.query(
        `insert into public.transactions
           (action, sample_id, operator, checked_out_to, notes)
         values ('sold', $1, $2, 'kiosk', $3)`,
        [
          item.sample_id,
          input.operator ?? payment.kiosk_id ?? "kiosk",
          `Kiosk sale via ${via} | $${
            dollars.toFixed(2)
          } | checkout ${payment.id}${
            input.providerPaymentId
              ? ` | payment ${input.providerPaymentId}`
              : ""
          }`,
        ],
      );
    }
    const r = await client.query(
      `update public.kiosk_payments
          set status = 'paid', paid_at = now(), updated_at = now(),
              provider_payment_id = coalesce($2, provider_payment_id),
              receipt_url = coalesce($3, receipt_url),
              receipt_number = coalesce($4, receipt_number),
              confirmed_by = coalesce($5, confirmed_by),
              last_error = null
        where id = $1 returning *`,
      [
        id,
        input.providerPaymentId ?? null,
        input.receiptUrl ?? null,
        input.receiptNumber ?? null,
        input.operator ?? null,
      ],
    );
    await client.query("COMMIT");
    return { payment: toPayment(r.rows[0]), replayed: false };
  } catch (error) {
    await rollback(client);
    throw error;
  }
}
