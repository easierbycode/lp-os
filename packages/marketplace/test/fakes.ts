// In-memory fakes for @lp-os/marketplace tests, mirroring the conventions of
// packages/lifecycle/test/fakes.ts (FakeTable string-equality filters,
// recorded events, first-match-wins routing).

import type {
  DueListingSchedule,
  ListingServiceDeps,
  MarketplaceAccount,
  MarketplaceClient,
  PublishInput,
  PublishResult,
  TableApi,
} from "../types.ts";
import type { MarketplaceError } from "../types.ts";

export class FakeTable implements TableApi {
  rows: Record<string, unknown>[] = [];
  nextId = 1;
  failNextCreate = false;

  list(orderBy?: string): Promise<Record<string, unknown>[]> {
    return this.filter({}, orderBy);
  }

  filter(
    filters: Record<string, unknown>,
    orderBy?: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]> {
    let out = this.rows.filter((row) =>
      Object.entries(filters).every(([k, v]) =>
        v === undefined || v === null || String(row[k]) === String(v)
      )
    );
    const raw = (orderBy || "").trim();
    if (raw) {
      const desc = raw.startsWith("-");
      const col = desc ? raw.slice(1) : raw;
      out = [...out].sort((a, b) => {
        const av = String(a[col] ?? "");
        const bv = String(b[col] ?? "");
        return desc ? bv.localeCompare(av) : av.localeCompare(bv);
      });
    }
    if (limit && limit > 0) out = out.slice(0, limit);
    return Promise.resolve(out.map((r) => ({ ...r })));
  }

  create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      return Promise.reject(new Error("create failed (FakeTable)"));
    }
    const row = {
      id: this.nextId++,
      created_at: new Date().toISOString(),
      ...data,
    };
    this.rows.push(row);
    return Promise.resolve({ ...row });
  }

  update(
    id: string | number,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const row = this.rows.find((r) => String(r.id) === String(id));
    if (!row) return Promise.resolve(null);
    Object.assign(row, data);
    return Promise.resolve({ ...row });
  }

  delete(id: string | number): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => String(r.id) !== String(id));
    return Promise.resolve(this.rows.length < before);
  }
}

export class FakeStore {
  events: { shortMessage: string; fields: Record<string, unknown> }[] = [];
  logEventResult = true;

  logEvent(
    shortMessage: string,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    this.events.push({ shortMessage, fields });
    return Promise.resolve(this.logEventResult);
  }

  eventsWithField(field: string) {
    return this.events.filter((e) => e.fields[field] !== undefined);
  }
}

export class FakeLifecycle {
  listingCalls: Record<string, unknown>[] = [];
  listingGraylog = true;
  dueSchedules: DueListingSchedule[] = [];
  doneScheduleIds: string[] = [];
  assignedCreator: string | null = null;

  recordSampleListing(
    input: Record<string, unknown>,
  ): Promise<{ ok: boolean; graylog: boolean; message: string }> {
    this.listingCalls.push(input);
    return Promise.resolve({
      ok: this.listingGraylog,
      graylog: this.listingGraylog,
      message: "recorded",
    });
  }

  fetchDueListingSchedules(): Promise<DueListingSchedule[]> {
    return Promise.resolve([...this.dueSchedules]);
  }

  markListingScheduleDone(scheduleId: string): Promise<void> {
    this.doneScheduleIds.push(scheduleId);
    return Promise.resolve();
  }

  fetchAssignedCreatorForSample(): Promise<string | null> {
    return Promise.resolve(this.assignedCreator);
  }
}

export class FakeClient implements MarketplaceClient {
  publishCalls: PublishInput[] = [];
  /** Queue of behaviors, one per publish call; last entry repeats. */
  publishPlan: Array<PublishResult | MarketplaceError | Error> = [{
    externalId: "110001",
    offerId: "offer-1",
    url: "https://sandbox.ebay.com/itm/110001",
    published: true,
  }];
  verifyResult = { ok: true, detail: "fake client OK" };

  publish(input: PublishInput): Promise<PublishResult> {
    this.publishCalls.push(input);
    const step = this.publishPlan.length > 1
      ? this.publishPlan.shift()!
      : this.publishPlan[0];
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve(step);
  }

  createDraft(input: PublishInput): Promise<PublishResult> {
    this.publishCalls.push(input);
    const step = this.publishPlan.length > 1
      ? this.publishPlan.shift()!
      : this.publishPlan[0];
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve({
      ...step,
      externalId: undefined,
      url: undefined,
      published: false,
    });
  }

  verify(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve(this.verifyResult);
  }
}

export function makeAccount(
  overrides: Partial<MarketplaceAccount> = {},
): MarketplaceAccount {
  return {
    marketplace: "ebay",
    environment: "sandbox",
    credentials: { accessToken: "test-token" },
    settings: {},
    connected_at: null,
    updated_at: new Date().toISOString(),
    updated_by: null,
    ...overrides,
  };
}

export function makeServiceDeps(accounts: MarketplaceAccount[] = []) {
  const Samples = new FakeTable();
  const Listings = new FakeTable();
  const store = new FakeStore();
  const lifecycle = new FakeLifecycle();
  const client = new FakeClient();
  const accountMap = new Map(accounts.map((a) => [a.marketplace, a]));

  const deps: ListingServiceDeps = {
    db: { Samples, Listings },
    store,
    lifecycle,
    getAccount: (marketplace) =>
      Promise.resolve(accountMap.get(marketplace) ?? null),
    listAccounts: () => Promise.resolve([...accountMap.values()]),
    clientFactory: () => client,
  };

  return { deps, Samples, Listings, store, lifecycle, client, accountMap };
}
