/**
 * Stub affiliate stats — replaces the Prisma `db.affiliate.findUnique` read and
 * the Rewardful sync (`orpcClient.users.affiliate.refreshStats`) that drive the
 * real dashboard. Until that backend is wired in, this seeds the enrolled-state
 * UI in `components/AffiliateDashboard.svelte`.
 *
 * Note: the source stores commission amounts in cents and divides by 100 at the
 * page boundary; here we keep them as dollars to match the component's props.
 */

export interface AffiliateStats {
  /** Full referral link, including the `?via=<token>` query param. */
  primaryLinkUrl: string | null;
  /** Total clicks on the primary link. */
  visitors: number;
  /** Referred conversions (customers). */
  conversions: number;
  /** Commissions earned, in dollars. */
  commissionsEarned: number;
  /** Commissions still pending payout, in dollars. */
  commissionsPending: number;
  /** Commissions already paid out, in dollars. */
  commissionsPaid: number;
  /** ISO timestamp of the last Rewardful sync, or null if never synced. */
  lastSyncAt: string | null;
}

/** A few hours ago, so the "Stats updated … ago" line reads naturally. */
const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

export const AFFILIATE_STATS: AffiliateStats = {
  primaryLinkUrl: "https://lifepreneur.com/?via=daniel",
  visitors: 1284,
  conversions: 37,
  commissionsEarned: 2148.5,
  commissionsPending: 612.0,
  commissionsPaid: 1536.5,
  lastSyncAt: threeHoursAgo,
};
