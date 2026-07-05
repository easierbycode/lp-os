// Local structural types for @lp-os/lifecycle.
//
// The dependency interfaces (TableApi / LifecycleDb / GraylogStore) mirror
// docs/CONTRACTS.md exactly but are declared HERE so this package compiles
// without importing @lp-os/db or @lp-os/graylog (built concurrently). The wire
// phase passes the real modules in — they satisfy these shapes structurally.

// ---------------------------------------------------------------------------
// Dependency interfaces (structural mirrors of the contracts)
// ---------------------------------------------------------------------------

// Mirrors @lp-os/db TableApi (CONTRACTS.md "Database" module API).
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

// The slice of @lp-os/db this package uses. The real module (typeof
// import("@lp-os/db")) has more exports; structural typing accepts it.
export interface LifecycleDb {
  Samples: TableApi;
  Bundles: TableApi;
  Transactions: TableApi; // audit rows — table "transactions"
}

// Search params/result mirror the @lp-os/graylog search surface (the same
// mini-Lucene + relative-range semantics as the shim it recreates). Kept loose
// on the result side so the real store's richer SearchResult still satisfies it.
// The param is named `rangeSeconds` to MATCH the real store's SearchParams —
// a differently-named optional prop would still typecheck structurally but
// silently turn every windowed read into all-time at runtime.
export type GraylogSearchParams = {
  query: string;
  rangeSeconds?: number; // seconds; 0 or >= 157680000 = all-time
  limit?: number;
  fields?: string[];
};

export type GraylogSearchMessage = {
  // Flat field map (source/message/timestamp copies + custom fields).
  message: Record<string, unknown>;
  index?: string;
};

export type GraylogSearchResult = {
  messages: GraylogSearchMessage[];
  total_results?: number;
};

// The slice of @lp-os/graylog's GraylogStore this package uses.
export interface GraylogStore {
  logEvent(
    shortMessage: string,
    fields: Record<string, unknown>,
  ): Promise<boolean>;
  search(params: GraylogSearchParams): Promise<GraylogSearchResult>;
}

export interface LifecycleDeps {
  db: LifecycleDb;
  store: GraylogStore;
}

// ---------------------------------------------------------------------------
// Vocabulary / config types
// ---------------------------------------------------------------------------

export type SampleStatusEntry = {
  value: string;
  label: string;
  kind: "status" | "badge";
  exclusive: boolean;
  appliesTo: string[];
  icon: string | null;
  palette: string;
  order: number;
};

export type CampaignEntry = {
  id: string;
  name: string;
  productMatch?: string[];
  productIds?: string[];
  dailyVideoGoal?: number;
  endsAt?: string;
  promo?: string;
};

// ---------------------------------------------------------------------------
// Input / result types (ported verbatim from data-pimp core/lifecycle.ts)
// ---------------------------------------------------------------------------

export type SampleRef = {
  sampleId?: string | number;
  productId?: string;
  qrCode?: string;
};

export type StatusUpdateInput = SampleRef & {
  status?: string;
  note?: string;
  source?: string;
  operator?: string;
};

export type StatusUpdateResult = {
  ok: boolean;
  sampleId: number | null;
  productId: string | null;
  name: string | null;
  status: string;
  previousStatus: string | null;
  postgres: { updated: boolean; reason?: string };
  graylog: boolean;
  message: string;
};

export type SoldInput = SampleRef & {
  creator?: string;
  salePrice?: number | string;
  marketplace?: string;
  fees?: number | string;
  shipping?: number | string;
  costBasis?: number | string;
  buyer?: string;
  orderRef?: string;
  note?: string;
  operator?: string;
  // Re-sell an already-sold sample on purpose (re-attribution). Off by default
  // because the Graylog revenue total can't be un-inflated.
  force?: boolean;
  // Emit ONLY the per-creator Graylog revenue event — skip the Postgres update,
  // the audit transaction, and the double-sell guard. Creator is resolved from
  // assignment history when not supplied.
  graylogOnly?: boolean;
  // Set by recordBulkSampleSold to tie a per-sample sale back to its bulk lot.
  bulkId?: string;
  bulkTotal?: number | string;
};

export type SoldResult = {
  ok: boolean;
  sampleId: number | null;
  productId: string | null;
  name: string | null;
  creator: string;
  marketplace: string;
  salePrice: number;
  fees: number;
  shipping: number;
  costBasis: number;
  net: number;
  postgres: { updated: boolean; transactionId: number | null; reason?: string };
  graylog: boolean;
  message: string;
};

export type BulkSoldItemInput = SampleRef & {
  creator?: string;
  price?: number | string;
  note?: string;
};

