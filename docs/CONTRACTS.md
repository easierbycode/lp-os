# LP-OS Build Contracts

Fixed decisions for the consolidation build. MIGRATION_PLAN.md is the _why_;
this file is the _what_, at the level of names, boundaries, and export
signatures. Every module follows these contracts — if a contract and local
convenience disagree, the contract wins (it's what the other, concurrently-built
modules compile against). Where MIGRATION_PLAN.md left a question open, the
decision made here is marked **[decided here]**.

## Repo layout

```
lp-os/
  deno.json                 # workspace root (apps/shell + packages/*)
  apps/
    shell/                  # Fresh 2.x core app: OS shell page + all HTTP/WS APIs (Deno)
    member/                 # SvelteKit member dashboard (@deno/svelte-adapter, own package.json)
  packages/
    db/                     # @lp-os/db        — consolidated Postgres schema, migrations, client
    relay/                  # @lp-os/relay     — scan-socket WebSocket relay: server + browser client
    graylog/                # @lp-os/graylog   — message store: GELF ingest, mini-Lucene search, backfill
    lifecycle/              # @lp-os/lifecycle — dual-write inventory event logic (port of core/lifecycle.ts)
  extension/                # merged Chrome extension (satellite; not part of the Deno workspace)
  .claude/skills/           # consolidated agent skills (7)
  docs/
```

