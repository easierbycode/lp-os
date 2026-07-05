import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createLifecycle } from "../mod.ts";
import { makeDeps } from "./fakes.ts";

// ---------------------------------------------------------------------------
// recordSampleStatus
// ---------------------------------------------------------------------------

Deno.test("status: happy path updates Postgres and emits event", async () => {
  const { db, store } = makeDeps();
  db.Samples.rows.push({
    id: 1,
    name: "Cupids Desire Drops",
    qr_code: "1729876543210",
    status: "available",
  });
  const lc = createLifecycle({ db, store });

  const result = await lc.recordSampleStatus({
    sampleId: 1,
    status: "cleared_to_sell",
    note: "passed QC",
  });

  assertEquals(result.ok, true);
  assertEquals(result.sampleId, 1);
  assertEquals(result.status, "cleared_to_sell");
  assertEquals(result.previousStatus, "available");
  assertEquals(result.postgres.updated, true);
  assertEquals(result.graylog, true);
  assertEquals(db.Samples.rows[0].status, "cleared_to_sell");
  // No checkout stamp for non-checked_out statuses.
  assertEquals(db.Samples.rows[0].checked_out_at, undefined);

  const [event] = store.eventsWithField("sample_status_json");
  assert(event, "sample_status_json event emitted");
  assertEquals(event.fields.sample_status, "cleared_to_sell");
  assertEquals(event.fields.product_id, "1729876543210");
  assertEquals(event.fields.sample_id, "1");
  assertEquals(event.fields.sample_source, "skill");
  const inner = JSON.parse(String(event.fields.sample_status_json));
  assertEquals(inner.previousStatus, "available");
  assertEquals(inner.note, "passed QC");
});

Deno.test("status: checked_out stamps checked_out_at", async () => {
  const { db, store } = makeDeps();
  db.Samples.rows.push({
    id: 7,
    name: "Item",
    qr_code: "111",
    status: "available",
  });
  const lc = createLifecycle({ db, store });

  await lc.recordSampleStatus({ sampleId: 7, status: "checked_out" });
  assertEquals(db.Samples.rows[0].status, "checked_out");
  assert(
    typeof db.Samples.rows[0].checked_out_at === "string" &&
      db.Samples.rows[0].checked_out_at.length > 0,
    "checked_out_at stamped",
  );
});

Deno.test("status: invalid status rejected with vocabulary list", async () => {
  const lc = createLifecycle(makeDeps());
  const err = await assertRejects(
    () => lc.recordSampleStatus({ sampleId: 1, status: "yeeted" }),
    Error,
  );
  assertStringIncludes(err.message, 'Unknown status "yeeted"');
  assertStringIncludes(err.message, "available");
  assertStringIncludes(err.message, "cleared_to_sell");
  // Badges are NOT valid statuses.
  const badge = await assertRejects(
    () => lc.recordSampleStatus({ sampleId: 1, status: "fire_sale" }),
    Error,
  );
  assertStringIncludes(badge.message, "Unknown status");
});

Deno.test("status: sold rejected — must use the sold flow", async () => {
  const lc = createLifecycle(makeDeps());
  const err = await assertRejects(
    () => lc.recordSampleStatus({ sampleId: 1, status: "sold" }),
    Error,
  );
  assertStringIncludes(err.message, "sold flow");
});

// ---------------------------------------------------------------------------
// recordSampleSold — guards
// ---------------------------------------------------------------------------

Deno.test("sold: creator required", async () => {
  const lc = createLifecycle(makeDeps());
  const err = await assertRejects(
    () =>
      lc.recordSampleSold({ sampleId: 1, salePrice: 40, marketplace: "ebay" }),
    Error,
  );
  assertStringIncludes(err.message, "creator is required");
});

Deno.test("sold: salePrice must be positive", async () => {
  const lc = createLifecycle(makeDeps());
  for (const bad of [0, -5, "nope", undefined]) {
    const err = await assertRejects(
      () =>
        lc.recordSampleSold({
          sampleId: 1,
          creator: "@x",
          salePrice: bad as number | string | undefined,
          marketplace: "ebay",
        }),
      Error,
    );
    assertStringIncludes(err.message, "salePrice must be a positive number");
  }
});

