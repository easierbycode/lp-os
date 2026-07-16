// eBay Sell API client (Inventory API listing flow) — the first marketplace
// adapter behind the MarketplaceClient interface.
//
// Flow per publish (https://developer.ebay.com/api-docs/sell/inventory):
//   ensure user access token (refresh-token grant against /identity/v1/oauth2)
//   → ensure merchant location + business policies (created once when absent)
//   → PUT  /sell/inventory/v1/inventory_item/{sku}
//   → POST /sell/inventory/v1/offer   (or update the existing offer for sku)
//   → POST /sell/inventory/v1/offer/{offerId}/publish → listingId.
//
// Credentials come from the marketplace_accounts row the user fills in via
// the shell's Marketplace window: {clientId, clientSecret, refreshToken}
// (the eBay keyset + an OAuth refresh token, ~18-month lifetime), or a bare
// {accessToken} for quick 2-hour tests. Sandbox and production are separate
// keysets — `environment` picks the API base.

import {
  type MarketplaceClient,
  MarketplaceError,
  type PublishInput,
  type PublishResult,
} from "./types.ts";

const BASES: Record<string, { api: string; item: string }> = {
  production: { api: "https://api.ebay.com", item: "https://www.ebay.com/itm" },
  sandbox: {
    api: "https://api.sandbox.ebay.com",
    item: "https://sandbox.ebay.com/itm",
  },
};

const TOKEN_PATH = "/identity/v1/oauth2/token";
const DEFAULT_MARKETPLACE_ID = "EBAY_US";
const DEFAULT_LOCATION_KEY = "lp-os-default";
const DEFAULT_CONDITION = "NEW";
const REQUEST_TIMEOUT_MS = 30_000;

