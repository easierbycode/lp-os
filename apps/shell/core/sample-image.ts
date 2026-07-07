// Sample product-image resolution via ScrapeCreators (TikTok Shop PDP) —
// ported from data-pimp product-image.ts + main.ts resolveSampleImage().
//
// Older "price-only" sample rows were saved without a picture_url. Given the
// sample's PDP url (its tiktok_affiliate_link, or one built from the numeric
// qr_code product id), fetch the product via ScrapeCreators, pull the first
// product image, and backfill it onto the Postgres row so it is fetched only
// once. Backs GET /api/samples/:id/image, which the kiosk's ProductImage
// helper calls lazily for legacy rows.
//
// Deps are injected (db reads/writes go through @lp-os/db's Samples API — no
// hand-written SQL) and the ScrapeCreators call sits behind the
// EXTERNAL_API_SCRAPECREATORS kill switch: disabled resolves to a clean null
// (the client falls back to its placeholder SVG), same as a keyless deploy.

import {
  type EnvReader,
  ExternalApiDisabledError,
  requireExternalApi,
} from "./external-apis.ts";

const DEFAULT_SCRAPECREATORS_BASE = "https://api.scrapecreators.com";
const DEFAULT_REGION = "US";

type SampleRow = Record<string, unknown>;

export interface SampleImageDeps {
  db: {
    Samples: {
      filter(
        filters: Record<string, unknown>,
        orderBy?: string,
        limit?: number,
      ): Promise<SampleRow[]>;
      update(
        id: string | number,
        data: Record<string, unknown>,
      ): Promise<SampleRow | null>;
    };
  };
  env: EnvReader;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface SampleImageService {
  /** Resolve a sample's product image URL; null when nothing resolves. */
  resolve(
    input: { sampleId: string | number },
  ): Promise<{ url: string } | null>;
}

/** First usable URL out of a ScrapeCreators images[] array. */
export function firstUrlFromImages(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  for (const img of images) {
    const entry = img as Record<string, unknown> | string | null;
    const url = (entry as Record<string, string[]>)?.url_list?.[0] ??
      (entry as Record<string, string[]>)?.thumb_url_list?.[0] ??
      (typeof entry === "string" ? entry : null);
    if (typeof url === "string" && url) return url;
  }
  return null;
}

/** ScrapeCreators returns product_base at the top level; each images[] entry
 * has url_list[] (full-res) and thumb_url_list[]. The other paths are
 * defensive fallbacks in case the response shape changes. */
export function extractProductImage(data: unknown): string | null {
  // deno-lint-ignore no-explicit-any
  const d = data as any;
  return (
    firstUrlFromImages(d?.product_base?.images) ||
    firstUrlFromImages(d?.product_info?.product_base?.images) ||
    firstUrlFromImages(d?.product?.images) ||
    firstUrlFromImages(d?.images) ||
    null
  );
}

/** The sample's TikTok Shop PDP url: an affiliate link that already points at
 * a PDP wins; otherwise build one from the numeric qr_code product id. */
export function pdpUrlForSample(sample: SampleRow): string | null {
  const link = sample.tiktok_affiliate_link;
  if (typeof link === "string" && link.includes("/shop/pdp/")) return link;
  const code = sample.qr_code;
  if (typeof code === "string" && /^\d+$/.test(code)) {
    return `https://www.tiktok.com/shop/pdp/product/${code}`;
  }
  return null;
}

export function createSampleImage(
  { db, env, fetchImpl = fetch }: SampleImageDeps,
): SampleImageService {
  // Same key/base env contract as core/product-analysis.ts.
  const apiKey = () => env("SCRAPECREATORS_API_KEY") || env("API_KEY");

  async function fetchProductImage(pdpUrl: string): Promise<string | null> {
    const key = apiKey();
    if (!key) {
      console.warn(
        "SCRAPECREATORS_API_KEY not set; cannot resolve product image",
      );
      return null;
    }
    const base = (env("SCRAPECREATORS_API_BASE") || DEFAULT_SCRAPECREATORS_BASE)
      .replace(/\/+$/, "");
    const endpoint = new URL(`${base}/v1/tiktok/product`);
    endpoint.searchParams.set("url", pdpUrl);
    endpoint.searchParams.set(
      "region",
      env("SCRAPECREATORS_REGION") || DEFAULT_REGION,
    );
    try {
      const res = await fetchImpl(endpoint, {
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          "x-api-key": key,
        },
      });
      if (!res.ok) {
        console.error(
          `ScrapeCreators ${res.status} ${res.statusText} for ${pdpUrl}`,
        );
        await res.body?.cancel();
        return null;
      }
      return extractProductImage(await res.json());
    } catch (err) {
      console.error("ScrapeCreators fetch failed:", err);
      return null;
    }
  }

  async function resolve(
    { sampleId }: { sampleId: string | number },
  ): Promise<{ url: string } | null> {
    const rows = await db.Samples.filter({ id: sampleId }, undefined, 1);
    const sample = rows[0];
    if (!sample) return null;
    if (sample.picture_url) return { url: String(sample.picture_url) };

    const pdpUrl = pdpUrlForSample(sample);
    if (!pdpUrl) return null;

    // Kill switch beats the key check: disabled is a clean miss, not an error
    // (the kiosk's ProductImage falls back to its placeholder SVG).
    try {
      requireExternalApi(env, "scrapecreators");
    } catch (err) {
      if (err instanceof ExternalApiDisabledError) return null;
      throw err;
    }

    const imageUrl = await fetchProductImage(pdpUrl);
    if (!imageUrl) return null;

    // Backfill so the image is saved permanently (best-effort).
    try {
      await db.Samples.update(String(sample.id), { picture_url: imageUrl });
    } catch (err) {
      console.error(
        `Failed to backfill picture_url for sample ${sampleId}:`,
        err,
      );
    }
    return { url: imageUrl };
  }

  return { resolve };
}
