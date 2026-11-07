// Scanned-barcode lookup (GET /api/upc-lookup/:upc), ported from data-pimp's
// core/samples.ts lookupProductByUpc. Resolves a UPC to a product name through
// a provider chain, then searches TikTok Shop (ScrapeCreators) for matching
// listings:
//   UPCitemdb → Go-UPC → Barcode Lookup (keyed) → Open Food Facts (free)
//   → Google Shopping (SerpApi, keyed).
// data-pimp's last-resort Google Lens step needs a rendered barcode image
// route (/api/barcode/<upc>.png) that LP-OS doesn't serve yet, so it is not
// ported. Env is injected, like the other shell services.

import { type EnvReader, externalApiEnabled } from "./external-apis.ts";
import {
  fetchWithRetry,
  imageFromScrapeCreators,
  priceFromScrapeCreatorsSearchProduct,
  scrapeCreatorsSearchProducts,
  scrapeCreatorsSearchProductSeller,
  scrapeCreatorsSearchProductTitle,
  scrapeCreatorsSearchProductUrl,
  searchProductScore,
} from "./product-analysis.ts";

const DEFAULT_UPCITEMDB_URL = "https://api.upcitemdb.com/prod/trial/lookup";
const DEFAULT_GOUPC_URL = "https://go-upc.com/api/v1/code";
const DEFAULT_BARCODELOOKUP_URL = "https://api.barcodelookup.com/v3/products";
const DEFAULT_OPENFOODFACTS_URL =
  "https://world.openfoodfacts.org/api/v2/product";
const DEFAULT_SERPAPI_URL = "https://serpapi.com/search.json";
const DEFAULT_SCRAPECREATORS_BASE = "https://api.scrapecreators.com";
const DEFAULT_REGION = "US";

export type UpcItem = {
  title: string;
  brand: string | null;
  category: string | null;
};

export type UpcMatch = {
  productId: string | null;
  name: string | null;
  price: number;
  image: string | null;
  seller: string | null;
  sourceUrl: string | null;
  source?: string | null;
  product?: Record<string, unknown>;
};

export type UpcSource =
  | "upcitemdb"
  | "go-upc"
  | "barcodelookup"
  | "openfoodfacts"
  | "googleshopping";

export type SerpDebug = Record<string, unknown>;

export type UpcLookup = {
  ok: boolean;
  upc: string;
  upcItem?: UpcItem;
  match?: UpcMatch | null;
  candidates?: UpcMatch[];
  error?: string;
  providersTried: UpcSource[];
  source?: UpcSource;
  debug?: SerpDebug;
};

export interface UpcLookupService {
  lookupProductByUpc(
    upc: string,
    opts?: { debug?: boolean },
  ): Promise<UpcLookup>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return value === undefined || value === null || value === ""
    ? null
    : String(value);
}

// Retail noise ("Buy …", "… - Walmart.com") trimmed so the TikTok search gets
// the product, not the storefront.
function cleanTitle(raw: string): string {
  return raw
    .replace(/^\s*(buy|shop|get|order)\s+/i, "")
    .split(/\s+[|–—]\s+|\s+-\s+(?=\S+\.\w{2,}|\w+\.com)/i)[0]
    .replace(/\s+/g, " ")
    .trim();
}

function shoppingCandidate(entry: Record<string, unknown>): UpcMatch {
  const priceObj = isRecord(entry.price) ? entry.price : null;
  const rawPrice = entry.extracted_price ?? priceObj?.extracted_value ??
    priceObj?.value ?? entry.price;
  const price = typeof rawPrice === "number"
    ? rawPrice
    : Number(String(rawPrice ?? "").replace(/[^0-9.]/g, ""));
  return {
    productId: null,
    name: cleanTitle(String(entry.title ?? "")) || null,
    price: Number.isFinite(price) ? price : 0,
    image: str(entry.thumbnail) ?? str(entry.image),
    seller: str(entry.source) ?? str(entry.seller),
    sourceUrl: str(entry.product_link) ?? str(entry.link),
    source: "google_shopping",
    product: entry,
  };
}

// UPC-A (12) and zero-padded EAN-13 (13) forms, as-given first.
export function upcCandidates(upc: string): string[] {
  const out = [upc];
  if (upc.length === 13 && upc.startsWith("0")) out.push(upc.slice(1));
  else if (upc.length === 12) out.push("0" + upc);
  return [...new Set(out)];
}

