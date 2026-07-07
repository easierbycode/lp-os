<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { SETTINGS_DATA } from '$lib/data/settings-data';

	let { children } = $props();

	// The LifePreneur web chrome from the original member web app: fixed
	// sidebar (Dashboard is the landing page), content on the right. Seller /
	// Streamer keep their routes under a secondary group so nothing the old
	// workspace picker linked to becomes unreachable.
	const nav = [
		{ href: '/web', label: 'Dashboard', icon: 'dashboard', exact: true },
		{ href: '/web/community', label: 'Community', icon: 'community', exact: false },
		{ href: '/web/content', label: 'Content', icon: 'content', exact: false },
		{ href: '/web/affiliate', label: 'Affiliate', icon: 'affiliate', exact: false },
		{ href: '/web/settings', label: 'Settings', icon: 'settings', exact: false }
	];
	const workspaces = [
		{ href: '/web/seller', label: 'Seller Dashboard' },
		{ href: '/web/streamer', label: 'Streamer Dashboard' }
	];

	const user = SETTINGS_DATA.user;

	function isActive(item: { href: string; exact: boolean }): boolean {
		const path = page.url.pathname.replace(/\/+$/, '') || '/';
		const target = `${base}${item.href}`;
		return item.exact ? path === target : path.startsWith(target);
	}
</script>

<div class="web-shell">
	<aside class="sidebar">
		<a href="{base}/web" class="brand">
			<img src="{base}/logo.svg" alt="" />
			<span>LifePreneur</span>
		</a>

		<nav>
			{#each nav as item (item.href)}
				<a href="{base}{item.href}" class="nav-item" class:active={isActive(item)}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						{#if item.icon === 'dashboard'}
							<rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
						{:else if item.icon === 'community'}
							<circle cx="9" cy="8" r="3.2" /><path d="M2.8 19c.8-3 3.2-4.6 6.2-4.6s5.4 1.6 6.2 4.6" /><circle cx="17" cy="9" r="2.4" /><path d="M15.6 14.7c2.6.2 4.6 1.6 5.4 4.3" />
						{:else if item.icon === 'content'}
							<circle cx="12" cy="12" r="9" /><path d="M10 8.5l6 3.5-6 3.5z" />
						{:else if item.icon === 'affiliate'}
							<path d="M10 14a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.1" /><path d="M14 10a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.1" />
						{:else}
							<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
						{/if}
					</svg>
					{item.label}
				</a>
			{/each}

			<p class="nav-group">Workspaces</p>
			{#each workspaces as item (item.href)}
				<a href="{base}{item.href}" class="nav-item small" class:active={isActive({ ...item, exact: false })}>
					{item.label}
				</a>
			{/each}
		</nav>

		<div class="profile">
			<span class="avatar">{user.initials}</span>
			<div>
				<p class="name">{user.name}</p>
				<p class="email">{user.email}</p>
			</div>
		</div>
	</aside>

	<div class="content">
		{@render children?.()}
	</div>
</div>

<style>
	.web-shell {
		display: flex;
		min-height: 100vh;
	}
	.sidebar {
		width: 232px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		padding: 20px 14px;
		border-right: 1px solid #2c2a27;
		background: #181715;
		position: sticky;
		top: 0;
		height: 100vh;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 10px 18px;
		border-bottom: 1px solid #2c2a27;
		margin-bottom: 14px;
	}
	.brand img {
		width: 34px;
		height: 34px;
	}
	.brand span {
		font-size: 17px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}
	nav {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
	}
	.nav-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 12px;
		border-radius: 10px;
		font-size: 14px;
		font-weight: 500;
		color: #b7b3ab;
		transition: background 0.12s ease, color 0.12s ease;
	}
	.nav-item svg {
		width: 18px;
		height: 18px;
	}
	.nav-item:hover {
		color: #f5f2ec;
		background: #232220;
	}
	.nav-item.active {
		color: #f2b23d;
		background: rgba(242, 178, 61, 0.12);
	}
	.nav-group {
		margin: 14px 12px 4px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #6f6b64;
	}
	.nav-item.small {
		font-size: 13px;
		padding: 7px 12px;
	}
	.profile {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 10px 4px;
		border-top: 1px solid #2c2a27;
	}
	.avatar {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		background: #35322d;
		color: #f5f2ec;
		font-size: 13px;
		font-weight: 700;
		flex-shrink: 0;
	}
	.profile .name {
		font-size: 13px;
		font-weight: 600;
	}
	.profile .email {
		font-size: 12px;
		color: #8f8b83;
	}
	.content {
		flex: 1;
		min-width: 0;
	}

	@media (max-width: 760px) {
		.web-shell {
			flex-direction: column;
		}
		.sidebar {
			width: 100%;
			height: auto;
			position: static;
			border-right: 0;
			border-bottom: 1px solid #2c2a27;
		}
	}
</style>