Deno.test("sold: double-sell blocked without force, allowed with force", async () => {
  const { db, store } = makeDeps();
  db.Samples.rows.push({
    id: 3,
    name: "Gadget",
    qr_code: "222",
    status: "sold",
    sold_at: "2026-06-01T00:00:00.000Z",
  });
  const lc = createLifecycle({ db, store });

  const err = await assertRejects(
    () =>
      lc.recordSampleSold({
        sampleId: 3,
        creator: "@x",
        salePrice: 40,
        marketplace: "ebay",
      }),
    Error,
  );
  assertStringIncludes(err.message, "already sold");
  assertStringIncludes(err.message, "sold_at=2026-06-01T00:00:00.000Z");
  assertEquals(store.eventsWithField("sample_sold_json").length, 0);

  const forced = await lc.recordSampleSold({
    sampleId: 3,
    creator: "@x",
    salePrice: 40,
    marketplace: "ebay",
    force: true,
  });
  assertEquals(forced.ok, true);
  assertEquals(store.eventsWithField("sample_sold_json").length, 1);
});

Deno.test("sold: happy path writes sale columns + audit transaction", async () => {
  const { db, store } = makeDeps();
  db.Samples.rows.push({
    id: 4,
    name: "Serum",
    qr_code: "333",
    status: "cleared_to_sell",
  });
  const lc = createLifecycle({ db, store });

  const result = await lc.recordSampleSold({
    productId: "333",
    creator: "@wizardofdealz",
    salePrice: 45,
    marketplace: "ebay",
    fees: 5,
    shipping: 3,
    buyer: "bob",
  });

  assertEquals(result.ok, true);
  assertEquals(result.net, 37);
  assertEquals(db.Samples.rows[0].status, "sold");
  assertEquals(db.Samples.rows[0].sold_price, 45);
  assertEquals(db.Samples.rows[0].sold_to, "bob");
  assertEquals(db.Transactions.rows.length, 1);
  assertEquals(db.Transactions.rows[0].action, "sold");
  assertEquals(
    result.postgres.transactionId,
    Number(db.Transactions.rows[0].id),
  );
  assertStringIncludes(
    String(db.Transactions.rows[0].notes),
    "Resale via ebay → @wizardofdealz | gross $45.00 | net $37.00",
  );
});

Deno.test("sold: graylogOnly resolves creator from assignment history and is idempotent", async () => {
  const { db, store } = makeDeps();
  db.Samples.rows.push({ id: 9, name: "Lamp", qr_code: "444", status: "sold" });
  // Assignment history answers the creator lookup.
  store.searchRoutes.push({
    match: "sample_assignment_json:*",
    messages: [
      {
        timestamp: "2026-06-01 00:00:00.000",
        creator: "@boosteddealsdaily",
        sample_id: "9",
        product_id: "444",
      },
    ],
  });
  const lc = createLifecycle({ db, store });

  const first = await lc.recordSampleSold({
    sampleId: 9,
    salePrice: 30,
    marketplace: "offerup",
    graylogOnly: true,
  });
  assertEquals(first.creator, "@boosteddealsdaily");
  assertEquals(first.graylog, true);
  assertEquals(first.postgres.updated, false);
  // No Postgres mutation, no audit row in graylogOnly mode.
  assertEquals(db.Samples.rows[0].sold_price, undefined);
  assertEquals(db.Transactions.rows.length, 0);
  const [event] = store.eventsWithField("sample_sold_json");
  assertEquals(event.fields.sample_source, "tracker-resale");

  // Second call: a tracker-resale event now exists → skipped.
  store.searchRoutes.unshift({
    match: 'sample_sold_json:* AND sample_source:"tracker-resale"',
    messages: [{ timestamp: "2026-06-02 00:00:00.000", sample_id: "9" }],
  });
  const second = await lc.recordSampleSold({
    sampleId: 9,
    salePrice: 30,
    marketplace: "offerup",
    graylogOnly: true,
  });
  assertEquals(second.ok, true);
  assertEquals(second.graylog, false);
  assertStringIncludes(second.message, "already attributed");
  assertEquals(store.eventsWithField("sample_sold_json").length, 1);
});

