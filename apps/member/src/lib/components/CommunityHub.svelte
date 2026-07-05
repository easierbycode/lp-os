<!--
	Port of apps/web/modules/saas/community/components/community-hub.tsx
	(+ platforms-tab, announcements-tab, announcement-card, announcement-dialog,
	discord-icon) — Svelte 5 island. All real UI lives here.

	Stubbed/deferred vs. the Next.js source:
	- Data (platforms + announcements + canConnectDiscord) comes in as props
	  from islands/community-data.ts instead of orpc/Prisma/Better-Auth.
	- The Discord "Connect" button is a deferred no-op (no OAuth/linkSocial);
	  see handleConnect below.
	- Read/unread state persists to localStorage (READ_KEY) instead of writing
	  server-side announcement view records.
	- PostHog analytics, the subscription-gate billing banner variant, and the
	  card tilt/in-view animation hooks are dropped.
-->
<script lang="ts">
	import type { Announcement, Platform } from "$lib/data/community-data";

	let {
		canConnectDiscord = true,
		platforms = [],
		announcements = [],
	}: {
		canConnectDiscord?: boolean;
		platforms?: Platform[];
		announcements?: Announcement[];
	} = $props();

	const READ_KEY = "community-read-announcements";
	const BANNER_KEY = "community-banner-dismissed";

	// Load persisted read state (set of announcement ids the user has read).
	function loadReadIds(): Set<string> {
		if (typeof localStorage === "undefined") return new Set();
		try {
			const stored = localStorage.getItem(READ_KEY);
			return new Set(stored ? (JSON.parse(stored) as string[]) : []);
		} catch {
			return new Set();
		}
	}

	function persistReadIds(ids: Set<string>) {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(READ_KEY, JSON.stringify([...ids]));
	}

	const readIds = $state(loadReadIds());

	// Merge the persisted read state over the seed data once on mount.
	// svelte-ignore state_referenced_locally
	let items = $state<Announcement[]>(
		announcements.map((a) => ({
			...a,
			read: a.read || readIds.has(a.id),
		})),
	);

	let activeTab = $state<"platforms" | "announcements">("platforms");
	let filter = $state<"all" | "unread">("all");
	let typeFilter = $state<string>("all");
	let typeMenuOpen = $state(false);
	let selected = $state<Announcement | null>(null);

	// Banner: re-show 7 days after dismissal (mirrors the source heuristic).
	function initialBannerDismissed(): boolean {
		if (typeof localStorage === "undefined") return false;
		const dismissed = localStorage.getItem(BANNER_KEY);
		if (!dismissed) return false;
		const daysSince = (Date.now() - new Date(dismissed).getTime()) /
			(1000 * 60 * 60 * 24);
		return daysSince < 7;
	}
	let bannerDismissed = $state(initialBannerDismissed());

	const unreadCount = $derived(items.filter((a) => !a.read).length);
	const discordPlatform = $derived(
		platforms.find((p) => p.id === "discord"),
	);
	const discordConnected = $derived(discordPlatform?.connected ?? false);
	const disconnectedPlatforms = $derived(
		platforms.filter((p) => !p.connected),
	);
	const showConnectBanner = $derived(
		disconnectedPlatforms.length > 0 &&
			!bannerDismissed &&
			!discordConnected &&
			canConnectDiscord,
	);

	const availableTypes = $derived(
		Array.from(new Set(items.map((a) => a.type))),
	);
	const activeFilterCount = $derived(
		(filter === "unread" ? 1 : 0) + (typeFilter !== "all" ? 1 : 0),
	);
	const filtered = $derived(
		items
			.filter((a) => (filter === "unread" ? !a.read : true))
			.filter((a) => (typeFilter !== "all" ? a.type === typeFilter : true)),
	);

	function setRead(id: string, read: boolean) {
		if (read) readIds.add(id);
		else readIds.delete(id);
		persistReadIds(readIds);
		items = items.map((a) => (a.id === id ? { ...a, read } : a));
	}

	function toggleRead(id: string) {
		const a = items.find((x) => x.id === id);
		if (!a) return;
		setRead(id, !a.read);
	}

	function markAllRead() {
		for (const a of items) readIds.add(a.id);
		persistReadIds(readIds);
		items = items.map((a) => ({ ...a, read: true }));
	}

	function openAnnouncement(a: Announcement) {
		selected = a;
		if (!a.read) setRead(a.id, true);
	}

	function dismissBanner() {
		bannerDismissed = true;
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(BANNER_KEY, new Date().toISOString());
		}
	}

	// Deferred: the Next.js flow kicked off a Discord OAuth `linkSocial`
	// redirect. There is no auth backend here, so this is a harmless no-op.
	function handleConnect(platformId: string) {
		if (platformId !== "discord" || !canConnectDiscord) return;
		// backend deferred — would initiate Discord OAuth here.
	}

	const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

	function formatRelativeDate(iso: string): string {
		const then = new Date(iso).getTime();
		const diff = Date.now() - then;
		const mins = Math.round(diff / 60000);
		if (mins < 1) return "just now";
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.round(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.round(hrs / 24);
		if (days < 7) return `${days}d ago`;
		return new Date(iso).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
		});
	}

	function formatLongDate(iso: string): string {
		return new Date(iso).toLocaleDateString("en-US", {
			month: "long",
			day: "numeric",
			year: "numeric",
		});
	}
