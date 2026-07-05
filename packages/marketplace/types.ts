// Local structural types for @lp-os/marketplace.
//
// Like @lp-os/lifecycle, the dependency interfaces mirror the real modules
// (@lp-os/db TableApi, @lp-os/graylog logEvent, @lp-os/lifecycle's listing
// surface) but are declared HERE so this package compiles standalone; the
// wire phase in apps/shell passes the real modules in — they satisfy these
// shapes structurally.

// ---------------------------------------------------------------------------
// Dependency interfaces (structural mirrors)
// ---------------------------------------------------------------------------

// Mirrors @lp-os/db TableApi.
export type TableApi = {
  list(orderBy?: string): Promise<Record<string, unknown>[]>;
  filter(
    filters: Record<string, unknown>,
    orderBy?: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]>;
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(
    id: string | number,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  delete(id: string | number): Promise<boolean>;
};

// The slice of @lp-os/db this package uses.
export interface MarketplaceDb {
  Samples: TableApi;
  Listings: TableApi;
}

// The slice of @lp-os/graylog's GraylogStore this package uses (event writes
// only — reads stay in @lp-os/lifecycle).
export interface EventStore {
  logEvent(
    shortMessage: string,
    fields: Record<string, unknown>,
  ): Promise<boolean>;
}

// Mirrors the @lp-os/lifecycle surface the listing service drives: the
// existing "listed" analytics event plus the scheduled-auto-list cron reads.
export type DueListingSchedule = {
  scheduleId: string;
  productId: string;
  sampleId: number | null;
  name: string;
  creator: string;
  marketplace: string;
  askPrice: number;
  listAt: string;
};

export interface LifecycleSlice {
  recordSampleListing(
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; graylog: boolean; message: string }>;
  fetchDueListingSchedules(): Promise<DueListingSchedule[]>;
  markListingScheduleDone(scheduleId: string): Promise<void>;
  fetchAssignedCreatorForSample(
    sampleId?: string | number,
    productId?: string,
  ): Promise<string | null>;
}

// Mirrors @lp-os/db MarketplaceAccount.
export type MarketplaceAccount = {
  marketplace: string;
  environment: string;
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
  connected_at: string | null;
  updated_at: string;
  updated_by: string | null;
};

// ---------------------------------------------------------------------------
// Marketplace client (the per-marketplace API adapter — eBay first)
// ---------------------------------------------------------------------------

export type PublishInput = {
  sku: string;
  title: string;
  description: string;
  price: number;
  currency: string;
  quantity: number;
  imageUrl?: string | null;
  brand?: string | null;
};

export type PublishResult = {
  /** Marketplace-side listing id (eBay: listingId). */
  externalId: string;
  /** Intermediate id when the marketplace has one (eBay: offerId). */
  offerId?: string;
  /** Public URL of the live listing. */
  url: string;
};

export interface MarketplaceClient {
  /** Cheap authenticated call proving the stored credentials work. */
  verify(): Promise<{ ok: boolean; detail: string }>;
  publish(input: PublishInput): Promise<PublishResult>;
}

/** Thrown by marketplace clients. `permanent: true` means retrying without a
 * config/data change cannot succeed (bad request, missing image, bad
 * credentials) — the auto-lister gives up on the schedule; transient errors
 * (network, 5xx, rate limit) leave the schedule open for the next pass. */
export class MarketplaceError extends Error {
  permanent: boolean;
  status?: number;
  code?: string;
  constructor(
    message: string,
    opts: { permanent?: boolean; status?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "MarketplaceError";
    this.permanent = opts.permanent ?? false;
    this.status = opts.status;
    this.code = opts.code;
  }
}

// ---------------------------------------------------------------------------
// Listing service inputs/results
// ---------------------------------------------------------------------------

export type ListSampleInput = {
  sampleId?: string | number;
  productId?: string;
  qrCode?: string;
  marketplace?: string;
  askPrice?: number | string;
  creator?: string;
  note?: string;
  operator?: string;
  /** What triggered the listing: manual (default) | schedule | status-auto. */
  source?: string;
  /** Re-list even when an active listing row already exists. */
  force?: boolean;
};

export type ListingRow = Record<string, unknown>;

export type ListSampleResult = {
  ok: boolean;
  listing: ListingRow | null;
  sampleId: number | null;
  productId: string | null;
  name: string | null;
  marketplace: string;
  askPrice: number;
  creator: string | null;
  listingUrl: string | null;
  externalId: string | null;
  /** Set on failure; `permanent` says whether a retry could help. */
  error: string | null;
  permanent?: boolean;
  /** True when the refusal was "this sample is already live on that
   * marketplace" — the auto-lister treats the intent as satisfied. */
  alreadyListed?: boolean;
  graylog: boolean;
  message: string;
};

export type ScheduleRunOutcome = {
  scheduleId: string;
  marketplace: string;
  status: "listed" | "failed" | "skipped" | "deferred";
  reason?: string;
  listingUrl?: string | null;
};

export type AutoListPassResult = {
  ok: boolean;
  ranAt: string;
  schedules: ScheduleRunOutcome[];
  statusAuto: ScheduleRunOutcome[];
  message: string;
};

export interface ListingServiceDeps {
  db: MarketplaceDb;
  store: EventStore;
  lifecycle: LifecycleSlice;
  getAccount(marketplace: string): Promise<MarketplaceAccount | null>;
  listAccounts(): Promise<MarketplaceAccount[]>;
  /** Override the marketplace-client construction (tests inject fakes). */
  clientFactory?: (account: MarketplaceAccount) => MarketplaceClient;
}

export interface ListingService {
  listSample(input: ListSampleInput): Promise<ListSampleResult>;
  runAutoListPass(): Promise<AutoListPassResult>;
  verifyMarketplace(
    marketplace: string,
  ): Promise<{ ok: boolean; detail: string }>;
}
