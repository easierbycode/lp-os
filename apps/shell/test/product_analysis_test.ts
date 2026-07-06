// Unit tests for core/product-analysis.ts against a fake GraylogStore. These
// lock in the store adaptation from data-pimp: search rows arrive wrapped in
// {message, index} (and must be unwrapped), price edits are recovered from
// sample_edit_json events (newest updatedAt wins), and writes go through
// store.logEvent — persistedTo is ["graylog"], there is no file store.

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { GraylogStore, SearchParams, SearchResult } from "@lp-os/graylog";
import {
  comparisonSignal,
  createProductAnalysis,
} from "../core/product-analysis.ts";

const noEnv = (_name: string) => undefined;

// Mirrors the real store closely enough for the module's two query shapes
// ("rows_json:* OR core_data_json:*" and "sample_edit_json:*"): field-existence
// matching plus the fields whitelist (timestamp + source always kept).
class FakeStore implements GraylogStore {
  rows: Record<string, unknown>[] = [];
  events: { shortMessage: string; fields: Record<string, unknown> }[] = [];
  logEventResult = true;

  ingestGelf(_body: unknown): Promise<{ ok: boolean; id?: string }> {
    return Promise.resolve({ ok: true, id: "fake" });
  }

  logEvent(
    shortMessage: string,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    this.events.push({ shortMessage, fields });
    return Promise.resolve(this.logEventResult);
  }

  search(p: SearchParams): Promise<SearchResult> {
    const wanted = [...(p.query ?? "").matchAll(/([A-Za-z_]+):\*/g)]
      .map((m) => m[1]);
    const whitelist = p.fields && p.fields.length ? p.fields : null;
    const hits = this.rows.filter((row) => wanted.some((f) => f in row));
    const messages = hits.map((row) => {
      let m = row;
      if (whitelist) {
        const keep: Record<string, unknown> = {
          timestamp: row.timestamp,
          source: row.source,
        };
        for (const f of whitelist) if (f in row) keep[f] = row[f];
        m = keep;
      }
      return { message: m, index: "graylog_pg" };
    });
    return Promise.resolve({
      messages,
      total_results: messages.length,
      from: new Date(0).toISOString(),
      to: new Date().toISOString(),
      fields: [],
      used_indices: ["graylog_pg"],
      time: 0,
      windowMinMs: null,
    });
  }

  newestTimestampMs(): Promise<number | null> {
    return Promise.resolve(null);
  }
}

function productMessage(
  timestamp: string,
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    timestamp,
    source: "tiktok-bookmarklet",
    rows_json: JSON.stringify(rows),
  };
}

function editMessage(edit: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: edit.updatedAt,
    source: "thirsty-store-kiosk",
    sample_edit_json: JSON.stringify(edit),
  };
}

function seededStore(): FakeStore {
  const store = new FakeStore();
  store.rows = [
    productMessage("2026-07-01T00:00:00.000Z", [
      {
        product_id: "111",
        product_name: "Alpha Drops",
        min_sku_original_price: 0,
        sample_count: 2,
        category: "Beauty",
        category_rank: 5,
        creators_count: 1,
        videos_count: 60,
        gmv: 2000,
      },
      {
        product_id: "222",
        product_name: "Beta Serum",
        min_sku_original_price: 12.5,
        sample_count: 1,
        category: "Beauty",
        category_rank: 40,
        creators_count: 9,
        videos_count: 10,
        gmv: 500,
      },
    ]),
    // Two edits for 222 — the newer updatedAt must win.
    editMessage({
      productId: "222",
      price: 5,
      source: "manual",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }),
    editMessage({
      productId: "222",
      price: 20,
      source: "manual",
      updatedAt: "2026-07-02T00:00:00.000Z",
    }),
  ];
  return store;
}

