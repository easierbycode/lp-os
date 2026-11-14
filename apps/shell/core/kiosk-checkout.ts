// kiosk-checkout.ts — the self-serve kiosk's checkout logic (/kiosk/self),
// kept free of HTTP and pg so it tests against in-memory fakes.
//
// Two ways to pay, both Cash App:
//   cashapp_link (default)  the kiosk shows a QR (or an NFC tag holds) the
//       plain https://cash.app/$cashtag/<total> link. Nothing tells LP-OS the
//       money arrived, so the customer taps "I've paid" (claimed) and staff
//       confirm or reject it against Cash App at /kiosk/payments.
//   square                  Square Web Payments SDK Cash App Pay. The SDK
//       hands the kiosk a token; pay() charges it server-side with
//       CreatePayment and marks the items sold the moment Square says
//       COMPLETED. Only offered when SQUARE_* env is set.
//
// Prices always come from the database at quote time; the browser only ever
// sends sample ids.

import type {
  CompleteKioskPaymentInput,
  CreateKioskQuoteInput,
  KioskPayment,
  KioskPaymentMethod,
  KioskPaymentStatus,
} from "@lp-os/db";
import {
  type CreatePaymentInput,
  type CreatePaymentResult,
  type SquareConfig,
  squarePublicConfig,
  SquareUnavailableError,
} from "./square.ts";

/** Daniel's cash.app link: the kiosk's default way to pay. The trailing
 * amount is the price used for any item that has no current_price. */
export const DEFAULT_CASHAPP_URL = "https://cash.app/$danieljohnsonaz/5.00";

export const DEFAULT_SELLABLE_STATUSES = ["available", "cleared_to_sell"];
export const DEFAULT_QUOTE_TTL_SECONDS = 300;

export type CashAppLinkConfig = {
  cashtag: string;
  defaultAmountCents: number | null;
};

const CASHAPP_URL_RE =
  /^https:\/\/cash\.app\/\$([A-Za-z][A-Za-z0-9_-]{0,19})(?:\/(\d{1,6}(?:\.\d{1,2})?))?\/?$/;

/** Parses https://cash.app/$cashtag[/amount]; null when malformed. */
export function parseCashAppUrl(url: string): CashAppLinkConfig | null {
  const m = CASHAPP_URL_RE.exec(url.trim());
  if (!m) return null;
  const amount = m[2] ? Math.round(Number(m[2]) * 100) : null;
  return {
    cashtag: m[1],
    defaultAmountCents: amount !== null && amount > 0 ? amount : null,
  };
}

export function centsToAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function cashAppPayUrl(cfg: CashAppLinkConfig, cents: number): string {
  return `https://cash.app/$${cfg.cashtag}/${centsToAmount(cents)}`;
}

/** Storage the checkout needs (packages/db KioskPayments + code lookup). */
export interface KioskStore {
  lookupByCode(code: string): Promise<{ samples: Record<string, unknown>[] }>;
  createQuote(input: CreateKioskQuoteInput): Promise<KioskPayment>;
  get(id: string): Promise<KioskPayment | null>;
  list(statuses: KioskPaymentStatus[], limit?: number): Promise<KioskPayment[]>;
  release(
    id: string,
    to: "cancelled" | "expired" | "rejected",
    from?: KioskPaymentStatus[],
    operator?: string | null,
  ): Promise<KioskPayment>;
  releaseExpired(): Promise<number>;
  beginCharge(id: string, idempotencyKey: string): Promise<KioskPayment>;
  resetCharge(id: string, error: string): Promise<KioskPayment | null>;
  markError(id: string, error: string): Promise<KioskPayment | null>;
  claim(id: string): Promise<KioskPayment>;
  complete(
    id: string,
    input: CompleteKioskPaymentInput,
  ): Promise<{ payment: KioskPayment; replayed: boolean }>;
}