// ---------------------------------------------------------------------------
// Event field shapes (exact keys — dashboards/skills query these verbatim)
// ---------------------------------------------------------------------------

Deno.test("sold event: exact flat fields and sample_sold_json keys", async () => {
  const { db, store } = makeDeps();
  db.Samples.rows.push({
    id: 5,
    name: "Cupids Desire Drops",
    qr_code: "555",
    status: "available",
  });
  const lc = createLifecycle({ db, store });

  await lc.recordSampleSold({
    sampleId: 5,
    creator: "@boosteddealsdaily",
    salePrice: 45,
    marketplace: "ebay",
    fees: 5,
    shipping: 3,
  });

  const [event] = store.eventsWithField("sample_sold_json");
  assertEquals(
    event.shortMessage,
    "thirsty sample sold: Cupids Desire Drops $45.00 via ebay → @boosteddealsdaily",
  );
  assertEquals(
    Object.keys(event.fields).sort(),
    [
      "cost_num",
      "creator",
      "fee_num",
      "gmv_num",
      "marketplace",
      "net_num",
      "product_id",
      "sale_price_num",
      "sample_id",
      "sample_sold_json",
      "sample_source",
      "sample_status",
      "shipping_num",
      "source",
    ],
  );
  assertEquals(event.fields.source, "thirsty-store-kiosk");
  assertEquals(event.fields.creator, "@boosteddealsdaily");
  assertEquals(event.fields.gmv_num, 45);
  assertEquals(event.fields.sale_price_num, 45);
  assertEquals(event.fields.fee_num, 5);
  assertEquals(event.fields.shipping_num, 3);
  assertEquals(event.fields.cost_num, 0);
  assertEquals(event.fields.net_num, 37);
  assertEquals(event.fields.marketplace, "ebay");
  assertEquals(event.fields.product_id, "555");
  assertEquals(event.fields.sample_id, "5");
  assertEquals(event.fields.sample_status, "sold");
  assertEquals(event.fields.sample_source, "skill-resale");

  const inner = JSON.parse(String(event.fields.sample_sold_json));
  assertEquals(
    Object.keys(inner).sort(),
    [
      "costBasis",
      "creator",
      "fees",
      "marketplace",
      "name",
      "net",
      "productId",
      "salePrice",
      "sampleId",
      "shipping",
      "soldAt",
    ],
  );
  assertEquals(inner.salePrice, 45);
  assertEquals(inner.net, 37);
});

Deno.test("assignment event: exact flat fields and sample_assignment_json keys", async () => {
  const { db, store } = makeDeps();
  db.Samples.rows.push({
    id: 12,
    name: "Cupids Desire Drops", // matches campaign productMatch "cupid"
    qr_code: "777",
    status: "reserved",
    checked_out_to: "kyle",
  });
  const lc = createLifecycle({ db, store });

  const result = await lc.recordSampleAssignment({
    sampleId: 12,
    creator: "@boosteddealsdaily",
  });
  assertEquals(result.ok, true);
  assertEquals(result.fromStatus, "reserved");
  assertEquals(result.agencyBucket, "kyle");
  assertEquals(result.campaign, "Cupids Desire");

  const [event] = store.eventsWithField("sample_assignment_json");
  assertEquals(
    event.shortMessage,
    "thirsty sample assigned: Cupids Desire Drops → @boosteddealsdaily",
  );
  assertEquals(
    Object.keys(event.fields).sort(),
    [
      "agency_bucket",
      "campaign",
      "campaign_id",
      "creator",
      "product_id",
      "sample_assignment_json",
      "sample_event",
      "sample_id",
      "sample_source",
      "sample_status",
      "source",
    ],
  );
  assertEquals(event.fields.creator, "@boosteddealsdaily");
  assertEquals(event.fields.sample_status, "checked_out");
  assertEquals(event.fields.sample_event, "assigned");
  assertEquals(event.fields.agency_bucket, "kyle");
  assertEquals(event.fields.campaign, "Cupids Desire");
  assertEquals(event.fields.campaign_id, "cupids-2026");
  assertEquals(event.fields.sample_source, "skill-assignment");

  const inner = JSON.parse(String(event.fields.sample_assignment_json));
  assertEquals(
    Object.keys(inner).sort(),
    [
      "agencyBucket",
      "assignedAt",
      "campaign",
      "campaignId",
      "creator",
      "fromStatus",
      "name",
      "productId",
      "sampleId",
    ],
  );
  assertEquals(inner.fromStatus, "reserved");
});

