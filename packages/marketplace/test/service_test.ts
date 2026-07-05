import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { createListingService, MarketplaceError } from "../mod.ts";
import { makeAccount, makeServiceDeps } from "./fakes.ts";

function seedSample(
  Samples: { rows: Record<string, unknown>[]; nextId: number },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const row = {
    id: Samples.nextId++,
    name: "Cupids Desire Drops",
    brand: "Cupid Labs",
    qr_code: "1729000000000000001",
    status: "cleared_to_sell",
    picture_url: "https://img.example.com/cupid.jpg",
    best_price: 24.99,
    current_price: 29.99,
    checked_out_to: "",
    quantity: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  };
  Samples.rows.push(row);
  return row;
}

Deno.test("listSample publishes and records the listed event", async () => {
  const { deps, Samples, Listings, lifecycle, client } = makeServiceDeps([
    makeAccount(),
  ]);
  const sample = seedSample(Samples);
  const service = createListingService(deps);

  const result = await service.listSample({
    sampleId: sample.id as number,
    creator: "@boosteddealsdaily",
    askPrice: 40,
    operator: "dj",
  });

  assert(result.ok, result.message);
  assertEquals(result.askPrice, 40);
  assertEquals(result.listingUrl, "https://sandbox.ebay.com/itm/110001");
  assertEquals(result.externalId, "110001");

  assertEquals(Listings.rows.length, 1);
  const row = Listings.rows[0];
  assertEquals(row.status, "listed");
  assertEquals(row.marketplace, "ebay");
  assertEquals(row.external_id, "110001");
  assertEquals(row.offer_id, "offer-1");
  assertEquals(row.sku, `lpos-${sample.id}`);
  assertEquals(row.source, "manual");
  assert(row.listed_at, "listed_at stamped");

  assertEquals(client.publishCalls.length, 1);
  assertEquals(client.publishCalls[0].price, 40);
  assertEquals(client.publishCalls[0].imageUrl, sample.picture_url);

  assertEquals(lifecycle.listingCalls.length, 1);
  const recorded = lifecycle.listingCalls[0];
  assertEquals(recorded.source, "marketplace-api");
  assertEquals(recorded.listingId, row.id);
  assertEquals(recorded.externalId, "110001");
  assertEquals(recorded.marketplace, "ebay");
  assertMatch(result.message, /Listed .+ on ebay/);
});

Deno.test("listSample refuses when the marketplace is not connected", async () => {
  const { deps, Samples } = makeServiceDeps([]); // no accounts at all
  const sample = seedSample(Samples);
  const service = createListingService(deps);

  await assertRejects(
    () => service.listSample({ sampleId: sample.id as number }),
    Error,
    "not connected",
  );
});

Deno.test("listSample refuses incomplete credentials", async () => {
  const { deps, Samples } = makeServiceDeps([
    makeAccount({ credentials: { clientId: "only-this" } }),
  ]);
  const sample = seedSample(Samples);
  const service = createListingService(deps);

  await assertRejects(
    () => service.listSample({ sampleId: sample.id as number }),
    Error,
    "not connected",
  );
});

Deno.test("listSample falls back to sample prices and resolved creator", async () => {
  const { deps, Samples, lifecycle, client } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples, { best_price: 19.5 });
  lifecycle.assignedCreator = "@wizardofdealz";
  const service = createListingService(deps);

  const result = await service.listSample({ sampleId: sample.id as number });

  assert(result.ok);
  assertEquals(result.askPrice, 19.5);
  assertEquals(result.creator, "@wizardofdealz");
  assertEquals(client.publishCalls[0].price, 19.5);
});

Deno.test("listSample rejects an unparseable explicit askPrice instead of substituting the sample price", async () => {
  const { deps, Samples, client } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples); // best_price 24.99 must NOT be used
  const service = createListingService(deps);

  await assertRejects(
    () =>
      service.listSample({
        sampleId: sample.id as number,
        creator: "@x",
        askPrice: "40 USD",
      }),
    Error,
    "askPrice",
  );
  assertEquals(client.publishCalls.length, 0);
});

