# LP-OS Architecture & Consolidation Plan

**Status:** Implemented (phases 1–8) — see the implementation note below.
**Date:** 2026-07-05 **Scope:** Originally architecture plan only; now also the
reference for the implementation that followed. **Inputs:** A live, read-only
audit of data-pimp, tok-scrape, tiktok-sample-tracker, and lp-os (2026-07-05),
plus scoping decisions from Daniel across five rounds (Section 1).

> **Implementation update (2026-07-05, later the same day):** Section 12's
> phases 1–8 are now built in this repo: the SpacetimeDB scaffold was removed;
> `apps/shell` (Fresh core app + the ported `os.js` desktop shell with Pin/Save,
> multi-instance windows, and generalized `default_home` role layouts),
> `apps/member` (SvelteKit dashboard with the ported Svelte components),
> `packages/{db,relay,graylog,lifecycle}`, the merged `extension/`, and the
> consolidated `.claude/skills/` all exist and pass `deno task check` +
> `deno task test`. Where this plan left questions open, the decisions taken are
> recorded in `docs/CONTRACTS.md` (marked **[decided here]**). Phase 9's in-repo
> work also landed later on 2026-07-05: PWA manifests + service workers for both
> apps and `deno desktop` build targets (`deno task desktop:shell` /
> `desktop:member`, Deno 2.9+) — see `docs/DISTRIBUTION.md` for the build flags,
> verified behavior, and known upstream issues. What remains of phases 9–10 is
> external: deploys to the new Deno Deploy, domain repointing, and retiring the
> old repos (checklist in `docs/DISTRIBUTION.md`; Android TWA stays with
> tiktok-sample-tracker until that app migrates). On the Section 13 deadline:
> data-pimp's `deno.json` deploy block uses the new platform's `{org, app}`
> format, so it appears to already be on the new Deno Deploy — worth a
> one-minute confirmation in console.deno.com before 2026-07-20.

> **Update, added minutes after this document was first drafted:** while it was
> being written, a SpacetimeDB quickstart scaffold
> (`spacetime dev --template deno-ts` — the stock "person" table / `add` +
> `sayHello` reducer demo, plus
> `.cursor`/`.windsurfrules`/`AGENTS.md`/`CLAUDE.md` agent-instruction
> boilerplate) appeared in `C:\CODE\lp-os`, created 2026-07-05 ~03:20-03:23, no
> git history. **Resolved in Revision 3: no SpacetimeDB.** The scaffold can be
> treated as exploratory and removed whenever convenient.

> **Revision 2:** Postgres is being recreated and optimized rather than ported
> as-is, and now also absorbs the Graylog message store instead of depending on
> tok-scrape's `graylog-shim` as a live service; Supabase is dropped (Neon
> only); Preact-in-Fresh is confirmed fine; the three member dashboards reduce
> to **one new SvelteKit app** covering every feature of the Next.js version.

> **Revision 3:** SpacetimeDB confirmed **out of scope**. Added: a Pin/Save +
> multi-instance spec for the draggable-window desktop shell (Section 8), and
> consolidating the Claude Code skills split across data-pimp/tok-scrape
> (Section 10).

> **Revision 4:** expanded the desktop shell's existing-but-minimal role system
> into functional roles with per-role default app layouts (Section 8.2), and
> decided to merge two of tok-scrape's three Chrome extensions into one, gated
> by that same role concept (Section 9).

> **Revision 5:** defined mock users for testing the role system — `dj` and `ka`
> (Karl) stop being roles themselves and become mock accounts assigned to
> `admin` and `warehouse` respectively, plus a new creator mock using
> `@boosteddealsdaily` (Section 8.3). The extension role-bridge question is
> resolved: a URL query param (`?creator=@handle`) carries context from the OS
> shell to the extension. `extension-creator-demo` is confirmed **not** carrying
> over to LP-OS.

> **Revision 6:** admin/agency vs. creator/seller mode is inferred directly from
> the logged-in user's role (`dj` → admin), not from a URL param. That requires
> LP-OS to expose an actual login/session capability it doesn't have today
> (Section 8.4).

> **Revision 7 (this update):** the login is mocked concretely — a `?user=` URL
> param (`?user=dj` → admin, `?user=@boosteddealsdaily` → creator) read by the
> extension, standing in for real auth. Also corrected: this is scoped to the
> consolidated **extension** only — an earlier reference tying it to the
> separate bookmarklets was wrong and has been removed; whether the bookmarklets
> need equivalent treatment is a distinct, still-open question.

---

## 1. Executive summary and locked-in decisions

