// Product Analysis backend (the /inventory dashboard), ported from data-pimp
// core/samples.ts plus the product-parsing half of core/graylog.ts. Only what
// the five dashboard endpoints need: the Graylog product-set fetch/parse
// (rows_json / core_data_json / summary_json scrapes), the sample_edit_json
// price-edit merge, the recovery-queue list/update, the ScrapeCreators price
// lookup, and the comparison engine.
//
// Adaptations from data-pimp, by design:
// - The data source is the LP-OS Graylog store (graylog_messages in Postgres)
//   via the injected GraylogStore, not an external Graylog REST API.
//   store.search wraps each row in {message, index} — searchFlat unwraps, or
//   every parse would silently see empties.
// - Writes go through store.logEvent with the same field shapes as the GELF
//   messages data-pimp sent; the .thirsty/sample-prices.json file store is
//   dropped entirely (Postgres is durable), so persistedTo is ["graylog"].
// - sample_edit_json records are read all-time rather than the 30-day product
//   window: without the file-store copy, a windowed read would silently revert
//   any price edited before the window.

import type { GraylogStore } from "@lp-os/graylog";
import { externalApiEnabled, requireExternalApi } from "./external-apis.ts";

/* ---------------------------------------------------------------- types -- */

export type EnvReader = (name: string) => string | undefined;

export type ProductAnalysis = {
  productId: string;
  name: string;
  priceRange: string;
  min_sku_original_price: number;
  category: string;
  categoryRank: number | null;
  seller: string;
  creators: number;
  liveStreams: number;
  videos: number;
  gmv: number;
  customers: number;
  quantity: number;
  skuOrders: number;
  refunds: number;
  unitsRefunded: number;
  sampleCount: number;
  estimatedRetailValue: number;
  lastSeen: string | null;
  image?: string | null;
};

export type ComparisonRow = {
  productId: string;
  name: string;
  category: string;
  rank: number | null;
  creatorVideos: number;
  platformVideos: number;
  sales: number;
  min_sku_original_price: number;
  sampleValue: number;
  signal: string;
};

export type SamplePriceEdit = {
  productId: string;
  price: number;
  sampleCount?: number;
  notes?: string;
  source: "manual" | "scrapecreators" | "extension";
  sourceUrl?: string;
  apiTitle?: string;
  apiSeller?: string;
  fetchedAt?: string;
  updatedAt: string;
};

export type UnpricedSample = {
  productId: string;
  name: string;
  originalPrice: number;
  price: number;
  sampleCount: number;
  sampleValue: number;
  gmv: number;
  quantity: number;
  lastSeen: string | null;
  notes: string;
  source: string;
  sourceUrl: string | null;
  apiTitle: string | null;
  apiSeller: string | null;
  fetchedAt: string | null;
  updatedAt: string | null;
  priced: boolean;
  image: string | null;
  persistedTo?: string[];
};

export type UnpricedSampleList = {
  items: UnpricedSample[];
  total: number;
  unpricedCount: number;
  pricedCount: number;
};

export type SampleUpdateInput = {
  price?: unknown;
  sampleCount?: unknown;
  notes?: unknown;
  source?: unknown;
  sourceUrl?: unknown;
  apiTitle?: unknown;
  apiSeller?: unknown;
  fetchedAt?: unknown;
};

type ScrapeCreatorsPrice = {
  price: number;
  sourceUrl: string;
  title?: string;
  seller?: string;
  image?: string;
  product?: Record<string, unknown>;
};

export interface ProductAnalysisService {
  listUnpricedSamples(
    query?: string,
    limit?: number,
  ): Promise<UnpricedSampleList>;
  updateSamplePrice(
    productId: string,
    input: SampleUpdateInput,
  ): Promise<UnpricedSample>;
  fetchPriceForSample(productId: string): Promise<UnpricedSample>;
  fetchProductWithEdits(productId: string): Promise<ProductAnalysis | null>;
  fetchComparisonWithEdits(): Promise<ComparisonRow[]>;
  scrapeCreatorsConfigured(): boolean;
}

/* ------------------------------------------------------------ constants -- */

const DEFAULT_SCRAPECREATORS_BASE = "https://api.scrapecreators.com";
const DEFAULT_REGION = "US";
// Continuity with the data already in the store: data-pimp's GELF writes all
// carried this host, and packages/lifecycle keeps stamping it too.
const GRAYLOG_SOURCE = "thirsty-store-kiosk";

const PRODUCT_ID_FIELDS = [
  "Product ID",
  "productId",
  "product_id",
  "tiktok_product_id",
  "tikTokProductId",
  "tt_product_id",
  "product.id",
  "productId.keyword",
];

const PRODUCT_NAME_FIELDS = [
  "Product",
  "Product Name",
  "name",
  "product_name",
  "productName",
  "title",
  "product_title",
  "productTitle",
  "product.name",
];

const MIN_PRICE_FIELDS = [
  "Min SKU Original Price",
  "Price",
  "min_sku_original_price",
  "minSkuOriginalPrice",
  "min_original_price",
  "minimum_original_price",
  "sku_original_price",
  "original_price",
  "retail_price",
  "msrp",
];

