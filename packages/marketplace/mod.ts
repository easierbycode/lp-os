// @lp-os/marketplace — marketplace listing of samples (eBay first of the
// initial three marketplaces).
//
// createListingService is the one write path for real listings: it resolves a
// sample, publishes through the marketplace's API adapter, keeps the Postgres
// `listings` row as the current-status truth, and emits the same Graylog
// events the skills already query ("listed" via lifecycle.recordSampleListing,
// plus a new "listing_failed"). startAutoLister is the in-process cron that
// turns the lifecycle package's scheduled-listing intents into real listings
// and optionally auto-lists samples the moment they are cleared_to_sell.

import { createEbayClient, ebayCredentialsUsable } from "./ebay.ts";
import {
  type AutoListPassResult,
  type DueListingSchedule,
  type ListingService,
  type ListingServiceDeps,
  type ListSampleInput,
  type ListSampleResult,
  type MarketplaceAccount,
  type MarketplaceClient,
  MarketplaceError,
  type PublishResult,
  type ScheduleRunOutcome,
} from "./types.ts";

export * from "./types.ts";
export {
  createEbayClient,
  type EbayClientOptions,
  ebayCredentialsUsable,
} from "./ebay.ts";
// Pricing formula ported verbatim from data-pimp core/ebay-pricing.ts (pure,
// stateless) — serves /api/ebay-price and the Demos/E2E pricing demo.
export {
  computeEbayPrice,
  DEFAULT_EBAY_PRICING,
  type EbayPriceInput,
  type EbayPriceResult,
  markdownLadder,
  type MarkdownLadderRow,
} from "./ebay-pricing.ts";

// Same GELF host as every lifecycle event (docs/CONTRACTS.md [decided here]).
const GRAYLOG_SOURCE = "thirsty-store-kiosk";

