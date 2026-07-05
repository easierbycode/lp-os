/**
 * Port of apps/web/modules/saas/community/lib/types.ts (+ the seed the
 * Next.js page derives from Prisma) — Svelte 5 island stub data.
 *
 * The Next.js `CommunityPage` reads announcements and Discord connection
 * state from Prisma + Better-Auth and gates Discord connect on an active
 * purchase (`canConnectDiscord`). All of that is deferred here: the
 * announcements below are an in-memory seed, the Discord platform is hard
 * coded `connected: false`, and `CAN_CONNECT_DISCORD` is stubbed `true`
 * (the connect button itself is a deferred no-op in the island). Read state
 * is persisted to localStorage by the Svelte component, not the server.
 */

export interface Platform {
  id: string;
  name: string;
  description: string;
  connected: boolean;
  username?: string | null;
  url?: string;
  /** Used to build a discord:// deep link that opens the native app. */
  guildId?: string;
  channelId?: string;
}

export type AnnouncementType =
  | "welcome"
  | "event"
  | "update"
  | "feature"
  | "maintenance"
  | "community";

export type AnnouncementPriority = "urgent" | "important" | "normal";

export interface Announcement {
  id: string;
  title: string;
  /** Short preview (first ~200 chars) rendered on the card. */
  content: string;
  /** Full body rendered in the dialog (newline-delimited paragraphs). */
  fullContent: string;
  date: string;
  type: AnnouncementType;
  priority: AnnouncementPriority;
  author: string;
  read?: boolean;
}

/**
 * Stubbed for `canConnectDiscord` — the Next.js page computes this from the
 * user's purchases. Hard-coded eligible so the "Connect" path renders.
 */
export const CAN_CONNECT_DISCORD = true;

export const DISCORD_PLATFORM: Platform = {
  id: "discord",
  name: "Discord",
  description:
    "Connect to access exclusive channels, member-only content, and real-time community support.",
  connected: false,
  username: null,
  // Deep-link env vars (NEXT_PUBLIC_DISCORD_*) are not wired here — deferred.
  url: undefined,
};

export const PLATFORMS: Platform[] = [DISCORD_PLATFORM];

const announcement = (
  a: Announcement,
): Announcement => a;