const SAMPLE_COUNT_FIELDS = [
  "Sample Count",
  "sample_count",
  "sampleCount",
  "samples",
  "quantity_available",
  "quantityAvailable",
  "available_samples",
];

const SEARCH_FIELDS = [
  "timestamp",
  "source",
  "message",
  "full_message",
  "core_data_json",
  "rows_json",
  "summary_json",
  "Product",
  "Product ID",
  "GMV",
  "Estimated commission",
  "Items sold",
  "productId",
  "product_id",
  "product_name",
  "min_sku_original_price",
  "category",
  "category_rank",
  "seller",
  "creator",
  "creators_count",
  "videos_count",
  "recent_livestreams_count",
  "gmv_direct",
  "gmv_affiliate",
  "items_sold",
  "scrapedAt",
];

/* -------------------------------------------------------------- factory -- */

export function createProductAnalysis(deps: {
  store: GraylogStore | null;
  env: EnvReader;
}): ProductAnalysisService {
  const { store, env } = deps;

  function productQuery(): string {
    return env("GRAYLOG_PRODUCT_QUERY") || "rows_json:* OR core_data_json:*";
  }

  function productRangeSeconds(): number {
    return cellNumber(env("GRAYLOG_RANGE_SECONDS"), 60 * 60 * 24 * 30);
  }

  // store.search wraps every row in {message, index}; data-pimp's searchGraylog
  // returned flat records. Unwrap here so the parsers below port unchanged.
  async function searchFlat(
    query: string,
    rangeSeconds: number,
    limit: number,
    fields: string[],
  ): Promise<Record<string, unknown>[]> {
    if (!store) return [];
    const result = await store.search({ query, rangeSeconds, limit, fields });
    return result.messages.map((m) => m.message);
  }

  async function fetchRecentProducts(
    limit: number,
  ): Promise<ProductAnalysis[]> {
    if (!store) return []; // unconfigured store degrades to an empty set

    const messageLimit = Math.max(25, Math.min(limit, 500));
    const messages = await searchFlat(
      productQuery(),
      productRangeSeconds(),
      messageLimit,
      SEARCH_FIELDS,
    );
    const products = new Map<string, ProductAnalysis>();

    for (const record of productRecordsFromMessages(messages)) {
      const product = normalizeProduct(record);
      if (!product) continue;

      const existing = products.get(product.productId);
      products.set(
        product.productId,
        existing ? mergeProduct(existing, product) : product,
      );
    }

    return [...products.values()]
      .sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""))
      .slice(0, limit);
  }

  // The durable price edits (sample_edit_json events), newest updatedAt per
  // product winning. Errors degrade to "no recovered edits" so reads still work.
  async function loadEdits(): Promise<Record<string, SamplePriceEdit>> {
    const edits: Record<string, SamplePriceEdit> = {};
    try {
      const messages = await searchFlat("sample_edit_json:*", 0, 500, [
        "timestamp",
        "sample_edit_json",
      ]);
      for (const message of messages) {
        const record = parseJsonValue(message.sample_edit_json);
        if (!isRecord(record)) continue;
        const edit = editFromRecord(record);
        if (!edit) continue;

        const existing = edits[edit.productId];
        if (!existing || edit.updatedAt > (existing.updatedAt || "")) {
          edits[edit.productId] = edit;
        }
      }
    } catch {
      // Graylog being unreachable must not take the queue down.
    }
    for (const productId of Object.keys(edits)) {
      edits[productId] = withoutAutoExtensionNote(edits[productId]);
    }
    return edits;
  }

  // Replaces data-pimp's sendGelfMessage: strip null/undefined/empty values so
  // the stored field set is identical, stamp the continuity source, never throw.
  async function persistEvent(
    shortMessage: string,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    if (!store) return false;
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

  // Every tracked sample that still needs a price or already carries one — the
  // backlog the dashboard counts as "unpriced + priced".
  async function sampleProducts(
    edits: Record<string, SamplePriceEdit>,
  ): Promise<UnpricedSample[]> {
    const products = await fetchRecentProducts(1000);
    return products
      .filter((product) => product.sampleCount > 0)
      .filter((product) =>
        product.min_sku_original_price <= 0 || edits[product.productId]
      )
      .map((product) => sampleFromProduct(product, edits[product.productId]));
  }

  async function listUnpricedSamples(
    query = "",
    limit = 100,
  ): Promise<UnpricedSampleList> {
    const edits = await loadEdits();
    const normalizedQuery = query.trim().toLowerCase();
    const items = (await sampleProducts(edits))
      .filter((sample) => matchesQuery(sample, normalizedQuery))
      .sort((a, b) =>
        Number(a.priced) - Number(b.priced) || a.name.localeCompare(b.name)
      );

    const total = items.length;
    const unpricedCount = items.filter((item) => !item.priced).length;

    // Samples the user has already priced sort below the unpriced backlog, so a
    // plain slice(0, limit) would drop a freshly priced row off the end whenever
    // the backlog exceeds the limit. Always keep edited samples in the page; the
    // limit only bounds how much of the unpriced backlog we return.
    const edited = items.filter((item) => edits[item.productId]);
    const backlog = items.filter((item) => !edits[item.productId]);
    const visible = [
      ...edited,
      ...backlog.slice(0, Math.max(0, limit - edited.length)),
    ].sort((a, b) =>
      Number(a.priced) - Number(b.priced) || a.name.localeCompare(b.name)
    );

    return {
      items: visible,
      total,
      unpricedCount,
      pricedCount: total - unpricedCount,
    };
  }

  async function updateSamplePrice(
    productId: string,
    input: SampleUpdateInput,
  ): Promise<UnpricedSample> {
    const edits = await loadEdits();
    const products = await fetchRecentProducts(1000);
    const product = products.find((item) => item.productId === productId);
    if (!product) {
      throw new Error(`Product ${productId} was not found in Graylog`);
    }

    const existing = edits[productId];
    const now = new Date().toISOString();
    const price = input.price === undefined
      ? existing?.price ?? 0
      : numericInput(input.price, "price");
    const sampleCount = input.sampleCount === undefined
      ? existing?.sampleCount
      : numericInput(input.sampleCount, "sample count");
    const notes = input.notes === undefined
      ? existing?.notes
      : String(input.notes || "").trim();
    // A confirmed ScrapeCreators price saves through here too, carrying the
    // fetched provenance so the row keeps its "API" source tag after saving.
    const fromApi = input.source === "scrapecreators";

    const edit: SamplePriceEdit = {
      productId,
      price,
      sampleCount,
      notes,
      source: fromApi ? "scrapecreators" : "manual",
      sourceUrl: fromApi
        ? optionalString(input.sourceUrl) ?? existing?.sourceUrl
        : undefined,
      apiTitle: fromApi
        ? optionalString(input.apiTitle) ?? existing?.apiTitle
        : undefined,
      apiSeller: fromApi
        ? optionalString(input.apiSeller) ?? existing?.apiSeller
        : undefined,
      fetchedAt: fromApi
        ? optionalString(input.fetchedAt) ?? existing?.fetchedAt ?? now
        : undefined,
      updatedAt: now,
    };
    const ok = await persistEvent(`thirsty sample price: ${product.name}`, {
      sample_source: edit.source,
      sample_edit_json: JSON.stringify(edit),
    });
    if (!ok) {
      throw new Error("Could not persist sample data to Graylog");
    }

    return { ...sampleFromProduct(product, edit), persistedTo: ["graylog"] };
  }

  async function fetchPriceForSample(
    productId: string,
  ): Promise<UnpricedSample> {
    // Kill switch first — don't even resolve the sample when the operator
    // turned ScrapeCreators off (EXTERNAL_API_SCRAPECREATORS=off).
    requireExternalApi(env, "scrapecreators");
    const edits = await loadEdits();
    const products = await fetchRecentProducts(1000);
    const product = products.find((item) => item.productId === productId);
    if (!product) {
      throw new Error(`Product ${productId} was not found in Graylog`);
    }

    const lookup = await fetchScrapeCreatorsPrice(product);
    if (lookup.price <= 0) {
      throw new Error("ScrapeCreators returned no usable price");
    }

    const now = new Date().toISOString();

    // The lookup response is the only place the entire product (title, seller,
    // images, skus) ever appears, so persist all of it right away — otherwise
    // the data is gone the moment the user dismisses the price confirm. The
    // price itself still goes through the preview/confirm flow; the saved
    // product row keeps its original price so the sample stays in the queue.
    const enriched: ProductAnalysis = {
      ...product,
      name: lookup.title || product.name,
      seller: lookup.seller || product.seller,
      image: lookup.image ?? product.image ?? null,
      lastSeen: now,
    };
    // Best-effort: a failed product save must not eat the looked-up price — the
    // client can still preview it and confirm, which persists via PATCH.
    const saved = await persistEvent(
      `thirsty product lookup: ${enriched.name}`,
      {
        sample_source: "scrapecreators",
        product_json: scrapeCreatorsProductJson(lookup.product),
        core_data_json: JSON.stringify({
          productId,
          name: enriched.name,
          min_sku_original_price: product.min_sku_original_price,
          sample_count: enriched.sampleCount,
          category: enriched.category,
          seller: enriched.seller,
          image: enriched.image,
          estimated_retail_value: enriched.estimatedRetailValue,
          scrapedAt: now,
        }),
      },
    );

    const existing = edits[productId];
    const proposed: SamplePriceEdit = {
      productId,
      price: lookup.price,
      sampleCount: existing?.sampleCount,
      notes: existing?.notes,
      source: "scrapecreators",
      sourceUrl: lookup.sourceUrl,
      apiTitle: lookup.title,
      apiSeller: lookup.seller,
      fetchedAt: now,
      updatedAt: now,
    };

    return {
      ...sampleFromProduct(enriched, proposed),
      persistedTo: saved ? ["graylog"] : [],
    };
  }

  async function fetchProductWithEdits(
    productId: string,
  ): Promise<ProductAnalysis | null> {
    const edits = await loadEdits();
    const products = await fetchRecentProducts(1000);
    const product = products.find((item) => item.productId === productId);
    if (!product) return null;

    // The product-detail view reads raw Graylog data, so a price recovered via
    // Save or Fetch API (stored as an edit) would otherwise never show here even
    // though the sample queue reflects it. Apply the edit so both views agree.
    return productWithEdit(product, edits[productId]);
  }

  async function fetchComparisonWithEdits(): Promise<ComparisonRow[]> {
    const edits = await loadEdits();
    const products = await fetchRecentProducts(200);

    return products
      .map((product) => {
        const sample = sampleFromProduct(product, edits[product.productId]);
        const creatorVideos = product.creators || product.videos || 0;
        const platformVideos = product.videos || 0;
        const rank = product.categoryRank;

        return {
          productId: product.productId,
          name: sample.name,
          category: product.category,
          rank,
          creatorVideos,
          platformVideos,
          sales: product.gmv,
          min_sku_original_price: sample.price,
          sampleValue: sample.sampleValue,
          signal: comparisonSignal(
            rank,
            creatorVideos,
            platformVideos,
            product.gmv,
          ),
        };
      })
      .sort((a, b) => {
        const aRank = a.rank ?? 999999;
        const bRank = b.rank ?? 999999;
        return aRank - bRank || b.sampleValue - a.sampleValue;
      });
  }

  /* --------------------------------------------- ScrapeCreators client -- */

  function apiKey(): string | undefined {
    return env("SCRAPECREATORS_API_KEY") || env("API_KEY");
  }

  async function fetchScrapeCreatorsPrice(
    product: ProductAnalysis,
  ): Promise<ScrapeCreatorsPrice> {
    requireExternalApi(env, "scrapecreators");
    const key = apiKey();
    if (!key) throw new Error("SCRAPECREATORS_API_KEY is not configured");

    const base = (env("SCRAPECREATORS_API_BASE") || DEFAULT_SCRAPECREATORS_BASE)
      .replace(/\/+$/, "");
    const region = env("SCRAPECREATORS_REGION") || DEFAULT_REGION;

    // Synthetic "9"-prefixed ids never map to a real PDP, so go straight to the
    // name search.
    if (product.productId.startsWith("9")) {
      return fetchScrapeCreatorsPriceByName(base, key, region, product);
    }

    // Prefer the by-URL lookup — when it works it returns the exact PDP's
    // price. But that endpoint is flaky (intermittent 500s on products it can
    // otherwise resolve) and some products never resolve, so fall back to the
    // name search instead of failing the whole request. The fallback may match
    // a different listing for the same product, which still beats no price.
    try {
      const byUrl = await fetchScrapeCreatorsPriceByUrl(
        base,
        key,
        region,
        product,
      );
      if (byUrl.price > 0) return byUrl;
    } catch (error) {
      console.error(
        "ScrapeCreators by-url lookup failed; trying name search:",
        error,
      );
    }

    return fetchScrapeCreatorsPriceByName(base, key, region, product);
  }

  return {
    listUnpricedSamples,
    updateSamplePrice,
    fetchPriceForSample,
    fetchProductWithEdits,
    fetchComparisonWithEdits,
    scrapeCreatorsConfigured: () =>
      externalApiEnabled(env, "scrapecreators") && Boolean(apiKey()),
  };
}