LP-OS consolidates three sibling repos — **data-pimp** ("Thirsty OS," the
backend + Postgres + Graylog + WebSocket-relay core, plus the `static/os.js`
desktop-shell UI), **tok-scrape** (scraping toolkit, Chrome extensions, Cordova
mobile apps, and a `member-app` monorepo with both a mature Next.js dashboard
and an experimental Fresh port), and **tiktok-sample-tracker** (a SvelteKit
operator/scanner PWA) — into one Deno app. **lp-os is currently empty** apart
from the SpacetimeDB quickstart scaffold noted above; there is no other existing
scaffolding, config, or planning doc there to reconcile with.

The audit surfaced one correction to the original brief: **none of the three
projects actually use Firebase** in any real capacity (one leftover hardcoded
demo URL in data-pimp is the only hit). The "replace Firebase" framing doesn't
apply — there's nothing to replace. The real datastore everywhere is Postgres,
and realtime presence is already solved with a working hand-rolled WebSocket +
Postgres NOTIFY/LISTEN pattern.

Current decisions, reflecting all four rounds of direction:

1. **Databases:** recreate and optimize a single consolidated Postgres schema —
   not a mechanical port — covering
   `samples`/`bundles`/`transactions`/`sample_images` across data-pimp and
   tiktok-sample-tracker. **Neon only, no Supabase.**
2. **Graylog messages:** also recreated and optimized, landing as a properly
   indexed table inside that same consolidated Postgres database, rather than
   treating tok-scrape's `graylog-shim` as a live external service LP-OS depends
   on (Section 7).
3. **Core realtime/presence:** keep the existing WebSocket + Postgres
   NOTIFY/LISTEN pattern already proven in data-pimp. **No SpacetimeDB** —
   confirmed.
4. **UI framework:** Deno canary + Fresh canary for the core app/shell, with
   **Preact confirmed fine** inside it (it's Fresh's own non-React default). The
   member-facing dashboard consolidates into **one new SvelteKit app** (official
   `@deno/svelte-adapter`, the pattern tiktok-sample-tracker already proves
   out), rebuilt to cover every feature of the Next.js version. **No React**
   anywhere.
5. **Desktop shell:** data-pimp's draggable-window UI (`static/os.js`, the
   "Thirsty OS" shell) carries forward, gaining a Pin/Save option per window,
   support for multiple concurrent instances of the same app, and a generalized,
   data-driven per-role default home layout, tested against mock users `dj` (→
   admin), `ka`/Karl (→ warehouse), and a new creator mock `@boosteddealsdaily`
   (Section 8).
6. **Agent skills:** consolidate data-pimp's 5 Claude Code skills and
   tok-scrape's 2 into one shared LP-OS skills directory, updating any skill
   whose behavior depends on now-changed architecture (Section 10).
7. **Browser extensions:** merge tok-scrape's `extension-agency` and
   `extension-seller` into one extension. Role comes from a **mocked login**:
   `?user=dj` → admin, `?user=@boosteddealsdaily` → creator (Section 8.4) — a
   placeholder for real auth, not a finished design. **`extension-creator-demo`
   does not carry over** (Section 9).
8. **Output targets:** web/PWA plus binary via `deno desktop`, which supports
   both Fresh and SvelteKit projects natively.

---

## 2. Current state (audited 2026-07-05)

