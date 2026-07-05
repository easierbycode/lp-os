/**
 * Stub seller dashboard data — shape mirrors the payload that
 * `bookmarklet-live.js` ships to Graylog when run on a TikTok Shop seller-side
 * LIVE Dashboard (`shop.tiktok.com/workbench/live/overview`). Until the
 * dashboard is wired to a live Graylog stream, this drives the UI.
 *
 * Update this when the bookmarklet payload schema changes.
 */

export interface SideKpis {
  /** Items sold during the live session. */
  "Items sold": string;
  /** Concurrent viewers (humanized: e.g. "1.74K"). */
  "Viewers": string;
}

export interface PerformanceMetric {
  name: string;
  value: string;
}

export interface TrafficSource {
  Channel: string;
  /** Share of GMV for this channel. */
  GMV: string;
  /** Share of impressions. */
  Impressions: string;
  /** Share of views. */
  Views: string;
}

export interface ProductRow {
  "Product ID": string;
  "Product name": string;
  "Product link": string;
  /**
   * Per-row metrics in column order. The set of columns can drift on the
   * server side, so the bookmarklet captures every cell as raw text rather
   * than parsing into named fields. Typical order on the Live Dashboard:
   *   [blank, impressions, ctr, gmv, atc, sales, conversion?]
   */
  Metrics: string[];
}

export interface SellerLivePayload {
  page: string;
  shop: string;
  roomId: string;
  duration: string;
  sessionRange: string;
  scrapedAt: string;
  /** Headline GMV — concatenated digits from the odometer. */
  gmv: string;
  sideKpis: SideKpis;
  performance: PerformanceMetric[];
  trafficSources: TrafficSource[];
  products: ProductRow[];
}

const product = (
  id: string,
  name: string,
  metrics: string[],
): ProductRow => ({
  "Product ID": id,
  "Product name": name,
  "Product link":
    `https://shop.tiktok.com/view/product/${id}?source=liveDashboard&region=US`,
  Metrics: metrics,
});

export const SELLER_LIVE_PAYLOAD: SellerLivePayload = {
  page: "LIVE Dashboard",
  shop: "boosteddealsdaily",
  roomId: "7630167109884611358",
  duration: "1h1m37s",
  sessionRange: "Apr 18 11:26:53 - Apr 18 12:28:30 UTC-07:00",
  scrapedAt: "2026-04-25T08:46:22.109Z",
  gmv: "1428",
  sideKpis: {
    "Items sold": "37",
    "Viewers": "1.74K",
  },
  performance: [
    { name: "Impressions", value: "21.87K" },
    { name: "Views", value: "1.92K" },
    { name: "GMV per hour", value: "$13.54" },
    { name: "Impressions per hour", value: "21.3K" },
    { name: "Show GPM", value: "0.64" },
    { name: "Avg. viewing duration per view", value: "11s" },
    { name: "Comment rate", value: "0.74%" },
    { name: "Follow rate", value: "0.05%" },
    { name: "Tap-through rate (via LIVE preview)", value: "0.78%" },
    { name: "Tap-through rate", value: "8.79%" },
    { name: "LIVE CTR", value: "3.43%" },
    { name: "Order rate (SKU orders)", value: "0.05%" },
    { name: "Share rate", value: "0.11%" },
    { name: "Like rate", value: "26.19%" },
    { name: "> 1 min. views", value: "44" },
    { name: "GMV Max ROI", value: "7.06" },
  ],
  trafficSources: [
    { Channel: "For You feed",        GMV: "62%", Impressions: "90.32%", Views: "75.45%" },
    { Channel: "LIVE swipe",          GMV: "18%", Impressions: "6.08%",  Views: "16.91%" },
    { Channel: "LIVE preview",        GMV: "10%", Impressions: "1.65%",  Views: "3.17%"  },
    { Channel: "Others' video prof…", GMV: "4%",  Impressions: "0.12%",  Views: "1.32%"  },
    { Channel: "Video profile taps",  GMV: "3%",  Impressions: "0.48%",  Views: "0.05%"  },
    { Channel: "LIVE feed",           GMV: "2%",  Impressions: "1.94%",  Views: "2.39%"  },
    { Channel: "Other",               GMV: "1%",  Impressions: "0.41%",  Views: "0.71%"  },
  ],
  products: [
    product(
      "1731194857673101831",
      "Zero Sugar Best Seller Trio — Pre, Post, Probiotic + Apple Cider Vinegar",
      ["", "1284", "3.21%", "$412.50", "98", "31", "Beauty"],
    ),
    product(
      "1729718141631565851",
      "[Dr.Melaxin Official] Calcium Multi Balm Eye Care Routine Korean Skin Care",
      ["", "812", "2.94%", "$248.18", "60", "22", "Beauty"],
    ),
    product(
      "1729444047203963674",
      "EZ BOMBS BirriaBombs 2 Bombs Per Pack — Authentic Mexican Seasoning",
      ["", "640", "5.16%", "$197.42", "55", "18", "Food"],
    ),
    product(
      "1731976483732624045",
      "Micro Ingredients NMN Complex 1,000mg — NAD+ Precursor Supplement",
      ["", "513", "2.21%", "$152.90", "33", "14", "Wellness"],
    ),
    product(
      "1729401873273951198",
      "15 Day Cleanse — Gut and Colon Support, Caffeine Free",
      ["", "402", "1.84%", "$118.32", "27", "11", "Wellness"],
    ),
    product(
      "1730812931231298471",
      "Shilajit Resin Pure Himalayan — Energy & Focus 30g Jar",
      ["", "356", "2.07%", "$98.71", "21", "9", "Wellness"],
    ),
    product(
      "1731554912034817233",
      "Korean Glass Skin Toner Pads — Snail Mucin + Niacinamide",
      ["", "298", "1.92%", "$74.20", "18", "6", "Beauty"],
    ),
    product(
      "1729998712309432109",
      "Magnesium Glycinate 500mg — Sleep + Stress Support",
      ["", "245", "1.51%", "$58.90", "15", "5", "Wellness"],
    ),
  ],
};
