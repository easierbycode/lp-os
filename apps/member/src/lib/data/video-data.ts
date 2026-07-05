/**
 * Stubbed video catalog. The Next.js app fetches this from Prisma
 * (`db.contentVideo.findMany`) and supports search via the orpc client. Until
 * we wire a real data layer, these in-memory entries drive the
 * `StreamingLibrary` island so the page renders end-to-end.
 */

export interface Video {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  views: number;
  category: string;
  description?: string;
  videoUrl?: string;
  isMock?: boolean;
}

export const VIDEO_CATEGORIES = [
  "Getting Started",
  "Advanced Strategies",
  "Case Studies",
  "Tools & Resources",
] as const;

export type VideoCategory = (typeof VIDEO_CATEGORIES)[number];

const placeholder = (text: string) =>
  `data:image/svg+xml;utf8,${
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 180'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='%23f54e00'/><stop offset='100%' stop-color='%231a1916'/></linearGradient></defs><rect width='320' height='180' fill='url(%23g)'/><text x='50%' y='50%' text-anchor='middle' dominant-baseline='middle' font-family='system-ui' font-size='18' fill='white'>${text}</text></svg>`,
    )
  }`;

export const VIDEOS: Video[] = [
  {
    id: "v1",
    title: "TikTok Shop Affiliate 101",
    thumbnail: placeholder("Affiliate 101"),
    duration: "12:30",
    views: 3421,
    category: "Getting Started",
    description:
      "Set up your seller profile and choose your first ten product picks.",
    isMock: true,
  },
  {
    id: "v2",
    title: "Picking Winning Products",
    thumbnail: placeholder("Winning Products"),
    duration: "08:14",
    views: 5210,
    category: "Getting Started",
    description: "Filters, momentum signals, and red flags to avoid.",
    isMock: true,
  },
  {
    id: "v3",
    title: "Hooks That Convert",
    thumbnail: placeholder("Hooks"),
    duration: "15:02",
    views: 8920,
    category: "Advanced Strategies",
    description: "Three hook archetypes that consistently land in TikTok ads.",
    isMock: true,
  },
  {
    id: "v4",
    title: "Scaling From $1K to $10K/Day",
    thumbnail: placeholder("Scaling"),
    duration: "22:48",
    views: 14302,
    category: "Advanced Strategies",
    description: "How to push spend without losing CTR or ROAS.",
    isMock: true,
  },
  {
    id: "v5",
    title: "$100K Beauty Drop",
    thumbnail: placeholder("Beauty Drop"),
    duration: "11:55",
    views: 6411,
    category: "Case Studies",
    description: "Behind-the-scenes of the spring beauty launch.",
    isMock: true,
  },
  {
    id: "v6",
    title: "Cold Start Postmortem",
    thumbnail: placeholder("Cold Start"),
    duration: "18:20",
    views: 4280,
    category: "Case Studies",
    description: "What we learned from a brand new account in week one.",
    isMock: true,
  },
  {
    id: "v7",
    title: "The Creator Stack We Use",
    thumbnail: placeholder("Creator Stack"),
    duration: "09:12",
    views: 2901,
    category: "Tools & Resources",
    description: "Tools for editing, scheduling, and analytics.",
    isMock: true,
  },
  {
    id: "v8",
    title: "Spreadsheet Templates",
    thumbnail: placeholder("Templates"),
    duration: "06:48",
    views: 1822,
    category: "Tools & Resources",
    description: "Plug-and-play sheets for tracking GMV and commission.",
    isMock: true,
  },
];