| Project                   | Runtime/Framework                                                                                                                                                                                                                                                                | UI                                                                                                                                                                                                                                     | Database                                                                                                         | Logging                                                                                                             | Realtime                                                                                                                                | Deploy/Binary                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **data-pimp**             | Deno, raw `Deno.serve` (`main.ts`, ~2,600 lines) + Fresh 2.3/Preact/Svelte 5 in `member/`                                                                                                                                                                                        | React 18 SPA shell (root) + Fresh/Preact islands wrapping Svelte 5 components (`member/`) + `static/os.js` draggable-window desktop shell (vanilla JS, ~1,300+ lines) with an existing per-device role/RBAC system (`core/roles.json`) | Postgres via `pg`, Neon-hosted, one DB per git branch                                                            | Graylog (GELF write + REST search), dual-written with every Postgres state change                                   | WebSocket scan-relay (`/api/scan-socket`), in-memory presence map, Postgres NOTIFY/LISTEN cross-isolate bridge, BroadcastChannel fanout | Deno Deploy (`deno.json` deploy block); `deno compile` tasks for mac/windows binaries; no PWA manifest                                |
| **tok-scrape**            | Node/TS scraping tools (Playwright) + nested `member-app` monorepo (pnpm/Turborepo): Next.js `apps/web`, Fresh 2.3/Preact/Svelte 5 `apps/fresh`; new `graylog-shim/` in Deno; 3 Manifest V3 Chrome extensions (`extension-agency`, `extension-seller`, `extension-creator-demo`) | Next.js (React, most feature-complete) and a Fresh/Preact/Svelte fork (older, incomplete vs. data-pimp's)                                                                                                                              | Postgres via Prisma (`member-app`), Deno KV (`graylog-shim`, not for app data)                                   | Graylog today (self-hosted Mac + paid ngrok); `graylog-shim` (Deno KV) migration fully specced and dated 2026-06-25 | None in the scraping/member-app code; TikTok SDK bundles in scraped fixtures are a false-positive grep hit                              | GitHub Actions build APK/iOS/extension zip/OTA bundles; `graylog-shim` already has a Deno Deploy config; no PWA manifest              |
| **tiktok-sample-tracker** | SvelteKit 2.65 / Svelte 5 (runes), official `@deno/svelte-adapter`, client-rendered SPA                                                                                                                                                                                          | Pure Svelte — ~30 feature components + ~60-file shadcn-svelte/Bits UI kit, 12 routes                                                                                                                                                   | Postgres via `pg` (shared Neon instance with data-pimp per code comment) + a parallel Supabase config/migrations | None of its own — posts a `graylogOnly` flag to data-pimp, which writes to Graylog                                  | WebSocket **client** only (`ScanRelay` in `scan-link.ts`); the relay **server** lives in data-pimp                                      | Deno Deploy; PWA manifest present (no service worker yet); Android APK via Bubblewrap TWA; iOS share extension documented but unbuilt |
| **lp-os**                 | —                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                                      | —                                                                                                                | —                                                                                                                   | —                                                                                                                                       | Empty apart from an unmodified SpacetimeDB quickstart scaffold added mid-session (see callout above).                                 |

Two structural findings shape everything below:

- **The "member" SaaS dashboard is implemented three times.** tok-scrape's
  Next.js app (`member-app/apps/web`) is the most feature-complete (Prisma,
  Stripe, Sentry, admin panel). data-pimp's Fresh+Preact+Svelte port (`member/`)
  is a more complete and more recently active fork (8 commits, 2026-06-13–15) of
  the same idea also present in tok-scrape (`member-app/apps/fresh`, 4 commits,
  abandoned earlier). The two Fresh forks are byte-identical in config; only
  content diverges, and only one component (`MemberDashboardV2`) diverges
  meaningfully — data-pimp's is the Svelte-island version, tok-scrape's is a raw
  ~700-line Preact port that was never migrated.
- **tiktok-sample-tracker is architecturally the closest of the four to "already
  migration-shaped"** — it's pure Svelte on Deno via an official adapter, no
  Firebase, no Graylog client of its own — but it's tightly coupled to data-pimp
  as an external service for product lookups, the scan-relay server, and Graylog
  writes.

---

## 3. Target architecture

### 3.1 Runtime and app framework

- **Deno canary**, tracking toward whatever supersedes the current 2.9 stable
  (released 2026-06-25). Re-check `deno --version` against the canary channel at
  scaffolding time rather than assuming a specific pin.
- **Fresh canary** (`jsr:@fresh/core@^2.3.0` or newer) for the core app/shell —
  backend routes, the `os.js` desktop shell (Section 8), whatever of data-pimp's
  current raw `Deno.serve` main.ts moves forward. Uses Preact for any islands it
  needs — **confirmed fine**, since Preact is Fresh's own default and explicitly
  not React.
- **SvelteKit** (official `@deno/svelte-adapter`, the exact pattern already
  proven in tiktok-sample-tracker) for the member-facing dashboard — one app
  instead of three (Section 4). Svelte components no longer need the
  Preact-island-wrapper workaround data-pimp/member used; SvelteKit mounts them
  natively.
- **No React** anywhere — this is what rules out porting the Next.js dashboard
  or data-pimp's React SPA shell as code (Section 4).
- **Open question:** whether this new SvelteKit dashboard app and
  tiktok-sample-tracker (also SvelteKit) end up as one merged app or two
  separate ones sharing a backend. Both are SvelteKit-on-Deno serving
  overlapping sample data, so merging is worth considering, but nothing decided
  so far settles it either way. Either way, both surface as windows inside the
  `os.js` desktop shell (Section 8).

### 3.2 Data layer

- **Postgres (Neon only, no Supabase)** as the single canonical store,
  **recreated and optimized** rather than ported as-is — a genuine schema
  redesign consolidating data-pimp's
  `samples`/`bundles`/`inventory_transactions` with tiktok-sample-tracker's
  overlapping `samples`/`bundles`/`transactions`/`sample_images` into one clean
  schema/migration set (Section 5), dropping tiktok-sample-tracker's separate
  Supabase project entirely.
- **Graylog message history, also recreated and optimized** — folded into the
  same consolidated Postgres database as a proper indexed table rather than kept
  in a separate service (Section 7).
- **WebSocket relay + Postgres NOTIFY/LISTEN + BroadcastChannel**, carried
  forward from data-pimp/main.ts's `/api/scan-socket` implementation (Section
  6). **No SpacetimeDB** (confirmed), no Firebase.