/* ------------------------------------------- ScrapeCreators primitives -- */

// Retry transient ScrapeCreators failures (5xx/429) a few times with linear
// backoff. Their endpoints occasionally fault on requests they can otherwise
// serve, and a short retry recovers the accurate result.
async function fetchWithRetry(
  url: URL,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let response!: Response;
  for (let attempt = 0; attempt < attempts; attempt++) {
    response = await fetch(url, init);
    if (response.status < 500 && response.status !== 429) return response;
    if (attempt < attempts - 1) {
      // Drain the unused body so the connection can be reused, then back off.
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  return response;
}

async function fetchScrapeCreatorsPriceByUrl(
  base: string,
  apiKey: string,
  region: string,
  product: ProductAnalysis,
): Promise<ScrapeCreatorsPrice> {
  const productUrl = tiktokProductUrl(product);
  const url = new URL(`${base}/v1/tiktok/product`);
  url.searchParams.set("url", productUrl);
  url.searchParams.set("region", region);

  const response = await fetchWithRetry(url, {
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(
      `ScrapeCreators lookup failed: ${response.status} ${await response
        .text()}`,
    );
  }

  const body = await response.json();
  const price = priceFromScrapeCreators(body);

  return {
    price,
    sourceUrl: productUrl,
    title: stringAt(body, ["product_info", "product_base", "title"]) ||
      stringAt(body, ["product_base", "title"]),
    seller: stringAt(body, ["product_info", "seller", "name"]) ||
      stringAt(body, ["seller", "name"]) ||
      stringAt(body, ["shop_info", "shop_name"]),
    image: imageFromScrapeCreators(body),
    product: isRecord(body) ? body : undefined,
  };
}

async function fetchScrapeCreatorsPriceByName(
  base: string,
  apiKey: string,
  region: string,
  product: ProductAnalysis,
): Promise<ScrapeCreatorsPrice> {
  const url = new URL(`${base}/v1/tiktok/shop/search`);
  url.searchParams.set("query", product.name);
  url.searchParams.set("region", region);

  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(
      `ScrapeCreators name lookup failed: ${response.status} ${await response
        .text()}`,
    );
  }

  const body = await response.json();
  const result = bestScrapeCreatorsSearchProduct(body, product.name);
  if (!result) {
    return { price: 0, sourceUrl: url.href };
  }

  return {
    price: priceFromScrapeCreatorsSearchProduct(result),
    sourceUrl: scrapeCreatorsSearchProductUrl(result) || url.href,
    title: scrapeCreatorsSearchProductTitle(result),
    seller: scrapeCreatorsSearchProductSeller(result),
    image: imageFromScrapeCreators(result),
    product: result,
  };
}

function priceFromScrapeCreators(body: unknown): number {
  const candidates = [
    valueAt(body, [
      "product_info",
      "product_base",
      "price",
      "min_sku_original_price",
    ]),
    valueAt(body, ["product_base", "price", "min_sku_original_price"]),
    valueAt(body, ["product_info", "product_base", "price", "min_sku_price"]),
    valueAt(body, ["product_base", "price", "min_sku_price"]),
    valueAt(body, ["product_info", "product_base", "price", "original_price"]),
    valueAt(body, ["product_base", "price", "original_price"]),
    valueAt(body, ["product_info", "product_base", "price", "real_price"]),
    valueAt(body, ["product_base", "price", "real_price"]),
    ...skuPriceCandidates(valueAt(body, ["product_info", "skus"])),
    ...skuPriceCandidates(valueAt(body, ["skus"])),
    valueAt(body, [
      "product_info",
      "product_base",
      "price",
      "max_sku_original_price",
    ]),
    valueAt(body, ["product_base", "price", "max_sku_original_price"]),
  ];

  for (const candidate of candidates) {
    const price = looseNumber(candidate, 0);
    if (price > 0) return price;
  }

  return 0;
}

function skuPriceCandidates(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((sku) => [
    valueAt(sku, ["price", "original_price_value"]),
    valueAt(sku, ["price", "original_price"]),
    valueAt(sku, ["price", "real_price", "price_val"]),
    valueAt(sku, ["price", "real_price", "price_str"]),
  ]);
}

function bestScrapeCreatorsSearchProduct(
  body: unknown,
  query: string,
): Record<string, unknown> | null {
  const products = scrapeCreatorsSearchProducts(body);
  let best: Record<string, unknown> | null = null;
  let bestScore = -Infinity;

  for (const product of products) {
    if (priceFromScrapeCreatorsSearchProduct(product) <= 0) continue;

    const score = searchProductScore(
      query,
      scrapeCreatorsSearchProductTitle(product) || "",
    );
    if (score > bestScore) {
      best = product;
      bestScore = score;
    }
  }

  return best;
}

function scrapeCreatorsSearchProducts(
  body: unknown,
): Record<string, unknown>[] {
  const candidates = [
    valueAt(body, ["products"]),
    valueAt(body, ["data", "products"]),
    valueAt(body, ["items"]),
    valueAt(body, ["data", "items"]),
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }

  return [];
}

function searchProductScore(query: string, title: string): number {
  const normalizedQuery = searchText(query);
  const normalizedTitle = searchText(title);
  if (!normalizedQuery || !normalizedTitle) return 0;
  if (normalizedTitle === normalizedQuery) return 1000;
  if (normalizedTitle.includes(normalizedQuery)) return 800;
  if (normalizedQuery.includes(normalizedTitle)) return 700;

  const queryTerms = new Set(normalizedQuery.split(" ").filter(Boolean));
  const titleTerms = new Set(normalizedTitle.split(" ").filter(Boolean));
  let shared = 0;
  for (const term of queryTerms) {
    if (titleTerms.has(term)) shared++;
  }

  return shared / Math.max(queryTerms.size, 1);
}

function searchText(value: string): string {
  return value.toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function priceFromScrapeCreatorsSearchProduct(product: unknown): number {
  const candidates = [
    valueAt(product, ["price"]),
    valueAt(product, ["sale_price"]),
    valueAt(product, ["original_price"]),
    valueAt(product, ["product_price_info", "sale_price_decimal"]),
    valueAt(product, ["product_price_info", "sale_price_format"]),
    valueAt(product, ["product_price_info", "single_product_price_decimal"]),
    valueAt(product, ["product_price_info", "single_product_price_format"]),
    valueAt(product, ["product_price_info", "original_price"]),
    valueAt(product, ["product_price_info", "original_price_value"]),
  ];

  for (const candidate of candidates) {
    const price = looseNumber(candidate, 0);
    if (price > 0) return price;
  }

  return 0;
}

function scrapeCreatorsSearchProductTitle(
  product: unknown,
): string | undefined {
  return stringAt(product, ["title"]) ||
    stringAt(product, ["name"]) ||
    stringAt(product, ["product_name"]);
}

function scrapeCreatorsSearchProductSeller(
  product: unknown,
): string | undefined {
  return stringAt(product, ["seller_info", "shop_name"]) ||
    stringAt(product, ["shop_name"]) ||
    stringAt(product, ["seller", "name"]);
}

function scrapeCreatorsSearchProductUrl(product: unknown): string | undefined {
  return stringAt(product, ["url"]) ||
    stringAt(product, ["seo_url", "canonical_url"]) ||
    stringAt(product, ["canonical_url"]);
}

// Works for both response shapes: the product endpoint nests image objects
// (url_list/thumb_url_list) under product_base, while search results carry
// flat cover/img fields.
function imageFromScrapeCreators(body: unknown): string | undefined {
  const candidates = [
    valueAt(body, ["product_info", "product_base", "images"]),
    valueAt(body, ["product_base", "images"]),
    valueAt(body, ["product_info", "images"]),
    valueAt(body, ["images"]),
    valueAt(body, ["cover"]),
    valueAt(body, ["cover_url"]),
    valueAt(body, ["img"]),
    valueAt(body, ["image"]),
    valueAt(body, ["thumbnail"]),
  ];

  for (const candidate of candidates) {
    const url = firstImageUrl(candidate);
    if (url) return url;
  }

  return undefined;
}

function firstImageUrl(value: unknown): string | undefined {
  if (typeof value === "string") {
    return /^https?:\/\//.test(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstImageUrl(item);
      if (url) return url;
    }
    return undefined;
  }
  if (isRecord(value)) {
    return firstImageUrl(value.url_list) ??
      firstImageUrl(value.thumb_url_list) ??
      firstImageUrl(value.url) ??
      firstImageUrl(value.uri);
  }
  return undefined;
}

// Every stored field is indexed, and oversized values can fail to index — ship
// the entire payload when it fits, otherwise keep the sections that matter
// (identity, pricing, images, seller) so the save never fails.
function scrapeCreatorsProductJson(
  product: Record<string, unknown> | undefined,
): string | undefined {
  if (!product) return undefined;

  const full = JSON.stringify(product);
  if (full.length <= 30000) return full;

  const compact: Record<string, unknown> = {};
  for (
    const key of [
      "product_base",
      "product_info",
      "skus",
      "seller",
      "seller_info",
      "shop_info",
      "seo_url",
      "title",
      "name",
      "price",
      "product_price_info",
      "cover",
      "img",
      "image",
      "images",
      "url",
    ]
  ) {
    if (product[key] !== undefined) compact[key] = product[key];
  }
  const compactJson = JSON.stringify(compact);
  if (compactJson.length <= 30000) return compactJson;

  return JSON.stringify({ truncated: true, keys: Object.keys(product) });
}

/* ----------------------------------------------- product-record parsing -- */

function productRecordsFromMessages(
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];

  for (const message of messages) {
    records.push(...productRecordsFromMessage(message));
  }

  return records;
}

function productRecordsFromMessage(
  message: Record<string, unknown>,
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];

  for (const field of ["rows_json", "core_data_json", "summary_json"]) {
    const parsed = parseJsonValue(message[field]);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (isRecord(item)) records.push(withMessageContext(message, item));
      }
    } else if (isRecord(parsed)) {
      records.push(...productRecordsFromParsedObject(message, parsed));
    }
  }

  return records.length ? records : [message];
}