Deno.test("listSample tolerates $ and thousands separators in askPrice", async () => {
  const { deps, Samples, client } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples);
  const service = createListingService(deps);

  const result = await service.listSample({
    sampleId: sample.id as number,
    creator: "@x",
    askPrice: "$1,299.99",
  });
  assert(result.ok);
  assertEquals(client.publishCalls[0].price, 1299.99);
});

Deno.test("listSample refuses to publish a sold sample", async () => {
  const { deps, Samples, client } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples, { status: "sold" });
  const service = createListingService(deps);

  await assertRejects(
    () => service.listSample({ sampleId: sample.id as number, creator: "@x" }),
    Error,
    "is sold",
  );
  assertEquals(client.publishCalls.length, 0);
});

Deno.test("resolve by productId finds nothing when every row is sold", async () => {
  const { deps, Samples } = makeServiceDeps([makeAccount()]);
  seedSample(Samples, { status: "sold", qr_code: "1729000000000000009" });
  const service = createListingService(deps);

  await assertRejects(
    () =>
      service.listSample({ productId: "1729000000000000009", creator: "@x" }),
    Error,
    "sample not found",
  );
});

Deno.test("concurrent listSample calls publish exactly once", async () => {
  const { deps, Samples, Listings, client } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples);
  const service = createListingService(deps);

  const [a, b] = await Promise.all([
    service.listSample({ sampleId: sample.id as number, creator: "@x" }),
    service.listSample({ sampleId: sample.id as number, creator: "@x" }),
  ]);

  assertEquals(client.publishCalls.length, 1);
  assertEquals(Listings.rows.length, 1);
  const oks = [a, b].filter((r) => r.ok).length;
  const dupes = [a, b].filter((r) => r.alreadyListed).length;
  assertEquals(oks, 1);
  assertEquals(dupes, 1);
});

Deno.test("force re-list uses a fresh sku so the live offer is untouched", async () => {
  const { deps, Samples, Listings, client } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples);
  client.publishPlan = [
    {
      externalId: "110001",
      offerId: "offer-1",
      url: "https://sandbox.ebay.com/itm/110001",
    },
    {
      externalId: "110002",
      offerId: "offer-2",
      url: "https://sandbox.ebay.com/itm/110002",
    },
  ];
  const service = createListingService(deps);

  const first = await service.listSample({
    sampleId: sample.id as number,
    creator: "@x",
  });
  assert(first.ok);
  const second = await service.listSample({
    sampleId: sample.id as number,
    creator: "@x",
    force: true,
  });
  assert(second.ok, second.message);
  assertEquals(Listings.rows.length, 2);
  assertEquals(client.publishCalls[0].sku, `lpos-${sample.id}`);
  assertEquals(client.publishCalls[1].sku, `lpos-${sample.id}-2`);
});

Deno.test("listSample requires a price from somewhere", async () => {
  const { deps, Samples } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples, { best_price: null, current_price: null });
  const service = createListingService(deps);

  await assertRejects(
    () =>
      service.listSample({
        sampleId: sample.id as number,
        creator: "@x",
      }),
    Error,
    "askPrice",
  );
});

Deno.test("listSample requires an https image", async () => {
  const { deps, Samples } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples, { picture_url: "" });
  const service = createListingService(deps);

  await assertRejects(
    () =>
      service.listSample({
        sampleId: sample.id as number,
        creator: "@x",
      }),
    Error,
    "image",
  );
});

Deno.test("listSample resolves by productId and prefers unsold rows", async () => {
  const { deps, Samples } = makeServiceDeps([makeAccount()]);
  seedSample(Samples, { status: "sold", qr_code: "1729000000000000002" });
  const unsold = seedSample(Samples, {
    status: "cleared_to_sell",
    qr_code: "1729000000000000002",
  });
  const service = createListingService(deps);

  const result = await service.listSample({
    productId: "1729000000000000002",
    creator: "@x",
  });
  assert(result.ok);
  assertEquals(result.sampleId, unsold.id);
});

Deno.test("second listSample reports alreadyListed without re-publishing", async () => {
  const { deps, Samples, client } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples);
  const service = createListingService(deps);

  const first = await service.listSample({
    sampleId: sample.id as number,
    creator: "@x",
  });
  assert(first.ok);
  const second = await service.listSample({
    sampleId: sample.id as number,
    creator: "@x",
  });
  assertEquals(second.ok, false);
  assertEquals(second.alreadyListed, true);
  assertEquals(client.publishCalls.length, 1);
});