// ---------------------------------------------------------------------------
// recordBulkSampleSold — allocation math
// ---------------------------------------------------------------------------

Deno.test("bulk: explicit prices honored, remainder split, last item absorbs rounding", async () => {
  const { db, store } = makeDeps();
  for (let i = 1; i <= 4; i++) {
    db.Samples.rows.push({
      id: i,
      name: `Item ${i}`,
      qr_code: `qr-${i}`,
      status: "available",
    });
  }
  const lc = createLifecycle({ db, store });

  // total 100, item1 explicit 40 → remaining 60 over 3 unpriced:
  // per = floor(20.00*100)/100 = 20; last absorbs 60 - 20*2 = 20 → 20/20/20.
  // Use 100 with explicit 39.99 → remaining 60.01 → per = 20.00, last = 20.01.
  const result = await lc.recordBulkSampleSold({
    items: [
      { sampleId: 1, price: 39.99 },
      { sampleId: 2 },
      { sampleId: 3 },
      { sampleId: 4 },
    ],
    totalPrice: 100,
    marketplace: "fbmarketplace",
    creator: "@lot",
  });

  assertEquals(result.ok, true);
  assertEquals(result.soldCount, 4);
  assertEquals(result.failures.length, 0);
  const prices = result.items.map((r) => r.salePrice);
  assertEquals(prices, [39.99, 20, 20, 20.01]);
  assertEquals(result.allocatedTotal, 100);
  // Every item shares the bulk id and each emits a full sold event.
  const events = store.eventsWithField("sample_sold_json");
  assertEquals(events.length, 4);
  for (const e of events) {
    assertEquals(e.fields.bulk_id, result.bulkId);
    assertEquals(e.fields.bulk_total_num, 100);
    assertEquals(e.fields.sample_source, "skill-bulk-resale");
  }
});

Deno.test("bulk: lot-level fees/shipping/costBasis allocated proportionally", async () => {
  const { db, store } = makeDeps();
  db.Samples.rows.push(
    { id: 1, name: "A", qr_code: "a", status: "available" },
    { id: 2, name: "B", qr_code: "b", status: "available" },
  );
  const lc = createLifecycle({ db, store });

  // grosses 75/25 → shares 0.75/0.25 of fees=10, shipping=4, costBasis=20.
  const result = await lc.recordBulkSampleSold({
    items: [
      { sampleId: 1, price: 75 },
      { sampleId: 2, price: 25 },
    ],
    totalPrice: 100,
    marketplace: "ebay",
    creator: "@lot",
    fees: 10,
    shipping: 4,
    costBasis: 20,
  });

  assertEquals(result.items[0].fees, 7.5);
  assertEquals(result.items[0].shipping, 3);
  assertEquals(result.items[0].costBasis, 15);
  assertEquals(result.items[0].net, 49.5);
  assertEquals(result.items[1].fees, 2.5);
  assertEquals(result.items[1].shipping, 1);
  assertEquals(result.items[1].costBasis, 5);
  assertEquals(result.items[1].net, 16.5);
  assertEquals(result.netTotal, 66);
});