function productRecordsFromParsedObject(
  message: Record<string, unknown>,
  parsed: Record<string, unknown>,
): Record<string, unknown>[] {
  const rows = first(parsed, ["rows", "products", "data", "items"]);

  if (Array.isArray(rows)) {
    return rows
      .filter(isRecord)
      .map((row) => withMessageContext(message, row));
  }

  return [withMessageContext(message, parsed)];
}

function withMessageContext(
  message: Record<string, unknown>,
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    timestamp: message.timestamp,
    source: message.source,
    creator: message.creator,
    scrapedAt: message.scrapedAt,
    ...row,
  };
}

function normalizeProduct(
  source: Record<string, unknown>,
): ProductAnalysis | null {
  const productId = stringFrom(first(source, PRODUCT_ID_FIELDS));
  if (!productId) return null;

  const minSkuOriginalPrice = cellNumber(first(source, MIN_PRICE_FIELDS), 0);
  const sampleCount = cellNumber(first(source, SAMPLE_COUNT_FIELDS), 1);
  const estimatedRetailValue = cellNumber(
    first(source, [
      "estimated_retail_value",
      "estimatedRetailValue",
      "sample_value",
      "sampleValue",
    ]),
    sampleCount * minSkuOriginalPrice,
  );

  return {
    productId,
    name: stringFrom(first(source, PRODUCT_NAME_FIELDS)) ||
      `Product ${productId}`,
    priceRange: stringFrom(
      first(source, ["priceRange", "price_range", "sku_price_range"]),
    ) ||
      formatPriceRange(source),
    min_sku_original_price: minSkuOriginalPrice,
    category: stringFrom(
      first(source, ["category", "product_category", "category_name"]),
    ) || "Uncategorized",
    categoryRank: numberOrNull(
      first(source, ["category_rank", "categoryRank", "rank", "Rank"]),
    ),
    seller: stringFrom(
      first(source, ["seller", "seller_name", "shop_name", "shopName"]),
    ) || "Unknown seller",
    creators: cellNumber(
      first(source, [
        "creators",
        "creator_count",
        "creatorCount",
        "creators_count",
      ]),
      0,
    ),
    liveStreams: cellNumber(
      first(source, [
        "liveStreams",
        "live_streams",
        "live_count",
        "liveCount",
        "recent_livestreams_count",
      ]),
      0,
    ),
    videos: cellNumber(
      first(source, [
        "videos",
        "video_count",
        "videoCount",
        "platform_videos",
        "videos_count",
      ]),
      0,
    ),
    gmv: cellNumber(
      first(source, [
        "GMV",
        "gmv",
        "sales",
        "revenue",
        "gmv_direct",
        "gmv_affiliate",
      ]),
      0,
    ),
    customers: cellNumber(
      first(source, ["customers", "customer_count", "customerCount"]),
      0,
    ),
    quantity: cellNumber(
      first(source, [
        "Items sold",
        "quantity",
        "quantity_sold",
        "items_sold",
        "units_sold",
      ]),
      0,
    ),
    skuOrders: cellNumber(
      first(source, [
        "Items sold",
        "skuOrders",
        "sku_orders",
        "orders",
        "order_count",
      ]),
      0,
    ),
    refunds: cellNumber(
      first(source, ["refunds", "refund_amount", "refundAmount"]),
      0,
    ),
    unitsRefunded: cellNumber(
      first(source, ["unitsRefunded", "units_refunded", "refund_units"]),
      0,
    ),
    sampleCount,
    estimatedRetailValue,
    lastSeen: stringFrom(
      first(source, [
        "scrapedAt",
        "timestamp",
        "event_time",
        "created_at",
        "updated_at",
      ]),
    ) || null,
    image: stringFrom(
      first(source, [
        "image",
        "image_url",
        "imageUrl",
        "picture_url",
        "pictureUrl",
        "cover",
        "thumbnail",
        "img",
      ]),
    ) || null,
  };
}