Deno.test("publish failure marks the row failed and emits listing_failed", async () => {
  const { deps, Samples, Listings, store, client } = makeServiceDeps([
    makeAccount(),
  ]);
  const sample = seedSample(Samples);
  client.publishPlan = [
    new MarketplaceError("eBay says no image", { permanent: true }),
  ];
  const service = createListingService(deps);

  const result = await service.listSample({
    sampleId: sample.id as number,
    creator: "@x",
  });

  assertEquals(result.ok, false);
  assertEquals(result.permanent, true);
  assertMatch(result.error ?? "", /eBay says no image/);
  assertEquals(Listings.rows[0].status, "failed");
  assertEquals(Listings.rows[0].error, "eBay says no image");

  const failures = store.eventsWithField("listing_error_json");
  assertEquals(failures.length, 1);
  const fields = failures[0].fields;
  assertEquals(fields.sample_event, "listing_failed");
  assertEquals(fields.sample_source, "marketplace-api");
  assertEquals(fields.marketplace, "ebay");
  assertEquals(fields.sample_id, String(sample.id));
  assertEquals(fields.source, "thirsty-store-kiosk");
  const blob = JSON.parse(String(fields.listing_error_json));
  assertEquals(blob.permanent, true);
  assertEquals(blob.error, "eBay says no image");
});

Deno.test("retry after failure reuses the same listing row", async () => {
  const { deps, Samples, Listings, client } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples);
  client.publishPlan = [
    new MarketplaceError("flaky", { permanent: false }),
    {
      externalId: "110002",
      offerId: "offer-2",
      url: "https://sandbox.ebay.com/itm/110002",
    },
  ];
  const service = createListingService(deps);

  const first = await service.listSample({
    sampleId: sample.id as number,
    creator: "@x",
  });
  assertEquals(first.ok, false);
  const second = await service.listSample({
    sampleId: sample.id as number,
    creator: "@x",
  });
  assert(second.ok);
  assertEquals(Listings.rows.length, 1);
  assertEquals(Listings.rows[0].status, "listed");
  assertEquals(Listings.rows[0].external_id, "110002");
});

Deno.test("runAutoListPass fires due schedules and marks them done", async () => {
  const { deps, Samples, lifecycle } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples);
  lifecycle.dueSchedules = [{
    scheduleId: "sched-1",
    productId: String(sample.qr_code),
    sampleId: sample.id as number,
    name: String(sample.name),
    creator: "@boosteddealsdaily",
    marketplace: "ebay",
    askPrice: 45,
    listAt: "2026-07-01T00:00:00.000Z",
  }];
  const service = createListingService(deps);

  const pass = await service.runAutoListPass();

  assertEquals(pass.schedules.length, 1);
  assertEquals(pass.schedules[0].status, "listed");
  assertEquals(lifecycle.doneScheduleIds, ["sched-1"]);
});

Deno.test("runAutoListPass defers schedules when marketplace not connected", async () => {
  const { deps, Samples, lifecycle } = makeServiceDeps([]);
  const sample = seedSample(Samples);
  lifecycle.dueSchedules = [{
    scheduleId: "sched-2",
    productId: String(sample.qr_code),
    sampleId: sample.id as number,
    name: String(sample.name),
    creator: "@x",
    marketplace: "ebay",
    askPrice: 45,
    listAt: "2026-07-01T00:00:00.000Z",
  }];
  const service = createListingService(deps);

  const pass = await service.runAutoListPass();

  assertEquals(pass.schedules[0].status, "deferred");
  assertEquals(lifecycle.doneScheduleIds, []);
});

