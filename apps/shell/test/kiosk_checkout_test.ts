// Self-serve kiosk checkout (core/kiosk-checkout.ts + core/square.ts).
// The store is an in-memory fake of packages/db KioskPayments with the same
// status machine; the real SQL is covered by
// packages/db/test/kiosk_payments_integration_test.ts. Square is a fake
// fetch, so nothing here touches the network or charges anything.

import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  CompleteKioskPaymentInput,
  CreateKioskQuoteInput,
  KioskPayment,
  KioskPaymentStatus,
} from "@lp-os/db";
import {
  cashAppPayUrl,
  createKioskCheckout,
  DEFAULT_CASHAPP_URL,
  KioskCheckoutError,
  type KioskStore,
  parseCashAppUrl,
} from "../core/kiosk-checkout.ts";
import {
  createSquarePayment,
  type SquareConfig,
  squareConfigFromEnv,
  SquareUnavailableError,
} from "../core/square.ts";

type Sample = {
  id: number;
  name: string;
  status: string;
  current_price: number | null;
  qr_code: string;
};

class FakeStore implements KioskStore {
  samples = new Map<number, Sample>();
  payments = new Map<string, KioskPayment>();
  sold: number[] = [];

  constructor(samples: Sample[]) {
    for (const s of samples) this.samples.set(s.id, { ...s });
  }

  lookupByCode(code: string) {
    return Promise.resolve({
      samples: [...this.samples.values()].filter((s) => s.qr_code === code),
    });
  }

