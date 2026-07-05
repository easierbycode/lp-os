<!--
	Port of islands/MemberDashboardV2.tsx — Svelte 5 island.
	In-place framework swap (Preact -> Svelte 5 runes), preserving exact
	behavior and pixel-for-pixel visuals. The stub data lives in
	islands/dashboard-data.ts (imported directly here). The CSS module
	(islands/MemberDashboardV2.module.css) is copied verbatim into the
	<style> block below; its class names become plain scoped classes.

	The original embedded a Preact `<SvelteCounter>` wrapper; here we import
	the Svelte `Counter.svelte` directly.
-->
<script lang="ts">
	import {
		ACCOUNTS,
		ALL_ACCOUNT,
		type Account,
		acctById,
		KPI_ALL,
		KPI_BY_ACCT,
		type KpiBundle,
		MONTH_COMPARE,
		POWER_DEAL,
		PRODUCTS,
		type Product,
		STREAK,
		VIDEOS,
		type Video,
	} from "$lib/data/dashboard-data";
	import Counter from "./Counter.svelte";

	const fmtMoney = (n: number | null | undefined) => {
		if (n == null || Number.isNaN(n)) return "—";
		if (n >= 1000) {
			return `$${
				(n / 1000).toLocaleString(undefined, {
					maximumFractionDigits: 1,
				})
			}k`;
		}
		return `$${Math.round(n).toLocaleString()}`;
	};

	const fmtMoneyFull = (n: number) => `$${Math.round(n).toLocaleString()}`;

	const fmtInt = (n: number | null | undefined) => {
		if (n == null || Number.isNaN(n)) return "—";
		if (n >= 1_000_000) {
			return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
		}
		if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
		return n.toLocaleString();
	};

	const pct = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n * 100)}%`;

	type Period = "7d" | "30d" | "90d" | "all";

	let scope = $state<string>("__all");
	let period = $state<Period>("7d");

	let selectorOpen = $state(false);
	let selectorEl = $state<HTMLDivElement>();

	$effect(() => {
		function handler(e: MouseEvent) {
			if (selectorEl && !selectorEl.contains(e.target as Node)) {
				selectorOpen = false;
			}
		}
		document.addEventListener("click", handler);
		return () => document.removeEventListener("click", handler);
	});

	const scoped = $derived.by(() => {
		if (scope === "__all") {
			return {
				kpi: KPI_ALL,
				products: PRODUCTS,
				videos: VIDEOS,
				scopeColor: "var(--primary)",
			};
		}
		const a = acctById(scope);
		const alloc = KPI_BY_ACCT[scope] ?? { gmv: 0, videos: 0, commission: 0 };
		const gmvW = alloc.gmv / KPI_ALL.gmv.value;
		const vidW = alloc.videos / KPI_ALL.videos.value;
		const comW = alloc.commission / KPI_ALL.commission.value;
		return {
			kpi: {
				gmv: {
					value: alloc.gmv,
					delta: 0.14,
					spark: KPI_ALL.gmv.spark.map(
						(v) => Math.round(v * gmvW * 10) / 10,
					),
				},
				videos: {
					value: alloc.videos,
					delta: 0.09,
					spark: KPI_ALL.videos.spark.map(
						(v) => Math.round(v * vidW * 10) / 10,
					),
				},
				commission: {
					value: alloc.commission,
					delta: 0.17,
					spark: KPI_ALL.commission.spark.map(
						(v) => Math.round(v * comW * 10) / 10,
					),
				},
			} satisfies KpiBundle,
			products: PRODUCTS.filter((p) => p.accounts.includes(scope)),
			videos: VIDEOS.filter((v) => v.accounts.includes(scope)),
			scopeColor: a?.color ?? "var(--primary)",
		};
	});

	const kpi = $derived(scoped.kpi);
	const products = $derived(scoped.products);
	const videos = $derived(scoped.videos);
	const scopeColor = $derived(scoped.scopeColor);

	const current = $derived<Account>(
		scope === "__all" ? ALL_ACCOUNT : (acctById(scope) ?? ALL_ACCOUNT),
	);

	const periods: Period[] = ["7d", "30d", "90d", "all"];
	const periodLabels: Record<Period, string> = {
		"7d": "7d",
		"30d": "30d",
		"90d": "90d",
		all: "All",
	};

	const up = MONTH_COMPARE.thisMonth > MONTH_COMPARE.prevMonth;

	// KPI tile descriptors, recomputed as the derived kpi changes.
	const tiles = $derived([
		{
			key: "gmv",
			label: "GMV",
			icon: "$",
			val: fmtMoneyFull(kpi.gmv.value),
			delta: kpi.gmv.delta,
			spark: kpi.gmv.spark,
		},
		{
			key: "videos",
			label: "# Videos",
			icon: "▶",
			val: fmtInt(kpi.videos.value),
			delta: kpi.videos.delta,
			spark: kpi.videos.spark,
		},
		{
			key: "commission",
			label: "Commission",
			icon: "%",
			val: fmtMoneyFull(kpi.commission.value),
			delta: kpi.commission.delta,
			spark: kpi.commission.spark,
		},
	]);

	function scopeAccount(s: string): Account {
		return s === "__all" ? ALL_ACCOUNT : (acctById(s) ?? ALL_ACCOUNT);
	}

	// Sparkline geometry — mirrors the Preact <Sparkline> computation.
	function sparkPaths(data: number[]) {
		const w = 120;
		const h = 34;
		const pad = 2;
		const max = Math.max(...data);
		const min = Math.min(...data);
		const span = max - min || 1;
		const step = (w - pad * 2) / (data.length - 1);
		const pts = data.map(
			(v, i) =>
				[pad + i * step, h - pad - ((v - min) / span) * (h - pad * 2)] as [
					number,
					number,
				],
		);
		const line = pts
			.map(
				([x, y], i) =>
					`${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`,
			)
			.join(" ");
		const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${
			h - pad
		} L${pts[0][0].toFixed(1)} ${h - pad} Z`;
		return { w, h, line, area };
	}

	// AccountBadges helper — names tooltip text.
	function badgeNames(accountIds: string[]): string {
		return accountIds
			.map((id) => acctById(id)?.name)
			.filter(Boolean)
			.join(", ");
	}