Deno.test("runAutoListPass burns schedules on permanent failure, keeps transient", async () => {
  const { deps, Samples, lifecycle, client } = makeServiceDeps([makeAccount()]);
  const a = seedSample(Samples, { qr_code: "1729000000000000011" });
  const b = seedSample(Samples, { qr_code: "1729000000000000012" });
  lifecycle.dueSchedules = [
    {
      scheduleId: "sched-perm",
      productId: String(a.qr_code),
      sampleId: a.id as number,
      name: String(a.name),
      creator: "@x",
      marketplace: "ebay",
      askPrice: 45,
      listAt: "2026-07-01T00:00:00.000Z",
    },
    {
      scheduleId: "sched-transient",
      productId: String(b.qr_code),
      sampleId: b.id as number,
      name: String(b.name),
      creator: "@x",
      marketplace: "ebay",
      askPrice: 45,
      listAt: "2026-07-01T00:00:00.000Z",
    },
  ];
  client.publishPlan = [
    new MarketplaceError("bad category", { permanent: true }),
    new MarketplaceError("eBay 500", { permanent: false }),
  ];
  const service = createListingService(deps);

  const pass = await service.runAutoListPass();

  const byId = new Map(pass.schedules.map((o) => [o.scheduleId, o]));
  assertEquals(byId.get("sched-perm")?.status, "failed");
  assertEquals(byId.get("sched-transient")?.status, "deferred");
  assertEquals(lifecycle.doneScheduleIds, ["sched-perm"]);
});

Deno.test("schedules for sold samples are burned, not retried forever", async () => {
  const { deps, Samples, lifecycle, client } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples, { status: "sold" });
  lifecycle.dueSchedules = [{
    scheduleId: "sched-sold",
    productId: "",
    sampleId: sample.id as number,
    name: String(sample.name),
    creator: "@x",
    marketplace: "ebay",
    askPrice: 45,
    listAt: "2026-07-01T00:00:00.000Z",
  }];
  const service = createListingService(deps);

  const pass = await service.runAutoListPass();
  assertEquals(pass.schedules[0].status, "failed");
  assertMatch(pass.schedules[0].reason ?? "", /sold/);
  assertEquals(lifecycle.doneScheduleIds, ["sched-sold"]);
  assertEquals(client.publishCalls.length, 0);
});

Deno.test("transient auto-retry failures do not spam listing_failed events", async () => {
  const { deps, Samples, lifecycle, client, store } = makeServiceDeps([
    makeAccount(),
  ]);
  const sample = seedSample(Samples);
  lifecycle.dueSchedules = [{
    scheduleId: "sched-flaky",
    productId: String(sample.qr_code),
    sampleId: sample.id as number,
    name: String(sample.name),
    creator: "@x",
    marketplace: "ebay",
    askPrice: 45,
    listAt: "2026-07-01T00:00:00.000Z",
  }];
  client.publishPlan = [new MarketplaceError("eBay 500", { permanent: false })];
  const service = createListingService(deps);

  await service.runAutoListPass();
  await service.runAutoListPass();

  assertEquals(store.eventsWithField("listing_error_json").length, 0);
  // ... but a permanent failure on the schedule path still writes one.
  client.publishPlan = [
    new MarketplaceError("bad category", { permanent: true }),
  ];
  await service.runAutoListPass();
  assertEquals(store.eventsWithField("listing_error_json").length, 1);
});

Deno.test("schedule firing is capped per pass to drain backlogs gradually", async () => {
  const { deps, Samples, lifecycle } = makeServiceDeps([makeAccount()]);
  lifecycle.dueSchedules = Array.from({ length: 12 }, (_, i) => {
    const sample = seedSample(Samples, {
      qr_code: `17290000000000001${String(i).padStart(2, "0")}`,
    });
    return {
      scheduleId: `sched-${i}`,
      productId: String(sample.qr_code),
      sampleId: sample.id as number,
      name: String(sample.name),
      creator: "@x",
      marketplace: "ebay",
      askPrice: 45,
      listAt: "2026-07-01T00:00:00.000Z",
    };
  });
  const service = createListingService(deps);

  const pass = await service.runAutoListPass();
  const listed = pass.schedules.filter((o) => o.status === "listed");
  const capped = pass.schedules.filter(
    (o) => o.status === "deferred" && /cap/.test(o.reason ?? ""),
  );
  assertEquals(listed.length, 10);
  assertEquals(capped.length, 2);
});

Deno.test("runAutoListPass marks already-listed schedules done as skipped", async () => {
  const { deps, Samples, lifecycle } = makeServiceDeps([makeAccount()]);
  const sample = seedSample(Samples);
  const service = createListingService(deps);
  const listed = await service.listSample({
    sampleId: sample.id as number,
    creator: "@x",
  });
  assert(listed.ok);

  lifecycle.dueSchedules = [{
    scheduleId: "sched-dup",
    productId: String(sample.qr_code),
    sampleId: sample.id as number,
    name: String(sample.name),
    creator: "@x",
    marketplace: "ebay",
    askPrice: 45,
    listAt: "2026-07-01T00:00:00.000Z",
  }];

  const pass = await service.runAutoListPass();
  assertEquals(pass.schedules[0].status, "skipped");
  assertEquals(lifecycle.doneScheduleIds, ["sched-dup"]);
});