export type KioskCheckoutDeps = {
  /** null when DATABASE_URL is unset: config still answers, nothing sells. */
  store: KioskStore | null;
  cashApp: CashAppLinkConfig | null;
  square: SquareConfig | null;
  createPayment?: (
    cfg: SquareConfig,
    input: CreatePaymentInput,
  ) => Promise<CreatePaymentResult>;
  /** Best-effort revenue attribution after a sale (lifecycle graylogOnly). */
  attributeSale?: (payment: KioskPayment) => Promise<void>;
  isKioskDisabled?: (kioskId: string) => boolean;
  sellableStatuses?: string[];
  ttlSeconds?: number;
  log?: (message: string) => void;
};

export class KioskCheckoutError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "KioskCheckoutError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(id: string): string {
  if (!UUID_RE.test(id)) {
    throw new KioskCheckoutError(400, "bad_id", "invalid checkout id");
  }
  return id.toLowerCase();
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  return text.slice(0, max);
}

/** Maps KioskPaymentError (by kind) and anything else to a KioskCheckoutError. */
function translate(error: unknown): never {
  if (error instanceof KioskCheckoutError) throw error;
  const kind = (error as { kind?: string })?.kind;
  const message = error instanceof Error ? error.message : String(error);
  const details = (error as { details?: unknown })?.details;
  if (kind === "validation") {
    throw new KioskCheckoutError(400, "invalid", message, details);
  }
  if (kind === "not_found") {
    throw new KioskCheckoutError(404, "not_found", message, details);
  }
  if (kind === "conflict") {
    throw new KioskCheckoutError(409, "conflict", message, details);
  }
  throw error;
}

export type PublicQuote = {
  id: string;
  kioskId: string | null;
  method: KioskPaymentMethod;
  status: KioskPaymentStatus;
  amountCents: number;
  amount: string;
  items: {
    sampleId: number;
    name: string | null;
    brand: string | null;
    priceCents: number;
    priced: boolean;
  }[];
  payUrl: string | null;
  expiresAt: string;
  claimedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  receiptNumber: string | null;
  receiptUrl: string | null;
  providerPaymentId: string | null;
  confirmedBy: string | null;
  lastError: string | null;
};

export function publicQuote(p: KioskPayment): PublicQuote {
  return {
    id: p.id,
    kioskId: p.kiosk_id,
    method: p.method,
    status: p.status,
    amountCents: p.amount_cents,
    amount: centsToAmount(p.amount_cents),
    items: p.items.map((i) => ({
      sampleId: i.sample_id,
      name: i.name,
      brand: i.brand,
      priceCents: i.price_cents,
      priced: i.priced,
    })),
    payUrl: p.pay_url,
    expiresAt: p.expires_at,
    claimedAt: p.claimed_at,
    paidAt: p.paid_at,
    createdAt: p.created_at,
    receiptNumber: p.receipt_number,
    receiptUrl: p.receipt_url,
    providerPaymentId: p.provider_payment_id,
    confirmedBy: p.confirmed_by,
    lastError: p.last_error,
  };
}

function priceCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

