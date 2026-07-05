# apps/member — Next.js parity checklist

Feature parity tracker against the original member app
(`tok-scrape/member-app/apps/web`, Next.js + Prisma + better-auth). Checked
items are covered by this SvelteKit scaffold (stub data from
`src/lib/data/*.ts`; live Postgres/Graylog wiring is incremental follow-on).

## Routes in this app (LP-OS contract)

- [x] `/` — MemberDashboardV2 (shell `Member/App` target)
- [x] `/web` — landing hub (shell `Member/Web` target)
- [x] `/web/seller` — SellerDashboard
- [x] `/web/streamer` — StreamerDashboard
- [x] `/web/content` — StreamingLibrary
- [x] `/web/community` — CommunityHub (bonus; stub announcements)
- [x] `/web/affiliate` — AffiliateDashboard (bonus; stub stats)
- [x] `/web/settings` — Settings (bonus; stub profile/billing)

## SaaS app routes (user member features)

- [x] `/app/dashboard` — MemberDashboardV2 (core creator metrics: GMV, videos,
      commission by account) → served here at `/` — account filter, period
      selector, streak row, KPI tiles + sparklines, power deal, products
      table, videos grid, account legend (stub data)
- [x] `/app/seller-dashboard` — TikTok Shop live-session seller analytics
      (items sold, viewers, products, traffic sources, Phaser GMV implosion)
      → `/web/seller` (stub payload)
- [x] `/app/streamer-dashboard` — Creator Compass video-analysis KPIs
      → `/web/streamer` (stub payload)
- [x] `/app/content` — content/streaming library (video rows, featured,
      search) → `/web/content` (stub catalog; player/detail modals deferred)
- [x] `/app/affiliate` — affiliate dashboard (simple enrolled view)
      → `/web/affiliate` (stub stats; no Rewardful sync, beta gating deferred)
- [x] `/app/community` — community hub / announcements → `/web/community`
      (read state in localStorage; Discord connect is a no-op)
- [ ] `/app/` — account home redirect
- [ ] `/app/(account)/notifications` — user notification center
- [~] `/app/(account)/settings/general` — profile form → `/web/settings`
      (stub form, no persistence)
- [~] `/app/(account)/settings/security` — passkey / 2FA management
      → `/web/settings` (display only)
- [~] `/app/(account)/settings/billing` — subscription, plan change, payment
      method → `/web/settings` (display only)
- [ ] `/app/(account)/settings/danger-zone` — account deletion request

## Organization routes (team/multi-seat)

- [ ] `/app/(organizations)/[organizationSlug]` — org home
- [ ] `/app/(organizations)/[organizationSlug]/settings/general`
- [ ] `/app/(organizations)/[organizationSlug]/settings/members`
- [ ] `/app/(organizations)/[organizationSlug]/settings/billing`
- [ ] `/app/(organizations)/[organizationSlug]/settings/danger-zone`
- [ ] `/app/choose-plan` — plan selection
- [ ] `/app/new-organization` — create organization
- [ ] `/app/onboarding` — guided first-login setup
- [ ] `/app/organization-invitation/[invitationId]` — accept org invite

## TikTok Shop agency routes (seller expansion)

- [ ] `/app/tiktok-shop` — linked TikTok accounts & import
- [ ] `/app/tiktok-shop/goals` — performance goals (daily/weekly/monthly)
- [ ] `/app/tiktok-shop/campaigns` — campaign enrollment & tracking
- [ ] `/app/tiktok-shop/profile` — TikTok account profile
- [ ] `/app/tiktok-shop/coming-soon` — placeholder

## Admin routes

