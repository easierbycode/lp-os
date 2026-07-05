/**
 * Stub streamer dashboard data — shape mirrors the payload that
 * `bookmarklet-streamer.js` ships to Graylog when run on TikTok Shop's
 * Streamer Compass video-analysis view
 * (`shop.tiktok.com/streamer/compass/video-analysis/view`). Until the
 * dashboard is wired to a live Graylog stream, this drives the UI.
 */

export interface KpiTile {
  name: string;
  value: string;
  /** Currency prefix shown next to the headline number, e.g. "$". */
  currency: string;
  /** Internal compare key from the source page (e.g.
   * "creatorcompass_video_analysis_vs_last_28d_us"). Surfaced here so
   * the UI can label the trend bucket. */
  compareKey: string;
  /** Trend delta string with sign, e.g. "+0.00", "-79.25%". */
  delta: string;
}

export interface VideoMetric {
  name: string;
  value: string;
}

export interface VideoCard {
  Thumbnail: string;
  Title: string;
  Posted: string;
  Duration: string;
  Metrics: VideoMetric[];
}

export interface StreamerPayload {
  page: string;
  dateLabel: string;
  dateRange: { start: string; end: string };
  scrapedAt: string;
  metrics: KpiTile[];
  videos: VideoCard[];
}

const tile = (
  name: string,
  value: string,
  delta: string,
  currency = "",
): KpiTile => ({
  name,
  value,
  currency,
  compareKey: "creatorcompass_video_analysis_vs_last_28d_us",
  delta,
});

const video = (
  thumb: string,
  title: string,
  posted: string,
  duration: string,
  metrics: Array<[string, string]>,
): VideoCard => ({
  Thumbnail: thumb,
  Title: title,
  Posted: posted,
  Duration: duration,
  Metrics: metrics.map(([name, value]) => ({ name, value })),
});

// Vibrant on-brand placeholder thumbnails (data URIs so the dashboard
// renders standalone without external assets). Each carries a different
// hue so the video cards visually differentiate at a glance.
const thumb = (hue: number, label: string) =>
  `data:image/svg+xml;utf8,${
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 480 270'>` +
        `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
        `<stop offset='0%' stop-color='hsl(${hue},85%,55%)'/>` +
        `<stop offset='100%' stop-color='#1a1916'/></linearGradient></defs>` +
        `<rect width='480' height='270' fill='url(%23g)'/>` +
        `<text x='50%' y='50%' text-anchor='middle' dominant-baseline='middle' ` +
        `font-family='system-ui' font-size='28' font-weight='700' fill='white'>${label}</text>` +
        `</svg>`,
    )
  }`;

export const STREAMER_PAYLOAD: StreamerPayload = {
  page: "video analysis",
  dateLabel: "Last 28 days",
  dateRange: { start: "Mar 01, 2026", end: "Mar 28, 2026" },
  scrapedAt: "2026-04-26T04:22:20.530Z",
  metrics: [
    tile("GMV", "12,847.39", "+18.42%", "$"),
    tile("Items sold", "412", "+22.10%"),
    tile("Views", "84,210", "+47.30%"),
    tile("New followers", "1,309", "+12.65%"),
    tile("Videos", "23", "+9.52%"),
  ],
  videos: [
    video(
      thumb(20, "Brainista Yerba"),
      "Brainista Yerba Magic 5-1 Capsules #tiktokshopcybermonday #tiktokshopblackfriday",
      "2025/11/18 22:45",
      "19s",
      [
        ["GMV", "$1,284.50"],
        ["Views", "12,431"],
        ["Items sold", "47"],
        ["CTR", "3.21%"],
        ["Completion", "62.40%"],
        ["New followers", "78"],
      ],
    ),
    video(
      thumb(40, "Yerba Magic 2"),
      "Brainista Yerba Magic 5-1 Capsules — quick recipe demo",
      "2025/11/18 22:44",
      "18s",
      [
        ["GMV", "$914.80"],
        ["Views", "9,210"],
        ["Items sold", "32"],
        ["CTR", "2.94%"],
        ["Completion", "59.10%"],
        ["New followers", "53"],
      ],
    ),
    video(
      thumb(330, "Cyber Monday"),
      "Cyber Monday flash bundle — Brainista Yerba + Shilajit",
      "2025/11/30 10:12",
      "27s",
      [
        ["GMV", "$2,418.90"],
        ["Views", "21,302"],
        ["Items sold", "82"],
        ["CTR", "4.18%"],
        ["Completion", "71.80%"],
        ["New followers", "194"],
      ],
    ),
    video(
      thumb(190, "Shilajit Resin"),
      "Shilajit Resin pure — energy + focus 30g jar",
      "2025/12/02 18:30",
      "22s",
      [
        ["GMV", "$1,742.00"],
        ["Views", "16,815"],
        ["Items sold", "59"],
        ["CTR", "3.61%"],
        ["Completion", "65.20%"],
        ["New followers", "112"],
      ],
    ),
    video(
      thumb(280, "Cleanse"),
      "15 Day Cleanse — gut & colon support, caffeine free",
      "2025/12/05 09:44",
      "31s",
      [
        ["GMV", "$1,128.40"],
        ["Views", "11,924"],
        ["Items sold", "41"],
        ["CTR", "2.84%"],
        ["Completion", "57.30%"],
        ["New followers", "67"],
      ],
    ),
    video(
      thumb(60, "NMN Complex"),
      "Micro Ingredients NMN Complex 1,000mg — NAD+ precursor demo",
      "2025/12/10 14:21",
      "24s",
      [
        ["GMV", "$1,510.20"],
        ["Views", "13,701"],
        ["Items sold", "48"],
        ["CTR", "3.07%"],
        ["Completion", "60.10%"],
        ["New followers", "85"],
      ],
    ),
    video(
      thumb(160, "Korean Toner"),
      "Korean glass-skin toner pads — snail mucin + niacinamide",
      "2025/12/14 19:08",
      "21s",
      [
        ["GMV", "$842.10"],
        ["Views", "8,612"],
        ["Items sold", "29"],
        ["CTR", "2.41%"],
        ["Completion", "58.40%"],
        ["New followers", "44"],
      ],
    ),
    video(
      thumb(220, "Magnesium"),
      "Magnesium Glycinate 500mg — sleep & stress support",
      "2025/12/18 21:52",
      "20s",
      [
        ["GMV", "$721.80"],
        ["Views", "7,415"],
        ["Items sold", "26"],
        ["CTR", "2.18%"],
        ["Completion", "55.90%"],
        ["New followers", "39"],
      ],
    ),
  ],
};