export function createKioskCheckout(deps: KioskCheckoutDeps) {
  const sellable = deps.sellableStatuses?.length
    ? deps.sellableStatuses
    : DEFAULT_SELLABLE_STATUSES;
  const ttlSeconds = deps.ttlSeconds && deps.ttlSeconds >= 30
    ? Math.floor(deps.ttlSeconds)
    : DEFAULT_QUOTE_TTL_SECONDS;
  const defaultPriceCents = deps.cashApp?.defaultAmountCents ?? null;
  const log = deps.log ??
    ((message: string) => console.warn(`[kiosk] ${message}`));
  const methods: KioskPaymentMethod[] = [
    ...(deps.cashApp ? ["cashapp_link" as const] : []),
    ...(deps.square && deps.createPayment ? ["square" as const] : []),
  ];

  function store(): KioskStore {
    if (!deps.store) {
      throw new KioskCheckoutError(503, "no_db", "DATABASE_URL not configured");
    }
    return deps.store;
  }

  async function attribute(payment: KioskPayment): Promise<void> {
    if (!deps.attributeSale) return;
    try {
      await deps.attributeSale(payment);
    } catch (error) {
      log(
        `revenue attribution for checkout ${payment.id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function releaseExpired(): Promise<void> {
    try {
      await store().releaseExpired();
    } catch (error) {
      if (error instanceof KioskCheckoutError) throw error;
      log(`expiring old checkouts failed: ${String(error)}`);
    }
  }

  return {
    methods,

    config() {
      return {
        ready: Boolean(deps.store) && methods.length > 0,
        defaultMethod: methods[0] ?? null,
        methods,
        cashApp: deps.cashApp
          ? {
            cashtag: deps.cashApp.cashtag,
            defaultAmount: defaultPriceCents === null
              ? null
              : centsToAmount(defaultPriceCents),
          }
          : null,
        square: deps.square && methods.includes("square")
          ? squarePublicConfig(deps.square)
          : null,
        ttlSeconds,
      };
    },

    async lookup(rawCode: unknown) {
      const code = cleanText(rawCode, 128);
      if (!code) throw new KioskCheckoutError(400, "invalid", "code required");
      const { samples } = await store().lookupByCode(code);
      const items = samples.map((s) => {
        const cents = priceCents(s.current_price);
        const status = String(s.status ?? "available");
        return {
          id: Number(s.id),
          name: s.name == null ? null : String(s.name),
          brand: s.brand == null ? null : String(s.brand),
          priceCents: cents ?? defaultPriceCents,
          priced: cents !== null,
          sellable: sellable.includes(status) &&
            (cents !== null || defaultPriceCents !== null),
          // null → the page resolves it via GET /api/samples/:id/image (JSON).
          imageUrl: s.picture_url ? String(s.picture_url) : null,
        };
      });
      return { code, items };
    },

    async createQuote(body: Record<string, unknown>): Promise<PublicQuote> {
      const method = (body.method ?? methods[0]) as KioskPaymentMethod;
      if (!methods.includes(method)) {
        throw new KioskCheckoutError(
          400,
          "method_unavailable",
          methods.length
            ? `payment method ${String(method)} is not set up`
            : "no payment method is set up",
        );
      }
      const kioskId = cleanText(body.kioskId, 64);
      if (kioskId && deps.isKioskDisabled?.(kioskId)) {
        throw new KioskCheckoutError(
          423,
          "kiosk_disabled",
          "this kiosk is closed",
        );
      }
      const s = store();
      await releaseExpired();
      try {
        const cashApp = deps.cashApp;
        const quote = await s.createQuote({
          id: crypto.randomUUID(),
          kioskId,
          method,
          sampleIds: body.sampleIds as number[],
          sellableStatuses: sellable,
          defaultPriceCents,
          ttlSeconds,
          payUrlFor: method === "cashapp_link" && cashApp
            ? (cents) => cashAppPayUrl(cashApp, cents)
            : undefined,
        });
        return publicQuote(quote);
      } catch (error) {
        translate(error);
      }
    },

    async get(id: string): Promise<PublicQuote> {
      const quote = await store().get(requireId(id));
      if (!quote) {
        throw new KioskCheckoutError(404, "not_found", "checkout not found");
      }
      return publicQuote(quote);
    },

    async cancel(id: string): Promise<PublicQuote> {
      try {
        return publicQuote(
          await store().release(requireId(id), "cancelled", ["pending"]),
        );
      } catch (error) {
        translate(error);
      }
    },

    /** Customer says they paid the cash.app link. */
    async claim(id: string): Promise<PublicQuote> {
      try {
        return publicQuote(await store().claim(requireId(id)));
      } catch (error) {
        translate(error);
      }
    },

    /** Charge a Square Cash App Pay token for a square quote. */
    async pay(id: string, body: Record<string, unknown>): Promise<PublicQuote> {
      const quoteId = requireId(id);
      const token = cleanText(body.token, 512);
      if (!token || /\s/.test(token)) {
        throw new KioskCheckoutError(400, "invalid", "payment token required");
      }
      if (!deps.square || !deps.createPayment) {
        throw new KioskCheckoutError(
          400,
          "method_unavailable",
          "Square is not set up",
        );
      }
      const s = store();
      await releaseExpired();
      const key = crypto.randomUUID();
      let charging: KioskPayment;
      try {
        charging = await s.beginCharge(quoteId, key);
      } catch (error) {
        translate(error);
      }

      let result: CreatePaymentResult;
      try {
        result = await deps.createPayment(deps.square, {
          sourceId: token,
          idempotencyKey: key,
          amountCents: charging.amount_cents,
          referenceId: charging.id,
          note: `LP-OS kiosk${
            charging.kiosk_id ? ` ${charging.kiosk_id}` : ""
          }: ${
            charging.items.map((i) => i.name || `sample ${i.sample_id}`).join(
              ", ",
            )
          }`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await s.markError(quoteId, `charge outcome unknown: ${message}`).catch(
          () => {},
        );
        log(`checkout ${quoteId}: ${message}`);
        throw new KioskCheckoutError(
          502,
          error instanceof SquareUnavailableError
            ? "payment_unknown"
            : "payment_error",
          "We couldn't confirm the payment. Please ask staff for help.",
        );
      }

      if (!result.ok) {
        await s.resetCharge(quoteId, `${result.code}: ${result.message}`);
        throw new KioskCheckoutError(
          402,
          "declined",
          "The payment didn't go through. Please try again.",
          {
            code: result.code,
          },
        );
      }

      try {
        const done = await s.complete(quoteId, {
          from: ["charging"],
          providerPaymentId: result.paymentId,
          receiptUrl: result.receiptUrl,
          receiptNumber: result.receiptNumber,
        });
        if (!done.replayed) await attribute(done.payment);
        return publicQuote(done.payment);
      } catch (error) {
        // Charged but not recorded: keep it visible for staff, never retry.
        const message = error instanceof Error ? error.message : String(error);
        await s.markError(
          quoteId,
          `charged (Square payment ${result.paymentId}) but recording the sale failed: ${message}`,
        ).catch(() => {});
        log(
          `checkout ${quoteId} charged ${result.paymentId} but not recorded: ${message}`,
        );
        throw new KioskCheckoutError(
          500,
          "record_failed",
          "Your payment went through, but the kiosk couldn't finish. Please ask staff for help.",
        );
      }
    },

    /* ----------------------------------------------------------- staff -- */

    async list(statusParam: unknown): Promise<PublicQuote[]> {
      const all: KioskPaymentStatus[] = [
        "pending",
        "charging",
        "claimed",
        "paid",
        "cancelled",
        "expired",
        "rejected",
        "error",
      ];
      const wanted = typeof statusParam === "string" && statusParam.trim()
        ? statusParam.split(",").map((v) => v.trim()).filter((
          v,
        ): v is KioskPaymentStatus => (all as string[]).includes(v))
        : (["claimed", "error"] as KioskPaymentStatus[]);
      if (wanted.length === 0) {
        throw new KioskCheckoutError(400, "invalid", "unknown status filter");
      }
      await releaseExpired();
      return (await store().list(wanted, 100)).map(publicQuote);
    },

    /** Staff checked Cash App (or the Square Dashboard): the money is there. */
    async confirm(
      id: string,
      body: Record<string, unknown>,
    ): Promise<PublicQuote> {
      const operator = cleanText(body.operator, 64) ?? "staff";
      try {
        const done = await store().complete(requireId(id), {
          from: ["claimed", "pending", "error"],
          operator,
        });
        if (!done.replayed) await attribute(done.payment);
        return publicQuote(done.payment);
      } catch (error) {
        translate(error);
      }
    },

    /** Staff found no payment: release the items. */
    async reject(
      id: string,
      body: Record<string, unknown>,
    ): Promise<PublicQuote> {
      const operator = cleanText(body.operator, 64) ?? "staff";
      try {
        const released = await store().release(
          requireId(id),
          "rejected",
          ["claimed", "pending", "error"],
          operator,
        );
        return publicQuote(released);
      } catch (error) {
        translate(error);
      }
    },
  };
}

export type KioskCheckout = ReturnType<typeof createKioskCheckout>;