Deno.test("bulk: explicit prices exceeding total rejected; per-item creator required", async () => {
  const lc = createLifecycle(makeDeps());
  const err = await assertRejects(
    () =>
      lc.recordBulkSampleSold({
        items: [{ sampleId: 1, price: 80 }, { sampleId: 2, price: 30 }],
        totalPrice: 100,
        marketplace: "ebay",
        creator: "@lot",
      }),
    Error,
  );
  assertStringIncludes(err.message, "exceed totalPrice");

  const noCreator = await assertRejects(
    () =>
      lc.recordBulkSampleSold({
        items: [{ sampleId: 1 }],
        totalPrice: 100,
        marketplace: "ebay",
      }),
    Error,
  );
  assertStringIncludes(noCreator.message, "item 1: creator is required");
});

Deno.test("bulk: per-item failure (already sold) collected, rest of lot proceeds", async () => {
  const { db, store } = makeDeps();
  db.Samples.rows.push(
    { id: 1, name: "A", qr_code: "a", status: "sold" },
    { id: 2, name: "B", qr_code: "b", status: "available" },
  );
  const lc = createLifecycle({ db, store });

  const result = await lc.recordBulkSampleSold({
    items: [{ sampleId: 1 }, { sampleId: 2 }],
    totalPrice: 100,
    marketplace: "ebay",
    creator: "@lot",
  });
  assertEquals(result.ok, false);
  assertEquals(result.soldCount, 1);
  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0].item, 1);
  assertStringIncludes(result.failures[0].error, "already sold");
  assertEquals(db.Samples.rows[1].status, "sold");
});

// ---------------------------------------------------------------------------
// recordSampleAssignment — reserved-bucket resolution
// ---------------------------------------------------------------------------

Deno.test("assignment: prefers the reserved unit for a shared qr_code", async () => {
  const { db, store } = makeDeps();
  db.Samples.rows.push(
    {
      id: 1,
      name: "Widget",
      qr_code: "shared",
      status: "available",
      created_at: "2026-07-01T00:00:00.000Z",
    },
    {
      id: 2,
      name: "Widget",
      qr_code: "shared",
      status: "reserved",
      checked_out_to: "kyle",
      created_at: "2026-06-01T00:00:00.000Z",
    },
  );
  const lc = createLifecycle({ db, store });

  const result = await lc.recordSampleAssignment({
    productId: "shared",
    creator: "@boosteddealsdaily",
  });

  assertEquals(result.sampleId, 2);
  assertEquals(result.fromStatus, "reserved");
  assertEquals(result.agencyBucket, "kyle");
  const row = db.Samples.rows.find((r) => r.id === 2)!;
  assertEquals(row.status, "checked_out");
  assertEquals(row.checked_out_to, "@boosteddealsdaily");
  // Untouched sibling.
  assertEquals(db.Samples.rows.find((r) => r.id === 1)!.status, "available");
  // check_out audit transaction recorded.
  assertEquals(db.Transactions.rows.length, 1);
  assertEquals(db.Transactions.rows[0].action, "check_out");
  assertEquals(db.Transactions.rows[0].checked_out_to, "@boosteddealsdaily");
});

// ---------------------------------------------------------------------------
// recordAgencyIntake
// ---------------------------------------------------------------------------

Deno.test("agency intake: creates qty reserved rows clamped to [1,200]", async () => {
  const { db, store } = makeDeps();
  const lc = createLifecycle({ db, store });

  const result = await lc.recordAgencyIntake({
    productId: "999",
    name: "Bulk Serum",
    agencyBucket: "kyle",
    qty: 3,
  });

  assertEquals(result.ok, true);
  assertEquals(result.qty, 3);
  assertEquals(result.postgres.created, 3);
  assertEquals(result.postgres.updated, 0);
  assertEquals(db.Samples.rows.length, 3);
  for (const row of db.Samples.rows) {
    assertEquals(row.status, "reserved");
    assertEquals(row.checked_out_to, "kyle");
    assertEquals(row.qr_code, "999");
  }
  assertEquals(db.Transactions.rows.length, 3);

  const [event] = store.eventsWithField("sample_intake_json");
  assertEquals(event.fields.sample_event, "agency_intake");
  assertEquals(event.fields.agency_bucket, "kyle");
  assertEquals(event.fields.qty_num, 3);
  assertEquals(event.fields.sample_source, "skill-agency-intake");
  const inner = JSON.parse(String(event.fields.sample_intake_json));
  assertEquals(inner.sampleIds.length, 3);
  assertEquals(inner.agencyBucket, "kyle");
});

