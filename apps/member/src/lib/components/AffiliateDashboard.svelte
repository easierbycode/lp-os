<!--
	Port of apps/web/modules/saas/affiliate/components/affiliate-dashboard-simple.tsx
	— Svelte 5 island (enrolled state).

	Stubbed/deferred vs. the source:
	- No orpc/Rewardful sync: the mount-time `refreshStats()` call and the
	  `refreshLink()` retry path are gone (our stub link is always present).
	- The "Open Dashboard on Rewardful" CTA is a deferred no-op (commented).
	- `sonner` toast on copy is replaced by a transient inline "Copied!" state
	  via navigator.clipboard.
	- The tilt/in-view hooks are dropped in favour of a plain CSS fade-in.
-->
<script lang="ts">
	interface AffiliateStats {
		primaryLinkUrl: string | null;
		visitors: number;
		conversions: number;
		commissionsEarned: number;
		commissionsPending: number;
		commissionsPaid: number;
		lastSyncAt: string | null;
	}

	let { stats }: { stats: AffiliateStats } = $props();

	const linkUrl = $derived(stats.primaryLinkUrl);

	function extractToken(url: string | null): string | null {
		if (!url) return null;
		try {
			return new URL(url).searchParams.get("via");
		} catch {
			return null;
		}
	}

	const affiliateToken = $derived(extractToken(linkUrl));

	function formatCurrency(dollars: number): string {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: "USD",
			minimumFractionDigits: 2,
		}).format(dollars);
	}

	function formatNumber(n: number): string {
		return new Intl.NumberFormat("en-US").format(n);
	}

	function formatTimeAgo(isoString: string | null): string {
		if (!isoString) return "Never synced";
		const diffMs = Date.now() - new Date(isoString).getTime();
		const minutes = Math.floor(diffMs / 60_000);
		if (minutes < 1) return "Just now";
		if (minutes < 60) {
			return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
		}
		const hours = Math.floor(minutes / 60);
		if (hours < 24) {
			return `${hours} hour${hours === 1 ? "" : "s"} ago`;
		}
		const days = Math.floor(hours / 24);
		return `${days} day${days === 1 ? "" : "s"} ago`;
	}

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	function handleCopy() {
		if (!linkUrl) return;
		navigator.clipboard?.writeText(linkUrl);
		copied = true;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied = false), 2000);
	}

	function handleOpenDashboard() {
		// Deferred: the source calls orpcClient.users.affiliate.getDashboardLink()
		// and opens the Rewardful dashboard in a new tab. No backend here, so this
		// is intentionally a no-op until the Rewardful integration is ported.
	}
</script>

