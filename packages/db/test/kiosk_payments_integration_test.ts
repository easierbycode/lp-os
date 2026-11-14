// DATABASE_URL-gated integration test for the self-serve kiosk checkout
// (packages/db/kiosk-payments.ts). Skips cleanly when the env var is unset.
// It runs the real SQL: FOR UPDATE reservation, jsonb item restore, the
// pending → charging → paid / pending → claimed → paid|rejected machine, and
// one `sold` transaction per sample. Creates only its own marker rows and
// deletes them afterwards. kioskScenario is exported so the same checks can
// run against any SqlClient (e.g. an in-process Postgres) during development.
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { SqlClient } from "../inventory.ts";
import {
  beginKioskCharge,
  claimKioskPayment,
  completeKioskPayment,
  createKioskQuote,
  getKioskPayment,
  KioskPaymentError,
  releaseExpiredKioskQuotes,
  releaseKioskQuote,
  resetKioskCharge,
} from "../kiosk-payments.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const SELLABLE = ["available", "cleared_to_sell"];

async function sampleRow(client: SqlClient, id: number) {
  const r = await client.query(
    `select status, sold_price, sold_to from public.samples where id = $1`,
    [id],
  );
  return r.rows[0];
}

async function makeSample(
  client: SqlClient,
  marker: string,
  suffix: string,
  status: string,
  price: number | null,
): Promise<number> {
  const r = await client.query(
    `insert into public.samples (name, qr_code, status, current_price)
     values ($1, $2, $3, $4) returning id`,
    [`${marker}-${suffix}`, `${marker}-${suffix}-qr`, status, price],
  );
  return Number(r.rows[0].id);
}

