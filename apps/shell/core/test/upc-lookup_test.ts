import { assertEquals } from "@std/assert";
import { createUpcLookup, upcCandidates } from "../upc-lookup.ts";

Deno.test("upcCandidates covers UPC-A and EAN-13 forms", () => {
  assertEquals(upcCandidates("0860013752903"), [
    "0860013752903",
    "860013752903",
  ]);
  assertEquals(upcCandidates("860013752903"), [
    "860013752903",
    "0860013752903",
  ]);
});

Deno.test("lookupProductByUpc: UPCitemdb hit → ranked TikTok candidates", async () => {
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.includes("upcitemdb")) {
      return Promise.resolve(Response.json({
        items: [{ title: "Glow Serum", brand: "Acme", category: "Beauty" }],
      }));
    }
    if (url.includes("scrapecreators")) {
      return Promise.resolve(Response.json({
        products: [{
          title: "Acme Glow Serum",
          product_id: "1729000000000000001",
          seo_url:
            "https://www.tiktok.com/shop/pdp/acme-glow-serum/1729000000000000001",
          product_price_info: { sale_price_decimal: "19.99" },
        }],
      }));
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as typeof fetch;
  try {
    const env = (n: string) =>
      ({ SCRAPECREATORS_API_KEY: "k" } as Record<string, string>)[n];
    const svc = createUpcLookup({ env });
    const r = await svc.lookupProductByUpc("0860013752903");
    assertEquals(r.ok, true);
    assertEquals(r.source, "upcitemdb");
    assertEquals(r.upcItem?.title, "Glow Serum");
    assertEquals(r.match?.source, "tiktok");
    // cached: a second call makes no new requests
    const before = seen.length;
    await svc.lookupProductByUpc("0860013752903");
    assertEquals(seen.length, before);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("lookupProductByUpc: all providers miss → ok:false", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("upcitemdb")) {
      return Promise.resolve(Response.json({ items: [] }));
    }
    return Promise.resolve(Response.json({ status: 0 }));
  }) as typeof fetch;
  try {
    const r = await createUpcLookup({ env: () => undefined })
      .lookupProductByUpc("123456789012");
    assertEquals(r.ok, false);
    assertEquals(r.providersTried, ["upcitemdb", "openfoodfacts"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("lookupProductByUpc: cache is bounded and evicts the oldest entry", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("upcitemdb")) {
      calls++;
      return Promise.resolve(Response.json({ items: [{ title: "Thing" }] }));
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as typeof fetch;
  try {
    const svc = createUpcLookup({ env: () => undefined, cacheMaxEntries: 2 });
    await svc.lookupProductByUpc("111111111111");
    await svc.lookupProductByUpc("222222222222");
    await svc.lookupProductByUpc("333333333333"); // evicts 111…
    const afterFill = calls;
    await svc.lookupProductByUpc("333333333333"); // still cached
    assertEquals(calls, afterFill);
    await svc.lookupProductByUpc("111111111111"); // evicted → refetched
    assertEquals(calls, afterFill + 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
