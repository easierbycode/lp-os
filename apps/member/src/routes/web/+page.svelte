<script lang="ts">
	// Landing hub for the "Member/Web" shell entry — links out to the
	// seller/streamer/content dashboards (CONTRACTS.md "Member app").
	const cards = [
		{
			href: '/web/seller',
			title: 'Seller Dashboard',
			desc: 'TikTok Shop live-session analytics — GMV, items sold, viewers, traffic sources.'
		},
		{
			href: '/web/streamer',
			title: 'Streamer Dashboard',
			desc: 'Creator Compass video-analysis KPIs and per-video metrics.'
		},
		{
			href: '/web/content',
			title: 'Content Library',
			desc: 'Streaming library with progress tracking and featured videos.'
		},
		{
			href: '/web/community',
			title: 'Community Hub',
			desc: 'Announcements and platform connections.'
		},
		{
			href: '/web/affiliate',
			title: 'Affiliate',
			desc: 'Referral link, visitors, conversions and commissions.'
		},
		{
			href: '/web/settings',
			title: 'Settings',
			desc: 'Profile, connected accounts, sessions and billing.'
		}
	];
</script>

<svelte:head>
	<title>LP-OS Member · Web</title>
</svelte:head>

<main class="hub">
	<header class="hub__header">
		<img src="/logo.svg" alt="" class="hub__logo" />
		<div>
			<h1>Member Web</h1>
			<p>Pick a workspace. The main dashboard lives at <a href="/" class="hub__home">/</a>.</p>
		</div>
	</header>

	<div class="hub__grid">
		{#each cards as card (card.href)}
			<a href={card.href} class="hub__card">
				<h2>{card.title}</h2>
				<p>{card.desc}</p>
				<span class="hub__go">Open →</span>
			</a>
		{/each}
	</div>
</main>

<style>
	.hub {
		max-width: 960px;
		margin: 0 auto;
		padding: 40px 24px 64px;
	}
	.hub__header {
		display: flex;
		align-items: center;
		gap: 16px;
		margin-bottom: 28px;
	}
	.hub__logo {
		width: 44px;
		height: 44px;
	}
	.hub__header h1 {
		font-size: 24px;
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	.hub__header p {
		color: #a8a49c;
		font-size: 14px;
		margin-top: 2px;
	}
	.hub__home {
		color: #f2b23d;
		text-decoration: underline;
	}
	.hub__grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 16px;
	}
	.hub__card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		background: #232220;
		border: 1px solid #33312e;
		border-radius: 14px;
		padding: 20px;
		transition:
			border-color 0.15s ease,
			transform 0.15s ease;
	}
	.hub__card:hover {
		border-color: #f2b23d;
		transform: translateY(-2px);
	}
	.hub__card h2 {
		font-size: 16px;
		font-weight: 600;
	}
	.hub__card p {
		font-size: 13px;
		color: #a8a49c;
		flex: 1;
	}
	.hub__go {
		font-size: 13px;
		color: #f2b23d;
		font-weight: 600;
	}
</style>