</script>

{#snippet accountBadges(
	accountIds: string[],
	max: number = 4,
	size: number = 24,
	title: string = "",
)}
	{@const shown = accountIds.slice(0, max)}
	{@const overflow = accountIds.length - shown.length}
	<span class="badges">
		{#each shown as id (id)}
			{@const a = acctById(id)}
			{#if a}
				<span
					class="badge"
					style="background: {a.color}; width: {size}px; height: {size}px"
					aria-label={a.name}
				>
					{a.initials}
				</span>
			{/if}
		{/each}
		{#if overflow > 0}
			<span
				class="badge badgeOverflow"
				style="width: {size}px; height: {size}px"
			>
				+{overflow}
			</span>
		{/if}
		<span class="badgeTip">{title || badgeNames(accountIds)}</span>
	</span>
{/snippet}

{#snippet sparkline(data: number[], color: string, gradId: string)}
	{@const p = sparkPaths(data)}
	<svg
		class="spark"
		viewBox="0 0 {p.w} {p.h}"
		preserveAspectRatio="none"
		aria-hidden="true"
	>
		<defs>
			<linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
				<stop offset="0%" stop-color={color} stop-opacity="0.35" />
				<stop offset="100%" stop-color={color} stop-opacity="0" />
			</linearGradient>
		</defs>
		<path d={p.area} fill="url(#{gradId})" />
		<path
			d={p.line}
			fill="none"
			stroke={color}
			stroke-width="1.6"
			stroke-linejoin="round"
			stroke-linecap="round"
		/>
	</svg>
{/snippet}

{#snippet scopePill(s: string)}
	{@const acc = scopeAccount(s)}
	<span class="scopePill">
		<span class="acctDot" style="background: {acc.color}"></span>
		{acc.name}
	</span>
{/snippet}

<div class="root">
	<header class="topbar">
		<div class="topbarMain">
			<span class="dotBrand"></span>
			<div>
				<div class="brandText">
					Tok<span class="brandTextAccent">Scrape</span>
				</div>
				<h1 class="title">Dashboard</h1>
			</div>
		</div>
		<div class="actions">
			<button
				type="button"
				class="btn btnIcon"
				title="Refresh"
				aria-label="Refresh"
			>
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<path d="M21 12a9 9 0 1 1-2.64-6.36" />
					<path d="M21 3v6h-6" />
				</svg>
			</button>
			<button
				type="button"
				class="btn btnIcon"
				title="Settings"
				aria-label="Settings"
			>
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<circle cx="12" cy="12" r="3" />
					<path
						d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"
					/>
				</svg>
			</button>
			<button
				type="button"
				class="btn btnIcon"
				title="Profile"
				aria-label="Profile"
			>
				<span class="avatar">DN</span>
			</button>
		</div>
	</header>

	<main class="page">
		<div class="acctBar">
			<div class="acctSelect" class:open={selectorOpen} bind:this={selectorEl}>
				<button
					type="button"
					class="acctTrigger"
					onclick={() => (selectorOpen = !selectorOpen)}
				>
					<span class="acctDot" style="background: {current.color}"></span>
					<span class="acctTriggerLabel">
						<span class="acctTriggerK">Viewing</span>
						<span class="acctTriggerV">
							{current.name}
							{#if scope === "__all"}
								<span
									style="color: var(--muted-foreground); font-weight: 500; font-size: 12px"
								>
									· {ACCOUNTS.length} accounts
								</span>
							{/if}
						</span>
					</span>
					<span class="acctCaret">▾</span>
				</button>
				{#if selectorOpen}
					<div
						class="acctPanel"
						onclick={(e) => e.stopPropagation()}
						onkeydown={(e) => {
							if (e.key === "Escape") selectorOpen = false;
						}}
						role="listbox"
						tabindex="-1"
					>
						<h4>Aggregate</h4>
						<button
							type="button"
							class="acctRow"
							class:acctRowActive={scope === "__all"}
							onclick={() => {
								scope = "__all";
								selectorOpen = false;
							}}
						>
							<span
								class="acctDot"
								style="background: {ALL_ACCOUNT.color}"
							></span>
							<span class="acctRowName">All Accounts</span>
							<span class="acctRowHandle">
								{ACCOUNTS.length} creators
							</span>
							<span class="acctCheck">
								{scope === "__all" ? "✓" : ""}
							</span>
						</button>
						<h4>Accounts</h4>
						{#each ACCOUNTS as a (a.id)}
							<button
								type="button"
								class="acctRow"
								class:acctRowActive={scope === a.id}
								onclick={() => {
									scope = a.id;
									selectorOpen = false;
								}}
							>
								<span class="acctDot" style="background: {a.color}"></span>
								<span class="acctRowName">{a.name}</span>
								<span class="acctRowHandle">{a.handle}</span>
								<span class="acctCheck">
									{scope === a.id ? "✓" : ""}
								</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
			<div class="seg">
				{#each periods as p (p)}
					<button
						type="button"
						class:segActive={p === period}
						onclick={() => (period = p)}
					>
						{periodLabels[p]}
					</button>
				{/each}
			</div>
		</div>

		<div class="streak">
			<div class="streakCard">
				<div class="streakNum">{STREAK.days}</div>
				<div class="streakMeta">
					<span class="streakMetaK">Daily posting streak</span>
					<span class="streakMetaV">
						{STREAK.days} days · best {STREAK.bestDays}
					</span>
				</div>
				<span class="streakFlame" role="img" aria-label="streak">
					🔥
				</span>
			</div>
			<div class="trendCard" title="Videos posted this month vs last month">
				<span class="trendNum">{MONTH_COMPARE.thisMonth}</span>
				<span class="trendArrow" class:trendArrowDown={!up}>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						{#if up}
							<path d="M6 15l6-6 6 6" />
						{:else}
							<path d="M6 9l6 6 6-6" />
						{/if}
					</svg>
				</span>
				<span class="trendNum" style="opacity: 0.5">
					{MONTH_COMPARE.prevMonth}
				</span>
				<span class="trendLabel">
					<strong>This month</strong>
					<br />
					vs last month
				</span>
			</div>
		</div>

		<div class="kpis">
			{#each tiles as t (t.key)}
				<div class="kpi">
					<div class="kpiLabel">
						<span class="kpiLabelIcon">{t.icon}</span>
						{t.label}
					</div>
					<div class="kpiVal">{t.val}</div>
					<div class="kpiDelta">
						<span class="delta" class:deltaUp={t.delta >= 0} class:deltaDown={t.delta < 0}>
							{pct(t.delta)}
						</span>{" "}
						vs prev period
					</div>
					<div class="kpiSpark">
						{@render sparkline(t.spark, scopeColor, `spark-${t.key}`)}
					</div>
				</div>
			{/each}
		</div>

		<div class="powerDeal">
			{@render accountBadges(POWER_DEAL.accounts, 4, 30)}
			<div>
				<div class="powerDealK">Today's Power Deal</div>
				<div class="powerDealTitle">{POWER_DEAL.title}</div>
				<div class="powerDealSub">{POWER_DEAL.sub}</div>
			</div>
			<div class="powerDealBadge">View →</div>
		</div>

		<section class="section">
			<div class="sectionHead">
				<h2 class="sectionTitle">
					Products <span class="pill">by brand</span>
				</h2>
				<div class="sectionActions">
					{@render scopePill(scope)}
				</div>
			</div>
			<div style="overflow-x: auto">
				<table class="tbl">
					<thead>
						<tr>
							<th style="width: 32px">#</th>
							<th>Brand</th>
							<th style="width: 120px">Accounts</th>
							<th class="num">GMV</th>
							<th class="num"># Units</th>
							<th class="num">Commission</th>
							<th class="num" style="width: 70px">
								Trend
							</th>
						</tr>
					</thead>
					<tbody>
						{#each products as p, i (p.id)}
							<tr>
								<td>
									<span class="rank" class:gold={i < 3}>
										{i + 1}
									</span>
								</td>
								<td>
									<div class="brand">{p.brand}</div>
									<div class="sub">{p.category}</div>
								</td>
								<td>
									{@render accountBadges(p.accounts)}
								</td>
								<td class="num money">
									{fmtMoneyFull(p.gmv)}
								</td>
								<td class="num">{p.units}</td>
								<td class="num money">
									{fmtMoneyFull(p.commission)}
								</td>
								<td class="num">
									<span
										class:deltaUp={p.trend >= 0}
										class:deltaDown={p.trend < 0}
										style="font-weight: 700"
									>
										{pct(p.trend)}
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<section class="section">
			<div class="sectionHead">
				<h2 class="sectionTitle">
					Videos <span class="pill">top performing</span>
				</h2>
				<div class="sectionActions">
					<button type="button" class="btn" style="font-size: 12px">
						View all →
					</button>
				</div>
			</div>
			<div class="videos">
				{#each videos as v (v.id)}
					<article class="video">
						<div class="videoThumb">
							<div class="videoThumbStripes"></div>
							<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
								<path d="M8 5v14l11-7z" />
							</svg>
							<div class="videoBadges">
								{@render accountBadges(v.accounts, 3, 20)}
							</div>
						</div>
						<div class="videoBody">
							<div class="videoBrand">
								{v.brand}
								{#if v.hot}
									<span class="videoHot">🔥 HOT</span>
								{/if}
							</div>
							<div class="videoCaption">{v.caption}</div>
							<div class="videoStats">
								<div>
									<div class="videoStatK">GMV</div>
									<div class="videoStatV">{fmtMoney(v.gmv)}</div>
								</div>
								<div>
									<div class="videoStatK">Views</div>
									<div class="videoStatV">{fmtInt(v.views)}</div>
								</div>
								<div>
									<div class="videoStatK">Com.</div>
									<div class="videoStatV">
										{fmtMoney(v.commission)}
									</div>
								</div>
							</div>
						</div>
					</article>
				{/each}
			</div>
		</section>

		<section class="section">
			<div class="sectionHead">
				<h2 class="sectionTitle">
					Accounts <span class="pill">legend</span>
				</h2>
			</div>
			<div class="legend">
				{#each ACCOUNTS as a (a.id)}
					<span class="acctChip">
						<span class="acctDot" style="background: {a.color}"></span>
						{a.name}
					</span>
				{/each}
			</div>
		</section>

		<section class="section">
			<div class="sectionHead">
				<h2 class="sectionTitle">
					Svelte Island{" "}
					<span class="pill">react + svelte side-by-side</span>
				</h2>
			</div>
			<Counter initial={5} label="Compiled by Svelte 5" />
		</section>
	</main>
</div>

<style>
	.root {
		color-scheme: dark;
		--background: #1a1916;
		--foreground: #f2f1ed;
		--card: #232220;
		--card-2: #2b2a27;
		--card-3: #33312e;
		--popover: #232220;
		--primary: #f54e00;
		--primary-foreground: #ffffff;
		--secondary: #24243a;
		--muted: #232220;
		--muted-foreground: rgba(242, 241, 237, 0.6);
		--subtle: rgba(242, 241, 237, 0.42);
		--accent: #aeadad;
		--success: #39a561;
		--warning: #fbbf24;
		--destructive: #ef4444;
		--border: rgba(242, 241, 237, 0.1);
		--border-2: rgba(242, 241, 237, 0.16);
		--ring: #e8650a;
		--radius: 14px;
		--shadow-flat: 0 1px 2px rgb(0 0 0 / 0.35), 0 0 0 1px rgb(242 241 237 / 0.08);
		--shadow-elevated: 0 6px 14px rgb(0 0 0 / 0.48),
			0 0 0 1px rgb(242 241 237 / 0.09), inset 0 1px 0 rgb(255 255 255 / 0.04);
		--shadow-overlay: 0 22px 48px rgb(0 0 0 / 0.52),
			0 0 0 1px rgb(242 241 237 / 0.1);
		--shadow-brand-glow: 0 8px 26px rgb(245 78 0 / 0.26),
			0 0 0 1px rgb(245 78 0 / 0.34), inset 0 1px 0 rgb(255 255 255 / 0.04);
		--font-sans: "Avenir Next", "SF Pro Text", "Segoe UI", system-ui, sans-serif;
		--font-serif: "Iowan Old Style", "Georgia", serif;
		--font-mono: "SF Mono", "JetBrains Mono", ui-monospace, monospace;

		position: relative;
		background: var(--background);
		color: var(--foreground);
		font-family: var(--font-sans);
		-webkit-font-smoothing: antialiased;
		text-rendering: optimizeLegibility;
		min-height: 100vh;
		margin: -1rem -1rem -6rem -1rem;
		padding-bottom: 1px;
	}

	.root::before {
		content: "";
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 0;
		background:
			radial-gradient(circle at top left, rgb(245 78 0 / 0.14), transparent 32%),
			radial-gradient(circle at top right, rgb(36 36 58 / 0.28), transparent 30%),
			linear-gradient(180deg, #211f1a 0%, #1a1916 38%, #151410 100%);
	}

	.root::after {
		content: "";
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 0;
		background: linear-gradient(
			180deg,
			rgb(242 241 237 / 0.02),
			transparent 24%,
			rgb(245 78 0 / 0.025) 100%
		);
	}

	.root button {
		font: inherit;
		color: inherit;
	}

	.root * {
		box-sizing: border-box;
	}

	/* ---------- Topbar ---------- */
	.topbar {
		position: sticky;
		top: 0;
		z-index: 30;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
		background: rgb(26 25 22 / 0.86);
		backdrop-filter: blur(18px);
	}

	.topbarMain {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.dotBrand {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--primary);
		box-shadow: var(--shadow-brand-glow);
	}

	.brandText {
		font-family: var(--font-serif);
		font-size: 11px;
		line-height: 1;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--muted-foreground);
	}

	.brandTextAccent {
		color: var(--primary);
	}

	.title {
		margin: 2px 0 0;
		font-size: 18px;
		line-height: 1.2;
		font-weight: 600;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 36px;
		min-width: 36px;
		padding: 8px 14px;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 10px;
		color: var(--foreground);
		cursor: pointer;
		transition:
			background-color 0.2s ease,
			border-color 0.2s ease,
			transform 0.15s ease;
	}

	.btn:hover {
		background: var(--secondary);
		border-color: var(--border-2);
	}

	.btn:active {
		transform: translateY(1px);
	}

	.btnIcon {
		width: 36px;
		height: 36px;
		padding: 0;
		border-radius: 999px;
	}

	.btnIcon svg {
		width: 20px;
		height: 20px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.avatar {
		width: 32px;
		height: 32px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		background: var(--secondary);
		color: var(--foreground);
		font-weight: 700;
		font-size: 11px;
		letter-spacing: 0.02em;
		box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.05);
	}

	/* ---------- Main layout ---------- */
	.page {
		position: relative;
		z-index: 1;
		max-width: 1160px;
		margin: 0 auto;
		padding: 20px 20px 60px;
		display: grid;
		gap: 16px;
	}

	@media (min-width: 720px) {
		.page {
			padding: 28px 28px 60px;
			gap: 20px;
		}
	}

	/* ---------- Account selector ---------- */
	.acctBar {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	@media (min-width: 720px) {
		.acctBar {
			flex-direction: row;
			align-items: center;
			justify-content: space-between;
		}
	}

	.acctSelect {
		position: relative;
	}

	.acctTrigger {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		background: var(--card);
		border: 1px solid var(--border-2);
		border-radius: 12px;
		cursor: pointer;
		box-shadow: var(--shadow-flat);
		transition:
			border-color 0.2s ease,
			background-color 0.2s ease;
	}

	.acctTrigger:hover {
		border-color: rgb(245 78 0 / 0.4);
	}

	.acctTriggerLabel {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		min-width: 0;
	}

	.acctTriggerK {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: var(--muted-foreground);
	}

	.acctTriggerV {
		font-weight: 700;
		font-size: 15px;
		margin-top: 2px;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.acctCaret {
		color: var(--muted-foreground);
		transition: transform 0.2s ease;
	}

	.open .acctCaret {
		transform: rotate(180deg);
	}

	.acctPanel {
		position: absolute;
		z-index: 40;
		top: calc(100% + 8px);
		left: 0;
		min-width: 320px;
		background: var(--popover);
		border: 1px solid var(--border-2);
		border-radius: 14px;
		padding: 8px;
		box-shadow: var(--shadow-overlay);
	}

	.acctPanel h4 {
		margin: 6px 8px;
		font-family: var(--font-serif);
		font-size: 12px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--muted-foreground);
		font-weight: 600;
	}

	.acctRow {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 10px 10px;
		border: 0;
		background: transparent;
		border-radius: 10px;
		color: var(--foreground);
		cursor: pointer;
		text-align: left;
		font-size: 14px;
	}

	.acctRow:hover {
		background: rgb(242 241 237 / 0.04);
	}

	.acctRowActive {
		background: rgb(245 78 0 / 0.12);
	}

	.acctRowName {
		flex: 1;
		font-weight: 600;
	}

	.acctRowHandle {
		font-size: 12px;
		color: var(--muted-foreground);
		font-family: var(--font-mono);
	}

	.acctCheck {
		color: var(--primary);
		width: 16px;
		text-align: center;
	}

	.acctDot {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		flex: 0 0 auto;
		box-shadow:
			0 0 0 2px rgb(26 25 22),
			inset 0 1px 0 rgb(255 255 255 / 0.15);
	}

	.acctChip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 2px 8px 2px 4px;
		border-radius: 999px;
		background: rgb(255 255 255 / 0.04);
		border: 1px solid var(--border);
		font-size: 11px;
		font-weight: 600;
		color: var(--foreground);
	}

	.acctChip .acctDot {
		width: 10px;
		height: 10px;
		box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.2);
	}

	/* ---------- Streak card ---------- */
	.streak {
		display: grid;
		gap: 12px;
		grid-template-columns: 1fr;
	}

	@media (min-width: 720px) {
		.streak {
			grid-template-columns: auto 1fr auto;
			align-items: center;
			gap: 20px;
		}
	}

	.streakCard {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 14px 18px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 16px;
		box-shadow: var(--shadow-flat);
		position: relative;
		overflow: hidden;
	}

	.streakCard::before {
		content: "";
		position: absolute;
		inset: 0 0 auto 0;
		height: 1px;
		background: linear-gradient(
			90deg,
			transparent,
			rgb(245 78 0 / 0.3),
			transparent
		);
	}

	.streakNum {
		font-family: var(--font-serif);
		font-size: 44px;
		line-height: 1;
		font-weight: 700;
		color: var(--primary);
		min-width: 66px;
		text-align: center;
	}

	.streakMeta {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.streakMetaK {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: var(--muted-foreground);
	}

	.streakMetaV {
		font-size: 15px;
		font-weight: 600;
	}

	.streakFlame {
		font-size: 28px;
		margin-left: 4px;
	}

	.trendCard {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 12px 16px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 14px;
	}

	.trendNum {
		font-family: var(--font-serif);
		font-size: 28px;
		font-weight: 700;
		line-height: 1;
	}

	.trendArrow {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 8px;
		background: rgb(57 165 97 / 0.14);
		color: var(--success);
	}

	.trendArrowDown {
		background: rgb(239 68 68 / 0.14);
		color: var(--destructive);
	}

	.trendLabel {
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.trendLabel strong {
		color: var(--foreground);
		font-weight: 700;
	}

	/* ---------- KPI tiles ---------- */
	.kpis {
		display: grid;
		gap: 12px;
		grid-template-columns: repeat(3, 1fr);
	}

	@media (max-width: 539px) {
		.kpis {
			grid-template-columns: 1fr 1fr;
		}
		.kpis > :last-child {
			grid-column: 1 / -1;
		}
	}

	.kpi {
		position: relative;
		overflow: hidden;
		padding: 16px 18px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 16px;
		box-shadow: var(--shadow-flat);
	}

	.kpi::before {
		content: "";
		position: absolute;
		inset: 0 0 auto 0;
		height: 1px;
		background: linear-gradient(
			90deg,
			transparent,
			rgb(245 78 0 / 0.26),
			transparent
		);
	}

	.kpiLabel {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-serif);
		font-size: 13px;
		font-weight: 700;
		letter-spacing: 0.02em;
		color: var(--foreground);
	}

	.kpiLabelIcon {
		width: 22px;
		height: 22px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		background: rgb(245 78 0 / 0.14);
		color: var(--primary);
		font-size: 13px;
	}

	.kpiVal {
		margin-top: 10px;
		font-family: var(--font-serif);
		font-size: 34px;
		font-weight: 700;
		line-height: 1;
		letter-spacing: -0.02em;
	}

	.kpiDelta {
		margin-top: 8px;
		font-size: 12px;
		color: var(--muted-foreground);
	}

	.kpiSpark {
		margin-top: 10px;
		height: 34px;
		width: 100%;
	}

	/* ---------- Section headers ---------- */
	.section {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 18px;
		box-shadow: var(--shadow-flat);
		overflow: hidden;
		position: relative;
		z-index: 1;
	}

	.sectionHead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 18px 8px;
		gap: 12px;
	}

	.sectionTitle {
		margin: 0;
		font-family: var(--font-serif);
		font-size: 18px;
		font-weight: 700;
		letter-spacing: -0.01em;
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.pill {
		font-family: var(--font-sans);
		font-size: 10px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		padding: 2px 8px;
		border-radius: 999px;
		background: rgb(245 78 0 / 0.12);
		color: var(--primary);
		font-weight: 700;
	}

	.sectionActions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.scopePill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px 4px 6px;
		border-radius: 999px;
		background: rgb(255 255 255 / 0.04);
		border: 1px solid var(--border);
		font-size: 11px;
		color: var(--muted-foreground);
		font-weight: 600;
	}

	.scopePill .acctDot {
		width: 10px;
		height: 10px;
	}

	/* ---------- Products table ---------- */
	.tbl {
		width: 100%;
		border-collapse: collapse;
	}

	.tbl th {
		text-align: left;
		padding: 10px 18px;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: var(--muted-foreground);
		font-weight: 600;
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
		background: rgb(0 0 0 / 0.18);
		white-space: nowrap;
	}

	.tbl td {
		padding: 14px 18px;
		border-bottom: 1px solid var(--border);
		font-size: 14px;
		vertical-align: middle;
	}

	.tbl tr:last-child td {
		border-bottom: 0;
	}

	.tbl tbody tr {
		transition: background-color 0.15s ease;
	}

	.tbl tbody tr:hover {
		background: rgb(242 241 237 / 0.03);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.num.money {
		font-weight: 700;
	}

	.brand {
		font-weight: 700;
		font-family: var(--font-serif);
		font-size: 15px;
	}

	.sub {
		color: var(--muted-foreground);
		font-size: 12px;
		margin-top: 2px;
	}

	.rank {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 6px;
		background: rgb(255 255 255 / 0.04);
		border: 1px solid var(--border);
		font-size: 11px;
		font-weight: 700;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
	}

	.rank.gold {
		background: rgb(245 78 0 / 0.14);
		color: var(--primary);
		border-color: rgb(245 78 0 / 0.35);
	}

	/* ---------- Account badges (the signature feature) ---------- */
	.badges {
		display: inline-flex;
		align-items: center;
		position: relative;
	}

	.badges .badge {
		width: 24px;
		height: 24px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		font-size: 9px;
		font-weight: 800;
		letter-spacing: 0.02em;
		color: #fff;
		border: 2px solid var(--card);
		box-shadow: 0 2px 6px rgb(0 0 0 / 0.45);
		position: relative;
		text-transform: uppercase;
	}

	.badges .badge + .badge {
		margin-left: -8px;
	}

	.badgeOverflow {
		background: var(--card-3) !important;
		color: var(--foreground) !important;
		border: 2px solid var(--card);
	}

	.badgeTip {
		position: absolute;
		bottom: calc(100% + 6px);
		left: 50%;
		transform: translateX(-50%);
		padding: 6px 10px;
		white-space: nowrap;
		background: rgb(26 25 22 / 0.98);
		color: var(--foreground);
		border: 1px solid var(--border-2);
		border-radius: 8px;
		font-size: 11px;
		font-weight: 600;
		font-family: var(--font-sans);
		box-shadow: var(--shadow-overlay);
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.15s ease;
		z-index: 50;
	}

	.badges:hover .badgeTip {
		opacity: 1;
	}

	/* ---------- Videos grid ---------- */
	.videos {
		padding: 14px 18px 18px;
		display: grid;
		gap: 14px;
		grid-template-columns: 1fr;
	}

	@media (min-width: 600px) {
		.videos {
			grid-template-columns: 1fr 1fr;
		}
	}

	@media (min-width: 960px) {
		.videos {
			grid-template-columns: 1fr 1fr 1fr;
		}
	}

	.video {
		display: grid;
		grid-template-columns: 92px 1fr;
		gap: 14px;
		padding: 12px;
		background: var(--card-2);
		border: 1px solid var(--border);
		border-radius: 14px;
		cursor: pointer;
		transition:
			transform 0.2s ease,
			border-color 0.2s ease,
			background-color 0.2s ease;
	}

	.video:hover {
		border-color: var(--border-2);
		background: var(--card-3);
		transform: translateY(-1px);
	}

	.videoThumb {
		position: relative;
		aspect-ratio: 9 / 16;
		border-radius: 10px;
		overflow: hidden;
		background: linear-gradient(135deg, #2b2a27 0%, #1a1916 100%);
		border: 1px solid var(--border);
		display: flex;
		align-items: center;
		justify-content: center;
		color: rgb(255 255 255 / 0.25);
	}

	.videoThumb svg {
		width: 28px;
		height: 28px;
	}

	.videoThumbStripes {
		position: absolute;
		inset: 0;
		background-image: repeating-linear-gradient(
			45deg,
			rgb(255 255 255 / 0.025) 0 8px,
			transparent 8px 16px
		);
	}

	.videoBadges {
		position: absolute;
		top: 6px;
		left: 6px;
	}

	.videoBody {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.videoBrand {
		font-family: var(--font-serif);
		font-weight: 700;
		font-size: 14px;
	}

	.videoHot {
		margin-left: 8px;
		color: var(--primary);
		font-family: var(--font-sans);
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.12em;
	}

	.videoCaption {
		font-size: 13px;
		line-height: 1.35;
		color: var(--foreground);
		text-wrap: pretty;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.videoStats {
		margin-top: auto;
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 4px;
		padding-top: 8px;
		border-top: 1px dashed var(--border);
	}

	.videoStatK {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--muted-foreground);
	}

	.videoStatV {
		font-size: 13px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	/* ---------- Today's power deal ---------- */
	.powerDeal {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 14px 18px;
		background: linear-gradient(
			135deg,
			rgb(245 78 0 / 0.14),
			rgb(245 78 0 / 0.02)
		);
		border: 1px solid rgb(245 78 0 / 0.35);
		border-radius: 16px;
		position: relative;
		overflow: hidden;
	}

	.powerDeal::after {
		content: "";
		position: absolute;
		right: -30px;
		top: -40px;
		width: 180px;
		height: 180px;
		border-radius: 50%;
		background: radial-gradient(
			circle,
			rgb(245 78 0 / 0.25),
			transparent 60%
		);
		pointer-events: none;
	}

	.powerDealK {
		font-size: 10px;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--primary);
		font-weight: 800;
	}

	.powerDealTitle {
		font-family: var(--font-serif);
		font-weight: 700;
		font-size: 20px;
		line-height: 1.1;
	}

	.powerDealSub {
		font-size: 12px;
		color: var(--muted-foreground);
		margin-top: 2px;
	}

	.powerDealBadge {
		margin-left: auto;
		position: relative;
		z-index: 1;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		background: var(--primary);
		color: var(--primary-foreground);
		border-radius: 10px;
		font-weight: 700;
		font-size: 13px;
		box-shadow: var(--shadow-brand-glow);
	}

	/* ---------- Period toggle ---------- */
	.seg {
		display: inline-flex;
		padding: 3px;
		background: rgb(0 0 0 / 0.3);
		border: 1px solid var(--border);
		border-radius: 10px;
	}

	.seg button {
		padding: 6px 12px;
		border: 0;
		background: transparent;
		color: var(--muted-foreground);
		font-size: 12px;
		font-weight: 600;
		border-radius: 7px;
		cursor: pointer;
		transition:
			background-color 0.15s ease,
			color 0.15s ease;
	}

	.seg button.segActive {
		background: var(--card-3);
		color: var(--foreground);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
	}

	/* ---------- Utility ---------- */
	.spark {
		width: 100%;
		height: 100%;
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 10px 18px 16px;
	}

	.delta {
		font-weight: 700;
	}

	.deltaUp {
		color: var(--success);
	}

	.deltaDown {
		color: var(--destructive);
	}
</style>