function productIdFromUrl(sourceUrl: string | undefined): string | null {
  if (!sourceUrl) return null;
  const m = sourceUrl.match(/(\d{6,})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

function matchDedupeKey(m: UpcMatch): string {
  if (m.productId) return `id:${m.productId}`;
  const norm = (v: string | null | undefined) =>
    (v || "").toLowerCase().replace(/\s+/g, " ").trim();
  const name = norm(m.name);
  const seller = norm(m.seller);
  if (name && seller) return `ts:${name}\t${seller}`;
  if (m.sourceUrl) return `url:${m.sourceUrl.toLowerCase()}`;
  return `name:${name}`;
}

// De-dupe and rank best-first: TikTok listings ahead of Shopping listings,
// each group keeping upstream order.
export function rankUpcMatches(matches: UpcMatch[], cap = 10): UpcMatch[] {
  const seen = new Set<string>();
  const deduped: { m: UpcMatch; i: number }[] = [];
  for (const m of matches) {
    const key = matchDedupeKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ m, i: deduped.length });
  }
  const rank = (m: UpcMatch) => (m.source === "tiktok" ? 0 : 1);
  return deduped
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map((x) => x.m)
    .slice(0, cap);
}

// Every ScrapeCreators search product as a candidate: priced first, then by
// title-match score, stable on upstream order.
export function tiktokSearchCandidates(
  body: unknown,
  query: string,
): UpcMatch[] {
  const ranked = scrapeCreatorsSearchProducts(body)
    .map((product, index) => {
      const title = scrapeCreatorsSearchProductTitle(product);
      return {
        product,
        index,
        title,
        price: priceFromScrapeCreatorsSearchProduct(product),
        score: searchProductScore(query, title || ""),
      };
    })
    .filter((e) => e.title);
  ranked.sort((a, b) => {
    const ap = a.price > 0 ? 1 : 0;
    const bp = b.price > 0 ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });
  return ranked.map(({ product, price }) => {
    const url = scrapeCreatorsSearchProductUrl(product);
    return {
      productId: productIdFromUrl(url),
      name: scrapeCreatorsSearchProductTitle(product) ?? null,
      price: price || 0,
      image: imageFromScrapeCreators(product) ?? null,
      seller: scrapeCreatorsSearchProductSeller(product) ?? null,
      sourceUrl: url ?? null,
      source: "tiktok",
      product: isRecord(product) ? product : undefined,
    };
  });
}