export type BulkSoldInput = {
  items?: BulkSoldItemInput[];
  totalPrice?: number | string;
  marketplace?: string;
  creator?: string;
  fees?: number | string;
  shipping?: number | string;
  costBasis?: number | string;
  buyer?: string;
  orderRef?: string;
  note?: string;
  force?: boolean;
  bulkId?: string;
  operator?: string;
};

export type BulkSoldResult = {
  ok: boolean;
  bulkId: string;
  marketplace: string;
  totalPrice: number;
  allocatedTotal: number;
  itemCount: number;
  soldCount: number;
  netTotal: number;
  items: SoldResult[];
  failures: { item: number; ref: string; error: string }[];
  message: string;
};

export type ListingInput = SampleRef & {
  creator?: string;
  marketplace?: string;
  askPrice?: number | string;
  listingUrl?: string;
  note?: string;
  operator?: string;
};

export type ListingResult = {
  ok: boolean;
  sampleId: number | null;
  productId: string | null;
  name: string | null;
  creator: string;
  marketplace: string;
  askPrice: number;
  listingUrl: string | null;
  graylog: boolean;
  message: string;
};

export type AgencyIntakeInput = {
  productId?: string;
  qrCode?: string;
  name?: string;
  sampleIds?: Array<string | number>;
  agencyBucket?: string;
  qty?: number | string;
  operator?: string;
  note?: string;
};

export type AgencyIntakeResult = {
  ok: boolean;
  productId: string | null;
  name: string | null;
  agencyBucket: string;
  qty: number;
  sampleIds: number[];
  postgres: { created: number; updated: number; reason?: string };
  graylog: boolean;
  message: string;
};

export type AssignmentInput = SampleRef & {
  creator?: string;
  agencyBucket?: string;
  campaign?: string;
  campaignId?: string;
  operator?: string;
  note?: string;
};

export type AssignmentResult = {
  ok: boolean;
  sampleId: number | null;
  productId: string | null;
  name: string | null;
  creator: string;
  fromStatus: string | null;
  agencyBucket: string | null;
  campaign: string | null;
  enrichment: string[];
  postgres: { updated: boolean; transactionId: number | null; reason?: string };
  graylog: boolean;
  message: string;
};

export type ImportInput = {
  productId?: string;
  qrCode?: string;
  name?: string;
  price?: number | string;
  image?: string;
  seller?: string;
  creator?: string;
  campaign?: string;
  operator?: string;
  note?: string;
  // Optional auto-listing schedule: after `autoListAfterDays`, a cron emits a
  // (stub) marketplace listing for this sample.
  autoListAfterDays?: number | string;
  marketplace?: string;
  askPrice?: number | string;
  // Preview only: compute campaign match + enrichment + the would-be schedule,
  // but write NOTHING (no Postgres row, no audit transaction, no Graylog event).
  dryRun?: boolean;
};

export type ScheduledListing = {
  scheduleId: string;
  listAt: string;
  marketplace: string;
  askPrice: number;
};

export type ImportResult = {
  ok: boolean;
  sampleId: number | null;
  productId: string | null;
  name: string | null;
  creator: string;
  campaign: string | null;
  enrichment: string[];
  scheduledListing: ScheduledListing | null;
  postgres: { created: boolean; transactionId: number | null; reason?: string };
  graylog: boolean;
  dryRun?: boolean;
  message: string;
};

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

// ---------------------------------------------------------------------------
// The Lifecycle surface (CONTRACTS.md "Lifecycle" — exact method set)
// ---------------------------------------------------------------------------

export interface Lifecycle {
  recordSampleStatus(input: StatusUpdateInput): Promise<StatusUpdateResult>;
  recordSampleSold(input: SoldInput): Promise<SoldResult>;
  recordBulkSampleSold(input: BulkSoldInput): Promise<BulkSoldResult>;
  recordSampleListing(input: ListingInput): Promise<ListingResult>;
  recordAgencyIntake(input: AgencyIntakeInput): Promise<AgencyIntakeResult>;
  recordSampleAssignment(input: AssignmentInput): Promise<AssignmentResult>;
  recordSampleImport(input: ImportInput): Promise<ImportResult>;
  listSampleStatuses(): SampleStatusEntry[];
}

// Graylog-backed reads lifecycle needs (CONTRACTS.md: reimplemented inside this
// package against the store). Exposed on the created object alongside Lifecycle.
export interface LifecycleReads {
  fetchKnownCreators(limit?: number): Promise<string[]>;
  fetchCreatorsForProduct(
    productId: string,
    limit?: number,
  ): Promise<string[]>;
  fetchAssignedCreatorForSample(
    sampleId?: string | number,
    productId?: string,
  ): Promise<string | null>;
  hasResaleEventForSample(sampleId?: string | number): Promise<boolean>;
  fetchDueListingSchedules(): Promise<DueListingSchedule[]>;
  markListingScheduleDone(scheduleId: string): Promise<void>;
}
