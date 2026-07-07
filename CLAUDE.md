# LP-OS

LP-OS ("Lifepreneur OS") consolidates three sibling repos — **data-pimp**
(Thirsty OS backend + desktop-shell UI), **tok-scrape** (scraping toolkit,
Chrome extensions, member-app monorepo), and **tiktok-sample-tracker**
(SvelteKit scanner PWA) — into one Deno app. `MIGRATION_PLAN.md` is the
canonical plan; `docs/CONTRACTS.md` fixes the concrete names/boundaries the code
follows.

## Stack (hard rules)

- **Deno + Fresh** (`apps/shell`) for the core app: OS shell page, HTTP +
  WebSocket APIs. Preact allowed inside Fresh islands only.
- **SvelteKit + Svelte 5 runes + `@deno/svelte-adapter`** (`apps/member`) for
  the member dashboard.
- **No React. No SpacetimeDB. No Firebase. No Supabase.** Postgres (Neon) is the
  only datastore, via `npm:pg` in `packages/db`.
- Realtime = WebSocket relay + Postgres NOTIFY/LISTEN + BroadcastChannel
  (`packages/relay`). Do not introduce other realtime systems.
- Log/event history lives in the `graylog_messages` Postgres table
  (`packages/graylog`) — there is no external Graylog service.

## Layout

- `apps/shell` — Fresh core app; `static/os.js` is the draggable-window desktop
  shell (vanilla JS, no framework — keep it that way).
- `apps/member` — SvelteKit dashboard (npm/Vite-driven; in the Deno workspace
  only because Deno requires nested configs to be members — npm owns its
  `node_modules`, and root fmt/lint exclude it).
- `packages/db` — schema, migrations (`migrations/*.sql`, applied by
  `scripts/migrate.ts`), pool + query helpers.
- `packages/relay` — scan-socket server module + `ScanRelay` browser client.
- `packages/graylog` — GELF-shaped ingest, mini-Lucene→SQL search, ndjson
  backfill.
- `packages/marketplace` — marketplace listing of samples (eBay Sell API
  adapter, listing service, in-process auto-lister); credentials live in the
  `marketplace_accounts` table, entered via the shell's Marketplace window.
- `extension/` — merged Chrome extension (agency + seller behaviors, role-gated
  by `?user=`).
- `.claude/skills/` — consolidated agent skills.

## Commands

- `deno task dev` — run the shell app (needs `DATABASE_URL` in `.env`).
- `deno task dev:member` — run the member app.
- `deno task check` — typecheck the Deno workspace.
- `deno task test` — package tests.
- `deno task migrate` — apply SQL migrations.
- `deno task demo:ebay-pricing` — CLI eBay pricing-formula demo (visual twin:
  `/demos/ebay-pricing`).
- `deno task desktop:shell` / `deno task desktop:member` — native desktop
  bundles into `dist/` (needs Deno 2.9+; see `docs/DISTRIBUTION.md`).
- `deno task gen:icons` — regenerate both apps' PWA/desktop icon sets.

## Conventions

- Reads of inventory data go through `packages/db` exports; never hand-write SQL
  against inventory tables from apps.
- User-supplied search input must go through `packages/graylog/lucene.ts`
  (parameterized SQL), never string-interpolated.
- Roles are functional (`admin`/`creator`/`warehouse`); `dj`, `ka`,
  `@boosteddealsdaily` are mock users assigned to them
  (`apps/shell/core/roles.json`). Login is mocked via `?user=` — a placeholder,
  not a design.