export type EbayClientOptions = {
  /** "sandbox" (default) or "production". */
  environment?: string;
  /** {clientId, clientSecret, refreshToken, accessToken?} — jsonb from the
   * marketplace_accounts row, so values are unknown until read. */
  credentials: Record<string, unknown>;
  /** Optional listing defaults, also jsonb: {marketplaceId, condition,
   * categoryId, merchantLocationKey, location: {country, postalCode, city,
   * stateOrProvince}, fulfillmentPolicyId, paymentPolicyId, returnPolicyId,
   * handlingTimeDays, shippingFlatCost}. */
  settings?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** True when the stored credentials are enough to mint/present a token. */
export function ebayCredentialsUsable(
  credentials: Record<string, unknown>,
): boolean {
  const c = credentials ?? {};
  if (str(c.accessToken)) return true;
  return Boolean(
    str(c.clientId) && str(c.clientSecret) && str(c.refreshToken),
  );
}

function ebayErrorMessage(status: number, body: unknown): {
  message: string;
  code?: string;
} {
  if (isRecord(body) && Array.isArray(body.errors) && body.errors.length) {
    const errs = body.errors.filter(isRecord);
    const text = errs
      .map((e) => str(e.longMessage) || str(e.message))
      .filter(Boolean)
      .join("; ");
    const code = errs.length ? str(errs[0].errorId) : "";
    return {
      message: text || `eBay request failed (HTTP ${status})`,
      code: code || undefined,
    };
  }
  return { message: `eBay request failed (HTTP ${status})` };
}

export function createEbayClient(opts: EbayClientOptions): MarketplaceClient {
  const environment = opts.environment === "production"
    ? "production"
    : "sandbox";
  const base = BASES[environment];
  const creds = opts.credentials ?? {};
  const settings = opts.settings ?? {};
  const doFetch = opts.fetchImpl ?? fetch;

  const marketplaceId = str(settings.marketplaceId) || DEFAULT_MARKETPLACE_ID;
  let locationKey = str(settings.merchantLocationKey) ||
    DEFAULT_LOCATION_KEY;
  const condition = str(settings.condition) || DEFAULT_CONDITION;
  // eBay enforces a per-marketplace Content-Language (hyphenated; en_US is
  // error 25709). Cover the marketplaces the adapter can be pointed at.
  const CONTENT_LANGUAGE: Record<string, string> = {
    EBAY_US: "en-US",
    EBAY_CA: "en-CA",
    EBAY_GB: "en-GB",
    EBAY_AU: "en-AU",
    EBAY_DE: "de-DE",
    EBAY_FR: "fr-FR",
    EBAY_IT: "it-IT",
    EBAY_ES: "es-ES",
  };
  const contentLanguage = CONTENT_LANGUAGE[marketplaceId] ?? "en-US";

  // Per-instance caches: the service holds one client per account for the
  // process lifetime, so prerequisite lookups happen once, not per publish.
  let token: { value: string; expiresAtMs: number } | null = null;
  let locationReady = false;
  let policies:
    | {
      fulfillmentPolicyId: string;
      paymentPolicyId: string;
      returnPolicyId: string;
    }
    | null = null;
  let categoryTreeId: string | null = null;

  async function request(
    method: string,
    path: string,
    body?: unknown,
    extra?: { auth?: string; form?: Record<string, string> },
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {};
    let payload: BodyInit | undefined;
    if (extra?.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(extra.form).toString();
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-language"] = contentLanguage;
      payload = JSON.stringify(body);
    }
    // PUT inventory_item and GET offer reject a request with no
    // Accept-Language (error 25709, "Invalid value for header
    // Accept-Language") — every other Sell/Taxonomy call tolerates it, so send
    // it on all API calls. The OAuth token endpoint is the exception: it takes
    // the form body only.
    if (!extra?.form) headers["accept-language"] = contentLanguage;
    if (extra?.auth) headers["authorization"] = extra.auth;

    let res: Response;
    try {
      res = await doFetch(`${base.api}${path}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MarketplaceError(
        `eBay request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { permanent: false },
      );
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed };
  }

  /** request() + throw a classified MarketplaceError on non-2xx. */
  async function api(
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = [],
  ): Promise<unknown> {
    const auth = `Bearer ${await accessToken()}`;
    const res = await request(method, path, body, { auth });
    if (res.status >= 200 && res.status < 300) return res.body;
    if (okStatuses.includes(res.status)) return res.body;
    const { message, code } = ebayErrorMessage(res.status, res.body);
    throw new MarketplaceError(message, {
      // 5xx and rate limits may clear on their own; every other 4xx needs a
      // config/data change first.
      permanent: res.status < 500 && res.status !== 429,
      status: res.status,
      code,
    });
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAtMs - Date.now() > 120_000) return token.value;

    const clientId = str(creds.clientId);
    const clientSecret = str(creds.clientSecret);
    const refreshToken = str(creds.refreshToken);

    if (!(clientId && clientSecret && refreshToken)) {
      const direct = str(creds.accessToken);
      if (direct) {
        token = { value: direct, expiresAtMs: Number.MAX_SAFE_INTEGER };
        return direct;
      }
      throw new MarketplaceError(
        "eBay credentials are incomplete — need clientId + clientSecret + refreshToken (or a temporary accessToken)",
        { permanent: true },
      );
    }

    let basicAuth: string;
    try {
      basicAuth = btoa(`${clientId}:${clientSecret}`);
    } catch {
      // btoa throws a raw DOMException on code units > 0xFF (a paste-mangled
      // credential); classify it instead of retrying forever.
      throw new MarketplaceError(
        "eBay clientId/clientSecret contain characters outside Latin-1 — re-paste the keyset values",
        { permanent: true },
      );
    }
    const res = await request("POST", TOKEN_PATH, undefined, {
      auth: `Basic ${basicAuth}`,
      form: { grant_type: "refresh_token", refresh_token: refreshToken },
    });
    if (res.status !== 200 || !isRecord(res.body)) {
      const detail = isRecord(res.body)
        ? str(res.body.error_description) || str(res.body.error)
        : "";
      throw new MarketplaceError(
        `eBay token refresh failed (HTTP ${res.status})${
          detail ? `: ${detail}` : ""
        }`,
        // Same classification as api(): rate limits clear on their own.
        {
          permanent: res.status < 500 && res.status !== 429,
          status: res.status,
        },
      );
    }
    const value = str(res.body.access_token);
    const expiresIn = Number(res.body.expires_in) || 7200;
    if (!value) {
      throw new MarketplaceError("eBay token response had no access_token", {
        permanent: true,
      });
    }
    token = { value, expiresAtMs: Date.now() + expiresIn * 1000 };
    return value;
  }

  async function ensureLocation(): Promise<void> {
    if (locationReady) return;
    const existing = await api(
      "GET",
      `/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`,
      undefined,
      [404],
    );
    if (isRecord(existing) && str(existing.merchantLocationKey)) {
      locationReady = true;
      return;
    }
    const loc = isRecord(settings.location) ? settings.location : {};
    const country = str(loc.country) || "US";
    const postalCode = str(loc.postalCode);
    if (!postalCode) {
      // Reuse a Seller Hub location when one already exists under a key other
      // than LP-OS's default. No need to duplicate the seller's address.
      const locations = await api(
        "GET",
        "/sell/inventory/v1/location?limit=1",
        undefined,
        [404],
      );
      if (isRecord(locations) && Array.isArray(locations.locations)) {
        for (const entry of locations.locations.filter(isRecord)) {
          const key = str(entry.merchantLocationKey);
          if (key) {
            locationKey = key;
            locationReady = true;
            return;
          }
        }
      }
      throw new MarketplaceError(
        "eBay needs a ship-from location — create one in Seller Hub or set the postal code in Marketplace settings",
        { permanent: true },
      );
    }
    const address: Record<string, string> = { country, postalCode };
    if (str(loc.city)) address.city = str(loc.city);
    if (str(loc.stateOrProvince)) {
      address.stateOrProvince = str(loc.stateOrProvince);
    }
    await api(
      "POST",
      `/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`,
      {
        location: { address },
        locationTypes: ["WAREHOUSE"],
        merchantLocationStatus: "ENABLED",
        name: "LP-OS warehouse",
      },
    );
    locationReady = true;
  }

  async function firstPolicyId(
    kind: "fulfillment" | "payment" | "return",
  ): Promise<string> {
    const listKey = `${kind}Policies`;
    const idKey = `${kind}PolicyId`;
    const body = await api(
      "GET",
      `/sell/account/v1/${kind}_policy?marketplace_id=${marketplaceId}`,
    );
    if (isRecord(body) && Array.isArray(body[listKey])) {
      const entries = (body[listKey] as unknown[]).filter(isRecord);
      for (const entry of entries) {
        const id = str(entry[idKey]);
        if (id) return id;
      }
    }
    return "";
  }

  async function optInToBusinessPolicies(): Promise<void> {
    const programs = await api(
      "GET",
      "/sell/account/v1/program/get_opted_in_programs",
      undefined,
      [404],
    );
    if (isRecord(programs) && Array.isArray(programs.programs)) {
      const opted = programs.programs.filter(isRecord).some(
        (p) => str(p.programType) === "SELLING_POLICY_MANAGEMENT",
      );
      if (opted) return;
    }
    await api("POST", "/sell/account/v1/program/opt_in", {
      programType: "SELLING_POLICY_MANAGEMENT",
    });
  }

  async function createDefaultPolicy(
    kind: "fulfillment" | "payment" | "return",
  ): Promise<string> {
    const name = `LP-OS default (${marketplaceId})`;
    // categoryTypes is required on every policy create.
    const categoryTypes = [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }];
    let body: Record<string, unknown>;
    if (kind === "fulfillment") {
      const handlingDays = Math.max(
        1,
        Math.trunc(Number(settings.handlingTimeDays) || 3),
      );
      const flatCost = str(settings.shippingFlatCost) || "9.99";
      body = {
        name,
        marketplaceId,
        categoryTypes,
        handlingTime: { value: handlingDays, unit: "DAY" },
        shippingOptions: [{
          optionType: "DOMESTIC",
          costType: "FLAT_RATE",
          shippingServices: [{
            sortOrder: 1,
            shippingCarrierCode: "USPS",
            shippingServiceCode: "USPSPriority",
            shippingCost: { value: flatCost, currency: "USD" },
          }],
        }],
      };
    } else if (kind === "payment") {
      body = { name, marketplaceId, categoryTypes, immediatePay: true };
    } else {
      body = { name, marketplaceId, categoryTypes, returnsAccepted: false };
    }
    const created = await api(
      "POST",
      `/sell/account/v1/${kind}_policy`,
      body,
    );
    const id = isRecord(created) ? str(created[`${kind}PolicyId`]) : "";
    if (!id) {
      throw new MarketplaceError(
        `eBay did not return a ${kind} policy id — create one in Seller Hub and set it in Marketplace settings`,
        { permanent: true },
      );
    }
    return id;
  }

  async function ensurePolicies(): Promise<
    {
      fulfillmentPolicyId: string;
      paymentPolicyId: string;
      returnPolicyId: string;
    }
  > {
    if (policies) return policies;
    const configured = {
      fulfillmentPolicyId: str(settings.fulfillmentPolicyId),
      paymentPolicyId: str(settings.paymentPolicyId),
      returnPolicyId: str(settings.returnPolicyId),
    };
    if (
      configured.fulfillmentPolicyId && configured.paymentPolicyId &&
      configured.returnPolicyId
    ) {
      policies = configured;
      return policies;
    }
    const resolved = { ...configured };
    let optedIn = false;
    for (const kind of ["fulfillment", "payment", "return"] as const) {
      const key = `${kind}PolicyId` as keyof typeof resolved;
      if (resolved[key]) continue;
      resolved[key] = await firstPolicyId(kind);
      if (!resolved[key]) {
        if (!optedIn) {
          await optInToBusinessPolicies();
          optedIn = true;
        }
        resolved[key] = await createDefaultPolicy(kind);
      }
    }
    policies = resolved as typeof configured;
    return policies;
  }

  async function suggestCategoryId(title: string): Promise<string> {
    const fallback = str(settings.categoryId);
    try {
      if (!categoryTreeId) {
        const tree = await api(
          "GET",
          `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${marketplaceId}`,
        );
        categoryTreeId = isRecord(tree) ? str(tree.categoryTreeId) : "";
      }
      if (categoryTreeId) {
        const res = await api(
          "GET",
          `/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_category_suggestions?q=${
            encodeURIComponent(title.slice(0, 120))
          }`,
          undefined,
          [404],
        );
        if (isRecord(res) && Array.isArray(res.categorySuggestions)) {
          for (const s of res.categorySuggestions.filter(isRecord)) {
            const cat = isRecord(s.category) ? s.category : null;
            const id = cat ? str(cat.categoryId) : "";
            if (id) return id;
          }
        }
      }
    } catch (error) {
      // A configured default category outranks a broken taxonomy API (e.g.
      // the keyset lacks the taxonomy scope) — only rethrow with no fallback.
      if (!fallback) throw error;
    }
    if (fallback) return fallback;
    throw new MarketplaceError(
      `eBay could not suggest a category for "${title}" — set a default categoryId in Marketplace settings`,
      { permanent: true },
    );
  }

  async function findOfferIdForSku(
    sku: string,
  ): Promise<{ offerId: string; published: boolean } | null> {
    const res = await api(
      "GET",
      `/sell/inventory/v1/offer?sku=${
        encodeURIComponent(sku)
      }&marketplace_id=${marketplaceId}`,
      undefined,
      [404],
    );
    if (isRecord(res) && Array.isArray(res.offers)) {
      for (const offer of res.offers.filter(isRecord)) {
        if (str(offer.marketplaceId) === marketplaceId) {
          const id = str(offer.offerId);
          if (id) {
            return {
              offerId: id,
              published: str(offer.status) === "PUBLISHED",
            };
          }
        }
      }
    }
    return null;
  }

  async function upsertOffer(input: PublishInput): Promise<string> {
    await ensureLocation();
    const policyIds = await ensurePolicies();

    const title = input.title.slice(0, 80);
    const product: Record<string, unknown> = {
      title,
      description: input.description,
    };
    if (input.imageUrl) product.imageUrls = [input.imageUrl];
    if (input.brand) product.aspects = { Brand: [input.brand] };

    await api(
      "PUT",
      `/sell/inventory/v1/inventory_item/${encodeURIComponent(input.sku)}`,
      {
        condition,
        product,
        availability: {
          shipToLocationAvailability: { quantity: input.quantity },
        },
      },
    );

    const categoryId = await suggestCategoryId(title);
    const offerBody = {
      sku: input.sku,
      marketplaceId,
      format: "FIXED_PRICE",
      categoryId,
      merchantLocationKey: locationKey,
      listingDescription: input.description,
      pricingSummary: {
        price: { value: input.price.toFixed(2), currency: input.currency },
      },
      listingPolicies: policyIds,
    };

    let offerId = "";
    try {
      const created = await api("POST", "/sell/inventory/v1/offer", offerBody);
      offerId = isRecord(created) ? str(created.offerId) : "";
    } catch (error) {
      if (!(error instanceof MarketplaceError) || !error.permanent) throw error;
      // A previous attempt may have left an UNPUBLISHED offer for this sku —
      // find and update it instead of failing on the duplicate. A PUBLISHED
      // offer is a live listing: never mutate it from here.
      const existing = await findOfferIdForSku(input.sku);
      if (!existing) throw error;
      if (existing.published) {
        throw new MarketplaceError(
          `an offer for sku ${input.sku} is already live on eBay (offer ${existing.offerId}) — end that listing on eBay first`,
          { permanent: true },
        );
      }
      offerId = existing.offerId;
      await api("PUT", `/sell/inventory/v1/offer/${offerId}`, offerBody);
    }
    if (!offerId) {
      throw new MarketplaceError("eBay createOffer returned no offerId", {
        permanent: true,
      });
    }

    return offerId;
  }

  async function createDraft(input: PublishInput): Promise<PublishResult> {
    const offerId = await upsertOffer(input);
    return { offerId, published: false };
  }

  async function publish(input: PublishInput): Promise<PublishResult> {
    const offerId = await upsertOffer(input);
    const published = await api(
      "POST",
      `/sell/inventory/v1/offer/${offerId}/publish`,
      {},
    );
    const listingId = isRecord(published) ? str(published.listingId) : "";
    if (!listingId) {
      throw new MarketplaceError("eBay publishOffer returned no listingId", {
        permanent: true,
      });
    }
    return {
      externalId: listingId,
      offerId,
      url: `${base.item}/${listingId}`,
      published: true,
    };
  }

  async function verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      await accessToken();
      // Cover both scopes a listing needs: sell.account (ensurePolicies) and
      // sell.inventory (ensureLocation/offers). Fetching ONE location by key
      // rather than listing them is deliberate — list-locations answers 500
      // (25001) on Sandbox, which made this check unpassable there. A 404 is
      // still a pass: it proves the token authenticated and the key merely
      // hasn't been provisioned yet.
      await api("GET", "/sell/account/v1/privilege");
      await api(
        "GET",
        `/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`,
        undefined,
        [404],
      );
      return {
        ok: true,
        detail: `eBay ${environment} credentials OK (${marketplaceId})`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { verify, createDraft, publish };
}