### 3.3 Logging and analytics

- LP-OS **recreates and optimizes** the Graylog message store itself rather than
  depending on tok-scrape's `graylog-shim` as a live external service.
  tok-scrape's plan (Section 7) is still the best available reference for the
  data shape and query grammar clients actually use — reuse its schema thinking
  and mini-Lucene grammar, but land the data as an indexed table in LP-OS's own
  Postgres rather than a separate Deno KV store.
- tok-scrape's own `graylog-shim` cutover can still proceed on its own timeline
  for its own clients (extensions, mobile app) — that's an independent project
  (Section 7), unaffected by this choice.

### 3.4 Deployment targets

- **Web/PWA:** the **new** Deno Deploy platform (`console.deno.com`). **Not
  Deploy Classic** — see the time-sensitive flag in Section 13.
- **Binary:** the `deno desktop` command (Deno 2.9+), which auto-detects the
  framework in the project directory — both Fresh and SvelteKit are supported
  natively — and wraps the built output in the OS's native webview (WebView2 on
  Windows, WebKit on macOS/Linux). This is what "new Deno desktop interface" in
  the original brief refers to. With two apps now in play (Fresh shell +
  SvelteKit dashboard), plan on two `deno desktop` build targets, one per app.
- **Mobile:** carry forward tiktok-sample-tracker's PWA manifest (add a service
  worker, which doesn't exist yet) and its Android TWA/Bubblewrap pipeline. The
  documented-but-unbuilt iOS share extension stays a future item.

---

## 4. Component/UI consolidation strategy