`apps/member` is npm/Vite-driven (mirroring tiktok-sample-tracker). It is listed
in the root `workspace` array only because Deno refuses to run against a nested
`deno.json` that isn't a member — but npm owns its `node_modules` (run `npm ci`
there, not `deno install`) and it is excluded from root fmt/lint. Its
`deno.json` import map carries the `node:` builtins plus the bare npm specifiers
the generated `.deno-deploy` server imports (needed by `deno desktop`; see
`docs/DISTRIBUTION.md`). Cross-package Deno imports use the workspace names
`@lp-os/db`, `@lp-os/relay`, `@lp-os/graylog`, `@lp-os/lifecycle` (already
pinned in each package's `deno.json`).

## Environment variables (the complete set)

- `DATABASE_URL` — Neon Postgres. The only datastore.
- `PORT` — shell app port (default 8000).
- `GRAYLOG_INGEST_TOKEN` — optional; when set, `POST /gelf` requires
  `_graylog_key` to equal it (legacy clients send this field). Empty ⇒
  unauthenticated ingest (local dev).
- `SCAN_RELAY_ORIGINS` — comma-separated extra allowed WS origins; localhost
  always allowed.
- `SCAN_RELAY_TOKEN` — optional WS token fallback (`?scanToken=`).
- `MEMBER_APP_URL` — where apps/member is served (default
  `http://localhost:8080`); used by the shell FOLDERS config (Member/App).
- `MEMBER_WEB_URL` — the Member/Web window's URL, a separate deployment from
  Member/App (default `https://data-pimp.easierbycode.deno.net/member`).
- `SCANNER_APP_URL`, `INVENTORY_APP_URL` — external app URLs for shell FOLDERS
  entries (defaults: current production URLs, e.g. `https://admin.thirsty.store`
  for inventory).

## Database (packages/db → `@lp-os/db`)

- Driver: `npm:pg` (`Pool`), lazy singleton, Neon-compatible TLS. No Supabase.
- Migrations: `packages/db/migrations/NNNN_name.sql`, applied in filename order
  by `packages/db/scripts/migrate.ts`, tracked in
  `schema_migrations(filename text primary key, applied_at timestamptz)`. Safe
  to re-run.
- **Consolidated schema** (redesigned union of data-pimp db.ts + tracker db.ts;
  both sources shared one Neon DB so their `samples` largely coincide):
  - `samples` — columns (keep these names; ported code depends on them):
    `id serial PK`, `name text NOT NULL`, `brand`, `location`, `qr_code` (TikTok
    product id; join key to graylog `product_id`), `picture_url`,
    `tiktok_affiliate_link`, `fire_sale`,
    `status text NOT NULL DEFAULT 'available'`,
    `current_price double precision`, `best_price double precision`,
    `best_price_source`, `last_price_checked_at timestamptz`,
    `bundle_id int REFERENCES bundles(id) ON DELETE SET NULL`,
    `checked_out_at timestamptz`, `checked_in_at timestamptz`,
    `checked_out_to text`, `sold_at timestamptz`, `sold_to text`,
    `sold_price double precision`, `notes`, `c19`, `related_upc text[]`,
    `product_json jsonb`, `quantity int NOT NULL DEFAULT 1`,
    `created_at timestamptz NOT NULL DEFAULT now()`. **Optimization vs sources
    [decided here]:** the `*_at` columns become real `timestamptz` (they were
    TEXT). The db layer accepts ISO strings on write and returns ISO strings on
    read (cast in SQL or serialize in JS) so ported callers don't care.
  - `bundles` — `id serial PK`, `name text NOT NULL`, `location`, `qr_code`,
    `notes`, `created_at timestamptz DEFAULT now()`.
  - `transactions` — **[decided here]** reconciled name (was
    `inventory_transactions` in data-pimp / `transactions` in tracker's plan):
    `id serial PK`, `action text NOT NULL`,
    `sample_id int REFERENCES samples(id) ON DELETE SET NULL`,
    `bundle_id int REFERENCES bundles(id) ON DELETE SET NULL`, `scanned_code`,
    `operator`, `checked_out_to`, `notes`,
    `created_at timestamptz NOT NULL DEFAULT now()` (was TO_CHAR text —
    optimized).
  - `sample_images` — `id text PK`, `content_type text NOT NULL`,
    `bytes bytea NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`.
  - `users` — `id serial PK`, `username text UNIQUE NOT NULL`,
    `display_name text`, `role text NOT NULL REFERENCES roles(name)`,
    `created_at timestamptz DEFAULT now()`. Seeded: `dj`→admin, `ka`
    (Karl)→warehouse, `@boosteddealsdaily`→creator.
  - `roles` — `name text PK`, `flags jsonb NOT NULL`,
    `default_home jsonb NOT NULL DEFAULT '[]'`. Seeded: admin/creator/warehouse
    per the Shell section.
  - `graylog_messages` — see Graylog section.
  - Indexes: samples(qr_code), samples(bundle_id), samples(status),
    samples(sold_to), GIN samples(related_upc), bundles(qr_code),
    transactions(sample_id), transactions(created_at).
- Module API (`mod.ts` exports — exact signatures):
  ```ts
  export function getPool(): Pool; // lazy singleton from DATABASE_URL
  export function query(text: string, params?: unknown[]): Promise<QueryResult>;
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
  export const Samples: TableApi;
  export const Bundles: TableApi;
  export const Transactions: TableApi; // maps to table "transactions"
  export function ensureSchema(): Promise<void>; // idempotent; mirrors migrations (CREATE/ALTER IF NOT EXISTS)
  ```
  Internals follow data-pimp's proven pattern: column cache from
  `information_schema.columns`, `safeIdent`, `parseOrderBy` (`col` / `-col`,
  legacy alias `created_date`→`created_at`), `buildWhere` ignoring unknown keys,
  `safeLimit` clamp [1,500]. `orderBy` default `-created_at`.
- Nothing outside packages/db hand-writes SQL against inventory tables;
  `@lp-os/graylog` owns SQL against `graylog_messages` only.

## Graylog store (packages/graylog → `@lp-os/graylog`)

Drop-in Graylog-compatible surface so existing clients (extensions,
bookmarklets, graylog_query script) work by changing only the base URL.
Reference implementation to port:
`C:\CODE\tok-scrape\graylog-shim\{main.ts,lucene.ts,import-to-kv.ts}` (Deno KV
version — translate storage to Postgres, keep parser/response semantics).

- Table `graylog_messages`: `id bigserial PK`, `message_id text UNIQUE NOT NULL`
  (original `_id`, or generated UUID), `timestamp timestamptz NOT NULL`,
  `source text NOT NULL`, `message text NOT NULL DEFAULT ''` (short_message),
  `fields jsonb NOT NULL DEFAULT '{}'` (the FLAT field map returned verbatim as
  the response `message` object — includes `source`, `message`, `timestamp`
  copies plus all custom fields, underscore prefixes stripped). Indexes: btree
  (timestamp DESC), (source, timestamp DESC), expression btree
  ((fields->>'creator'), timestamp DESC), GIN (fields).
- Module API (`mod.ts`):
  ```ts
  export function createGraylogStore(pool: Pool): GraylogStore;
  export interface GraylogStore {
    ingestGelf(
      body: unknown,
    ): Promise<{ ok: boolean; id?: string; error?: string }>; // GELF v1.1 → row
    logEvent(
      shortMessage: string,
      fields: Record<string, unknown>,
    ): Promise<boolean>; // in-process writer, source "lp-os" default via fields.source; replaces sendGelfMessage
    search(params: SearchParams): Promise<SearchResult>;
    newestTimestampMs(): Promise<number | null>;
  }
  export function parseQuery(q: string): Ast; // lucene.ts — port of shim grammar
  export function astToSql(ast: Ast): { clause: string; values: unknown[] }; // parameterized; fields via fields->>'key'
  export function handleGelfRequest(
    store: GraylogStore,
    req: Request,
  ): Promise<Response>; // POST /gelf → 202
  export function handleSearchRequest(
    store: GraylogStore,
    req: Request,
  ): Promise<Response>; // GET /api/search/universal/relative
  export function handleSessionsStub(req: Request): Response; // POST /api/system/sessions
  export function handleViewsStub(req: Request): Response; // GET|POST /api/views
  ```
- Grammar (from the shim, exhaustive): `*` | `field:bare` | `field:"phrase"` (\"
  escape) | `field:*` existence (present with a non-empty value — real-Graylog
  semantics; the lifecycle reads and skill docs depend on it; a quoted `"*"`
  stays literal equality) | `field.keyword:` collapsed to `field` |
  `field:[lo TO hi]` inclusive numeric ranges with `*` bounds | `AND`/`OR`
  case-insensitive, implicit adjacency = AND, AND binds tighter, parens. Range
  guard: null/empty field ⇒ no match.
- Search endpoint semantics
  (`GET /api/search/universal/relative?query=&range=&limit=&fields=`):
  - Response
    `{messages: [{message: {...flat fields}, index: "graylog_pg"}], total_results, from, to, fields, used_indices: ["graylog_pg"], time}`
    sorted newest-first.
  - `range` seconds; `0` or `≥157680000` ⇒ all-time.
  - `fields=` csv whitelist, but `timestamp` + `source` always included.
  - **Empty-window quirk:** return 500
    `{type: "ApiError", message: "...index_not_found_exception..."}` ONLY when
    zero results AND the window's lower bound is strictly newer than the newest
    stored doc; otherwise 200 with `total_results: 0`. `used_indices` is never
    empty on 200.
  - Auth: Basic `<token>:token` or `admin:<password>` accepted but NOT required
    in this recreation **[decided here]** (single-tenant behind LP-OS);
    `POST /gelf` gated by `_graylog_key === GRAYLOG_INGEST_TOKEN` only when that
    env is set.
- Backfill: `packages/graylog/scripts/backfill.ts <messages.ndjson>` — parses
  `{_id, source, timestamp, fields}` lines; **timestamps are space-separated UTC
  without zone — parse as `ts.replace(' ', 'T') + 'Z'`**; idempotent on
  `message_id` (ON CONFLICT DO NOTHING). The 2026-06-25 backup (827 lines / 817
  unique ids) lives on the old Mac at
  `~/graylog-backups/2026-06-25/messages.ndjson` — script is written and tested
  against a synthetic fixture here; real import runs wherever that file is.

## Realtime relay (packages/relay → `@lp-os/relay`)

Port of data-pimp main.ts `/api/scan-socket` (see scout brief for full protocol)
as a self-contained module. Wire-protocol-compatible with existing clients.

- `server.ts`:
  ```ts
  export interface ScanRelayServer {
    handleUpgrade(req: Request): Response; // WS upgrade + origin/token check
    presenceSnapshot(): ScannerPresence; // {count, devices:[{id,name?,since?}]}
    heartbeat(body: unknown): KioskInfo; // POST /api/heartbeat handler logic
    kiosks(): KioskInfo[];
    setKioskDisabled(id: string, disabled: boolean): KioskInfo | null;
    close(): Promise<void>;
  }
  export function createScanRelay(opts?: {
    pool?: Pool; // enables Postgres NOTIFY/LISTEN bridge (channel "lp_os_scan_relay")
    allowedOrigins?: string[]; // merged with SCAN_RELAY_ORIGINS env + localhost
    token?: string; // fallback: SCAN_RELAY_TOKEN env
  }): ScanRelayServer;
  ```
  Keeps: scanner/listener roles via `hello`, `scan` fanout to listeners,
  `ping`/`pong`, `scanners` presence broadcasts, per-client rate limiting,
  BroadcastChannel cross-isolate fanout (guarded — not available everywhere), pg
  NOTIFY/LISTEN bridge, kiosk heartbeat map with disable flags.
- `client.ts`: framework-free port of tracker's scan-link.ts — `ScanRelay` class
  (`{role, deviceId?, name?, url?, onScan?, onPresence?, onStatus?}`,
  auto-reconnect 1s→30s backoff, 10s ping), `classifyScan`, `PRODUCT_ID_RE`,
  `BARCODE_RE`, `ScanEvent`, `ScannerPresence`, `RelayStatus`, BLE
  service/characteristic UUIDs. Default relay URL becomes same-origin
  `/api/scan-socket` (overridable).
- `mod.ts` re-exports both.

## Lifecycle (packages/lifecycle → `@lp-os/lifecycle`)

Port of data-pimp `core/lifecycle.ts` — same exported function names,
input/output types, event field shapes (see scout briefs; the skills depend on
these shapes verbatim):

```ts
export function createLifecycle(
  deps: { db: typeof import("@lp-os/db"); store: GraylogStore },
): Lifecycle;
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
```

- Graylog events go through `store.logEvent(shortMessage, fields)` (host/source
  `thirsty-store-kiosk` kept for continuity of existing queries **[decided
  here]**).
- Postgres writes go through `@lp-os/db` `Samples`/`Transactions` (audit rows
  use table `transactions` now).
- Creator/product Graylog _reads_ that lifecycle needs (`fetchKnownCreators`,
  `fetchCreatorsForProduct`, `fetchAssignedCreatorForSample`,
  `hasResaleEventForSample`) are reimplemented as SQL against `graylog_messages`
  inside this package (they may use `store.search()` or parameterized SQL via
  the pool — never string-interpolated).
- `sample-statuses.json` and `campaign-config.json` are copied from data-pimp
  `core/` into this package.

## Shell app (apps/shell)

Fresh 2.x (`jsr:@fresh/core`), Preact only if an island is genuinely needed.
Routes:

- `GET /` — OS shell page: HTML template ported from data-pimp `renderOSShell`,
  injecting `globalThis.LPOS_RBAC` (roles config below + resolved current user),
  `globalThis.LPOS_OS_CONFIG` (member/scanner/inventory URLs from env),
  `globalThis.LPOS_SCAN_RELAY` (same-origin default).
- `GET /api/scan-socket` — `relay.handleUpgrade`.
- `POST /api/heartbeat`, `GET /api/kiosks`,
  `POST /api/kiosks/:id/{disable,enable}` — relay kiosk fleet.
- `POST /gelf`, `GET /api/search/universal/relative`,
  `POST /api/system/sessions`, `GET|POST /api/views`, `GET /health` — graylog
  store handlers.
- `GET|POST /api/samples`, `PATCH|DELETE /api/samples/:id`, same for
  `/api/bundles`, `GET|POST /api/transactions`, `DELETE /api/transactions/:id` —
  inventory CRUD via `@lp-os/db` (request/response shapes per data-pimp:
  `order_by`, `limit`, filter params).
- `POST /api/sample-status | sample-sold | sample-listing | sample-bulk-sold | agency-intake | sample-assign | sample-import`
  — thin wrappers over `@lp-os/lifecycle`.
- `GET /api/sample-statuses`, `GET /api/creators`, `GET /api/roles` —
  vocab/config reads.
- Static: `/os.js`, `/os.css`, `/scan-client.js` (built from `@lp-os/relay`
  client or a thin re-export), icons.
- CORS: permissive on the API routes that had it in data-pimp (samples
  import/products/e2e), same headers.

### Desktop shell (apps/shell/static/os.js) — ported + three features

Port `C:\CODE\data-pimp\static\os.js` (1811 lines) and `static/os.css`
faithfully (rebrand "Thirsty OS" → "LP-OS"), then:

1. **Multi-instance [Section 8.1]:** window ids become `app:<item.id>#<n>`
   (monotonic per-app counter). `openApp` ALWAYS creates a new window — delete
   the refocus-and-return branch (os.js:1040–1046) and the equivalents in
   `openFolder`/`openBrowser` stay single-instance for folders **[decided
   here]** (folders are pickers; apps are workspaces). Windows of one app get
   title "Name · 2", "Name · 3" from the second instance up. Dock shows one item
   per window instance. No cap.
2. **Pin/Save [Section 8.1]:** a pin (📌) button in every app-window titlebar.
   Pinning stores
   `{app: item.id, url: <current iframe URL incl. query>, title, at}` in
   localStorage `lpos.pins.v1` (array). Pinned windows re-open at boot (before
   default_home layout). Unpin via the same button (toggled state). Pinned
   window's iframe URL is captured at pin time; best-effort — cross-origin
   iframes fall back to the launch URL + params. Per-device by design; per-user
   Postgres pins documented as the follow-on once real auth exists.
3. **Roles/default_home [Section 8.2]:** replace `boot` with
   `default_home: [appPath, side][]` applied generically at boot; delete the
   hardcoded warehouse if-block. `appPath` = `"FolderName/ItemLabel"` resolved
   case-insensitively over FOLDERS (e.g. `Apps/Inventory`, `Apps/Kiosk`,
   `Member/App`, `Member/Web`); `side` ∈ `left`|`right`|`none` (snap or free
   placement). Unresolvable paths are skipped with a console.warn. Keep the
   `?workspace=samples-import` E2E block working.

### Roles config (apps/shell/core/roles.json + roles.ts)

```jsonc
{
  "defaultUser": "dj",
  "flags": [/* carried over from data-pimp verbatim */],
  "roles": [
    {
      "id": "admin",
      "name": "Admin",
      "default_home": [],
      "flags": { "*": true }
    },
    {
      "id": "creator",
      "name": "Creator",
      "default_home": [["Member/App", "left"], ["Member/Web", "right"]],
      "flags": { "folder.member": true }
    },
    {
      "id": "warehouse",
      "name": "Warehouse",
      "default_home": [["Apps/Inventory", "left"], ["Apps/Kiosk", "right"]],
      "flags": {
        "folder.apps": true,
        "app.inventory": true,
        "app.kiosk": true,
        "app.installExtension": true,
        "app.scanner": true,
        "app.graylog": false,
        "app.productAnalysis": false,
        "folder.demos": false,
        "folder.member": false,
        "ops.debugCounts": false,
        "ops.checkoutAlerts": true
      }
    }
  ],
  "users": [
    // `email` (optional) ties a shell user to the same identity in
    // lifepreneur-v1 (Better Auth login) — the shared mock admin.
    {
      "id": "dj",
      "name": "DJ",
      "role": "admin",
      "email": "daniel@lifepreneur.com"
    },
    { "id": "ka", "name": "Karl", "role": "warehouse" },
    {
      "id": "@boosteddealsdaily",
      "name": "@boosteddealsdaily",
      "role": "creator"
    }
  ]
}
```

Warehouse flags = Karl's current set verbatim. The warehouse `default_home`
Inventory entry carries the `?status=cleared_to_sell` query (encode it in the
appPath entry as `["Apps/Inventory?status=cleared_to_sell","left"]` — resolver
splits the query string and appends it to the item URL). **User selection:**
`?user=<id>` URL param wins, else localStorage `lpos-os-user`, else
`defaultUser`. The taskbar switcher now lists users (not roles); role is
derived. `roles.ts` mirrors flag logic server-side and exports
`rbacClientConfig(currentUserId)`.

### FOLDERS changes vs data-pimp

- `Member/App` → `${MEMBER_APP_URL}/` and `Member/Web` → `MEMBER_WEB_URL`
  **[decided here]** (independent deployments; Web defaults to the data-pimp
  member dashboard).
- `Apps/Inventory` → `INVENTORY_APP_URL` (default stays
  `https://admin.thirsty.store` until the tracker migrates in).
- `Apps/Graylog` → same-origin `/api/search/universal/relative`-backed simple
  search page is future work; keep the entry `requiresConfig`-gated and hidden
  by default.
- Demos folder entries carry over as-is (external easierbycode.com URLs).
- Kiosk stays pointing at `https://thirsty.store/kiosk` (external) until the
  React kiosk is rebuilt **[decided here]** — LP-OS ships no React.

## Member app (apps/member)

- SvelteKit 2 + Svelte 5 runes + `@deno/svelte-adapter@^0.2`, Tailwind v4 via
  `@tailwindcss/vite`, config copied from tiktok-sample-tracker
  (svelte.config.js with `alias {'@': 'src'}`, vite.config.ts with
  `tsconfigRaw: '{}'`, deno.json with `nodeModulesDir: "auto"` + node: import
  map, dev on **port 8080**).
- Routes **[decided here]**: `/` = MemberDashboardV2 (the dashboard, aka
  `Member/App` target), `/web` = web/landing view hosting the
  seller/streamer/content dashboards behind tabs or subroutes (`/web/seller`,
  `/web/streamer`, `/web/content`), matching what `Member/Web` pointed at.
- Components ported from `C:\CODE\data-pimp\member\components\*.svelte` (all of
  them; data-pimp's fork preferred, including its Svelte MemberDashboardV2).
  Preact wrappers are NOT ported. Stub data files (`dashboard-data.ts`,
  `seller-data.ts`, `streamer-data.ts`, etc.) port as `src/lib/data/*.ts` for
  now; wiring to live LP-OS APIs is incremental follow-on.
- `apps/member/FEATURES.md` — the Next.js parity checklist (from the
  member-dashboards scout brief), checked off as features land.

## Merged extension (extension/)

- Union of `extension-agency` + `extension-seller` manifests: merged
  `host_permissions` (partner.us.tiktokshop.com + shop.tiktok.com +
  www.tiktok.com), both content-script/injection sets, one `background.js` with
  both behavior families; all `scrape-*.js` payloads carried over unchanged
  where possible.
- Role gate **[Sections 8.4/9]:** background resolves mode from a `?user=` param
  on the LP-OS shell tab (queried via `chrome.tabs`) or, fallback,
  `chrome.storage.local.lpos_user` set from the extension's popup. `dj` → admin
  → agency behaviors enabled; `@boosteddealsdaily` (any `@handle`) → creator →
  seller behaviors enabled, scoped to that creator handle. Domain matching alone
  no longer enables a behavior.
- `config.js`: one merged TOK_CONFIG; GELF endpoint becomes configurable,
  defaulting to LP-OS `/gelf` (placeholder `http://localhost:8000/gelf` until a
  domain exists).
- `extension-creator-demo` is dropped.

## Marketplace listings (@lp-os/marketplace) **[decided here]**

Real marketplace listing of samples — eBay first of the initial three
marketplaces. Post-phase-8 feature work; names fixed here.

- Package `packages/marketplace` = `@lp-os/marketplace`, same
  compile-standalone structural-deps pattern as `@lp-os/lifecycle`
  (`createListingService({db, store, lifecycle, getAccount, listAccounts})`).
  eBay adapter behind a `MarketplaceClient` interface
  (`createEbayClient({environment, credentials, settings, fetchImpl?})`) —
  Sell Inventory API flow: inventory_item → offer → publish, with merchant
  location + business policies auto-provisioned on first use.
- Tables (migration `0002_marketplace.sql`, mirrored in `ensureSchema()`):
  - `listings` — the Postgres truth for current listing status
    (`pending → listed → ended|sold`, or `failed`); columns include
    sample_id FK, marketplace, status, source (`manual|schedule|status-auto`),
    sku (`lpos-<sampleId>`), offer_id, external_id (eBay listingId),
    listing_url, ask_price, currency, creator, operator, error, listed_at.
    Exported as `Listings: TableApi`; joined read
    `listListingsWithSamples(filters, limit)`.
  - `marketplace_accounts` — single-tenant per marketplace (login is mocked):
    PK marketplace, environment (`sandbox|production`), credentials jsonb
    (eBay: clientId/clientSecret/refreshToken/accessToken), settings jsonb
    (location, defaultCreator, condition, shippingFlatCost, autoListScheduled,
    autoListClearedToSell, autoListMaxPerPass, policy-id overrides).
    Helpers: `getMarketplaceAccount` / `listMarketplaceAccounts` /
    `upsertMarketplaceAccount` / `deleteMarketplaceAccount`. Credential VALUES
    never leave the server: API views expose key names only, and credentials
    are never written to graylog_messages.
- Shell routes: `GET|POST /api/listings` (GET = joined status rows with
  `sample_id`/`marketplace`/`status`/`limit` filters; POST = on-demand publish,
  validation → 400 `{ok:false,error}`, remote publish failure → 200
  `{ok:false, error, listing}`), `POST /api/listings/run-due` (one auto-list
  pass now), `GET /api/marketplaces`, `GET|POST|DELETE
  /api/marketplaces/:marketplace` (POST merges credentials per-key + settings
  shallow), `POST /api/marketplaces/:marketplace/verify` (live check, stamps
  connected_at). Window page: `GET /marketplace` → `static/marketplace.html`
  (FOLDERS app id `marketplace`, RBAC flag `app.marketplace` — admin via `*`,
  warehouse true, creator denied).
- Automatic listing = `startAutoLister` in-process interval in apps/shell boot
  (env `AUTO_LIST_INTERVAL_MS`, default 300000): each pass (a) fires due
  `fetchDueListingSchedules()` intents (success or permanent failure →
  `markListingScheduleDone`; transient → retried next pass) and (b) when
  `settings.autoListClearedToSell === true`, lists `cleared_to_sell` samples
  that have no listings row yet (one automatic attempt per sample+marketplace).
- Events keep the lifecycle conventions (source `thirsty-store-kiosk`, one
  `*_json` container + flat scalars): success reuses `recordSampleListing`'s
  `sample_event:"listed"` shape with additive fields `listing_id`,
  `external_listing_id` and `sample_source` tokens `marketplace-api` (manual) /
  `marketplace-cron` (schedule) / `marketplace-auto` (status-auto); failures
  are `sample_event:"listing_failed"` with `listing_error_json` — so
  `sample_event:listed` never matches failures and existing skill queries are
  unchanged.
- Env vars added to the complete set: `AUTO_LIST_INTERVAL_MS` (optional,
  auto-list pass interval in ms, default 300000). eBay credentials are NOT env
  vars — they live in `marketplace_accounts`, entered through the Marketplace
  window.
- Shipping is scoped (not built) in `docs/SHIPPING_SCOPE.md`.

## Skills (.claude/skills/)

Seven skills: `ebay-listing`, `sample-e2e`, `sample-lifecycle`,
`samples-import`, `scrapecreators-api` (from data-pimp),
`run-partner-center-bookmarklet` (from tok-scrape), `graylog-query` (rewritten).

- URL updates: `https://thirsty.store` →
  `${LPOS_API_URL:-http://localhost:8000}`; `https://admin.thirsty.store` stays
  for now (tracker not yet migrated); note in each SKILL.md that LP-OS's
  production domain is TBD.
- `graylog-query` rewrite: same triggers/purpose; script becomes
  `scripts/graylog_query.ts` (Deno) that (a) default mode: queries Postgres
  directly via `@lp-os/graylog`'s parser + `DATABASE_URL`, (b) `--url` mode:
  hits any Graylog-compatible REST endpoint (incl. LP-OS itself and the legacy
  shim). Same flags where sensible (`-q`, `--last`, `--range`, `--all`,
  `--fields`, `--limit`, `--terms`, `--list-sources`, `--json`).
- `sample-lifecycle`/`sample-e2e` reference the same lifecycle REST endpoints,
  now served by LP-OS.

## Conventions

- TypeScript everywhere in Deno code; `deno fmt` defaults; no React anywhere.
- All server config from env; no hardcoded hosts outside FOLDERS defaults.
- User-supplied search strings go through `parseQuery`/`astToSql` — never
  interpolated into SQL.
- Tests: `deno test` colocated under `packages/*/test/` (parser, relay protocol,
  db builders get real tests; use `DATABASE_URL`-gated integration tests that
  skip when unset).
