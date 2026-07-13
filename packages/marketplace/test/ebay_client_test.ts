import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { createEbayClient, ebayCredentialsUsable } from "../ebay.ts";
import { MarketplaceError, type PublishInput } from "../types.ts";

type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
};

type Scripted = { status: number; body?: unknown } | undefined;

function makeFetch(handler: (call: Call) => Scripted) {
  const calls: Call[] = [];
  const fetchImpl = ((input: URL | Request | string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    const res = handler(call) ?? { status: 404, body: {} };
    return Promise.resolve(
      new Response(
        res.body === undefined ? null : JSON.stringify(res.body),
        { status: res.status },
      ),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const REFRESH_CREDS = {
  clientId: "app-id",
  clientSecret: "cert-id",
  refreshToken: "rt-123",
};

const PUBLISH_INPUT: PublishInput = {
  sku: "lpos-1",
  title: "Cupids Desire Drops",
  description: "Cupids Desire Drops by Cupid Labs. Brand new.",
  price: 40,
  currency: "USD",
  quantity: 1,
  imageUrl: "https://img.example.com/cupid.jpg",
  brand: "Cupid Labs",
};

/** Scripted happy-path sandbox: existing location + policies. */
function happyRoutes(call: Call): Scripted {
  const { method, url } = call;
  if (url.includes("/identity/v1/oauth2/token")) {
    return { status: 200, body: { access_token: "at-1", expires_in: 7200 } };
  }
  if (method === "GET" && url.includes("/sell/inventory/v1/location/")) {
    return { status: 200, body: { merchantLocationKey: "lp-os-default" } };
  }
  if (method === "GET" && url.includes("/sell/account/v1/fulfillment_policy")) {
    return {
      status: 200,
      body: { fulfillmentPolicies: [{ fulfillmentPolicyId: "F1" }] },
    };
  }
  if (method === "GET" && url.includes("/sell/account/v1/payment_policy")) {
    return {
      status: 200,
      body: { paymentPolicies: [{ paymentPolicyId: "P1" }] },
    };
  }
  if (method === "GET" && url.includes("/sell/account/v1/return_policy")) {
    return {
      status: 200,
      body: { returnPolicies: [{ returnPolicyId: "R1" }] },
    };
  }
  if (method === "PUT" && url.includes("/sell/inventory/v1/inventory_item/")) {
    return { status: 204 };
  }
  if (url.includes("get_default_category_tree_id")) {
    return { status: 200, body: { categoryTreeId: "0" } };
  }
  if (url.includes("get_category_suggestions")) {
    return {
      status: 200,
      body: { categorySuggestions: [{ category: { categoryId: "12345" } }] },
    };
  }
  if (method === "POST" && /\/sell\/inventory\/v1\/offer$/.test(url)) {
    return { status: 201, body: { offerId: "OFF1" } };
  }
  if (method === "POST" && url.includes("/offer/OFF1/publish")) {
    return { status: 200, body: { listingId: "110123" } };
  }
  return undefined;
}

Deno.test("publish walks token → item → offer → publish with exact headers", async () => {
  const { fetchImpl, calls } = makeFetch(happyRoutes);
  const client = createEbayClient({
    environment: "sandbox",
    credentials: REFRESH_CREDS,
    fetchImpl,
  });

  const result = await client.publish(PUBLISH_INPUT);
  assertEquals(result.externalId, "110123");
  assertEquals(result.offerId, "OFF1");
  assertEquals(result.url, "https://sandbox.ebay.com/itm/110123");
  assertEquals(result.published, true);

  const token = calls.find((c) => c.url.includes("/oauth2/token"))!;
  assert(token, "token endpoint called");
  assertStringIncludes(token.url, "api.sandbox.ebay.com");
  assertMatch(token.headers.authorization ?? "", /^Basic /);
  assertEquals(
    token.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assertStringIncludes(token.body ?? "", "grant_type=refresh_token");
  assertStringIncludes(token.body ?? "", "refresh_token=rt-123");

  const item = calls.find((c) =>
    c.method === "PUT" && c.url.includes("/inventory_item/lpos-1")
  )!;
  assert(item, "inventory item PUT sent");
  assertEquals(item.headers.authorization, "Bearer at-1");
  // Hyphenated form is load-bearing: en_US triggers eBay error 25709.
  assertEquals(item.headers["content-language"], "en-US");
  const itemBody = JSON.parse(item.body ?? "{}");
  assertEquals(itemBody.condition, "NEW");
  assertEquals(itemBody.product.title, "Cupids Desire Drops");
  assertEquals(itemBody.product.imageUrls, [
    "https://img.example.com/cupid.jpg",
  ]);
  assertEquals(itemBody.product.aspects.Brand, ["Cupid Labs"]);
  assertEquals(
    itemBody.availability.shipToLocationAvailability.quantity,
    1,
  );

  const offer = calls.find((c) =>
    c.method === "POST" && /\/offer$/.test(c.url)
  )!;
  const offerBody = JSON.parse(offer.body ?? "{}");
  assertEquals(offerBody.sku, "lpos-1");
  assertEquals(offerBody.marketplaceId, "EBAY_US");
  assertEquals(offerBody.format, "FIXED_PRICE");
  assertEquals(offerBody.categoryId, "12345");
  assertEquals(offerBody.merchantLocationKey, "lp-os-default");
  assertEquals(offerBody.pricingSummary.price, {
    value: "40.00",
    currency: "USD",
  });
  assertEquals(offerBody.listingPolicies, {
    fulfillmentPolicyId: "F1",
    paymentPolicyId: "P1",
    returnPolicyId: "R1",
  });
});

Deno.test("createDraft stops after a complete unpublished offer", async () => {
  const { fetchImpl, calls } = makeFetch(happyRoutes);
  const client = createEbayClient({
    credentials: REFRESH_CREDS,
    fetchImpl,
  });

  const result = await client.createDraft(PUBLISH_INPUT);
  assertEquals(result, { offerId: "OFF1", published: false });
  assert(
    !calls.some((call) => call.url.includes("/offer/OFF1/publish")),
    "draft creation must never publish the offer",
  );
});

Deno.test("publish creates the merchant location when missing", async () => {
  const { fetchImpl, calls } = makeFetch((call) => {
    if (
      call.method === "GET" && call.url.includes("/sell/inventory/v1/location/")
    ) {
      return { status: 404, body: {} };
    }
    if (
      call.method === "POST" &&
      call.url.includes("/sell/inventory/v1/location/")
    ) {
      return { status: 204 };
    }
    return happyRoutes(call);
  });
  const client = createEbayClient({
    credentials: REFRESH_CREDS,
    settings: {
      location: {
        postalCode: "89104",
        city: "Las Vegas",
        stateOrProvince: "NV",
      },
    },
    fetchImpl,
  });

  await client.publish(PUBLISH_INPUT);

  const created = calls.find((c) =>
    c.method === "POST" && c.url.includes("/location/lp-os-default")
  )!;
  assert(created, "location created");
  const body = JSON.parse(created.body ?? "{}");
  assertEquals(body.location.address.postalCode, "89104");
  assertEquals(body.location.address.country, "US");
  assertEquals(body.merchantLocationStatus, "ENABLED");
});

Deno.test("publish requires a ship-from postal code when creating the location", async () => {
  const { fetchImpl } = makeFetch((call) => {
    if (
      call.method === "GET" && call.url.includes("/sell/inventory/v1/location/")
    ) {
      return { status: 404, body: {} };
    }
    return happyRoutes(call);
  });
  const client = createEbayClient({ credentials: REFRESH_CREDS, fetchImpl });

  const error = await assertRejects(
    () => client.publish(PUBLISH_INPUT),
    MarketplaceError,
    "postal code",
  );
  assertEquals(error.permanent, true);
});

Deno.test("publish reuses an existing Seller Hub location key", async () => {
  const { fetchImpl, calls } = makeFetch((call) => {
    if (
      call.method === "GET" &&
      call.url.includes("/sell/inventory/v1/location/lp-os-default")
    ) {
      return { status: 404, body: {} };
    }
    if (
      call.method === "GET" &&
      call.url.includes("/sell/inventory/v1/location?limit=1")
    ) {
      return {
        status: 200,
        body: { locations: [{ merchantLocationKey: "seller-hub-main" }] },
      };
    }
    return happyRoutes(call);
  });
  const client = createEbayClient({ credentials: REFRESH_CREDS, fetchImpl });

  await client.createDraft(PUBLISH_INPUT);

  const offer = calls.find((call) =>
    call.method === "POST" && /\/sell\/inventory\/v1\/offer$/.test(call.url)
  )!;
  assertEquals(
    JSON.parse(offer.body ?? "{}").merchantLocationKey,
    "seller-hub-main",
  );
});

Deno.test("publish opts in and creates default policies when none exist", async () => {
  const { fetchImpl, calls } = makeFetch((call) => {
    const { method, url } = call;
    if (method === "GET" && url.includes("_policy?marketplace_id=")) {
      return {
        status: 200,
        body: {
          fulfillmentPolicies: [],
          paymentPolicies: [],
          returnPolicies: [],
        },
      };
    }
    if (url.includes("get_opted_in_programs")) {
      return { status: 200, body: { programs: [] } };
    }
    if (method === "POST" && url.includes("/program/opt_in")) {
      return { status: 200, body: {} };
    }
    if (
      method === "POST" && url.includes("/sell/account/v1/fulfillment_policy")
    ) {
      return { status: 201, body: { fulfillmentPolicyId: "NF" } };
    }
    if (method === "POST" && url.includes("/sell/account/v1/payment_policy")) {
      return { status: 201, body: { paymentPolicyId: "NP" } };
    }
    if (method === "POST" && url.includes("/sell/account/v1/return_policy")) {
      return { status: 201, body: { returnPolicyId: "NR" } };
    }
    return happyRoutes(call);
  });
  const client = createEbayClient({
    credentials: REFRESH_CREDS,
    settings: { shippingFlatCost: "6.50", handlingTimeDays: 2 },
    fetchImpl,
  });

  await client.publish(PUBLISH_INPUT);

  const optIn = calls.find((c) => c.url.includes("/program/opt_in"));
  assert(optIn, "opted in to business policies");
  const fulfillment = calls.find((c) =>
    c.method === "POST" && c.url.includes("/sell/account/v1/fulfillment_policy")
  )!;
  const body = JSON.parse(fulfillment.body ?? "{}");
  assertEquals(body.handlingTime, { value: 2, unit: "DAY" });
  assertEquals(
    body.shippingOptions[0].shippingServices[0].shippingCost.value,
    "6.50",
  );
  // categoryTypes is required on every policy create — eBay rejects without.
  for (
    const kind of ["fulfillment_policy", "payment_policy", "return_policy"]
  ) {
    const create = calls.find((c) =>
      c.method === "POST" && c.url.includes(`/sell/account/v1/${kind}`)
    )!;
    assertEquals(JSON.parse(create.body ?? "{}").categoryTypes, [
      { name: "ALL_EXCLUDING_MOTORS_VEHICLES" },
    ]);
  }
  const offer = calls.find((c) =>
    c.method === "POST" && /\/offer$/.test(c.url)
  )!;
  assertEquals(JSON.parse(offer.body ?? "{}").listingPolicies, {
    fulfillmentPolicyId: "NF",
    paymentPolicyId: "NP",
    returnPolicyId: "NR",
  });
});

Deno.test("publish falls back to updating an existing offer for the sku", async () => {
  const { fetchImpl, calls } = makeFetch((call) => {
    const { method, url } = call;
    if (method === "POST" && /\/sell\/inventory\/v1\/offer$/.test(url)) {
      return {
        status: 400,
        body: {
          errors: [{ errorId: 25002, message: "Offer entity already exists." }],
        },
      };
    }
    if (method === "GET" && url.includes("/sell/inventory/v1/offer?sku=")) {
      return {
        status: 200,
        body: { offers: [{ offerId: "OFF9", marketplaceId: "EBAY_US" }] },
      };
    }
    if (method === "PUT" && url.includes("/sell/inventory/v1/offer/OFF9")) {
      return { status: 204 };
    }
    if (method === "POST" && url.includes("/offer/OFF9/publish")) {
      return { status: 200, body: { listingId: "110900" } };
    }
    return happyRoutes(call);
  });
  const client = createEbayClient({ credentials: REFRESH_CREDS, fetchImpl });

  const result = await client.publish(PUBLISH_INPUT);
  assertEquals(result.offerId, "OFF9");
  assertEquals(result.externalId, "110900");
  assert(
    calls.some((c) => c.method === "PUT" && c.url.includes("/offer/OFF9")),
    "existing offer updated",
  );
});

Deno.test("a PUBLISHED offer for the sku is never mutated by the fallback", async () => {
  const { fetchImpl, calls } = makeFetch((call) => {
    const { method, url } = call;
    if (method === "POST" && /\/sell\/inventory\/v1\/offer$/.test(url)) {
      return {
        status: 400,
        body: {
          errors: [{ errorId: 25002, message: "Offer entity already exists." }],
        },
      };
    }
    if (method === "GET" && url.includes("/sell/inventory/v1/offer?sku=")) {
      return {
        status: 200,
        body: {
          offers: [{
            offerId: "OFF9",
            marketplaceId: "EBAY_US",
            status: "PUBLISHED",
          }],
        },
      };
    }
    return happyRoutes(call);
  });
  const client = createEbayClient({ credentials: REFRESH_CREDS, fetchImpl });

  const error = await assertRejects(
    () => client.publish(PUBLISH_INPUT),
    MarketplaceError,
    "already live",
  );
  assertEquals(error.permanent, true);
  assert(
    !calls.some((c) => c.method === "PUT" && c.url.includes("/offer/OFF9")),
    "published offer must not be updated",
  );
  assert(
    !calls.some((c) => c.url.includes("/offer/OFF9/publish")),
    "published offer must not be re-published",
  );
});

Deno.test("taxonomy API failure falls back to the configured categoryId", async () => {
  const { fetchImpl, calls } = makeFetch((call) => {
    if (call.url.includes("get_default_category_tree_id")) {
      return {
        status: 403,
        body: {
          errors: [{ errorId: 1100, message: "Insufficient permissions." }],
        },
      };
    }
    return happyRoutes(call);
  });
  const client = createEbayClient({
    credentials: REFRESH_CREDS,
    settings: { categoryId: "99999" },
    fetchImpl,
  });

  await client.publish(PUBLISH_INPUT);
  const offer = calls.find((c) =>
    c.method === "POST" && /\/offer$/.test(c.url)
  )!;
  assertEquals(JSON.parse(offer.body ?? "{}").categoryId, "99999");
});

Deno.test("HTTP 429 on token refresh stays transient", async () => {
  const { fetchImpl } = makeFetch((call) => {
    if (call.url.includes("/oauth2/token")) {
      return { status: 429, body: { error: "rate_limited" } };
    }
    return happyRoutes(call);
  });
  const client = createEbayClient({ credentials: REFRESH_CREDS, fetchImpl });
  const error = await assertRejects(
    () => client.publish(PUBLISH_INPUT),
    MarketplaceError,
    "token refresh failed",
  );
  assertEquals(error.permanent, false);
});

Deno.test("Content-Language follows the configured marketplace", async () => {
  const { fetchImpl, calls } = makeFetch(happyRoutes);
  const client = createEbayClient({
    credentials: { accessToken: "t" },
    settings: { marketplaceId: "EBAY_DE" },
    fetchImpl,
  });
  await client.publish(PUBLISH_INPUT).catch(() => {
    // policy fixtures return ids regardless of marketplace query — a later
    // step may still fail; the header assertion below is what matters.
  });
  const item = calls.find((c) =>
    c.method === "PUT" && c.url.includes("/inventory_item/")
  )!;
  assertEquals(item.headers["content-language"], "de-DE");
});

Deno.test("errors classify: 5xx transient, 4xx permanent with eBay message", async () => {
  const { fetchImpl } = makeFetch((call) => {
    if (call.method === "PUT" && call.url.includes("/inventory_item/")) {
      return {
        status: 500,
        body: {
          errors: [{ errorId: 25001, message: "A system error has occurred." }],
        },
      };
    }
    return happyRoutes(call);
  });
  const client = createEbayClient({ credentials: REFRESH_CREDS, fetchImpl });
  const transient = await assertRejects(
    () => client.publish(PUBLISH_INPUT),
    MarketplaceError,
    "system error",
  );
  assertEquals(transient.permanent, false);
  assertEquals(transient.status, 500);
  assertEquals(transient.code, "25001");

  const bad = makeFetch((call) => {
    if (call.method === "PUT" && call.url.includes("/inventory_item/")) {
      return {
        status: 400,
        body: {
          errors: [{
            errorId: 25709,
            message: "Invalid value for Content-Language.",
          }],
        },
      };
    }
    return happyRoutes(call);
  });
  const client2 = createEbayClient({
    credentials: REFRESH_CREDS,
    fetchImpl: bad.fetchImpl,
  });
  const permanent = await assertRejects(
    () => client2.publish(PUBLISH_INPUT),
    MarketplaceError,
    "Content-Language",
  );
  assertEquals(permanent.permanent, true);
});

Deno.test("a bare accessToken skips the token endpoint", async () => {
  const { fetchImpl, calls } = makeFetch(happyRoutes);
  const client = createEbayClient({
    credentials: { accessToken: "direct-token" },
    fetchImpl,
  });
  await client.publish(PUBLISH_INPUT);
  assertEquals(calls.filter((c) => c.url.includes("/oauth2/token")).length, 0);
  const item = calls.find((c) => c.method === "PUT")!;
  assertEquals(item.headers.authorization, "Bearer direct-token");
});

Deno.test("token refresh failure surfaces a clear error", async () => {
  const { fetchImpl } = makeFetch((call) => {
    if (call.url.includes("/oauth2/token")) {
      return {
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: "refresh token expired",
        },
      };
    }
    return happyRoutes(call);
  });
  const client = createEbayClient({ credentials: REFRESH_CREDS, fetchImpl });
  const error = await assertRejects(
    () => client.publish(PUBLISH_INPUT),
    MarketplaceError,
    "refresh token expired",
  );
  assertEquals(error.permanent, true);
});

Deno.test("verify reports ok with working credentials and failure detail otherwise", async () => {
  const { fetchImpl } = makeFetch((call) => {
    if (call.url.includes("/oauth2/token")) {
      return { status: 200, body: { access_token: "at-1", expires_in: 7200 } };
    }
    if (call.url.includes("/sell/inventory/v1/location?limit=1")) {
      return { status: 200, body: { locations: [] } };
    }
    return undefined;
  });
  const client = createEbayClient({ credentials: REFRESH_CREDS, fetchImpl });
  const ok = await client.verify();
  assertEquals(ok.ok, true);
  assertStringIncludes(ok.detail, "sandbox");

  const failing = makeFetch((call) => {
    if (call.url.includes("/oauth2/token")) {
      return { status: 401, body: { error: "invalid_client" } };
    }
    return undefined;
  });
  const client2 = createEbayClient({
    credentials: REFRESH_CREDS,
    fetchImpl: failing.fetchImpl,
  });
  const bad = await client2.verify();
  assertEquals(bad.ok, false);
  assertMatch(bad.detail, /token refresh failed/);
});

Deno.test("production environment uses the production hosts", async () => {
  const { fetchImpl, calls } = makeFetch(happyRoutes);
  const client = createEbayClient({
    environment: "production",
    credentials: { accessToken: "t" },
    fetchImpl,
  });
  const result = await client.publish(PUBLISH_INPUT);
  assert(calls.every((c) => c.url.startsWith("https://api.ebay.com/")));
  assertEquals(result.url, "https://www.ebay.com/itm/110123");
});

Deno.test("ebayCredentialsUsable accepts either token shape", () => {
  assert(ebayCredentialsUsable({ accessToken: "x" }));
  assert(ebayCredentialsUsable(REFRESH_CREDS));
  assertEquals(ebayCredentialsUsable({ clientId: "a" }), false);
  assertEquals(ebayCredentialsUsable({}), false);
});