export function createUpcLookup(deps: { env: EnvReader }): UpcLookupService {
  const { env } = deps;
  const cache = new Map<string, { value: UpcLookup; expires: number }>();

  // "0" disables caching; unset/non-numeric falls back to the default.
  const ttl = (name: string, fallback: number) => {
    const raw = env(name);
    const n = raw === undefined || raw === "" ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  async function fetchUpcItemDb(upc: string): Promise<UpcItem | null> {
    const url = new URL(env("UPCITEMDB_API_URL") || DEFAULT_UPCITEMDB_URL);
    url.searchParams.set("upc", upc);
    const headers: Record<string, string> = { accept: "application/json" };
    const key = env("UPCITEMDB_API_KEY");
    if (key) {
      headers["user_key"] = key;
      headers["key_type"] = "3scale";
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(
        `UPCitemdb lookup failed: ${res.status} ${await res.text()}`,
      );
    }
    const body = await res.json();
    const item = isRecord(body) && Array.isArray(body.items)
      ? body.items[0]
      : null;
    if (!isRecord(item) || !item.title) return null;
    return {
      title: String(item.title),
      brand: str(item.brand),
      category: str(item.category),
    };
  }

  async function fetchGoUpcItem(upc: string, key: string) {
    const base = (env("GOUPC_API_URL") || DEFAULT_GOUPC_URL).replace(
      /\/+$/,
      "",
    );
    const res = await fetch(`${base}/${encodeURIComponent(upc)}`, {
      headers: { accept: "application/json", authorization: `Bearer ${key}` },
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      throw new Error(
        `Go-UPC lookup failed: ${res.status} ${await res.text()}`,
      );
    }
    const body = await res.json();
    const p = isRecord(body) && isRecord(body.product) ? body.product : null;
    if (!p || !p.name) return null;
    return {
      title: String(p.name),
      brand: str(p.brand),
      category: str(p.category),
    };
  }

  async function fetchBarcodeLookupItem(upc: string, key: string) {
    const url = new URL(
      (env("BARCODELOOKUP_API_URL") || DEFAULT_BARCODELOOKUP_URL).replace(
        /\/+$/,
        "",
      ),
    );
    url.searchParams.set("barcode", upc);
    url.searchParams.set("key", key);
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      throw new Error(
        `Barcode Lookup failed: ${res.status} ${await res.text()}`,
      );
    }
    const body = await res.json();
    const p = isRecord(body) && Array.isArray(body.products)
      ? body.products[0]
      : null;
    if (!isRecord(p)) return null;
    const title = String(p.product_name ?? p.title ?? "").trim();
    if (!title) return null;
    return { title, brand: str(p.brand), category: str(p.category) };
  }

  async function fetchOpenFoodFactsItem(upc: string): Promise<UpcItem | null> {
    const base = (env("OPENFOODFACTS_API_URL") || DEFAULT_OPENFOODFACTS_URL)
      .replace(/\/+$/, "");
    const url = new URL(`${base}/${encodeURIComponent(upc)}.json`);
    url.searchParams.set("fields", "product_name,brands,categories");
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "lp-os/1.0 (+https://thirsty.store)",
      },
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      throw new Error(
        `Open Food Facts lookup failed: ${res.status} ${await res.text()}`,
      );
    }
    const body = await res.json();
    if (!isRecord(body) || body.status !== 1) return null;
    const p = isRecord(body.product) ? body.product : null;
    const title = p?.product_name ? String(p.product_name).trim() : "";
    if (!title) return null;
    const brand = p?.brands
      ? String(p.brands).split(",")[0].trim() || null
      : null;
    const cats = p?.categories
      ? String(p.categories).split(",").map((c) => c.trim()).filter(Boolean)
      : [];
    return {
      title,
      brand,
      category: cats.length ? cats[cats.length - 1] : null,
    };
  }

  async function fetchGoogleShoppingItem(
    upc: string,
    key: string,
    debug: SerpDebug | undefined,
    collect: UpcMatch[],
  ): Promise<UpcItem | null> {
    const url = new URL(env("SERPAPI_API_URL") || DEFAULT_SERPAPI_URL);
    url.searchParams.set("engine", "google_shopping");
    url.searchParams.set("q", upc);
    url.searchParams.set("api_key", key);
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(
        `Google Shopping lookup failed: ${res.status} ${await res.text()}`,
      );
    }
    const body = await res.json();
    if (debug) debug[`google_shopping:${upc}`] = body;
    const results = isRecord(body) && Array.isArray(body.shopping_results)
      ? body.shopping_results
      : [];
    let first: UpcItem | null = null;
    for (const r of results) {
      if (!isRecord(r) || !r.title) continue;
      const title = cleanTitle(String(r.title));
      if (!title) continue;
      if (!first) first = { title, brand: null, category: null };
      collect.push(shoppingCandidate(r));
    }
    return first;
  }

  async function fetchUpcItem(upc: string, debug: boolean) {
    const forms = upcCandidates(upc);
    const providersTried: UpcSource[] = [];
    const debugInfo: SerpDebug | undefined = debug ? {} : undefined;
    const serpCandidates: UpcMatch[] = [];
    let primaryError: unknown = null;
    let anyAnswered = false;

    const run = async (
      source: UpcSource,
      fn: (u: string) => Promise<UpcItem | null>,
    ): Promise<UpcItem | null> => {
      providersTried.push(source);
      let answered = false;
      let firstError: unknown = null;
      for (const form of forms) {
        try {
          const item = await fn(form);
          answered = true;
          if (item) return item;
        } catch (error) {
          if (firstError === null) firstError = error;
        }
      }
      if (answered) anyAnswered = true;
      else if (firstError !== null && primaryError === null) {
        primaryError = firstError;
      }
      return null;
    };

    const done = (item: UpcItem | null, source: UpcSource | null) => ({
      item,
      source,
      providersTried,
      debug: debugInfo,
      candidates: serpCandidates,
    });

    let item = await run("upcitemdb", fetchUpcItemDb);
    if (item) return done(item, "upcitemdb");

    const goUpcKey = env("GOUPC_API_KEY");
    if (goUpcKey) {
      item = await run("go-upc", (u) => fetchGoUpcItem(u, goUpcKey));
      if (item) return done(item, "go-upc");
    }

    const blKey = env("BARCODELOOKUP_API_KEY");
    if (blKey && externalApiEnabled(env, "barcodelookup")) {
      item = await run(
        "barcodelookup",
        (u) => fetchBarcodeLookupItem(u, blKey),
      );
      if (item) return done(item, "barcodelookup");
    }

    item = await run("openfoodfacts", fetchOpenFoodFactsItem);
    if (item) return done(item, "openfoodfacts");

    const serpKey = env("SERPAPI_API_KEY");
    if (serpKey) {
      item = await run(
        "googleshopping",
        (u) => fetchGoogleShoppingItem(u, serpKey, debugInfo, serpCandidates),
      );
      if (item) return done(item, "googleshopping");
    }

    // Every provider errored → surface it (route returns 502); otherwise a
    // clean miss.
    if (!anyAnswered && primaryError) throw primaryError;
    return done(null, null);
  }

  // Never throws: a TikTok miss must not fail the lookup. `errored` flags a
  // transient ScrapeCreators failure so it's cached briefly.
  async function resolveTiktokByName(
    name: string,
  ): Promise<{ candidates: UpcMatch[]; errored: boolean }> {
    if (!externalApiEnabled(env, "scrapecreators")) {
      return { candidates: [], errored: false };
    }
    const apiKey = env("SCRAPECREATORS_API_KEY") || env("API_KEY");
    const query = name.replace(/\s+/g, " ").trim();
    if (!apiKey || !query) return { candidates: [], errored: false };
    const base = (env("SCRAPECREATORS_API_BASE") || DEFAULT_SCRAPECREATORS_BASE)
      .replace(/\/+$/, "");
    const url = new URL(`${base}/v1/tiktok/shop/search`);
    url.searchParams.set("query", query);
    url.searchParams.set(
      "region",
      env("SCRAPECREATORS_REGION") || DEFAULT_REGION,
    );
    try {
      const res = await fetchWithRetry(url, {
        headers: { accept: "application/json", "x-api-key": apiKey },
      });
      if (!res.ok) {
        await res.body?.cancel();
        return { candidates: [], errored: true };
      }
      return {
        candidates: tiktokSearchCandidates(await res.json(), query),
        errored: false,
      };
    } catch {
      return { candidates: [], errored: true };
    }
  }

  async function compute(
    upc: string,
    debug: boolean,
  ): Promise<{ lookup: UpcLookup; errored: boolean }> {
    const { item, source, providersTried, debug: dbg, candidates: serp } =
      await fetchUpcItem(upc, debug);
    if (!item) {
      return {
        lookup: {
          ok: false,
          upc,
          error: "No product found for that UPC",
          providersTried,
          debug: dbg,
          candidates: [],
          match: null,
        },
        errored: false,
      };
    }
    const query = [item.brand, item.title].filter(Boolean).join(" ")
      .replace(/\s+/g, " ").trim();
    const { candidates: tiktok, errored } = await resolveTiktokByName(
      query || item.title,
    );
    const candidates = rankUpcMatches([...tiktok, ...serp], 10);
    return {
      lookup: {
        ok: true,
        upc,
        upcItem: item,
        providersTried,
        source: source ?? undefined,
        debug: dbg,
        candidates,
        match: candidates[0] ?? null,
      },
      errored,
    };
  }

  async function lookupProductByUpc(
    upc: string,
    opts: { debug?: boolean } = {},
  ): Promise<UpcLookup> {
    const clean = String(upc || "").replace(/\D/g, "");
    if (!clean) throw new Error("upc is required");
    const debug = Boolean(opts.debug);
    if (!debug) {
      const hit = cache.get(clean);
      if (hit && hit.expires > Date.now()) return hit.value;
    }
    const { lookup, errored } = await compute(clean, debug);
    if (!debug) {
      const life = errored || !lookup.ok
        ? ttl("LOOKUP_CACHE_NEG_TTL_MS", 60 * 60 * 1000)
        : ttl("LOOKUP_CACHE_TTL_MS", 24 * 60 * 60 * 1000);
      if (life > 0) {
        cache.set(clean, { value: lookup, expires: Date.now() + life });
      }
    }
    return lookup;
  }

  return { lookupProductByUpc };
}