function mergeProduct(
  current: ProductAnalysis,
  incoming: ProductAnalysis,
): ProductAnalysis {
  const fallbackName = `Product ${incoming.productId}`;

  return {
    ...current,
    ...incoming,
    name: incoming.name === fallbackName && current.name !== fallbackName
      ? current.name
      : incoming.name,
    priceRange:
      incoming.priceRange === "Unknown" && current.priceRange !== "Unknown"
        ? current.priceRange
        : incoming.priceRange,
    category: incoming.category === "Uncategorized" &&
        current.category !== "Uncategorized"
      ? current.category
      : incoming.category,
    seller: incoming.seller === "Unknown seller" &&
        current.seller !== "Unknown seller"
      ? current.seller
      : incoming.seller,
    creators: Math.max(current.creators, incoming.creators),
    liveStreams: Math.max(current.liveStreams, incoming.liveStreams),
    videos: Math.max(current.videos, incoming.videos),
    gmv: Math.max(current.gmv, incoming.gmv),
    customers: Math.max(current.customers, incoming.customers),
    quantity: Math.max(current.quantity, incoming.quantity),
    skuOrders: Math.max(current.skuOrders, incoming.skuOrders),
    refunds: Math.max(current.refunds, incoming.refunds),
    unitsRefunded: Math.max(current.unitsRefunded, incoming.unitsRefunded),
    sampleCount: Math.max(current.sampleCount, incoming.sampleCount),
    estimatedRetailValue: Math.max(
      current.estimatedRetailValue,
      incoming.estimatedRetailValue,
    ),
    min_sku_original_price: incoming.min_sku_original_price ||
      current.min_sku_original_price,
    lastSeen:
      [current.lastSeen, incoming.lastSeen].filter(Boolean).sort().at(-1) ||
      null,
    image: incoming.image || current.image || null,
  };
}