Deno.test("listUnpricedSamples unwraps store rows and merges newest edit", async () => {
  const svc = createProductAnalysis({ store: seededStore(), env: noEnv });
  const list = await svc.listUnpricedSamples();

  // 111 is unpriced backlog; 222 is priced-but-edited so it stays in the set.
  assertEquals(list.total, 2);
  assertEquals(list.unpricedCount, 1);
  assertEquals(list.pricedCount, 1);
  assertEquals(list.items.map((i) => i.productId), ["111", "222"]);

  const beta = list.items.find((i) => i.productId === "222");
  assert(beta);
  assertEquals(beta.price, 20); // newest edit, not 5 and not the scraped 12.5
  assertEquals(beta.originalPrice, 12.5);
  assertEquals(beta.priced, true);
  assertEquals(beta.sampleValue, 20);

  // JS-side query filter (never SQL).
  const filtered = await svc.listUnpricedSamples("alpha");
  assertEquals(filtered.items.map((i) => i.productId), ["111"]);
});

Deno.test("updateSamplePrice writes a sample_edit_json event → graylog", async () => {
  const store = seededStore();
  const svc = createProductAnalysis({ store, env: noEnv });
  const saved = await svc.updateSamplePrice("111", {
    price: "10",
    sampleCount: 3,
    notes: " hi ",
  });

  assertEquals(saved.price, 10);
  assertEquals(saved.sampleCount, 3);
  assertEquals(saved.sampleValue, 30);
  assertEquals(saved.priced, true);
  assertEquals(saved.notes, "hi");
  assertEquals(saved.source, "manual");
  assertEquals(saved.persistedTo, ["graylog"]);

  assertEquals(store.events.length, 1);
  const event = store.events[0];
  assertEquals(event.shortMessage, "thirsty sample price: Alpha Drops");
  assertEquals(event.fields.sample_source, "manual");
  const edit = JSON.parse(String(event.fields.sample_edit_json));
  assertEquals(edit.productId, "111");
  assertEquals(edit.price, 10);
});

Deno.test("updateSamplePrice rejects unknown products and failed writes", async () => {
  const store = seededStore();
  const svc = createProductAnalysis({ store, env: noEnv });
  await assertRejects(
    () => svc.updateSamplePrice("999", { price: 1 }),
    Error,
    "was not found in Graylog",
  );

  store.logEventResult = false;
  await assertRejects(
    () => svc.updateSamplePrice("111", { price: 1 }),
    Error,
    "Could not persist sample data to Graylog",
  );
});

Deno.test("fetchProductWithEdits applies the recovered price", async () => {
  const svc = createProductAnalysis({ store: seededStore(), env: noEnv });
  const product = await svc.fetchProductWithEdits("222");
  assert(product);
  assertEquals(product.min_sku_original_price, 20);
  assertEquals(product.priceRange, "$20.00");
  assertEquals(product.estimatedRetailValue, 20);

  assertEquals(await svc.fetchProductWithEdits("999"), null);
});

Deno.test("fetchComparisonWithEdits ranks by category rank and signals", async () => {
  const svc = createProductAnalysis({ store: seededStore(), env: noEnv });
  const rows = await svc.fetchComparisonWithEdits();
  assertEquals(rows.map((r) => r.productId), ["111", "222"]);
  assertEquals(rows[0].signal, "Under-posted"); // rank 5, 1 creator, 60 videos
  assertEquals(rows[1].signal, "Over-posted"); // 9 creators, gmv < 1000
  assertEquals(rows[1].sampleValue, 20); // edited price feeds the comparison
});

Deno.test("fetchPriceForSample without an API key → clean error", async () => {
  const svc = createProductAnalysis({ store: seededStore(), env: noEnv });
  assertEquals(svc.scrapeCreatorsConfigured(), false);
  await assertRejects(
    () => svc.fetchPriceForSample("111"),
    Error,
    "SCRAPECREATORS_API_KEY is not configured",
  );
});

Deno.test("degrades to empty results without a store", async () => {
  const svc = createProductAnalysis({ store: null, env: noEnv });
  assertEquals(await svc.listUnpricedSamples(), {
    items: [],
    total: 0,
    unpricedCount: 0,
    pricedCount: 0,
  });
  assertEquals(await svc.fetchProductWithEdits("111"), null);
  assertEquals(await svc.fetchComparisonWithEdits(), []);
});

Deno.test("comparisonSignal thresholds", () => {
  assertEquals(comparisonSignal(5, 1, 60, 2000), "Under-posted");
  assertEquals(comparisonSignal(null, 9, 10, 500), "Over-posted");
  assertEquals(comparisonSignal(20, 3, 10, 5000), "Priority");
  assertEquals(comparisonSignal(null, 0, 0, 0), "Watch");
});