</script>

{#snippet bell()}
	<svg
		class="icon"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M10.268 21a2 2 0 0 0 3.464 0" />
		<path
			d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"
		/>
	</svg>
{/snippet}

{#snippet checkCheck()}
	<svg
		class="icon"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M18 6 7 17l-5-5" />
		<path d="m22 10-7.5 7.5L13 16" />
	</svg>
{/snippet}

{#snippet filterIcon()}
	<svg
		class="icon"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path
			d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"
		/>
	</svg>
{/snippet}

{#snippet alertCircle()}
	<svg
		class="icon"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<circle cx="12" cy="12" r="10" />
		<line x1="12" x2="12" y1="8" y2="12" />
		<line x1="12" x2="12.01" y1="16" y2="16" />
	</svg>
{/snippet}

{#snippet alertTriangle()}
	<svg
		class="icon"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path
			d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"
		/>
		<path d="M12 9v4" />
		<path d="M12 17h.01" />
	</svg>
{/snippet}

{#snippet info()}
	<svg
		class="icon"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<circle cx="12" cy="12" r="10" />
		<path d="M12 16v-4" />
		<path d="M12 8h.01" />
	</svg>
{/snippet}

{#snippet externalLink()}
	<svg
		class="icon"
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

{#snippet xIcon()}
	<svg
		class="icon"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M18 6 6 18" />
		<path d="m6 6 12 12" />
	</svg>
{/snippet}

{#snippet bellOff()}
	<svg
		class="icon"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M10.268 21a2 2 0 0 0 3.464 0" />
		<path
			d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742"
		/>
		<path d="m2 2 20 20" />
		<path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05" />
	</svg>
{/snippet}

{#snippet eye()}
	<svg
		class="icon"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path
			d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
		/>
		<circle cx="12" cy="12" r="3" />
	</svg>
{/snippet}

{#snippet eyeOff()}
	<svg
		class="icon"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path
			d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"
		/>
		<path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
		<path
			d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"
		/>
		<path d="m2 2 20 20" />
	</svg>
{/snippet}

{#snippet checkMark()}
	<svg
		class="icon"
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

{#snippet discordGlyph()}
	<svg class="discord-glyph" viewBox="0 0 24 24" fill="currentColor">
		<path
			d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"
		/>
	</svg>
{/snippet}

<div class="root">
	{#if showConnectBanner}
		<div class="banner">
			<div class="banner__top">
				<div class="banner__lead">
					<div class="banner__icon">
						{@render alertCircle()}
					</div>
					<div>
						<h3 class="banner__title">
							Discord Required
							<span class="badge badge--warning">Important</span>
						</h3>
						<p class="banner__sub">
							Connect to Discord — our primary support and community
							channel
						</p>
					</div>
				</div>
				<button
					type="button"
					class="icon-btn"
					aria-label="Dismiss banner"
					onclick={dismissBanner}
				>
					{@render xIcon()}
				</button>
			</div>
			<button
				type="button"
				class="btn btn--discord btn--lg"
				onclick={() => handleConnect(disconnectedPlatforms[0].id)}
			>
				{@render externalLink()}
				Connect Now
			</button>
		</div>
	{/if}

	<div class="tabs">
		<div class="tabs__list" role="tablist">
			<button
				type="button"
				role="tab"
				class="tab"
				class:tab--active={activeTab === "platforms"}
				aria-selected={activeTab === "platforms"}
				onclick={() => (activeTab = "platforms")}
			>
				Platforms
			</button>
			<button
				type="button"
				role="tab"
				class="tab"
				class:tab--active={activeTab === "announcements"}
				aria-selected={activeTab === "announcements"}
				onclick={() => (activeTab = "announcements")}
			>
				{@render bell()}
				Announcements
				{#if unreadCount > 0}
					<span class="badge badge--info badge--count">{unreadCount}</span>
				{/if}
			</button>
		</div>

		{#if activeTab === "platforms"}
			<div class="tab-panel">
				{#each platforms as platform (platform.id)}
					<div class="card platform-card">
						<div class="platform-card__header">
							<div class="platform-card__lead">
								<div class="platform-card__logo">
									{@render discordGlyph()}
								</div>
								<div class="platform-card__meta">
									<div class="card__title">{platform.name}</div>
									<div class="card__desc">{platform.description}</div>
								</div>
							</div>
							{#if !platform.connected}
								<span class="badge badge--info platform-card__badge">
									{platform.id === "discord" && !canConnectDiscord
										? "Subscription required"
										: "Connect"}
								</span>
							{/if}
						</div>

						<div class="platform-card__body">
							{#if platform.connected}
								{#if platform.username}
									<div class="connected-pill">
										Connected as
										<span class="connected-pill__name">{platform.username}</span>
									</div>
								{/if}
								<p class="card__desc">
									You're connected to our {platform.name} community! Join the
									conversation, ask questions, and connect with other members.
								</p>
								<button type="button" class="btn btn--discord btn--block">
									{@render externalLink()}
									Open {platform.name}
								</button>
							{:else if platform.id === "discord" && !canConnectDiscord}
								<p class="card__desc">
									An active subscription or eligible access is required to
									connect Discord and join the server.
								</p>
								<button type="button" class="btn btn--primary btn--block">
									View billing &amp; plans
								</button>
							{:else}
								<button
									type="button"
									class="btn btn--discord btn--block"
									onclick={() => handleConnect(platform.id)}
								>
									{@render externalLink()}
									Connect {platform.name}
								</button>
							{/if}
						</div>
					</div>
				{/each}

				<div class="card future-card">
					<div class="future-card__icon">
						<svg
							class="icon icon--lg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M12 4v16m8-8H4" />
						</svg>
					</div>
					<h3 class="future-card__title">More Platforms Coming Soon</h3>
					<p class="future-card__sub">
						We're working on integrating additional platforms to expand your
						community experience.
					</p>
				</div>
			</div>
		{/if}

		{#if activeTab === "announcements"}
			<div class="tab-panel">
				<div class="card ann-header">
					<div class="ann-header__row">
						<div class="ann-header__title-wrap">
							{@render bell()}
							<h2 class="ann-header__title">
								{items.length}
								{items.length === 1 ? "Announcement" : "Announcements"}
							</h2>
						</div>
						{#if unreadCount > 0}
							<button
								type="button"
								class="btn btn--secondary btn--sm"
								onclick={markAllRead}
							>
								{@render checkCheck()}
								<span class="hide-sm">Mark All Read</span>
							</button>
						{/if}
					</div>

					<div class="ann-header__filters">
						<button
							type="button"
							class="btn btn--sm"
							class:btn--primary={filter === "all"}
							class:btn--secondary={filter !== "all"}
							onclick={() => (filter = "all")}
						>
							All
						</button>
						<button
							type="button"
							class="btn btn--sm"
							class:btn--primary={filter === "unread"}
							class:btn--secondary={filter !== "unread"}
							onclick={() => (filter = "unread")}
						>
							{@render bell()}
							Unread
							{#if unreadCount > 0}
								<span class="pill-count">{unreadCount}</span>
							{/if}
						</button>

						<div class="dropdown">
							<button
								type="button"
								class="btn btn--sm"
								class:btn--primary={typeFilter !== "all"}
								class:btn--secondary={typeFilter === "all"}
								onclick={() => (typeMenuOpen = !typeMenuOpen)}
							>
								{@render filterIcon()}
								<span>{typeFilter !== "all" ? cap(typeFilter) : "Filter"}</span>
							</button>
							{#if typeMenuOpen}
								<div class="dropdown__menu">
									<button
										type="button"
										class="dropdown__item"
										onclick={() => {
											typeFilter = "all";
											typeMenuOpen = false;
										}}
									>
										<span>All Types</span>
										{#if typeFilter === "all"}{@render checkMark()}{/if}
									</button>
									{#each availableTypes as t (t)}
										<button
											type="button"
											class="dropdown__item"
											onclick={() => {
												typeFilter = t;
												typeMenuOpen = false;
											}}
										>
											<span>{cap(t)}</span>
											{#if typeFilter === t}{@render checkMark()}{/if}
										</button>
									{/each}
								</div>
							{/if}
						</div>

						{#if activeFilterCount > 0}
							<button
								type="button"
								class="btn btn--ghost btn--sm"
								onclick={() => {
									filter = "all";
									typeFilter = "all";
								}}
							>
								Clear ({activeFilterCount})
							</button>
						{/if}
					</div>
				</div>

				<div class="ann-list">
					{#if filtered.length === 0}
						<div class="card empty-state">
							<div class="empty-state__icon">
								{@render bellOff()}
							</div>
							<h3 class="empty-state__title">
								{filter === "unread" ? "All Caught Up!" : "No Announcements Yet"}
							</h3>
							<p class="empty-state__desc">
								{filter === "unread"
									? "You've read all announcements. Check back later for updates!"
									: "New announcements will appear here when available."}
							</p>
							{#if filter === "unread"}
								<button
									type="button"
									class="btn btn--outline btn--sm"
									onclick={() => (filter = "all")}
								>
									View All Announcements
								</button>
							{/if}
						</div>
					{:else}
						{#each filtered as a (a.id)}
							<button
								type="button"
								class="card ann-card"
								class:ann-card--read={a.read}
								onclick={() => openAnnouncement(a)}
							>
								<div class="ann-card__icon">
									{#if a.priority === "urgent"}
										<span class="prio prio--urgent">{@render alertCircle()}</span>
									{:else if a.priority === "important"}
										<span class="prio prio--important">
											{@render alertTriangle()}
										</span>
									{:else}
										<span class="prio prio--normal">{@render info()}</span>
									{/if}
								</div>
								<div class="ann-card__body">
									<div class="ann-card__title-row">
										<h3 class="ann-card__title">{a.title}</h3>
										{#if a.priority === "urgent" || a.priority === "important"}
											<span
												class="badge"
												class:badge--error={a.priority === "urgent"}
												class:badge--warning={a.priority === "important"}
											>
												{a.priority}
											</span>
										{/if}
										{#if !a.read}
											<span class="badge badge--info badge--new">
												<svg
													class="dot"
													viewBox="0 0 24 24"
													fill="currentColor"
												>
													<circle cx="12" cy="12" r="10" />
												</svg>
												New
											</span>
										{/if}
									</div>
									<div class="ann-card__meta">
										<span>{formatRelativeDate(a.date)}</span>
										<span>•</span>
										<span>by {a.author}</span>
									</div>
									<p class="ann-card__preview">{a.content}</p>
								</div>
							</button>
						{/each}
					{/if}
				</div>
			</div>
		{/if}
	</div>

	{#if selected}
		<div
			class="dialog-overlay"
			role="presentation"
			onclick={() => (selected = null)}
			onkeydown={(e) => {
				if (e.key === "Escape") selected = null;
			}}
		>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- Click only stops the overlay's close-on-click; not a control. -->
			<div
				class="dialog"
				role="dialog"
				tabindex="-1"
				aria-modal="true"
				aria-label={selected.title}
				onclick={(e) => e.stopPropagation()}
			>
				<div class="dialog__header">
					<button
						type="button"
						class="icon-btn dialog__close"
						aria-label="Close"
						onclick={() => (selected = null)}
					>
						{@render xIcon()}
					</button>
					<h2 class="dialog__title">{selected.title}</h2>
					<div class="dialog__meta">
						<span class="badge badge--info dialog__type">{selected.type}</span>
						<span class="dialog__date">{formatLongDate(selected.date)}</span>
					</div>
				</div>

				<div class="dialog__body">
					{#each selected.fullContent.split("\n") as para, i (i)}
						{#if para.trim() === ""}
							<div class="dialog__gap"></div>
						{:else}
							<p class="dialog__para">{para}</p>
						{/if}
					{/each}
				</div>

				<div class="dialog__footer">
					{#if selected}
						{@const cur = selected}
						<button
							type="button"
							class="btn btn--outline"
							onclick={() => {
								toggleRead(cur.id);
								selected = null;
							}}
						>
							{#if cur.read}
								{@render eyeOff()}
								Mark as Unread
							{:else}
								{@render eye()}
								Mark as Read
							{/if}
						</button>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>

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
		--discord: #5865f2;
		--discord-hover: #4752c4;
		--amber: #f59e0b;

		color: var(--foreground);
		font-family: inherit;
		max-width: 56rem;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.icon {
		width: 1.05rem;
		height: 1.05rem;
		flex-shrink: 0;
	}
	.icon--lg {
		width: 1.6rem;
		height: 1.6rem;
	}

	/* ---- Cards ---- */
	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}
	.card__title {
		font-family: var(--font-serif);
		font-weight: 700;
		letter-spacing: -0.01em;
		font-size: 1.15rem;
	}
	.card__desc {
		color: var(--muted-foreground);
		font-size: 0.9rem;
		line-height: 1.55;
	}

	/* ---- Badges ---- */
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 600;
		line-height: 1.4;
		text-transform: capitalize;
		white-space: nowrap;
	}
	.badge--info {
		background: rgba(245, 78, 0, 0.16);
		color: var(--primary);
		border: 1px solid rgba(245, 78, 0, 0.28);
	}
	.badge--warning {
		background: rgba(251, 191, 36, 0.16);
		color: var(--warning);
		border: 1px solid rgba(251, 191, 36, 0.3);
	}
	.badge--error {
		background: rgba(239, 68, 68, 0.16);
		color: var(--destructive);
		border: 1px solid rgba(239, 68, 68, 0.3);
	}
	.badge--count {
		min-width: 20px;
		height: 20px;
		justify-content: center;
		padding: 0 0.35rem;
	}
	.badge--new .dot {
		width: 0.5rem;
		height: 0.5rem;
	}

	/* ---- Buttons ---- */
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		padding: 0.6rem 1rem;
		border-radius: 10px;
		border: 1px solid transparent;
		font-family: inherit;
		font-size: 0.9rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			opacity 0.15s ease;
		color: var(--foreground);
		background: transparent;
	}
	.btn--sm {
		padding: 0.45rem 0.85rem;
		font-size: 0.82rem;
	}
	.btn--lg {
		padding: 0.8rem 1.25rem;
		font-size: 0.95rem;
	}
	.btn--block {
		width: 100%;
	}
	.btn--primary {
		background: var(--primary);
		color: var(--primary-foreground);
		border-color: var(--primary);
	}
	.btn--primary:hover {
		background: var(--ring);
	}
	.btn--secondary {
		background: var(--card-3);
		color: var(--foreground);
		border-color: var(--border-2);
	}
	.btn--secondary:hover {
		background: var(--card-2);
	}
	.btn--outline {
		background: transparent;
		border-color: var(--border-2);
		color: var(--foreground);
	}
	.btn--outline:hover {
		background: rgba(242, 241, 237, 0.06);
	}
	.btn--ghost {
		background: transparent;
		color: var(--muted-foreground);
		font-size: 0.78rem;
	}
	.btn--ghost:hover {
		background: rgba(242, 241, 237, 0.06);
		color: var(--foreground);
	}
	.btn--discord {
		background: var(--discord);
		color: #fff;
		border-color: var(--discord);
	}
	.btn--discord:hover {
		background: var(--discord-hover);
	}

	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 8px;
		border: none;
		background: transparent;
		color: var(--muted-foreground);
		cursor: pointer;
		flex-shrink: 0;
	}
	.icon-btn:hover {
		background: rgba(242, 241, 237, 0.08);
		color: var(--foreground);
	}

	.hide-sm {
		display: none;
	}
	@media (min-width: 640px) {
		.hide-sm {
			display: inline;
		}
	}

	/* ---- Connect banner ---- */
	.banner {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-bottom: 1.5rem;
		padding: 1.25rem;
		border-radius: var(--radius);
		background: rgba(245, 158, 11, 0.06);
		border: 1px solid var(--border);
		border-left: 4px solid var(--amber);
	}
	.banner__top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.banner__lead {
		display: flex;
		align-items: flex-start;
		gap: 0.85rem;
		flex: 1;
	}
	.banner__icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		border-radius: 10px;
		background: rgba(245, 158, 11, 0.15);
		color: var(--amber);
		flex-shrink: 0;
	}
	.banner__title {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		font-family: var(--font-serif);
		font-weight: 700;
		font-size: 1.2rem;
		letter-spacing: -0.01em;
	}
	.banner__sub {
		margin-top: 0.2rem;
		color: var(--muted-foreground);
		font-size: 0.9rem;
	}

	/* ---- Tabs ---- */
	.tabs__list {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
		max-width: 28rem;
		padding: 0.3rem;
		border-radius: 12px;
		background: var(--card);
		border: 1px solid var(--border);
	}
	.tab {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		padding: 0.55rem 0.75rem;
		border-radius: 9px;
		border: none;
		background: transparent;
		color: var(--muted-foreground);
		font-family: inherit;
		font-size: 0.9rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}
	.tab--active {
		background: var(--card-3);
		color: var(--foreground);
	}
	.tab-panel {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1.5rem;
	}

	/* ---- Platform card ---- */
	.platform-card {
		border-width: 2px;
		transition: border-color 0.15s ease;
	}
	.platform-card:hover {
		border-color: rgba(245, 78, 0, 0.3);
	}
	.platform-card__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 1.25rem 1.25rem 1rem;
	}
	.platform-card__lead {
		display: flex;
		align-items: center;
		gap: 0.9rem;
		flex: 1;
		min-width: 0;
	}
	.platform-card__logo {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3.25rem;
		height: 3.25rem;
		border-radius: 10px;
		background: var(--discord);
		color: #fff;
		flex-shrink: 0;
	}
	.discord-glyph {
		width: 2.25rem;
		height: 2.25rem;
	}
	.platform-card__meta {
		min-width: 0;
	}
	.platform-card__meta .card__desc {
		margin-top: 0.25rem;
		font-size: 0.82rem;
	}
	.platform-card__badge {
		align-self: flex-start;
		flex-shrink: 0;
	}
	.platform-card__body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 0 1.25rem 1.25rem;
	}
	.connected-pill {
		text-align: center;
		padding: 0.85rem;
		border-radius: 10px;
		border: 2px solid rgba(57, 165, 97, 0.3);
		background: rgba(57, 165, 97, 0.1);
		color: var(--success);
		font-size: 0.9rem;
		font-weight: 500;
	}
	.connected-pill__name {
		font-weight: 700;
	}

	/* ---- Future-platforms card ---- */
	.future-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 3rem 1.5rem;
		border: 2px dashed var(--border-2);
		background: rgba(242, 241, 237, 0.02);
		max-width: 48rem;
	}
	.future-card__icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3.5rem;
		height: 3.5rem;
		margin-bottom: 1rem;
		border-radius: 999px;
		background: rgba(242, 241, 237, 0.08);
		color: var(--subtle);
	}
	.future-card__title {
		font-family: var(--font-serif);
		font-weight: 700;
		font-size: 1.1rem;
		margin-bottom: 0.5rem;
	}
	.future-card__sub {
		color: var(--muted-foreground);
		font-size: 0.9rem;
		max-width: 28rem;
	}

	/* ---- Announcements header ---- */
	.ann-header {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1.25rem;
		border-width: 2px;
	}
	.ann-header__row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.ann-header__title-wrap {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--muted-foreground);
	}
	.ann-header__title {
		font-family: var(--font-serif);
		font-weight: 700;
		font-size: 1.2rem;
		letter-spacing: -0.01em;
		color: var(--foreground);
	}
	.ann-header__filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.pill-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: rgba(245, 78, 0, 0.2);
		color: var(--primary);
		font-size: 0.7rem;
		font-weight: 700;
		line-height: 1;
	}

	/* ---- Dropdown ---- */
	.dropdown {
		position: relative;
	}
	.dropdown__menu {
		position: absolute;
		top: calc(100% + 0.35rem);
		left: 0;
		z-index: 20;
		min-width: 12rem;
		padding: 0.3rem;
		border-radius: 10px;
		background: var(--popover);
		border: 1px solid var(--border-2);
		box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
	}
	.dropdown__item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		gap: 0.5rem;
		padding: 0.5rem 0.6rem;
		border: none;
		border-radius: 7px;
		background: transparent;
		color: var(--foreground);
		font-family: inherit;
		font-size: 0.85rem;
		text-align: left;
		cursor: pointer;
	}
	.dropdown__item:hover {
		background: var(--card-3);
	}

	/* ---- Announcement list & cards ---- */
	.ann-list {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}
	.ann-card {
		display: flex;
		gap: 0.9rem;
		width: 100%;
		text-align: left;
		padding: 1.1rem;
		border-width: 2px;
		border-color: rgba(242, 241, 237, 0.16);
		background: var(--card);
		cursor: pointer;
		font-family: inherit;
		color: inherit;
		transition:
			border-color 0.2s ease,
			box-shadow 0.2s ease,
			opacity 0.2s ease,
			transform 0.1s ease;
	}
	.ann-card:hover {
		border-color: var(--border-2);
		box-shadow: 0 10px 26px rgba(0, 0, 0, 0.35);
	}
	.ann-card:active {
		transform: scale(0.985);
	}
	.ann-card--read {
		border-width: 1px;
		border-color: var(--border);
		opacity: 0.6;
	}
	.ann-card--read:hover {
		opacity: 0.85;
	}
	.ann-card__icon {
		flex-shrink: 0;
		padding-top: 0.15rem;
	}
	.prio {
		display: inline-flex;
	}
	.prio .icon {
		width: 1.35rem;
		height: 1.35rem;
	}
	.prio--urgent {
		color: var(--destructive);
	}
	.prio--important {
		color: var(--amber);
	}
	.prio--normal {
		color: #3b82f6;
	}
	.ann-card__body {
		min-width: 0;
		flex: 1;
	}
	.ann-card__title-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.ann-card__title {
		font-family: var(--font-serif);
		font-weight: 700;
		font-size: 1.05rem;
		line-height: 1.25;
		letter-spacing: -0.01em;
	}
	.ann-card__meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
		font-size: 0.78rem;
		color: var(--muted-foreground);
	}
	.ann-card__preview {
		font-size: 0.9rem;
		line-height: 1.6;
		color: var(--muted-foreground);
	}

	/* ---- Empty state ---- */
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 0.6rem;
		padding: 3rem 1.5rem;
		border-width: 2px;
	}
	.empty-state__icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		border-radius: 999px;
		background: rgba(242, 241, 237, 0.06);
		color: var(--muted-foreground);
		margin-bottom: 0.4rem;
	}
	.empty-state__icon .icon {
		width: 1.5rem;
		height: 1.5rem;
	}
	.empty-state__title {
		font-family: var(--font-serif);
		font-weight: 700;
		font-size: 1.1rem;
	}
	.empty-state__desc {
		color: var(--muted-foreground);
		font-size: 0.9rem;
		max-width: 26rem;
	}

	/* ---- Dialog ---- */
	.dialog-overlay {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
		background: rgba(0, 0, 0, 0.6);
		backdrop-filter: blur(2px);
	}
	.dialog {
		display: flex;
		flex-direction: column;
		width: 100%;
		max-width: 56rem;
		max-height: 85vh;
		overflow: hidden;
		border-radius: var(--radius);
		background: var(--popover);
		border: 1px solid var(--border-2);
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
	}
	.dialog__header {
		position: relative;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1.5rem 1.75rem 1.25rem;
		border-bottom: 1px solid var(--border);
	}
	.dialog__close {
		position: absolute;
		top: 1rem;
		right: 1rem;
	}
	.dialog__title {
		padding-right: 2.5rem;
		font-family: var(--font-serif);
		font-weight: 600;
		font-size: 1.45rem;
		line-height: 1.2;
		letter-spacing: -0.01em;
	}
	.dialog__meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
	}
	.dialog__type {
		text-transform: capitalize;
	}
	.dialog__date {
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--muted-foreground);
	}
	.dialog__body {
		flex: 1;
		overflow-y: auto;
		padding: 1.5rem 1.75rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		scrollbar-width: none;
	}
	.dialog__body::-webkit-scrollbar {
		display: none;
	}
	.dialog__para {
		font-size: 0.95rem;
		line-height: 1.65;
		color: rgba(242, 241, 237, 0.9);
		white-space: pre-wrap;
	}
	.dialog__gap {
		height: 0.5rem;
	}
	.dialog__footer {
		flex-shrink: 0;
		padding: 1rem 1.75rem;
		border-top: 1px solid var(--border);
	}
</style>