/* --------------------------------------------------- samples and edits -- */

function sampleFromProduct(
  product: ProductAnalysis,
  edit?: SamplePriceEdit,
): UnpricedSample {
  const price = edit?.price ?? product.min_sku_original_price;
  const sampleCount = edit?.sampleCount ?? product.sampleCount;

  return {
    productId: product.productId,
    name: edit?.apiTitle || product.name,
    originalPrice: product.min_sku_original_price,
    price,
    sampleCount,
    sampleValue: price * sampleCount,
    gmv: product.gmv,
    quantity: product.quantity,
    lastSeen: product.lastSeen,
    notes: edit?.notes || "",
    source: edit?.source || "graylog",
    sourceUrl: edit?.sourceUrl || null,
    apiTitle: edit?.apiTitle || null,
    apiSeller: edit?.apiSeller || null,
    fetchedAt: edit?.fetchedAt || null,
    updatedAt: edit?.updatedAt || null,
    priced: price > 0,
    image: product.image ?? null,
  };
}

function productWithEdit(
  product: ProductAnalysis,
  edit?: SamplePriceEdit,
): ProductAnalysis {
  if (!edit) return product;

  const price = edit.price ?? product.min_sku_original_price;
  return {
    ...product,
    name: edit.apiTitle || product.name,
    min_sku_original_price: price,
    priceRange: price > 0 ? formatUsd(price) : product.priceRange,
    estimatedRetailValue: price > 0
      ? price * product.sampleCount
      : product.estimatedRetailValue,
  };
}