export async function kioskScenario(client: SqlClient): Promise<void> {
  const marker = `lp-os-kiosk-test-${crypto.randomUUID()}`;
  const ids: number[] = [];
  const quotes: string[] = [];
  try {
    const a = await makeSample(client, marker, "a", "available", 12.5);
    const b = await makeSample(client, marker, "b", "cleared_to_sell", 7);
    const c = await makeSample(client, marker, "c", "available", null);
    const d = await makeSample(client, marker, "d", "checked_out", 3);
    ids.push(a, b, c, d);

    // Unpriced items take the default price; not-for-sale items refuse.
    await assertRejects(
      () =>
        createKioskQuote(client, {
          id: crypto.randomUUID(),
          method: "cashapp_link",
          sampleIds: [a, d],
          sellableStatuses: SELLABLE,
          defaultPriceCents: 500,
          ttlSeconds: 300,
        }),
      KioskPaymentError,
      "not for sale",
    );
    assertEquals((await sampleRow(client, a)).status, "available"); // rolled back

    // --- cash.app link: reserve → claim → staff confirm → sold -----------
    const linkId = crypto.randomUUID();
    quotes.push(linkId);
    const link = await createKioskQuote(client, {
      id: linkId,
      kioskId: "test-kiosk",
      method: "cashapp_link",
      sampleIds: [a, c],
      sellableStatuses: SELLABLE,
      defaultPriceCents: 500,
      ttlSeconds: 300,
      payUrlFor: (cents) =>
        `https://cash.app/$test/${(cents / 100).toFixed(2)}`,
    });
    assertEquals(link.amount_cents, 1750);
    assertEquals(link.pay_url, "https://cash.app/$test/17.50");
    assertEquals(link.items.map((i) => i.priced), [true, false]);
    assertEquals((await sampleRow(client, a)).status, "reserved");

    // A second kiosk can't grab a reserved sample.
    await assertRejects(
      () =>
        createKioskQuote(client, {
          id: crypto.randomUUID(),
          method: "cashapp_link",
          sampleIds: [a],
          sellableStatuses: SELLABLE,
          defaultPriceCents: 500,
          ttlSeconds: 300,
        }),
      KioskPaymentError,
      "not for sale",
    );

    const claimed = await claimKioskPayment(client, linkId);
    assertEquals(claimed.status, "claimed");
    assertEquals((await claimKioskPayment(client, linkId)).status, "claimed");
    // Claimed quotes never expire on their own.
    await releaseExpiredKioskQuotes(client);
    assertEquals((await getKioskPayment(client, linkId))?.status, "claimed");

    const done = await completeKioskPayment(client, linkId, {
      from: ["claimed", "pending"],
      operator: "staff-test",
    });
    assertEquals(done.payment.status, "paid");
    assertEquals(done.payment.confirmed_by, "staff-test");
    const soldA = await sampleRow(client, a);
    assertEquals(soldA.status, "sold");
    assertEquals(Number(soldA.sold_price), 12.5);
    assertEquals(Number((await sampleRow(client, c)).sold_price), 5);
    const tx = await client.query(
      `select count(*)::int as n from public.transactions
        where action = 'sold' and sample_id = any($1::int[])`,
      [[a, c]],
    );
    assertEquals(Number(tx.rows[0].n), 2);
    // Replay is a no-op.
    const again = await completeKioskPayment(client, linkId, {
      from: ["claimed"],
    });
    assert(again.replayed);

    // --- square: charging is single-winner; decline → retry → paid -------
    const sqId = crypto.randomUUID();
    quotes.push(sqId);
    await createKioskQuote(client, {
      id: sqId,
      method: "square",
      sampleIds: [b],
      sellableStatuses: SELLABLE,
      defaultPriceCents: null,
      ttlSeconds: 300,
    });
    const charging = await beginKioskCharge(client, sqId, crypto.randomUUID());
    assertEquals(charging.status, "charging");
    await assertRejects(
      () => beginKioskCharge(client, sqId, crypto.randomUUID()),
      KioskPaymentError,
      "already charging",
    );
    await resetKioskCharge(client, sqId, "GENERIC_DECLINE");
    const retry = await beginKioskCharge(client, sqId, crypto.randomUUID());
    assertEquals(retry.attempts, 2);
    const paid = await completeKioskPayment(client, sqId, {
      from: ["charging"],
      providerPaymentId: "sq-test-payment",
      receiptNumber: "ABCD",
    });
    assertEquals(paid.payment.provider_payment_id, "sq-test-payment");
    assertEquals((await sampleRow(client, b)).status, "sold");

    // --- cancel / expire restore the exact prior status -------------------
    await client.query(
      `update public.samples set status = 'cleared_to_sell', sold_price = null,
         sold_to = null, sold_at = null where id = $1`,
      [b],
    );
    const cancelId = crypto.randomUUID();
    quotes.push(cancelId);
    await createKioskQuote(client, {
      id: cancelId,
      method: "cashapp_link",
      sampleIds: [b],
      sellableStatuses: SELLABLE,
      defaultPriceCents: 500,
      ttlSeconds: 300,
    });
    const cancelled = await releaseKioskQuote(client, cancelId, "cancelled");
    assertEquals(cancelled.status, "cancelled");
    assertEquals((await sampleRow(client, b)).status, "cleared_to_sell");

    const expId = crypto.randomUUID();
    quotes.push(expId);
    await createKioskQuote(client, {
      id: expId,
      method: "square",
      sampleIds: [b],
      sellableStatuses: SELLABLE,
      defaultPriceCents: null,
      ttlSeconds: 300,
    });
    await client.query(
      `update public.kiosk_payments set expires_at = now() - interval '1 second'
        where id = $1`,
      [expId],
    );
    await assertRejects(
      () => beginKioskCharge(client, expId, crypto.randomUUID()),
      KioskPaymentError,
      "expired",
    );
    assert((await releaseExpiredKioskQuotes(client)) >= 1);
    assertEquals((await getKioskPayment(client, expId))?.status, "expired");
    assertEquals((await sampleRow(client, b)).status, "cleared_to_sell");
  } finally {
    if (quotes.length) {
      await client.query(
        `delete from public.kiosk_payments where id = any($1::uuid[])`,
        [quotes],
      );
    }
    if (ids.length) {
      await client.query(
        `delete from public.transactions where sample_id = any($1::int[])`,
        [ids],
      );
      await client.query(
        `delete from public.samples where id = any($1::int[])`,
        [
          ids,
        ],
      );
    }
  }
}

Deno.test({
  name: "integration: kiosk checkout reserve / claim / charge / sold",
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { ensureSchema, getPool } = await import("../mod.ts");
    await ensureSchema();
    const client = await getPool().connect();
    try {
      await kioskScenario(client);
    } finally {
      client.release();
      await getPool().end();
    }
  },
});