Deno.test("agency intake: updates explicit sampleIds instead of creating", async () => {
  const { db, store } = makeDeps();
  db.Samples.rows.push(
    { id: 1, name: "X", qr_code: "1", status: "available" },
    { id: 2, name: "X", qr_code: "1", status: "available" },
  );
  const lc = createLifecycle({ db, store });

  const result = await lc.recordAgencyIntake({
    sampleIds: [1, 2],
    agencyBucket: "kyle",
  });
  assertEquals(result.postgres.updated, 2);
  assertEquals(result.postgres.created, 0);
  assertEquals(result.sampleIds, [1, 2]);
  assertEquals(db.Samples.rows[0].status, "reserved");
  assertEquals(db.Samples.rows[1].checked_out_to, "kyle");
});

// ---------------------------------------------------------------------------
// recordSampleImport (+ schedule) and cron reads
// ---------------------------------------------------------------------------

Deno.test("import: creates checked_out row, emits imported event, schedules listing", async () => {
  const { db, store } = makeDeps();
  const lc = createLifecycle({ db, store });

  const result = await lc.recordSampleImport({
    productId: "123456",
    name: "Glow Serum",
    price: 29.99,
    seller: "TikTok Shop",
    creator: "@boosteddealsdaily",
    autoListAfterDays: 2,
    marketplace: "ebay",
    askPrice: 45,
  });

  assertEquals(result.ok, true);
  assertEquals(result.postgres.created, true);
  assert(result.scheduledListing);
  assertEquals(result.scheduledListing!.marketplace, "ebay");
  assertEquals(result.scheduledListing!.askPrice, 45);
  assertEquals(db.Samples.rows[0].status, "checked_out");
  assertEquals(db.Samples.rows[0].checked_out_to, "@boosteddealsdaily");
  assertEquals(db.Samples.rows[0].brand, "TikTok Shop");
  assertEquals(db.Samples.rows[0].current_price, 29.99);

  const [sched] = store.eventsWithField("sample_schedule_json");
  assertEquals(sched.fields.sample_event, "listing_scheduled");
  assertEquals(sched.fields.marketplace, "ebay");
  assertEquals(sched.fields.ask_price_num, 45);
  assertEquals(sched.fields.sample_source, "skill-import");

  const [imported] = store.eventsWithField("sample_assignment_json");
  assertEquals(imported.fields.sample_event, "imported");
  assertEquals(imported.fields.sample_status, "checked_out");
  assertEquals(imported.fields.sample_source, "skill-import");
});

Deno.test("import: dryRun writes nothing", async () => {
  const { db, store } = makeDeps();
  const lc = createLifecycle({ db, store });

  const result = await lc.recordSampleImport({
    productId: "42",
    creator: "@x",
    dryRun: true,
    autoListAfterDays: 1,
  });
  assertEquals(result.ok, true);
  assertEquals(result.dryRun, true);
  assertEquals(result.postgres.created, false);
  assert(result.scheduledListing); // computed, not written
  assertEquals(db.Samples.rows.length, 0);
  assertEquals(db.Transactions.rows.length, 0);
  assertEquals(store.events.length, 0);
});