Deno.test("status-auto lists cleared_to_sell samples only when opted in", async () => {
  const account = makeAccount({
    settings: { autoListClearedToSell: true, defaultCreator: "@agency" },
  });
  const { deps, Samples, Listings } = makeServiceDeps([account]);
  seedSample(Samples, { qr_code: "1729000000000000021" });
  seedSample(Samples, {
    qr_code: "1729000000000000022",
    status: "checked_out",
  });
  const service = createListingService(deps);

  const pass = await service.runAutoListPass();

  assertEquals(pass.statusAuto.length, 1);
  assertEquals(pass.statusAuto[0].status, "listed");
  assertEquals(Listings.rows.length, 1);
  assertEquals(Listings.rows[0].source, "status-auto");
  assertEquals(Listings.rows[0].creator, "@agency");

  // Second pass: the sample already has a listing row — nothing new happens.
  const again = await service.runAutoListPass();
  assertEquals(again.statusAuto.length, 0);
});

Deno.test("status-auto stays off without the explicit opt-in", async () => {
  const { deps, Samples } = makeServiceDeps([makeAccount()]);
  seedSample(Samples);
  const service = createListingService(deps);

  const pass = await service.runAutoListPass();
  assertEquals(pass.statusAuto.length, 0);
});

Deno.test("status-auto respects autoListMaxPerPass", async () => {
  const account = makeAccount({
    settings: {
      autoListClearedToSell: true,
      defaultCreator: "@agency",
      autoListMaxPerPass: 2,
    },
  });
  const { deps, Samples } = makeServiceDeps([account]);
  for (let i = 0; i < 5; i++) {
    seedSample(Samples, { qr_code: `172900000000000003${i}` });
  }
  const service = createListingService(deps);

  const pass = await service.runAutoListPass();
  assertEquals(pass.statusAuto.length, 2);
});

Deno.test("status-auto reports unlistable samples as skipped", async () => {
  const account = makeAccount({
    settings: { autoListClearedToSell: true, defaultCreator: "@agency" },
  });
  const { deps, Samples, Listings } = makeServiceDeps([account]);
  seedSample(Samples, { picture_url: "" });
  const service = createListingService(deps);

  const pass = await service.runAutoListPass();
  assertEquals(pass.statusAuto[0].status, "skipped");
  assertMatch(pass.statusAuto[0].reason ?? "", /image/);
  assertEquals(Listings.rows.length, 0);
});

Deno.test("status-auto: unlistable samples do not consume the per-pass budget", async () => {
  const account = makeAccount({
    settings: {
      autoListClearedToSell: true,
      defaultCreator: "@agency",
      autoListMaxPerPass: 1,
    },
  });
  const { deps, Samples } = makeServiceDeps([account]);
  // Newest first in the scan: an unlistable sample ahead of a listable one.
  seedSample(Samples, {
    qr_code: "1729000000000000041",
    created_at: "2026-07-01T00:00:00.000Z",
  });
  seedSample(Samples, {
    qr_code: "1729000000000000042",
    picture_url: "",
    created_at: "2026-07-02T00:00:00.000Z",
  });
  const service = createListingService(deps);

  const pass = await service.runAutoListPass();
  const listed = pass.statusAuto.filter((o) => o.status === "listed");
  assertEquals(listed.length, 1, JSON.stringify(pass.statusAuto));
});

Deno.test("verifyMarketplace reports unconfigured and delegated results", async () => {
  const { deps, client } = makeServiceDeps([makeAccount()]);
  const service = createListingService(deps);

  const missing = await service.verifyMarketplace("offerup");
  assertEquals(missing.ok, false);
  assertMatch(missing.detail, /not configured/);

  client.verifyResult = { ok: true, detail: "fake client OK" };
  const ok = await service.verifyMarketplace("ebay");
  assertEquals(ok.ok, true);
});