// sample_source tokens stamped on marketplace-written events, alongside the
// lifecycle's existing skill-* vocabulary.
const SOURCE_TOKENS: Record<string, string> = {
  manual: "marketplace-api",
  schedule: "marketplace-cron",
  "status-auto": "marketplace-auto",
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function toNumber(v: unknown): number {
  if (v === undefined || v === null || v === "") return 0;
  // Tolerate "$1,299.99" / "1 299.99"; anything else non-numeric stays 0 so
  // callers can tell "absent/unparseable" from a real value.
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Do the stored credentials look usable for this marketplace? */
export function accountConnected(account: MarketplaceAccount | null): boolean {
  if (!account) return false;
  if (account.marketplace === "ebay") {
    return ebayCredentialsUsable(account.credentials ?? {});
  }
  return Object.values(account.credentials ?? {}).some((v) => str(v));
}

export function createListingService(deps: ListingServiceDeps): ListingService {
  // One client per marketplace account, rebuilt when the stored
  // environment/credentials/settings change (prerequisite lookups are cached
  // on the client instance).
  const clients = new Map<
    string,
    { stamp: string; client: MarketplaceClient }
  >();

  function defaultClientFactory(
    account: MarketplaceAccount,
  ): MarketplaceClient {
    if (account.marketplace === "ebay") {
      return createEbayClient({
        environment: account.environment,
        credentials: account.credentials ?? {},
        settings: account.settings ?? {},
      });
    }
    throw new MarketplaceError(
      `no API adapter for marketplace "${account.marketplace}" yet — eBay is the first of the initial three`,
      { permanent: true },
    );
  }

  function clientFor(account: MarketplaceAccount): MarketplaceClient {
    const stamp = JSON.stringify([
      account.environment,
      account.credentials,
      account.settings,
    ]);
    const cached = clients.get(account.marketplace);
    if (cached && cached.stamp === stamp) return cached.client;
    const client = (deps.clientFactory ?? defaultClientFactory)(account);
    clients.set(account.marketplace, { stamp, client });
    return client;
  }

  // sendEvent semantics matched to @lp-os/lifecycle: strip empty values,
  // stamp the shared source, never throw.
  async function sendEvent(
    shortMessage: string,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === "") continue;
      clean[k] = v;
    }
    clean.source = GRAYLOG_SOURCE;
    try {
      return await deps.store.logEvent(shortMessage, clean);
    } catch {
      return false;
    }
  }

  async function resolveSample(
    input: ListSampleInput,
  ): Promise<Record<string, unknown> | null> {
    const sid = str(input.sampleId);
    if (sid) {
      const rows = await deps.db.Samples.filter({ id: sid }, undefined, 1);
      return rows[0] ?? null;
    }
    const key = str(input.productId) || str(input.qrCode);
    if (!key) return null;
    const rows = await deps.db.Samples.filter(
      { qr_code: key },
      "-created_at",
      25,
    );
    // Unlike the analytics-only lifecycle resolver, NO fallback to a sold
    // row: this path publishes real listings, so sold stock never qualifies.
    return rows.find((r) => str(r.status) !== "sold") ?? null;
  }

  // Serializes attempts per sample+marketplace so concurrent calls (double-
  // clicked Retry, cron pass racing a manual list) can't both pass the
  // already-listed check and publish twice.
  const inflight = new Map<string, Promise<ListSampleResult>>();

  function listSample(input: ListSampleInput): Promise<ListSampleResult> {
    return listSamplePrepare(input);
  }

  async function listSamplePrepare(
    input: ListSampleInput,
  ): Promise<ListSampleResult> {
    const marketplace = str(input.marketplace) || "ebay";
    const sourceKind = Object.hasOwn(SOURCE_TOKENS, str(input.source))
      ? str(input.source)
      : "manual";
    const sourceToken = SOURCE_TOKENS[sourceKind];

    const row = await resolveSample(input);
    if (!row) {
      throw new Error(
        "sample not found (or every matching row is sold) — pass the sampleId, productId, or qrCode of an unsold inventory row",
      );
    }
    const sampleId = Number(row.id);
    const productId = str(row.qr_code) || str(input.productId) || null;
    const name = str(row.name) || null;

    if (str(row.status) === "sold") {
      throw new Error(
        `sample ${sampleId} is sold — refusing to publish a listing for stock that no longer exists`,
      );
    }

    const account = await deps.getAccount(marketplace);
    if (!accountConnected(account)) {
      throw new Error(
        `${marketplace} is not connected — open the Marketplace window and save API credentials first`,
      );
    }

    // An explicitly supplied price must parse — never silently substitute the
    // sample's stored price for a typo'd one (this publishes a live listing).
    const explicitAsk = str(input.askPrice);
    const parsedAsk = toNumber(input.askPrice);
    if (explicitAsk && !(parsedAsk > 0)) {
      throw new Error(
        `askPrice "${explicitAsk}" is not a positive number — fix it or leave it blank to use the sample's best/current price`,
      );
    }
    const askPrice = parsedAsk || toNumber(row.best_price) ||
      toNumber(row.current_price);
    if (!(askPrice > 0)) {
      throw new Error(
        "askPrice must be a positive number (none given and the sample has no best/current price)",
      );
    }

    let creator = str(input.creator);
    if (!creator) {
      creator = str(
        await deps.lifecycle.fetchAssignedCreatorForSample(
          sampleId,
          productId ?? undefined,
        ),
      );
    }
    if (!creator) creator = str(row.checked_out_to);
    if (!creator) creator = str(account!.settings?.defaultCreator);
    if (!creator) {
      throw new Error(
        "creator is required — pass creator or set a default creator in Marketplace settings",
      );
    }

    const imageUrl = str(row.picture_url);
    if (!imageUrl.startsWith("https://")) {
      throw new Error(
        "eBay requires at least one public https image — set the sample's picture_url first",
      );
    }

    // Everything below reads-then-writes listing rows and talks to the
    // marketplace — one attempt at a time per sample+marketplace.
    const key = `${marketplace}:${sampleId}`;
    const chained = (inflight.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() =>
        listSampleAttempt(input, {
          marketplace,
          sourceKind,
          sourceToken,
          row,
          sampleId,
          productId,
          name,
          account: account!,
          askPrice,
          creator,
          imageUrl,
        })
      );
    inflight.set(key, chained);
    try {
      return await chained;
    } finally {
      if (inflight.get(key) === chained) inflight.delete(key);
    }
  }

  async function listSampleAttempt(
    input: ListSampleInput,
    ctx: {
      marketplace: string;
      sourceKind: string;
      sourceToken: string;
      row: Record<string, unknown>;
      sampleId: number;
      productId: string | null;
      name: string | null;
      account: MarketplaceAccount;
      askPrice: number;
      creator: string;
      imageUrl: string;
    },
  ): Promise<ListSampleResult> {
    const {
      marketplace,
      sourceKind,
      sourceToken,
      row,
      sampleId,
      productId,
      name,
      account,
      askPrice,
      creator,
      imageUrl,
    } = ctx;

    const existing = await deps.db.Listings.filter(
      { sample_id: sampleId, marketplace },
      "-created_at",
      25,
    );
    const live = existing.find((l) => str(l.status) === "listed");
    if (live && !input.force) {
      const url = str(live.listing_url) || null;
      return {
        ok: false,
        listing: live,
        sampleId,
        productId,
        name,
        marketplace,
        askPrice,
        creator,
        listingUrl: url,
        externalId: str(live.external_id) || null,
        error: `already listed on ${marketplace}${
          url ? ` (${url})` : ""
        } — pass force to list again`,
        permanent: true,
        alreadyListed: true,
        graylog: false,
        message: `${name ?? "sample"} is already listed on ${marketplace}${
          url ? `: ${url}` : ""
        }.`,
      };
    }

    // force = deliberately list ANOTHER unit while one is already live. The
    // SKU must differ — reusing lpos-<id> would collide with the live offer
    // (eBay allows one offer per sku+marketplace) and mutate it.
    const sku = live && input.force
      ? `lpos-${sampleId}-${existing.length + 1}`
      : `lpos-${sampleId}`;
    const now = new Date().toISOString();
    const pendingPatch = {
      status: "pending",
      source: sourceKind,
      sku,
      ask_price: askPrice,
      currency: str(account.settings?.currency) || "USD",
      creator,
      operator: str(input.operator) || null,
      error: null,
      updated_at: now,
    };
    const reusable = existing.find((l) =>
      str(l.status) === "pending" || str(l.status) === "failed"
    );
    let listing = reusable
      ? (await deps.db.Listings.update(String(reusable.id), pendingPatch)) ??
        reusable
      : await deps.db.Listings.create({
        sample_id: sampleId,
        marketplace,
        ...pendingPatch,
      });
    const listingId = Number(listing.id);

    const brand = str(row.brand) || null;
    const quantity = Math.max(1, Math.trunc(toNumber(row.quantity)) || 1);
    const title = (name ?? `Sample ${sampleId}`).slice(0, 80);
    const description = `${title}${brand ? ` by ${brand}` : ""}. ${
      str(account.settings?.descriptionSuffix) ||
      "Brand new, unopened item from our creator sample inventory."
    }`;

    let published: PublishResult;
    try {
      published = await clientFor(account).publish({
        sku,
        title,
        description,
        price: askPrice,
        currency: str(account.settings?.currency) || "USD",
        quantity,
        imageUrl,
        brand,
      });
    } catch (error) {
      const permanent = error instanceof MarketplaceError
        ? error.permanent
        : false;
      const message = errorMessage(error);
      const failedAt = new Date().toISOString();
      listing = (await deps.db.Listings.update(String(listingId), {
        status: "failed",
        error: message,
        updated_at: failedAt,
      })) ?? listing;

      // Manual attempts and dead ends get an event; transient auto-retries
      // only update the row — otherwise a 5-minute cron against a flaky
      // marketplace floods graylog with one listing_failed per pass.
      let graylog = false;
      if (permanent || sourceKind === "manual") {
        graylog = await sendEvent(
          `thirsty sample listing failed: ${
            name ?? productId ?? "sample"
          } on ${marketplace} — ${message}`,
          {
            listing_error_json: JSON.stringify({
              listingId,
              sampleId,
              productId,
              name,
              creator,
              marketplace,
              askPrice,
              error: message,
              permanent,
              failedAt,
            }),
            creator,
            marketplace,
            ask_price_num: askPrice,
            product_id: productId ?? undefined,
            sample_id: String(sampleId),
            listing_id: String(listingId),
            sample_event: "listing_failed",
            sample_source: sourceToken,
          },
        );
      }

      return {
        ok: false,
        listing,
        sampleId,
        productId,
        name,
        marketplace,
        askPrice,
        creator,
        listingUrl: null,
        externalId: null,
        error: message,
        permanent,
        graylog,
        message: `Listing ${
          name ?? `sample ${sampleId}`
        } on ${marketplace} failed: ${message}${
          permanent ? "" : " (transient — will be retried if scheduled)"
        }`,
      };
    }

    // The listing is LIVE from here on — persistence problems must never be
    // reported as a failed listing (that would invite a re-list → duplicate).
    let persistWarning = "";
    const listedAt = new Date().toISOString();
    try {
      listing = (await deps.db.Listings.update(String(listingId), {
        status: "listed",
        offer_id: published.offerId ?? null,
        external_id: published.externalId,
        listing_url: published.url,
        listed_at: listedAt,
        error: null,
        updated_at: listedAt,
      })) ?? listing;
    } catch (error) {
      persistWarning =
        ` WARNING: the eBay listing IS live at ${published.url} but the listings row update failed (${
          errorMessage(error)
        }) — fix the row manually.`;
    }

    // The same "listed" analytics event the skills already query, extended
    // with the row/marketplace ids so status is joinable both ways.
    let graylog = false;
    try {
      const recorded = await deps.lifecycle.recordSampleListing({
        sampleId,
        creator,
        marketplace,
        askPrice,
        listingUrl: published.url,
        note: str(input.note) || undefined,
        operator: str(input.operator) || undefined,
        source: sourceToken,
        listingId,
        externalId: published.externalId,
      });
      graylog = recorded.graylog;
    } catch {
      graylog = false;
    }

    return {
      ok: true,
      listing,
      sampleId,
      productId,
      name,
      marketplace,
      askPrice,
      creator,
      listingUrl: published.url,
      externalId: published.externalId,
      error: null,
      graylog,
      message: `Listed ${name ?? `sample ${sampleId}`} at $${
        askPrice.toFixed(2)
      } on ${marketplace} for ${creator}: ${published.url}${
        graylog ? "" : " WARNING: Graylog listing event was NOT written."
      }${persistWarning}`,
    };
  }

  async function runSchedules(
    accounts: Map<string, MarketplaceAccount>,
  ): Promise<ScheduleRunOutcome[]> {
    const outcomes: ScheduleRunOutcome[] = [];
    // At most this many real publish attempts per pass, across marketplaces.
    const scheduleCap = 10;
    let fired = 0;
    let due: DueListingSchedule[] = [];
    try {
      due = await deps.lifecycle.fetchDueListingSchedules();
    } catch (error) {
      return [{
        scheduleId: "(fetch)",
        marketplace: "*",
        status: "deferred",
        reason: `fetchDueListingSchedules failed: ${errorMessage(error)}`,
      }];
    }

    for (const sched of due) {
      const marketplace = sched.marketplace || "ebay";
      const base = { scheduleId: sched.scheduleId, marketplace };
      const account = accounts.get(marketplace) ?? null;
      if (!accountConnected(account)) {
        outcomes.push({
          ...base,
          status: "deferred",
          reason: `${marketplace} not connected`,
        });
        continue;
      }
      if (account!.settings?.autoListScheduled === false) {
        outcomes.push({
          ...base,
          status: "deferred",
          reason: "scheduled auto-listing disabled in settings",
        });
        continue;
      }
      if (fired >= scheduleCap) {
        // A backlog of stub-era schedules must not real-publish all at once
        // the moment credentials land — drain it a few per pass instead.
        outcomes.push({
          ...base,
          status: "deferred",
          reason:
            `auto-list pass cap (${scheduleCap}) reached — continuing next pass`,
        });
        continue;
      }
      fired++;
      try {
        const result = await listSample({
          sampleId: sched.sampleId ?? undefined,
          productId: sched.productId || undefined,
          marketplace,
          askPrice: sched.askPrice,
          creator: sched.creator || undefined,
          source: "schedule",
          note: `auto-listed from schedule ${sched.scheduleId}`,
        });
        if (result.ok) {
          await deps.lifecycle.markListingScheduleDone(sched.scheduleId);
          outcomes.push({
            ...base,
            status: "listed",
            listingUrl: result.listingUrl,
          });
        } else if (result.alreadyListed) {
          await deps.lifecycle.markListingScheduleDone(sched.scheduleId);
          outcomes.push({
            ...base,
            status: "skipped",
            reason: result.error ?? "already listed",
          });
        } else if (result.permanent) {
          await deps.lifecycle.markListingScheduleDone(sched.scheduleId);
          outcomes.push({
            ...base,
            status: "failed",
            reason: result.error ?? "permanent failure",
          });
        } else {
          outcomes.push({
            ...base,
            status: "deferred",
            reason: result.error ?? "transient failure",
          });
        }
      } catch (error) {
        // Thrown = local validation. A missing or SOLD sample can never be
        // listed — burn the schedule; anything else stays open for the next
        // pass (missing price/creator/image are fixable on the sample).
        const reason = errorMessage(error);
        if (/sample not found|is sold/i.test(reason)) {
          await deps.lifecycle.markListingScheduleDone(sched.scheduleId);
          outcomes.push({ ...base, status: "failed", reason });
        } else {
          outcomes.push({ ...base, status: "deferred", reason });
        }
      }
    }
    return outcomes;
  }

  async function runStatusAuto(
    accounts: MarketplaceAccount[],
  ): Promise<ScheduleRunOutcome[]> {
    const outcomes: ScheduleRunOutcome[] = [];
    for (const account of accounts) {
      // Explicit opt-in only: auto-listing every cleared_to_sell sample is a
      // policy decision the user makes in Marketplace settings.
      if (account.settings?.autoListClearedToSell !== true) continue;
      if (!accountConnected(account)) continue;
      const marketplace = account.marketplace;
      const maxRaw = toNumber(account.settings?.autoListMaxPerPass);
      const max = Math.min(25, Math.max(1, Math.trunc(maxRaw) || 5));

      let rows: Record<string, unknown>[] = [];
      try {
        rows = await deps.db.Samples.filter(
          { status: "cleared_to_sell" },
          "-created_at",
          100,
        );
      } catch (error) {
        outcomes.push({
          scheduleId: "(samples)",
          marketplace,
          status: "deferred",
          reason: errorMessage(error),
        });
        continue;
      }

      let attempted = 0;
      for (const row of rows) {
        if (attempted >= max) break;
        const sampleId = Number(row.id);
        // One automatic attempt per sample+marketplace: any prior row
        // (listed, pending, or failed) means a human decides what's next.
        const prior = await deps.db.Listings.filter(
          { sample_id: sampleId, marketplace },
          undefined,
          1,
        );
        if (prior.length) continue;
        const base = { scheduleId: `sample-${sampleId}`, marketplace };
        try {
          const result = await listSample({
            sampleId,
            marketplace,
            source: "status-auto",
          });
          // Only real publish attempts consume the per-pass budget —
          // validation-skipped samples (no image/price/creator) create no
          // listing row and would otherwise starve listable ones forever.
          attempted++;
          outcomes.push({
            ...base,
            status: result.ok ? "listed" : "failed",
            reason: result.error ?? undefined,
            listingUrl: result.listingUrl,
          });
        } catch (error) {
          outcomes.push({
            ...base,
            status: "skipped",
            reason: errorMessage(error),
          });
        }
      }
    }
    return outcomes;
  }

  async function runAutoListPass(): Promise<AutoListPassResult> {
    const ranAt = new Date().toISOString();
    let accounts: MarketplaceAccount[] = [];
    try {
      accounts = await deps.listAccounts();
    } catch (error) {
      return {
        ok: false,
        ranAt,
        schedules: [],
        statusAuto: [],
        message: `auto-list pass failed to read accounts: ${
          errorMessage(error)
        }`,
      };
    }
    const byMarketplace = new Map(accounts.map((a) => [a.marketplace, a]));
    const schedules = await runSchedules(byMarketplace);
    const statusAuto = await runStatusAuto(accounts);
    const listed =
      [...schedules, ...statusAuto].filter((o) => o.status === "listed").length;
    const failed =
      [...schedules, ...statusAuto].filter((o) => o.status === "failed").length;
    return {
      ok: true,
      ranAt,
      schedules,
      statusAuto,
      message:
        `auto-list pass: ${listed} listed, ${failed} failed, ${schedules.length} schedule(s) checked, ${statusAuto.length} status-auto attempt(s)`,
    };
  }

  async function verifyMarketplace(
    marketplace: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const account = await deps.getAccount(marketplace);
    if (!account) {
      return { ok: false, detail: `${marketplace} is not configured` };
    }
    if (!accountConnected(account)) {
      return {
        ok: false,
        detail: `${marketplace} credentials are incomplete`,
      };
    }
    try {
      return await clientFor(account).verify();
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    }
  }

  return { listSample, runAutoListPass, verifyMarketplace };
}