Deno.test("cron reads: due schedules exclude fired + future ones", async () => {
  const { db, store } = makeDeps();
  const past = new Date(Date.now() - 3600_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  store.searchRoutes.push({
    match: "sample_schedule_json:*",
    messages: [
      {
        sample_schedule_json: JSON.stringify({
          scheduleId: "sched-due",
          productId: "1",
          sampleId: 10,
          name: "Due",
          creator: "@x",
          marketplace: "ebay",
          askPrice: 20,
          listAt: past,
        }),
      },
      {
        sample_schedule_json: JSON.stringify({
          scheduleId: "sched-fired",
          productId: "2",
          listAt: past,
        }),
      },
      {
        sample_schedule_json: JSON.stringify({
          scheduleId: "sched-future",
          productId: "3",
          listAt: future,
        }),
      },
    ],
  });
  store.searchRoutes.push({
    match: "sample_schedule_done_json:*",
    messages: [
      {
        sample_schedule_done_json: JSON.stringify({
          scheduleId: "sched-fired",
        }),
      },
    ],
  });
  const lc = createLifecycle({ db, store });

  const due = await lc.fetchDueListingSchedules();
  assertEquals(due.length, 1);
  assertEquals(due[0].scheduleId, "sched-due");
  assertEquals(due[0].askPrice, 20);

  await lc.markListingScheduleDone("sched-due");
  const [done] = store.eventsWithField("sample_schedule_done_json");
  assertEquals(done.fields.sample_event, "listing_fired");
  assertEquals(done.fields.schedule_id, "sched-due");
  assertEquals(done.fields.sample_source, "skill-cron");
});

// ---------------------------------------------------------------------------
// Graylog-backed creator reads (same query strings as the source)
// ---------------------------------------------------------------------------

Deno.test("fetchKnownCreators: distinct, @-handles first", async () => {
  const { db, store } = makeDeps();
  store.searchRoutes.push({
    match: "creator:*",
    messages: [
      { creator: "zeta-agency" },
      { creator: "@bob" },
      { creator: "@alice" },
      { creator: "@bob" },
      { creator: "  " },
    ],
  });
  const lc = createLifecycle({ db, store });
  const creators = await lc.fetchKnownCreators();
  assertEquals(creators, ["@alice", "@bob", "zeta-agency"]);
  // Query string is verbatim.
  assertEquals(store.searches[0].query, "creator:*");
  assertEquals(store.searches[0].rangeSeconds, 60 * 60 * 24 * 365 * 5);
});

Deno.test("fetchCreatorsForProduct: affiliate-export query verbatim", async () => {
  const { db, store } = makeDeps();
  store.searchRoutes.push({
    match: "source:tiktok-affiliate-export",
    messages: [{ creator: "@carol", product_id: "777" }],
  });
  const lc = createLifecycle({ db, store });
  const creators = await lc.fetchCreatorsForProduct("777");
  assertEquals(creators, ["@carol"]);
  assertEquals(
    store.searches[0].query,
    'source:tiktok-affiliate-export AND (product_id:"777" OR product_id.keyword:"777")',
  );
});

Deno.test("fetchAssignedCreatorForSample: exact sample_id match wins over recency", async () => {
  const { db, store } = makeDeps();
  store.searchRoutes.push({
    match: "sample_assignment_json:*",
    messages: [
      {
        timestamp: "2026-07-04 00:00:00.000",
        creator: "@newer-product-match",
        sample_id: "77",
        product_id: "555",
      },
      {
        timestamp: "2026-06-01 00:00:00.000",
        creator: "@exact-sample-match",
        sample_id: "42",
        product_id: "555",
      },
    ],
  });
  const lc = createLifecycle({ db, store });
  const creator = await lc.fetchAssignedCreatorForSample(42, "555");
  assertEquals(creator, "@exact-sample-match");
  assertEquals(
    store.searches[0].query,
    'creator:* AND sample_assignment_json:* AND (sample_id:"42" OR product_id:"555")',
  );
});

// ---------------------------------------------------------------------------
// listSampleStatuses
// ---------------------------------------------------------------------------

Deno.test("listSampleStatuses: full vocabulary verbatim (statuses + badges)", () => {
  const lc = createLifecycle(makeDeps());
  const statuses = lc.listSampleStatuses();
  assertEquals(statuses.map((s) => s.value), [
    "available",
    "checked_out",
    "reserved",
    "cleared_to_sell",
    "discontinued",
    "fire_sale",
    "lowest_price",
    "sold",
  ]);
  assertEquals(statuses.filter((s) => s.kind === "badge").length, 2);
});