The three existing "member dashboard" implementations reduce to **one new
SvelteKit app**, rebuilt to cover every feature of the Next.js version. This app
(and tiktok-sample-tracker's scanner UI) run as windows inside the `os.js`
desktop shell (Section 8) rather than as standalone top-level sites.

- **Feature spec:** tok-scrape's Next.js app (`member-app/apps/web`) stays the
  completeness checklist — every dashboard/feature it has
  (seller/streamer/affiliate/community, GMV views, admin analytics) needs an
  equivalent in the new SvelteKit app. Still not a code source, since it's
  React.
- **Component source:** the `.svelte` files already written in data-pimp's
  `member/` (and, where useful, tok-scrape's `member-app/apps/fresh`) are the
  fastest starting point — Svelte components themselves aren't tied to Fresh vs.
  SvelteKit, only the mounting layer is. Drop the Preact-island wrapper each
  currently uses (`SellerDashboard.tsx`, `StreamerDashboard.tsx`,
  `SvelteCounter.tsx`, etc. in both forks) and mount the same `.svelte` files
  natively in SvelteKit instead. Prefer data-pimp's version of any file that
  diverges (it's the more complete, more recently active fork), except for
  `MemberDashboardV2` — take data-pimp's Svelte-island version of that one, not
  tok-scrape's raw Preact port.
- **Structural source:** tiktok-sample-tracker is the closest existing precedent
  for the target shape — it's already SvelteKit on the official
  `@deno/svelte-adapter`, already has a ~60-file shadcn-svelte/Bits UI component
  library, already deploys on Deno. The new member-dashboard app should likely
  follow its project layout directly rather than starting from zero.
- **Real effort, not just consolidation:** every dashboard feature that exists
  only in the Next.js app today (nothing to lift, since it's React) needs a
  genuine from-scratch Svelte build. "Reduce 3 into 1" removes duplication — it
  doesn't remove the work of matching Next.js's full feature set.
- **Open question carried from Section 3.1:** does this new dashboard app merge
  with tiktok-sample-tracker into one SvelteKit app, or stay as two SvelteKit
  apps side by side? This bears directly on Section 8.2's `Member/App` /
  `Member/Web` mapping.

---

## 5. Data model consolidation

data-pimp's `db.ts` talks to Postgres directly via `pg`, with a dynamic
column-cache query builder over `samples`, `bundles`, `inventory_transactions`.
tiktok-sample-tracker has its own `src/lib/server/db.ts` with idempotent
schema-ensure logic (`CREATE TABLE IF NOT EXISTS`/`ALTER TABLE`) over an
overlapping schema (`samples`, `bundles`, `transactions`, `sample_images`, the
last storing images as `bytea`), plus a `supabase/` folder with 5 SQL
migrations. **Decided: Neon only, drop Supabase entirely** —
tiktok-sample-tracker's Supabase project and migrations don't carry forward; its
schema content does.

For LP-OS: this is a genuine redesign, not a mechanical merge — recreate and
optimize one schema module and one migration set from scratch, informed by both
existing schemas rather than picking one wholesale. Reconcile the
`inventory_transactions` vs. `transactions` naming and fold in `sample_images`
(which data-pimp's schema doesn't have) as part of that redesign. This is also
where the recreated Graylog message table (Section 7) lives, as one more
properly indexed table in the same database rather than a separate store.

---

## 6. Realtime/presence carry-forward

data-pimp/main.ts already implements the whole pattern LP-OS should keep: a
`/api/scan-socket` WebSocket endpoint distinguishing "scanner" and "listener"
roles, an in-memory presence map, cross-isolate fanout via `BroadcastChannel`, a
Postgres `NOTIFY`/`LISTEN` fallback bridge for multi-isolate deployments,
rate-limiting, and a kiosk-fleet heartbeat map. tiktok-sample-tracker's
`ScanRelay` class (`scan-link.ts`) is the matching client, with auto-reconnect
and a `ScannerPresence` protocol (`{count, devices[]}`).

Recommendation: extract this out of data-pimp's 2,600-line `main.ts` into a
standalone, independently testable module when it moves into LP-OS, rather than
re-embedding it in another monolithic entry point. This is a good opportunity
given it's moving anyway, not a requirement to solve something broken today —
the current implementation works.

---

## 7. Graylog messages: recreated and optimized within LP-OS

LP-OS recreates the Graylog message store itself, optimized, as part of its own
consolidated Postgres database (Section 5), rather than treating tok-scrape's
`graylog-shim` as a live service it depends on.

tok-scrape's `MIGRATION_PLAN.md` (dated 2026-06-25, "Status: Canonical plan") is
still the best available reference for doing this well — it fully characterizes
the data (827 docs / 817 unique IDs, ~3.8MB, largest doc 32.5KB, append-only)
and hand-writes the exact mini-Lucene query grammar clients actually emit
(`source:`, `creator(.keyword):`, numeric ranges, `AND`/`OR` nesting, the
`used_indices`/empty-window response quirks a real Graylog client expects). That
plan chose Deno KV over Postgres specifically to avoid standing up a _second
managed service_ — a concern that doesn't apply here, since LP-OS's Postgres is
already running for everything else. Reuse its schema thinking (indexed by
timestamp/source/creator) and its mini-Lucene parser design, but land it as SQL
tables instead of KV keyspaces.

For LP-OS: port data-pimp's `core/graylog.ts` (GELF send + Graylog search
client) and `core/lifecycle.ts` (dual-write-every-event logic) into a single
write path against the new table, and import the existing backup
(`~/graylog-backups/2026-06-25/messages.ndjson`, referenced in tok-scrape's
plan) as seed data. The `graylog-query` skill (Section 10) needs a matching
rewrite to query this table instead of the old Graylog REST API.

Separately, and independently of LP-OS: tok-scrape's own `graylog-shim` cutover
(for its extensions, mobile app, and `.claude/skills/graylog-query` skill in its
current form) can still proceed on its own ~4-5 day timeline. It has its own
clients and its own reasons to exist regardless of what LP-OS does.

---

## 8. Desktop shell: draggable windows, roles, Pin/Save, multiple instances

### 8.1 Pin/Save and multiple instances

data-pimp's `static/os.js` (~1,300+ lines, vanilla JS, no framework) is the
"Thirsty OS" desktop-style shell that everything else runs inside as a window —
it already has a working window manager (`createWindow`, `closeWindow`,
`focusWindow`, `frontWindow`, `snapWindow` for edge-snapping). This is the
general container for the product's UI, not a data-pimp-only affectation: the
`samples-import` skill (currently in tok-scrape, moving per Section 10) already
describes its target surfacing "in a Thirsty OS window or a browser tab." This
carries forward into LP-OS as the shell that hosts both the Fresh app/shell
surfaces and the new SvelteKit dashboard/scanner windows (Section 4).

Requirements from Revision 3:

- **Pin/Save option on every draggable window.** Pinning captures the window's
  target **app plus its current URL, including query params** — a pinned window
  remembers exactly what it was showing, not just "the app was open."
- **Multiple concurrent instances of the same app.** Today's
  `createWindow`/`focusWindow` pattern reads as single-instance-per-id —
  reopening "the same app" would refocus the existing window. That changes: two
  or more windows of the same app can be open side by side. If the user opens an
  app that already has a pinned window open, that action opens a **new, separate
  window instance** rather than focusing the existing pinned one.
- **Open implementation questions (not yet settled):** where pin records persist
  (per-device `localStorage`, matching the existing role pattern below, vs. a
  per-user row in the consolidated Postgres so pins follow the user across
  devices); whether there's a cap on concurrent instances of one app; and how
  the UI distinguishes multiple open windows of the same app.

### 8.2 Roles and default-home layouts

The RBAC groundwork already exists and is more built-out than a first glance
suggests. `core/roles.json` defines roles with capability `flags` (gating
folder/app visibility — `folder.apps`, `folder.demos`, `folder.member`,
`app.inventory`, `app.kiosk`, `app.scanner`, `app.graylog`, etc.) and a per-role
`boot` layout string; `core/roles.ts` mirrors the flag logic for the server;
`static/os.js` reads it via `globalThis.THIRSTY_RBAC` (injected by `main.ts`'s
`renderOSShell`). Today there are exactly two roles, both named after
individuals rather than functions: `dj` (the default, `flags: {"*": true}`,
`boot: "default"`, full access) and `ka` — literally **"Karl · Warehouse"** —
restricted to the Apps folder's inventory/kiosk/scanner/install-extension,
`boot: "warehouse"`. Karl's `"warehouse"` boot value is handled today by one
hardcoded `if (bootLayout === "warehouse")` block in `os.js` (~line 1765) that
opens the `apps/inventory` item — pre-filtered to `?status=cleared_to_sell` —
snapped left, and `apps/kiosk` snapped right. In other words: Karl's layout
already does exactly what this revision asks for generally, just as a one-off
special case instead of general, data-driven configuration.

**Decided this revision:** generalize `boot` into a `default_home` array of
`[appPath, side]` pairs per role, replacing the hardcoded warehouse if-block,
and move from individual-named roles toward functional ones:

- `admin` → `default_home: []` (nothing auto-opens).
- `creator` → `default_home: [['Member/App', 'left'], ['Member/Web', 'right']]`.
- `warehouse` →
  `default_home: [['Apps/Inventory', 'left'], ['Apps/Kiosk', 'right']]` — the
  generalized form of Karl's existing special case.

`'FolderName/ItemLabel'` addresses an item the same way the existing `FOLDERS`
array already structures things: `Apps/Inventory` is folder `apps` → item
`inventory` (today: `admin.thirsty.store`, i.e. tiktok-sample-tracker);
`Apps/Kiosk` is folder `apps` → item `kiosk` (today: `/kiosk`); `Member/App` is
folder `member` → item `tokscrape-dashboard` (labeled "App," today the Cordova
mobile-app build); `Member/Web` is folder `member` → item `member-web` (labeled
"Web," today the Fresh `/member` dashboard).

Open questions this raises:

- **What do `Member/App` and `Member/Web` point at once Section 4's
  consolidation lands?** Both currently point at implementations (the Cordova
  mobile build and the Fresh dashboard) being replaced by the single new
  SvelteKit app — they may become two routes/views inside that one app rather
  than two separate apps.
- **Flags for the new roles aren't fully specified yet.** `admin` presumably
  gets `{"*": true}` like `dj` today; `creator` needs at least `folder.member`;
  neither was stated explicitly, and `warehouse`'s exact flags (vs. `ka`'s
  current ones) weren't restated either.

### 8.3 Mock users for testing roles

Resolves the "does `admin` replace `dj`, does `warehouse` replace `ka`" question
from Revision 4: rather than the two existing named roles being retired or
coexisting awkwardly alongside the new functional ones, `dj` and `ka` stop being
roles in their own right and become **mock/example user accounts assigned to the
new functional roles**, for testing and demos:

| Mock user                    | Assigned role | Notes                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dj`                         | `admin`       | Reuses the existing full-access identity (`flags: {"*": true}`) as the admin mock.                                                                                                                                                                                                                                                              |
| `ka` (Karl)                  | `warehouse`   | Reuses Karl's existing identity and current flag set as the warehouse mock.                                                                                                                                                                                                                                                                     |
| _(new)_ `@boosteddealsdaily` | `creator`     | No existing mock covered this role. `@boosteddealsdaily` is already the example creator used throughout the existing skills (e.g. `sample-lifecycle`'s "assign 1 Cupids Desire Drops to @boosteddealsdaily"), so it's reused here — and as the example in the extension role-bridge (Section 9) — rather than inventing a new example identity. |

This implies a small but real architectural shift: a **user** concept distinct
from a **role**. Today's system conflates the two (a "role" _is_ a person,
chosen per-device). Roles become the functional category
(`admin`/`creator`/`warehouse`); mock users are concrete accounts assigned to a
role — which is also the shape needed once this becomes a real multi-user system
backed by the consolidated Postgres database (Section 5), rather than a
per-device `localStorage` toggle.

### 8.4 Login/session (mocked for now)

Section 9's extension role bridge needs LP-OS to expose _something_ the
extension can "log in" to and get the current user's role back. Today's system
has **no auth/session at all** — `core/roles.json`'s RBAC is explicitly
per-device `localStorage`, not server-backed (see the "the OS has no
auth/session" comment in `os.js`).

**Decided this revision: mock it via a URL param, not a real session system
yet.** `?user=dj` signals the `dj` mock user (→ admin, Section 8.3);
`?user=@boosteddealsdaily` signals that creator mock (→ creator). No
`ka`/warehouse case, since warehouse doesn't use the extension at all (Section
9). This is explicitly a placeholder standing in for real auth — presumably
replaced later by an actual login/session flow once LP-OS has real user accounts
rather than mock ones.

---

## 9. Browser extension consolidation

tok-scrape currently ships three separate Manifest V3 Chrome extensions:

- **`extension-agency`** — targets `partner.us.tiktokshop.com` (Partner Center
  creator + sellers dashboards), no declarative content scripts (injects via the
  `scripting` permission instead).
- **`extension-seller`** — targets `shop.tiktok.com` and `www.tiktok.com`
  (seller-side LIVE Dashboard, Streamer Compass), plus one declarative content
  script on `tiktok.com/shop/order_detail*` (MAIN-world, `document_start`, for
  order-price scraping).
- **`extension-creator-demo`** — referenced from `os.js`'s Demos folder ("Sample
  Valuation"); confirmed **not** carrying over to LP-OS (see below).

`extension-agency` and `extension-seller` are otherwise near-identical: same
`action`/icon block, and the exact same `TOK_CONFIG` shape and GELF token
literal in both `config.js` files today. The only real differences are
`host_permissions` and which pages get scraped.

**Decided this revision:** merge `extension-agency` and `extension-seller` into
one extension. Gate which scraping behavior is active by the same role concept
being added to the desktop shell (Section 8.2): **admin role → agency behavior**
(Partner Center scraping), **creator role → seller behavior** (LIVE
Dashboard/Streamer Compass/order-price scraping). Practically, this means
unioning the two manifests' `host_permissions` and `content_scripts`, keeping
both sets of scraping logic in one merged `background.js`, and using the active
role — not just page-domain matching — to decide which is enabled.

**Resolved — role bridge, made concrete this revision:** admin vs. creator mode
is inferred directly from the logged-in user's role, not a separate signal for
creator context. The login itself is mocked for now (Section 8.4): the extension
reads a `?user=` URL param — `?user=dj` → admin → agency behavior;
`?user=@boosteddealsdaily` → creator → seller behavior, scoped to that creator.
This one param covers both "which role" and, for the creator case, "which
creator," rather than needing a separate mechanism for each. A real
login/session system presumably replaces this mock later, once LP-OS has real
accounts rather than the Section 8.3 mock users.

**Correction:** the earlier framing of this as a "bookmarklet" login was wrong —
this is about the consolidated extension (this section), not the separate
`bookmarklet-*.js` scripts (Section 10's `run-partner-center-bookmarklet`
skill). Whether the bookmarklets need any equivalent mock-login treatment is a
separate, still-open question.

**Resolved — `extension-creator-demo`:** it does **not** carry over to LP-OS.
Only `extension-agency` and `extension-seller` merge into the one consolidated
extension.

---

## 10. Agent skills consolidation

Claude Code skills currently split across two repos:

- **data-pimp** (`.claude/skills/`, 5 skills): `ebay-listing` (autofill an eBay
  draft listing from a sample via Claude-in-Chrome), `sample-e2e` (run the
  import/lifecycle end-to-end test, with a two-pane visual replay),
  `sample-lifecycle` (the main write-path skill — status changes,
  assign-to-creator, agency intake, resale listing, sale logging; each action
  writes Postgres plus a Graylog event), `samples-import` (open the
  Samples-Import page / help install the tok-scrape Chrome extension),
  `scrapecreators-api` (read-only TikTok Shop product/review lookups during
  intake, via the ScrapeCreators MCP).
- **tok-scrape** (`.claude/skills/`, 2 skills): `graylog-query` (translate a
  question into a Lucene query, run `scripts/graylog_query.py` against Graylog),
  `run-partner-center-bookmarklet` (drive the user's real Chrome via the
  Claude-in-Chrome extension to run one of five scraper bookmarklets against
  Partner Center / seller pages).

These already function as one logical skill set split by accident of repo
boundary — `sample-lifecycle` (data-pimp) explicitly defers read-only questions
to `graylog-query` (tok-scrape) across that boundary today. Consolidating into a
single LP-OS `.claude/skills/` directory fixes that split.

The one skill that can't move over unchanged is `graylog-query`: it's built
around Graylog's REST search API and Lucene syntax, but Section 7 recreates the
message store as a Postgres table inside LP-OS. It needs a rewrite — same
trigger phrasing and same job (answer "how many affiliate orders did @x get"
style questions), but querying LP-OS's own table directly instead of
`scripts/graylog_query.py` hitting an external Graylog host. The other six
skills carry forward with path/URL updates only
(`thirsty.store`/`admin.thirsty.store` → whatever LP-OS's domain becomes;
`samples-import` and `run-partner-center-bookmarklet` also need updating once
Section 9's extension merge lands).

---

## 11. Non-portable satellites (stay outside LP-OS)

tok-scrape's Chrome extensions (now consolidating per Section 9), its Cordova
mobile apps, and its Google Apps Script integration are platform-constrained —
browser extension APIs, Cordova/Cordova-iOS, and the Apps Script runtime don't
run inside a Fresh/SvelteKit/Deno app. They stay as separate satellites, and
their logging keeps flowing to whichever Graylog replacement tok-scrape itself
cuts over to (`graylog-shim`) — that migration is independent of LP-OS's own
recreated message store (Section 7), since these satellites aren't LP-OS
clients.

---

## 12. Suggested phasing

1. **Scaffold** — Fresh canary project for the core app/shell (including the
   `os.js` desktop shell, Section 8), a separate SvelteKit project (official
   `@deno/svelte-adapter`) for the member dashboard, `deno desktop` build
   targets configured for both, deployed empty to the new Deno Deploy platform.
2. **Data layer** — recreated, optimized Postgres schema and migrations (Section
   5), including the Graylog message table, dropping Supabase.
3. **Realtime/presence** — extracted WebSocket relay module (Section 6), both
   server and the tiktok-sample-tracker-derived client.
4. **Logging** — recreated Graylog message store live (Section 7), backfilled
   from the existing backup, before or alongside UI work so dashboards have real
   data to render against.
5. **Desktop shell** — port `os.js`'s window manager; add Pin/Save,
   multi-instance support, and the generalized role/`default_home` system
   (Section 8).
6. **UI** — the new consolidated SvelteKit dashboard app (Section 4), built out
   feature-by-feature against the Next.js version's checklist; then
   scanner/inventory (ported from tiktok-sample-tracker, possibly into the same
   app).
7. **Browser extension merge** — combine `extension-agency` and
   `extension-seller`, wire up role detection, decide `extension-creator-demo`'s
   fate (Section 9).
8. **Skills** — consolidate data-pimp's and tok-scrape's Claude Code skills into
   one LP-OS skills directory, rewriting `graylog-query` against the new
   Postgres-backed message table (Section 10).
9. **Distribution** — web/PWA, `deno desktop` binaries for both apps, Android
   TWA carried forward, service worker added.
10. **Retire/redirect** — old repos' deploys repointed or decommissioned once
    LP-OS is verified at parity. tok-scrape's independent `graylog-shim` cutover
    can proceed on its own schedule regardless of this phasing.

---

## 13. Risks and open questions

**Time-sensitive, independent of LP-OS's own timeline:** tok-scrape's
`graylog-shim` plan states the **new** Deno Deploy platform's documentation
confirms **Deploy Classic shuts down 2026-07-20** — 15 days from today.
data-pimp is currently deployed via a `deno.json` `"deploy": {org, app}` block;
confirm today whether that's already on the new platform or still on Classic.
This deadline hits regardless of how LP-OS planning proceeds and is worth
checking independently of this document.

Other open items:

- **Merged or separate SvelteKit apps** (Sections 3.1, 4, 8.2) — does the new
  member-dashboard app absorb tiktok-sample-tracker, or do they stay as two
  SvelteKit apps sharing the same backend? This also decides what
  `Member/App`/`Member/Web` resolve to.
- **RBAC flags for the new roles** (Section 8.2) — mock users are now defined
  (Section 8.3), but the exact capability flags each role grants (beyond `admin`
  presumably getting full access) aren't fully specified yet.
- **Pin persistence and instance differentiation** (Section 8.1) — per-device
  `localStorage` or a per-user Postgres row for pins; any cap on concurrent
  same-app windows; how the UI tells multiple instances of one app apart.
- **Real login eventually replacing the mock** (Sections 8.4, 9) — `?user=dj` /
  `?user=@boosteddealsdaily` is an explicit placeholder, not a finished design;
  when/how it's replaced by real accounts and a real session isn't decided.
  Whether the standalone bookmarklets (Section 10) need equivalent treatment is
  also open, separate from the extension case.
- **How much Graylog history to actually import** (Section 7) — the full 827-doc
  backup, or only what's still operationally relevant.
- **graylog-shim overlap** (Section 7) — LP-OS's recreated message store and
  tok-scrape's `graylog-shim` now solve the same underlying problem
  independently for different clients; worth a sanity check that running both
  isn't more confusing than it needs to be long-term.
- **TWA vs. Deno Desktop overlap** — Android distribution today goes through
  Bubblewrap/TWA (wrapping the PWA); `deno desktop` targets native
  mac/windows/linux binaries. These serve different platforms and likely both
  stay, but worth confirming Android isn't also expected to go through
  `deno desktop`.