- [ ] `/admin` — admin dashboard
- [ ] `/admin/users` — user list, ban, impersonation, deletion queue
- [ ] `/admin/analytics` — system metrics
- [ ] `/admin/announcements` (+ `/global`) — announcement CRUD
- [ ] `/admin/notifications` (+ `/settings`) — bulk messaging
- [ ] `/admin/subscriptions` — coupons, refunds, Stripe sync
- [ ] `/admin/affiliates` — Rewardful sync audit
- [ ] `/admin/content` — content video management
- [ ] `/admin/beta-features` — beta flag assignment
- [ ] `/admin/help-center` (+ `/articles`, `/categories`) — FAQ CRUD
- [ ] `/admin/testimonials` — testimonial management
- [ ] `/admin/audit-log` — admin action audit trail
- [ ] `/admin/discord/*` — Discord integration control (message studio,
      emergency, analytics, audit-logs, additional-accounts, sync-check)
- [ ] `/admin/command-center` — ops tooling
- [ ] `/admin/marketing` — marketing content editor
- [ ] `/admin/maintenance` — maintenance mode toggle
- [ ] `/admin/mobile-redirect` — mobile deep-link routing

## Marketing routes (public)

- [ ] `/(marketing)/[locale]/` — localized homepage
- [ ] `/(marketing)/[locale]/blog` (+ posts)
- [ ] `/(marketing)/[locale]/changelog`
- [ ] `/(marketing)/[locale]/checkout/[plan]` (+ lifetime, promo)
- [ ] `/(marketing)/[locale]/contact`
- [ ] `/(marketing)/[locale]/docs/[[...path]]`
- [ ] `/(marketing)/[locale]/helpcenter` (+ article detail)
- [ ] `/(marketing)/[locale]/legal/[...path]`
- [ ] `/(marketing)/[locale]/studio-verification`

## API routes

- [ ] `POST /api/auth/create-session` — session from LoginToken (magic link)
- [ ] `POST /api/auth/validate-checkout` — Stripe checkout webhook
- [ ] `POST /api/checkout/create` — Stripe Checkout session init
- [ ] `GET /api/health`
- [ ] `POST /api/user/request-deletion` — GDPR deletion request
- [ ] `POST /api/announcements/dismiss` / `check-active` / `onboarding/check`
- [ ] `POST /api/cron/sync-stripe-subscriptions` / `grace-period-expiration`
      / `purge-deleted-users` / `discord-health-check`
- [ ] `POST /api/discord/interactions` — Discord webhook
- [ ] `POST /api/admin/announcements/global`, `POST /api/admin/maintenance`
- [ ] `GET /api/docs-search`

## Auth & gating

- [ ] Session provider / getSession route protection (better-auth port)
- [ ] Admin role barrier
- [ ] Beta feature flags (e.g. fullAffiliateDashboard)
- [ ] Organization context (activeOrganizationId)
- [ ] Subscription status gating (Purchase records)

## Data integration (replaces stub `src/lib/data/*.ts`)

- [ ] Postgres via `@lp-os/db` (users, content, announcements, affiliate…)
- [ ] Graylog payloads via LP-OS `/api/search/universal/relative`
      (seller-live payloads, streamer/creator-compass payloads, KPI events)
- [ ] Stripe (checkout, subscription sync)
- [ ] Rewardful (affiliate metrics sync)
- [ ] Discord bot integration

## Components ported (data-pimp/member/components → src/lib/components)

- [x] MemberDashboardV2.svelte
- [x] SellerDashboard.svelte
- [x] GmvImplosion.svelte (Phaser 4, lazy-loaded in onMount — kept)
- [x] StreamerDashboard.svelte
- [x] StreamingLibrary.svelte + VideoRow.svelte
- [x] CommunityHub.svelte
- [x] AffiliateDashboard.svelte
- [x] Settings.svelte
- [x] Counter.svelte (Svelte-island interop demo, embedded by
      MemberDashboardV2)
- Preact wrappers/components (islands/*.tsx, NavBar/BottomNav/MobileHeader/
  PageHeader/UserMenu/Logo/icons .tsx) intentionally NOT ported — LP-OS
  ships no Preact/React in apps/member.