<div class="root">
	<div class="dashboard">
		<!-- Affiliate link card -->
		<div class="card fade-in">
			<div class="card-header">
				<div class="enrolled-row">
					{@render checkCircle()}
					<span class="badge badge-success">Enrolled as Affiliate</span>
				</div>
				<h3 class="card-title link-title">Your Affiliate Link</h3>
			</div>
			<div class="card-content">
				<div class="link-row">
					<input
						class="input mono"
						value={linkUrl}
						readonly
						aria-label="Your affiliate link"
					/>
					<button
						type="button"
						class="btn btn-icon"
						onclick={handleCopy}
						aria-label="Copy affiliate link"
					>
						{#if copied}
							{@render checkSmall()}
						{:else}
							{@render copyIcon()}
						{/if}
					</button>
				</div>
				{#if copied}
					<p class="copied-note">Copied!</p>
				{/if}
				<p class="muted-text">
					Share this link to earn commissions on referrals.
				</p>

				{#if affiliateToken}
					<div class="token-box">
						<div class="token-line">
							<span class="token-label">Your referral token</span>
							<code class="token-code">?via={affiliateToken}</code>
						</div>
						<p class="token-hint">
							You can also link to any page on our site by adding
							<code class="token-inline">?via={affiliateToken}</code>
							to the end of the URL.
						</p>
					</div>
				{/if}
			</div>
		</div>

		<!-- Stats cards -->
		<div class="stats-grid">
			<!-- Clicks -->
			<div class="card stat-card fade-in" style="animation-delay:0ms">
				<div class="card-content stat-content">
					<div class="stat-top">
						<div class="stat-text">
							<p class="stat-label">Clicks</p>
							<p class="stat-value">{formatNumber(stats.visitors)}</p>
							<p class="stat-sub">Primary link</p>
						</div>
						<div class="stat-icon icon-blue">
							{@render mousePointer()}
						</div>
					</div>
				</div>
			</div>

			<!-- Customers -->
			<div class="card stat-card fade-in" style="animation-delay:100ms">
				<div class="card-content stat-content">
					<div class="stat-top">
						<div class="stat-text">
							<p class="stat-label">Customers</p>
							<p class="stat-value">
								{formatNumber(stats.conversions)}
							</p>
							<p class="stat-sub">Referred conversions</p>
						</div>
						<div class="stat-icon icon-primary">
							{@render users()}
						</div>
					</div>
				</div>
			</div>

			<!-- Commissions -->
			<div class="card stat-card fade-in" style="animation-delay:200ms">
				<div class="card-content stat-content">
					<div class="stat-top">
						<div class="stat-text">
							<p class="stat-label">Commissions</p>
							<p class="stat-value stat-value-success">
								{formatCurrency(stats.commissionsEarned)}
							</p>
							<p class="stat-sub">Earned</p>
						</div>
						<div class="stat-icon icon-success">
							{@render dollar()}
						</div>
					</div>
					<div class="separator"></div>
					<div class="breakdown">
						<div class="breakdown-row">
							<span class="muted-text">Paid out</span>
							<span class="breakdown-value">
								{formatCurrency(stats.commissionsPaid)}
							</span>
						</div>
						<div class="breakdown-row">
							<span class="muted-text">Pending</span>
							<span class="breakdown-value">
								{formatCurrency(stats.commissionsPending)}
							</span>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Last synced timestamp -->
		<div class="synced-row">
			<span>Stats updated {formatTimeAgo(stats.lastSyncAt)}</span>
		</div>

		<!-- Full analytics CTA -->
		<div class="card fade-in">
			<div class="card-header">
				<h3 class="card-title">Full Analytics</h3>
			</div>
			<div class="card-content">
				<p class="muted-text">
					For a full breakdown of your commissions, payout history, and
					detailed referral analytics, open your Rewardful dashboard.
				</p>
				<button
					type="button"
					class="btn btn-primary btn-lg btn-block"
					onclick={handleOpenDashboard}
				>
					{@render externalLink()}
					<span>Open Dashboard on Rewardful</span>
				</button>
			</div>
		</div>
	</div>
</div>

{#snippet checkCircle()}
	<svg
		class="icon-check"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<circle cx="12" cy="12" r="10" />
		<path d="m9 12 2 2 4-4" />
	</svg>
{/snippet}

{#snippet checkSmall()}
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M20 6 9 17l-5-5" />
	</svg>
{/snippet}

{#snippet copyIcon()}
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
		<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
	</svg>
{/snippet}

{#snippet mousePointer()}
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path
			d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"
		/>
	</svg>
{/snippet}

{#snippet users()}
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
		<path d="M16 3.128a4 4 0 0 1 0 7.744" />
		<path d="M22 21v-2a4 4 0 0 0-3-3.87" />
		<circle cx="9" cy="7" r="4" />
	</svg>
{/snippet}

{#snippet dollar()}
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<circle cx="12" cy="12" r="10" />
		<path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
		<path d="M12 18V6" />
	</svg>
{/snippet}

{#snippet externalLink()}
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M15 3h6v6" />
		<path d="M10 14 21 3" />
		<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
	</svg>
{/snippet}

<style>
	.root {
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
		--font-serif: "Iowan Old Style", "Georgia", serif;
		color: var(--foreground);
		font-family: inherit;
	}

	*,
	*::before,
	*::after {
		box-sizing: border-box;
	}

	.dashboard {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	/* Card primitives */
	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.card-header {
		padding: 1.5rem 1.5rem 0;
		display: flex;
		flex-direction: column;
	}
	.card-content {
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.card-title {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 600;
		line-height: 1.4;
	}
	.link-title {
		margin-top: 0.5rem;
	}

	/* Enrolled badge row */
	.enrolled-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.icon-check {
		width: 1.25rem;
		height: 1.25rem;
		color: #22c55e;
		flex-shrink: 0;
	}
	.badge {
		display: inline-flex;
		align-items: center;
		border-radius: 9999px;
		padding: 0.125rem 0.625rem;
		font-size: 0.75rem;
		font-weight: 600;
		line-height: 1.4;
	}
	.badge-success {
		background: rgba(57, 165, 97, 0.15);
		color: var(--success);
		border: 1px solid rgba(57, 165, 97, 0.3);
	}

	/* Link row */
	.link-row {
		display: flex;
		gap: 0.5rem;
	}
	.input {
		min-width: 0;
		flex: 1;
		height: 2.5rem;
		padding: 0 0.75rem;
		background: var(--background);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--foreground);
		font-size: 0.875rem;
		outline: none;
	}
	.input:focus-visible {
		border-color: var(--ring);
		box-shadow: 0 0 0 2px rgba(232, 101, 10, 0.3);
	}
	.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		border: 1px solid transparent;
		border-radius: 8px;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition:
			background 0.15s ease,
			opacity 0.15s ease;
		white-space: nowrap;
	}
	.btn svg {
		width: 1rem;
		height: 1rem;
		flex-shrink: 0;
	}
	.btn-icon {
		width: 2.5rem;
		height: 2.5rem;
		flex-shrink: 0;
		padding: 0;
		background: var(--primary);
		color: var(--primary-foreground);
	}
	.btn-icon:hover {
		background: #d94600;
	}
	.btn-primary {
		background: var(--primary);
		color: var(--primary-foreground);
	}
	.btn-primary:hover {
		background: #d94600;
	}
	.btn-lg {
		height: 2.75rem;
		padding: 0 1.5rem;
		font-size: 0.9375rem;
	}
	.btn-block {
		width: 100%;
	}

	.copied-note {
		margin: -0.5rem 0 0;
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--success);
	}

	.muted-text {
		margin: 0;
		font-size: 0.875rem;
		color: var(--muted-foreground);
	}

	/* Referral token helper box */
	.token-box {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		border-radius: 8px;
		background: rgba(242, 241, 237, 0.04);
		padding: 0.75rem 1rem;
	}
	.token-line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.token-label {
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}
	.token-code {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.75rem;
		font-weight: 600;
		background: rgba(242, 241, 237, 0.08);
		border-radius: 4px;
		padding: 0.125rem 0.375rem;
	}
	.token-hint {
		margin: 0;
		font-size: 0.75rem;
		color: var(--muted-foreground);
		line-height: 1.5;
	}
	.token-inline {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}

	/* Stats grid */
	.stats-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1rem;
	}
	@media (min-width: 768px) {
		.stats-grid {
			grid-template-columns: repeat(3, 1fr);
		}
	}
	.stat-content {
		gap: 0;
		padding-top: 1.5rem;
	}
	.stat-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.stat-text {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.stat-label {
		margin: 0;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--muted-foreground);
	}
	.stat-value {
		margin: 0;
		font-size: 1.875rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1.1;
	}
	.stat-value-success {
		font-size: 1.5rem;
		color: var(--success);
	}
	.stat-sub {
		margin: 0;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}
	.stat-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		flex-shrink: 0;
		border-radius: 0.5rem;
	}
	.stat-icon svg {
		width: 1.25rem;
		height: 1.25rem;
	}
	.icon-blue {
		background: rgba(59, 130, 246, 0.1);
		color: #3b82f6;
	}
	.icon-primary {
		background: rgba(245, 78, 0, 0.1);
		color: var(--primary);
	}
	.icon-success {
		background: rgba(57, 165, 97, 0.1);
		color: var(--success);
	}

	.separator {
		height: 1px;
		background: var(--border);
		margin: 1rem 0;
	}
	.breakdown {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		font-size: 0.875rem;
	}
	.breakdown-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.breakdown-value {
		font-weight: 500;
	}

	/* Last synced */
	.synced-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}

	/* Fade-in animation (replaces tilt/in-view hooks) */
	.fade-in {
		opacity: 0;
		transform: translateY(1rem);
		animation: fade-in-up 0.5s ease forwards;
	}
	@keyframes fade-in-up {
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.fade-in {
			opacity: 1;
			transform: none;
			animation: none;
		}
	}
</style>