/* --------------------------------------------------------- auto-lister -- */

export type AutoLister = {
  stop(): void;
  runNow(): Promise<AutoListPassResult | null>;
};

/** In-process cron: fires runAutoListPass every intervalMs (default 5 min),
 * never overlapping passes. This is the whole "automatic listing" scheduler —
 * no external queue, per the realtime/no-new-systems rule. */
export function startAutoLister(opts: {
  service: ListingService;
  intervalMs?: number;
  onPass?: (result: AutoListPassResult) => void;
  logger?: (message: string) => void;
}): AutoLister {
  const intervalMs = Math.max(15_000, opts.intervalMs ?? 300_000);
  const log = opts.logger ?? (() => {});
  let running = false;
  let stopped = false;

  async function pass(): Promise<AutoListPassResult | null> {
    if (running || stopped) return null;
    running = true;
    try {
      const result = await opts.service.runAutoListPass();
      const acted = result.schedules.length + result.statusAuto.length;
      if (acted > 0 || !result.ok) log(`[auto-list] ${result.message}`);
      opts.onPass?.(result);
      return result;
    } catch (error) {
      log(
        `[auto-list] pass crashed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    } finally {
      running = false;
    }
  }

  // First pass shortly after boot (let the server finish coming up), then
  // steady-state on the interval.
  const first = setTimeout(pass, 15_000);
  const timer = setInterval(pass, intervalMs);

  return {
    stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
    runNow: pass,
  };
}
