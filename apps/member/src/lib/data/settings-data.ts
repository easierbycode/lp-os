/**
 * Port of apps/web/app/(saas)/app/(account)/settings/* — stub data.
 *
 * The Next.js settings pages read from Better Auth (`getSession`,
 * `getUserAccounts`, `getUserPasskeys`, `listSessions`) and the billing
 * (orpc `payments.listPurchases`). None of that exists in the Fresh app yet,
 * so this file supplies a typed seed user, connected-account state, active
 * sessions, and the current plan. The UI renders these faithfully but every
 * mutating control (Save / upload / Enable / Delete) is disabled with a
 * "sign-in is connected" note — see `Settings.svelte`.
 *
 * Update this when the real auth/billing backend is wired in.
 */

export interface SettingsUser {
  name: string;
  email: string;
  /** Optional separate address for product/billing notifications. */
  notificationEmail: string;
  initials: string;
}

export interface ConnectedAccount {
  /** Stable provider key (matches the source `oAuthProviders` map). */
  provider: "google" | "discord";
  name: string;
  linked: boolean;
}

export interface ActiveSession {
  id: string;
  /** Human label for the device/browser. */
  device: string;
  lastActive: string;
  /** Whether this is the session the user is browsing from right now. */
  current: boolean;
}

export interface BillingPlan {
  name: string;
  status: "active" | "trialing" | "past_due" | "canceled";
  /** Display price, already formatted. */
  price: string;
  /** Renewal date, already formatted. */
  renewsOn: string;
  features: string[];
}

export interface SettingsData {
  user: SettingsUser;
  connectedAccounts: ConnectedAccount[];
  sessions: ActiveSession[];
  plan: BillingPlan;
}

export const SETTINGS_DATA: SettingsData = {
  user: {
    name: "Daniel Nguyen",
    email: "daniel@easierbycode.com",
    notificationEmail: "",
    initials: "DN",
  },
  connectedAccounts: [
    { provider: "google", name: "Google", linked: true },
    { provider: "discord", name: "Discord", linked: false },
  ],
  sessions: [
    {
      id: "sess_current",
      device: "Chrome on macOS",
      lastActive: "Active now",
      current: true,
    },
    {
      id: "sess_phone",
      device: "Safari on iPhone",
      lastActive: "2 hours ago",
      current: false,
    },
  ],
  plan: {
    name: "LifePreneur Pro",
    status: "active",
    price: "$49 / month",
    renewsOn: "July 13, 2026",
    features: [
      "Unlimited product scrapes",
      "Live + Streamer dashboards",
      "Premium training content",
      "Priority support",
    ],
  },
};