function matchesQuery(sample: UnpricedSample, query: string): boolean {
  if (!query) return true;

  return sample.productId.toLowerCase().includes(query) ||
    sample.name.toLowerCase().includes(query) ||
    sample.notes.toLowerCase().includes(query);
}

function editFromRecord(
  record: Record<string, unknown>,
): SamplePriceEdit | null {
  const productId = String(record.productId || "").trim();
  const price = looseNumber(record.price, NaN);
  if (!productId || !Number.isFinite(price) || price < 0) return null;

  const sampleCount = looseNumber(record.sampleCount, NaN);
  const source = record.source === "scrapecreators" ||
      record.source === "extension"
    ? record.source
    : "manual";

  return {
    productId,
    price,
    sampleCount: Number.isFinite(sampleCount) ? sampleCount : undefined,
    notes: optionalString(record.notes),
    source,
    sourceUrl: optionalString(record.sourceUrl),
    apiTitle: optionalString(record.apiTitle),
    apiSeller: optionalString(record.apiSeller),
    fetchedAt: optionalString(record.fetchedAt),
    updatedAt: optionalString(record.updatedAt) || "",
  };
}

// The extension used to stamp every auto-priced sample with a note like
// "Estimated by extension demo · confidence med · variant Black, 10*300cm".
// The row's source badge (API / Extension) already conveys that provenance, so
// the note was pure noise. Drop it on read so existing records show a clean
// Notes column and the cleared value persists on the next save. The pattern
// matches only the machine-generated shape — a manual note is never touched.
const AUTO_EXTENSION_NOTE_RE =
  /^(?:Estimated by extension demo|Resolved by extension lookup)(?: · confidence [^·]*)?(?: · variant .*)?$/;