  createQuote(input: CreateKioskQuoteInput): Promise<KioskPayment> {
    const items = input.sampleIds.map((id) => {
      const s = this.samples.get(id);
      if (!s) {
        throw Object.assign(new Error("not found"), { kind: "not_found" });
      }
      if (!input.sellableStatuses.includes(s.status)) {
        throw Object.assign(new Error("some items are not for sale"), {
          kind: "conflict",
          details: { unavailable: [id] },
        });
      }
      const cents = s.current_price ? Math.round(s.current_price * 100) : null;
      return {
        sample_id: id,
        name: s.name,
        brand: null,
        price_cents: cents ?? input.defaultPriceCents ?? 0,
        priced: cents !== null,
        prior_status: s.status,
      };
    });
    for (const i of items) this.samples.get(i.sample_id)!.status = "reserved";
    const amount = items.reduce((n, i) => n + i.price_cents, 0);
    const now = new Date();
    const p: KioskPayment = {
      id: input.id,
      kiosk_id: input.kioskId ?? null,
      method: input.method,
      status: "pending",
      items,
      amount_cents: amount,
      currency: "USD",
      pay_url: input.payUrlFor ? input.payUrlFor(amount) : null,
      idempotency_key: null,
      attempts: 0,
      provider_payment_id: null,
      receipt_url: null,
      receipt_number: null,
      confirmed_by: null,
      last_error: null,
      expires_at: new Date(now.getTime() + input.ttlSeconds * 1000)
        .toISOString(),
      claimed_at: null,
      paid_at: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.payments.set(p.id, p);
    return Promise.resolve({ ...p });
  }

  get(id: string) {
    const p = this.payments.get(id);
    return Promise.resolve(p ? { ...p } : null);
  }

  list(statuses: KioskPaymentStatus[]) {
    return Promise.resolve(
      [...this.payments.values()].filter((p) => statuses.includes(p.status)),
    );
  }

  private must(id: string): KioskPayment {
    const p = this.payments.get(id);
    if (!p) {
      throw Object.assign(new Error("checkout not found"), {
        kind: "not_found",
      });
    }
    return p;
  }

  release(
    id: string,
    to: "cancelled" | "expired" | "rejected",
    from: KioskPaymentStatus[] = ["pending"],
    operator?: string | null,
  ) {
    const p = this.must(id);
    if (from.includes(p.status)) {
      for (const i of p.items) {
        const s = this.samples.get(i.sample_id)!;
        if (s.status === "reserved") s.status = i.prior_status;
      }
      p.status = to;
      if (operator) p.confirmed_by = operator;
    }
    return Promise.resolve({ ...p });
  }

  releaseExpired() {
    return Promise.resolve(0);
  }

  beginCharge(id: string, key: string) {
    const p = this.must(id);
    if (p.method !== "square" || p.status !== "pending") {
      throw Object.assign(new Error(`this checkout is already ${p.status}`), {
        kind: "conflict",
      });
    }
    p.status = "charging";
    p.attempts++;
    p.idempotency_key = key;
    return Promise.resolve({ ...p });
  }

  resetCharge(id: string, error: string) {
    const p = this.must(id);
    if (p.status === "charging") {
      p.status = "pending";
      p.last_error = error;
    }
    return Promise.resolve({ ...p });
  }

  markError(id: string, error: string) {
    const p = this.must(id);
    p.status = "error";
    p.last_error = error;
    return Promise.resolve({ ...p });
  }

  claim(id: string) {
    const p = this.must(id);
    if (p.method !== "cashapp_link") {
      throw Object.assign(new Error("not a link payment"), {
        kind: "conflict",
      });
    }
    if (p.status === "pending") p.status = "claimed";
    return Promise.resolve({ ...p });
  }

  complete(id: string, input: CompleteKioskPaymentInput) {
    const p = this.must(id);
    if (p.status === "paid") {
      return Promise.resolve({ payment: { ...p }, replayed: true });
    }
    if (!input.from.includes(p.status)) {
      throw Object.assign(new Error(`this checkout is ${p.status}`), {
        kind: "conflict",
      });
    }
    for (const i of p.items) {
      this.samples.get(i.sample_id)!.status = "sold";
      this.sold.push(i.sample_id);
    }
    p.status = "paid";
    p.provider_payment_id = input.providerPaymentId ?? null;
    p.receipt_number = input.receiptNumber ?? null;
    p.confirmed_by = input.operator ?? null;
    return Promise.resolve({ payment: { ...p }, replayed: false });
  }
}

const SQUARE: SquareConfig = {
  environment: "sandbox",
  applicationId: "sandbox-sq0idb-test",
  locationId: "LTEST",
  accessToken: "EAAA-test",
};

function samples(): Sample[] {
  return [
    {
      id: 1,
      name: "Lip gloss",
      status: "available",
      current_price: 12.5,
      qr_code: "A1",
    },
    {
      id: 2,
      name: "Mystery box",
      status: "cleared_to_sell",
      current_price: null,
      qr_code: "B2",
    },
    {
      id: 3,
      name: "Creator loaner",
      status: "checked_out",
      current_price: 9,
      qr_code: "C3",
    },
  ];
}

function setup(opts: {
  square?: boolean;
  createPayment?: Parameters<typeof createKioskCheckout>[0]["createPayment"];
  disabled?: string[];
} = {}) {
  const store = new FakeStore(samples());
  const attributed: string[] = [];
  const checkout = createKioskCheckout({
    store,
    cashApp: parseCashAppUrl(DEFAULT_CASHAPP_URL),
    square: opts.square ? SQUARE : null,
    createPayment: opts.createPayment,
    attributeSale: (p) => {
      attributed.push(p.id);
      return Promise.resolve();
    },
    isKioskDisabled: (id) => (opts.disabled ?? []).includes(id),
    log: () => {},
  });
  return { store, checkout, attributed };
}

Deno.test("cash.app link: default is Daniel's link with a $5.00 default price", () => {
  const cfg = parseCashAppUrl(DEFAULT_CASHAPP_URL);
  assertEquals(cfg, { cashtag: "danieljohnsonaz", defaultAmountCents: 500 });
  assertEquals(
    cashAppPayUrl(cfg!, 1750),
    "https://cash.app/$danieljohnsonaz/17.50",
  );
  assertEquals(parseCashAppUrl("https://cash.app/$shop"), {
    cashtag: "shop",
    defaultAmountCents: null,
  });
  assertEquals(parseCashAppUrl("http://cash.app/$shop/5"), null);
  assertEquals(parseCashAppUrl("https://evil.example/$shop/5"), null);
  assertEquals(parseCashAppUrl("https://cash.app/$shop/5/../x"), null);
});

Deno.test("config: link is the default method; Square only when configured", () => {
  const plain = setup().checkout.config();
  assertEquals(plain.ready, true);
  assertEquals(plain.defaultMethod, "cashapp_link");
  assertEquals(plain.methods, ["cashapp_link"]);
  assertEquals(plain.cashApp, {
    cashtag: "danieljohnsonaz",
    defaultAmount: "5.00",
  });
  assertEquals(plain.square, null);

  const both = setup({ square: true, createPayment: () => Promise.reject() })
    .checkout
    .config();
  assertEquals(both.methods, ["cashapp_link", "square"]);
  assertEquals(both.defaultMethod, "cashapp_link");
  assertEquals(
    both.square?.sdkUrl,
    "https://sandbox.web.squarecdn.com/v1/square.js",
  );
  assert(
    !JSON.stringify(both).includes("EAAA-test"),
    "access token must not leak",
  );
});

Deno.test("lookup flags sellable items and applies the default price", async () => {
  const { checkout } = setup();
  const a = await checkout.lookup("A1");
  assertEquals(a.items[0].priceCents, 1250);
  assertEquals(a.items[0].sellable, true);
  const b = await checkout.lookup("B2");
  assertEquals(b.items[0].priceCents, 500);
  assertEquals(b.items[0].priced, false);
  const c = await checkout.lookup("C3");
  assertEquals(c.items[0].sellable, false);
  await assertRejects(() => checkout.lookup(""), KioskCheckoutError);
});

Deno.test("link flow: quote → claim → staff confirm marks items sold", async () => {
  const { checkout, store, attributed } = setup();
  const quote = await checkout.createQuote({
    sampleIds: [1, 2],
    kioskId: "front",
  });
  assertEquals(quote.method, "cashapp_link");
  assertEquals(quote.amount, "17.50");
  assertEquals(quote.payUrl, "https://cash.app/$danieljohnsonaz/17.50");
  assertEquals(store.samples.get(1)!.status, "reserved");

  const claimed = await checkout.claim(quote.id);
  assertEquals(claimed.status, "claimed");
  assertEquals((await checkout.list(undefined)).map((q) => q.id), [quote.id]);

  const paid = await checkout.confirm(quote.id, { operator: "dj" });
  assertEquals(paid.status, "paid");
  assertEquals(paid.confirmedBy, "dj");
  assertEquals(store.sold, [1, 2]);
  assertEquals(attributed, [quote.id]);
  // A link quote can't be "paid" with a Square token.
  await assertRejects(
    () => checkout.pay(quote.id, { token: "wnon:cash-app-ok" }),
    KioskCheckoutError,
  );
});

Deno.test("link flow: staff reject puts items back on sale", async () => {
  const { checkout, store } = setup();
  const quote = await checkout.createQuote({ sampleIds: [2] });
  await checkout.claim(quote.id);
  const rejected = await checkout.reject(quote.id, {});
  assertEquals(rejected.status, "rejected");
  assertEquals(store.samples.get(2)!.status, "cleared_to_sell");
});

Deno.test("quote refuses items not for sale, bad ids and closed kiosks", async () => {
  const { checkout } = setup({ disabled: ["closed-kiosk"] });
  const notForSale = await assertRejects(
    () => checkout.createQuote({ sampleIds: [3] }),
    KioskCheckoutError,
  );
  assertEquals(notForSale.status, 409);
  assertEquals((notForSale.details as { unavailable: number[] }).unavailable, [
    3,
  ]);
  const closed = await assertRejects(
    () => checkout.createQuote({ sampleIds: [1], kioskId: "closed-kiosk" }),
    KioskCheckoutError,
  );
  assertEquals(closed.status, 423);
  const badMethod = await assertRejects(
    () => checkout.createQuote({ sampleIds: [1], method: "square" }),
    KioskCheckoutError,
  );
  assertEquals(badMethod.status, 400);
  await assertRejects(() => checkout.get("not-a-uuid"), KioskCheckoutError);
});

Deno.test("square flow: COMPLETED token marks items sold once", async () => {
  const calls: unknown[] = [];
  const { checkout, store } = setup({
    square: true,
    createPayment: (_cfg, input) => {
      calls.push(input);
      return Promise.resolve({
        ok: true,
        paymentId: "sq-1",
        status: "COMPLETED",
        receiptUrl: "https://squareup.com/receipt/preview/sq-1",
        receiptNumber: "SQ01",
      });
    },
  });
  const quote = await checkout.createQuote({
    sampleIds: [1],
    method: "square",
  });
  assertEquals(quote.payUrl, null);
  const paid = await checkout.pay(quote.id, { token: "wnon:cash-app-ok" });
  assertEquals(paid.status, "paid");
  assertEquals(paid.receiptNumber, "SQ01");
  assertEquals(store.samples.get(1)!.status, "sold");
  const call = calls[0] as {
    amountCents: number;
    referenceId: string;
    idempotencyKey: string;
  };
  assertEquals(call.amountCents, 1250);
  assertEquals(call.referenceId, quote.id);
  assert(call.idempotencyKey.length <= 45);
  // Second token for the same quote is refused, never charged.
  await assertRejects(
    () => checkout.pay(quote.id, { token: "wnon:cash-app-ok" }),
    KioskCheckoutError,
  );
  assertEquals(calls.length, 1);
});

Deno.test("square flow: decline returns 402 and the customer can retry", async () => {
  let attempt = 0;
  const { checkout, store } = setup({
    square: true,
    createPayment: () => {
      attempt++;
      return Promise.resolve(
        attempt === 1
          ? { ok: false as const, code: "GENERIC_DECLINE", message: "declined" }
          : {
            ok: true as const,
            paymentId: "sq-2",
            status: "COMPLETED",
            receiptUrl: null,
            receiptNumber: null,
          },
      );
    },
  });
  const quote = await checkout.createQuote({
    sampleIds: [1],
    method: "square",
  });
  const declined = await assertRejects(
    () => checkout.pay(quote.id, { token: "wnon:cash-app-declined" }),
    KioskCheckoutError,
  );
  assertEquals(declined.status, 402);
  assertEquals(store.payments.get(quote.id)!.status, "pending");
  assertEquals(store.samples.get(1)!.status, "reserved");
  const paid = await checkout.pay(quote.id, { token: "wnon:cash-app-ok" });
  assertEquals(paid.status, "paid");
});

Deno.test("square flow: unknown outcome keeps items reserved for staff", async () => {
  const { checkout, store } = setup({
    square: true,
    createPayment: () => Promise.reject(new SquareUnavailableError("timeout")),
  });
  const quote = await checkout.createQuote({
    sampleIds: [1],
    method: "square",
  });
  const err = await assertRejects(
    () => checkout.pay(quote.id, { token: "wnon:cash-app-ok" }),
    KioskCheckoutError,
  );
  assertEquals(err.status, 502);
  assertEquals(store.payments.get(quote.id)!.status, "error");
  assertEquals(store.samples.get(1)!.status, "reserved");
  assertEquals((await checkout.list(undefined)).length, 1);
});

Deno.test("no database: config answers, checkout refuses with 503", async () => {
  const checkout = createKioskCheckout({
    store: null,
    cashApp: parseCashAppUrl(DEFAULT_CASHAPP_URL),
    square: null,
  });
  assertEquals(checkout.config().ready, false);
  const err = await assertRejects(
    () => checkout.lookup("A1"),
    KioskCheckoutError,
  );
  assertEquals(err.status, 503);
});

/* ------------------------------------------------------------- square.ts -- */

Deno.test("squareConfigFromEnv needs all three ids; defaults to sandbox", () => {
  const env = (vals: Record<string, string>) => (name: string) => vals[name];
  assertEquals(squareConfigFromEnv(env({ SQUARE_APPLICATION_ID: "a" })), null);
  const cfg = squareConfigFromEnv(env({
    SQUARE_APPLICATION_ID: "a",
    SQUARE_LOCATION_ID: "l",
    SQUARE_ACCESS_TOKEN: "t",
  }));
  assertEquals(cfg?.environment, "sandbox");
  assertEquals(
    squareConfigFromEnv(env({
      SQUARE_APPLICATION_ID: "a",
      SQUARE_LOCATION_ID: "l",
      SQUARE_ACCESS_TOKEN: "t",
      SQUARE_ENVIRONMENT: "production",
    }))?.environment,
    "production",
  );
});

function fakeFetch(status: number, body: unknown, seen: Request[] = []) {
  return (input: string, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

Deno.test("createSquarePayment posts CreatePayment and reads COMPLETED", async () => {
  const seen: Request[] = [];
  const result = await createSquarePayment(
    SQUARE,
    {
      sourceId: "wnon:cash-app-ok",
      idempotencyKey: "k1",
      amountCents: 500,
      referenceId: "r",
    },
    fakeFetch(200, {
      payment: {
        id: "p1",
        status: "COMPLETED",
        receipt_url: "https://squareup.com/receipt/preview/p1",
        receipt_number: "P1",
        wallet_details: { brand: "CASH_APP" },
      },
    }, seen),
  );
  assertEquals(result, {
    ok: true,
    paymentId: "p1",
    status: "COMPLETED",
    receiptUrl: "https://squareup.com/receipt/preview/p1",
    receiptNumber: "P1",
  });
  assertEquals(seen[0].url, "https://connect.squareupsandbox.com/v2/payments");
  assertEquals(seen[0].headers.get("authorization"), "Bearer EAAA-test");
  const body = await seen[0].json();
  assertEquals(body.amount_money, { amount: 500, currency: "USD" });
  assertEquals(body.source_id, "wnon:cash-app-ok");
  assertEquals(body.location_id, "LTEST");
  assertEquals(body.autocomplete, true);
});

Deno.test("createSquarePayment: 4xx is a definite decline, 5xx is unknown", async () => {
  const declined = await createSquarePayment(
    SQUARE,
    {
      sourceId: "wnon:cash-app-declined",
      idempotencyKey: "k2",
      amountCents: 500,
    },
    fakeFetch(400, {
      errors: [{ code: "GENERIC_DECLINE", detail: "Declined" }],
    }),
  );
  assertEquals(declined, {
    ok: false,
    code: "GENERIC_DECLINE",
    message: "Declined",
  });
  await assertRejects(
    () =>
      createSquarePayment(
        SQUARE,
        { sourceId: "x", idempotencyKey: "k3", amountCents: 500 },
        fakeFetch(503, {}),
      ),
    SquareUnavailableError,
  );
  await assertRejects(
    () =>
      createSquarePayment(
        SQUARE,
        { sourceId: "x", idempotencyKey: "k4", amountCents: 500 },
        () => Promise.reject(new TypeError("network down")),
      ),
    SquareUnavailableError,
  );
});