export const ANNOUNCEMENTS: Announcement[] = [
  announcement({
    id: "ann-welcome",
    title: "Welcome to the LifePreneur community",
    content:
      "You're in! This is mission control for your TikTok Shop journey — training, announcements, and the member Discord all live here. Take a minute to connect Discord and introduce yourself.",
    fullContent:
      "You're in! This is mission control for your TikTok Shop journey.\n\n" +
      "Everything you need is one click away: the Content Library for training, the Seller Dashboard for live GMV, and the member Discord for real-time help from the team and other sellers.\n\n" +
      "First steps:\n" +
      "1. Connect your Discord account on the Platforms tab.\n" +
      "2. Drop an intro in #introductions — tell us your niche and your goal for the next 30 days.\n" +
      '3. Watch "TikTok Shop Affiliate 101" in the Content Library.\n\n' +
      "We're glad you're here. Let's build something.",
    date: "2026-06-12T15:00:00.000Z",
    type: "welcome",
    priority: "normal",
    author: "LifePreneur Team",
    read: false,
  }),
  announcement({
    id: "ann-live-bootcamp",
    title: "Live Bootcamp: Scaling past $10K/day — this Thursday",
    content:
      "Join us Thursday at 1pm ET for a live teardown of three accounts that crossed $10K/day this month. Bring questions — we'll do a 30-minute Q&A at the end.",
    fullContent:
      "Join us Thursday at 1:00pm ET for our monthly Live Bootcamp.\n\n" +
      "This session is a live teardown of three creator accounts that crossed $10K/day in GMV this month. We'll walk through their hooks, their product mix, and exactly where their spend went.\n\n" +
      "Agenda:\n" +
      "- 0:00 — The three accounts at a glance\n" +
      "- 0:15 — Hook breakdown, frame by frame\n" +
      "- 0:35 — Spend and ROAS curves\n" +
      "- 0:50 — Live Q&A\n\n" +
      "Can't make it live? The replay lands in the Content Library within 24 hours.",
    date: "2026-06-11T18:30:00.000Z",
    type: "event",
    priority: "important",
    author: "LifePreneur Team",
    read: false,
  }),
  announcement({
    id: "ann-dashboard-update",
    title: "Seller Dashboard now shows per-session traffic mix",
    content:
      "We shipped a refresh to the Seller Dashboard: every live session now breaks down GMV, impressions, and views by traffic channel so you can see exactly where your sales come from.",
    fullContent: "We shipped a refresh to the Seller Dashboard.\n\n" +
      "Every live session now includes a traffic-mix breakdown — GMV, impressions, and views split by channel (For You feed, LIVE swipe, LIVE preview, and more). It's the fastest way to see which surfaces are actually driving sales versus just eyeballs.\n\n" +
      "We also tuned the performance panel so the most actionable metrics (GPM, tap-through rate, order rate) surface first.\n\n" +
      "Open the Seller Dashboard to take it for a spin.",
    date: "2026-06-09T13:00:00.000Z",
    type: "update",
    priority: "normal",
    author: "LifePreneur Team",
    read: false,
  }),
  announcement({
    id: "ann-feature-saved-products",
    title: "New: Save and tag products straight from the product list",
    content:
      "You can now bookmark products and add your own tags right from the Seller Dashboard product list. Build watchlists for restocks, winners, and niches you're testing.",
    fullContent: "New feature: saved products with custom tags.\n\n" +
      "From any product row in the Seller Dashboard you can now hit Save and attach your own tags. Use it to build watchlists — restock candidates, proven winners, niches you're testing — and filter the list down to just what matters.\n\n" +
      "Saved products sync across your devices, so the watchlist you build on desktop is there on your phone too.\n\n" +
      "This is the first of several quality-of-life features rolling out this month. Tell us what you'd build next in #feature-requests.",
    date: "2026-06-07T16:45:00.000Z",
    type: "feature",
    priority: "normal",
    author: "LifePreneur Team",
    read: true,
  }),
  announcement({
    id: "ann-maintenance",
    title: "Scheduled maintenance Saturday 2-4am ET",
    content:
      "We'll be performing scheduled database maintenance this Saturday from 2:00 to 4:00am ET. The dashboard and Content Library may be briefly unavailable during this window.",
    fullContent: "Heads up: scheduled maintenance is coming.\n\n" +
      "This Saturday from 2:00am to 4:00am ET we'll be performing database maintenance to keep things fast as the community grows.\n\n" +
      "What to expect:\n" +
      "- The dashboard and Content Library may be briefly unavailable.\n" +
      "- The member Discord is unaffected and stays online.\n" +
      "- No action is needed on your end.\n\n" +
      "We picked the lowest-traffic window to keep disruption minimal. Thanks for your patience.",
    date: "2026-06-05T20:00:00.000Z",
    type: "maintenance",
    priority: "urgent",
    author: "LifePreneur Team",
    read: false,
  }),
  announcement({
    id: "ann-community-wins",
    title: "Member wins: $1.2M in combined GMV last month",
    content:
      "The community crossed $1.2M in combined GMV in May — a new record. Huge shoutout to everyone grinding. Drop your own win in #wins so we can celebrate it.",
    fullContent: "Member wins roundup — and a new record.\n\n" +
      "Together this community crossed $1.2M in combined GMV in May. That's not us, that's you. Every hook tested, every late-night live, every product swap added up.\n\n" +
      "A few standouts from #wins:\n" +
      "- A first-time seller hit their first $1K day in week three.\n" +
      "- A beauty-niche member 3x'd their ROAS after the hook bootcamp.\n" +
      "- Two members teamed up on a bundle and sold out their first drop.\n\n" +
      "Got a win, big or small? Post it in #wins — celebrating each other is half the point.",
    date: "2026-06-02T14:15:00.000Z",
    type: "community",
    priority: "normal",
    author: "LifePreneur Team",
    read: true,
  }),
];