function withoutAutoExtensionNote(edit: SamplePriceEdit): SamplePriceEdit {
  if (edit.notes && AUTO_EXTENSION_NOTE_RE.test(edit.notes.trim())) {
    return { ...edit, notes: undefined };
  }
  return edit;
}

/* -------------------------------------------------------------- signals -- */

export function comparisonSignal(
  rank: number | null,
  creatorVideos: number,
  platformVideos: number,
  gmv: number,
): string {
  if (
    (rank !== null && rank <= 10 || gmv >= 1000) && creatorVideos <= 2 &&
    platformVideos >= 50
  ) {
    return "Under-posted";
  }
  if (creatorVideos >= 8 && gmv < 1000) return "Over-posted";
  if (rank !== null && rank <= 25) return "Priority";
  return "Watch";
}

/* -------------------------------------------------------------- helpers -- */

function first(source: Record<string, unknown>, fields: string[]): unknown {
  for (const field of fields) {
    const value = source[field];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

// Graylog-cell coercion ("$1,234" style) — data-pimp core/graylog.ts numberFrom.
function cellNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

// Looser user/API-input coercion ("$12.34/ea" style) — samples.ts numberFrom.
function looseNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^\d.-]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function numberOrNull(value: unknown): number | null {
  const parsed = cellNumber(value, NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function numericInput(value: unknown, label: string): number {
  const number = looseNumber(value, NaN);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return number;
}

function stringFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim() || value === "-") {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatPriceRange(source: Record<string, unknown>): string {
  const min = cellNumber(first(source, MIN_PRICE_FIELDS), 0);
  const max = cellNumber(
    first(source, [
      "max_sku_original_price",
      "maxSkuOriginalPrice",
      "max_original_price",
    ]),
    min,
  );
  if (!min && !max) return "Unknown";
  if (min === max) return formatUsd(min);
  return `${formatUsd(min)}-${formatUsd(max)}`;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
    .format(value);
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;

  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }

  return current;
}

function stringAt(value: unknown, path: string[]): string | undefined {
  const result = valueAt(value, path);
  return typeof result === "string" && result ? result : undefined;
}

function tiktokProductUrl(product: ProductAnalysis): string {
  return `https://www.tiktok.com/shop/pdp/${
    slug(product.name)
  }/${product.productId}`;
}

function slug(value: string): string {
  return value.toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || "product";
}
