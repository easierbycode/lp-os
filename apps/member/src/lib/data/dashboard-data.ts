export interface Account {
	id: string;
	name: string;
	handle: string;
	initials: string;
	symbol: string;
	color: string;
}

export interface KpiMetric {
	value: number;
	delta: number;
	spark: number[];
}

export interface KpiBundle {
	gmv: KpiMetric;
	videos: KpiMetric;
	commission: KpiMetric;
}

export interface Product {
	id: string;
	brand: string;
	category: string;
	gmv: number;
	units: number;
	commission: number;
	trend: number;
	accounts: string[];
}

export interface Video {
	id: string;
	brand: string;
	caption: string;
	gmv: number;
	views: number;
	commission: number;
	accounts: string[];
	hot?: boolean;
}

export const ACCOUNTS: Account[] = [
	{
		id: "blackfridaybrian",
		name: "Black Friday Brian",
		handle: "@blackfridaybrian",
		initials: "BF",
		symbol: "★",
		color: "oklch(0.72 0.18 30)",
	},
	{
		id: "beautybybri",
		name: "Beauty by Bri",
		handle: "@beautybybri",
		initials: "BB",
		symbol: "✿",
		color: "oklch(0.72 0.18 350)",
	},
	{
		id: "bertha6",
		name: "Bertha 6",
		handle: "@bertha6",
		initials: "B6",
		symbol: "◆",
		color: "oklch(0.72 0.18 280)",
	},
	{
		id: "betterb46",
		name: "BetterB 46",
		handle: "@betterb46",
		initials: "B4",
		symbol: "▲",
		color: "oklch(0.72 0.18 210)",
	},
	{
		id: "better9",
		name: "Better 9",
		handle: "@better9",
		initials: "B9",
		symbol: "●",
		color: "oklch(0.72 0.18 160)",
	},
	{
		id: "petrb2",
		name: "PetrB 2",
		handle: "@petrb2",
		initials: "P2",
		symbol: "■",
		color: "oklch(0.72 0.18 90)",
	},
];

export const ALL_ACCOUNT: Account = {
	id: "__all",
	name: "All Accounts",
	handle: "aggregate",
	initials: "ALL",
	symbol: "＊",
	color: "oklch(0.78 0.02 90)",
};

export const STREAK = { days: 22, bestDays: 45 };
export const MONTH_COMPARE = { thisMonth: 30, prevMonth: 7 };

export const KPI_ALL: KpiBundle = {
	gmv: {
		value: 100000,
		delta: 0.18,
		spark: [22, 28, 24, 36, 30, 42, 48, 52, 60, 54, 66, 72, 80, 92, 100],
	},
	videos: {
		value: 600,
		delta: 0.11,
		spark: [
			210, 230, 260, 280, 320, 340, 380, 420, 450, 480, 500, 530, 555, 580,
			600,
		],
	},
	commission: {
		value: 30000,
		delta: 0.22,
		spark: [6, 7, 9, 11, 13, 14, 16, 18, 20, 22, 24, 26, 27, 29, 30],
	},
};

export const KPI_BY_ACCT: Record<
	string,
	{ gmv: number; videos: number; commission: number }
> = {
	blackfridaybrian: { gmv: 28000, videos: 140, commission: 8400 },
	beautybybri: { gmv: 25000, videos: 118, commission: 7500 },
	bertha6: { gmv: 18000, videos: 96, commission: 5400 },
	betterb46: { gmv: 12500, videos: 92, commission: 3800 },
	better9: { gmv: 9500, videos: 84, commission: 2850 },
	petrb2: { gmv: 7000, videos: 70, commission: 2050 },
};

export const PRODUCTS: Product[] = [
	{
		id: "salary",
		brand: "Salary",
		category: "Skincare · Retinol Serum",
		gmv: 25000,
		units: 43,
		commission: 5000,
		trend: 0.34,
		accounts: ["blackfridaybrian", "beautybybri", "bertha6"],
	},
	{
		id: "berbury",
		brand: "Berbury",
		category: "Handbags · Crossbody",
		gmv: 20000,
		units: 11,
		commission: 2000,
		trend: 0.21,
		accounts: ["beautybybri", "blackfridaybrian"],
	},
	{
		id: "crocs",
		brand: "Crocs",
		category: "Footwear · Classic Clog",
		gmv: 18000,
		units: 22,
		commission: 4500,
		trend: 0.12,
		accounts: ["petrb2", "better9", "betterb46", "bertha6"],
	},
	{
		id: "raybee",
		brand: "Raybee",
		category: "Lighting · LED Floor Lamp",
		gmv: 14200,
		units: 31,
		commission: 2130,
		trend: 0.55,
		accounts: ["blackfridaybrian", "betterb46", "better9"],
	},
	{
		id: "graze",
		brand: "Graze",
		category: "Pet · Slow-feed Bowl",
		gmv: 9800,
		units: 48,
		commission: 1470,
		trend: -0.04,
		accounts: ["petrb2"],
	},
	{
		id: "stallon",
		brand: "Stallon",
		category: "Fitness · Resistance Set",
		gmv: 7600,
		units: 24,
		commission: 910,
		trend: 0.08,
		accounts: ["better9", "bertha6"],
	},
	{
		id: "golf25",
		brand: "Golf 2S Trio",
		category: "Golf · Training Aid",
		gmv: 5400,
		units: 12,
		commission: 810,
		trend: 0.41,
		accounts: ["blackfridaybrian"],
	},
];

export const VIDEOS: Video[] = [
	{
		id: "v1",
		brand: "Salary",
		caption: "POV: the retinol serum that fixed my 3am skin",
		gmv: 18600,
		views: 1_310_000,
		commission: 3600,
		accounts: ["blackfridaybrian", "beautybybri"],
	},
	{
		id: "v2",
		brand: "Raybee",
		caption: "Raybee 2 for 1!! get in here before it sells out",
		gmv: 12400,
		views: 984_000,
		commission: 1860,
		accounts: ["blackfridaybrian", "betterb46", "better9"],
		hot: true,
	},
	{
		id: "v3",
		brand: "Berbury",
		caption: "Why everyone is buying the mini crossbody this week",
		gmv: 9200,
		views: 612_000,
		commission: 920,
		accounts: ["beautybybri"],
	},
	{
		id: "v4",
		brand: "Crocs",
		caption: "Black Friday deep dive: the clog drop nobody saw coming",
		gmv: 8400,
		views: 540_000,
		commission: 2100,
		accounts: ["petrb2", "better9", "bertha6"],
	},
	{
		id: "v5",
		brand: "Graze",
		caption: "slow feeder review: my dog actually chews now",
		gmv: 3200,
		views: 210_000,
		commission: 480,
		accounts: ["petrb2"],
	},
	{
		id: "v6",
		brand: "Stallon",
		caption: "3 resistance band workouts for the couch-to-5k crowd",
		gmv: 2800,
		views: 188_000,
		commission: 335,
		accounts: ["better9"],
	},
];

export const POWER_DEAL = {
	brand: "Raybee",
	title: "Raybee 2 for 1!",
	sub: "Featured by 3 accounts · ends 11:59 PT",
	accounts: ["blackfridaybrian", "betterb46", "better9"],
};

export const acctById = (id: string) => ACCOUNTS.find((a) => a.id === id);
