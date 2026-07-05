<!--
	VideoRow — one category of cards with horizontal scroll + left/right buttons.
	Port of apps/web/modules/saas/content/components/video-row.tsx. Each instance
	owns its own scroll-container ref and showLeft/showRight state, mirroring the
	per-row component in the Preact island (islands/StreamingLibrary.tsx).
-->
<script lang="ts">
	import type { Video } from "$lib/data/video-data";

	let { title, videos }: { title: string; videos: Video[] } = $props();

	let scrollEl = $state<HTMLDivElement>();
	let showLeft = $state(false);
	let showRight = $state(true);

	function scroll(direction: "left" | "right") {
		const el = scrollEl;
		if (!el) return;
		const amount = el.clientWidth * 0.8;
		el.scrollTo({
			left: direction === "left"
				? el.scrollLeft - amount
				: el.scrollLeft + amount,
			behavior: "smooth",
		});
	}

	function handleScroll() {
		const el = scrollEl;
		if (!el) return;
		showLeft = el.scrollLeft > 0;
		showRight = el.scrollLeft < el.scrollWidth - el.clientWidth - 10;
	}
</script>

<div class="row">
	<h2 class="rowTitle">{title}</h2>
	<div class="rowScrollWrap">
		{#if showLeft}
			<button
				type="button"
				onclick={() => scroll("left")}
				class="scrollBtn scrollBtnLeft"
				aria-label="Scroll left"
			>
				<span class="scrollBtnInner">
					<svg
						class="scrollBtnIcon"
						width="24"
						height="24"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="m15 18-6-6 6-6" />
					</svg>
				</span>
			</button>
		{/if}
		{#if showRight}
			<button
				type="button"
				onclick={() => scroll("right")}
				class="scrollBtn scrollBtnRight"
				aria-label="Scroll right"
			>
				<span class="scrollBtnInner">
					<svg
						class="scrollBtnIcon"
						width="24"
						height="24"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="m9 18 6-6-6-6" />
					</svg>
				</span>
			</button>
		{/if}
		<div bind:this={scrollEl} onscroll={handleScroll} class="cards">
			{#each videos as video (video.id)}
				<!-- Clicking a card no-ops for now — detail/player modals are deferred. -->
				<button type="button" class="card">
					<div class="thumbWrap">
						<img
							src={video.thumbnail}
							alt={video.title}
							loading="lazy"
							class="thumb"
						/>
						{#if video.isMock}
							<span class="mockBadge">MOCK</span>
						{/if}
						<span class="durationBadge">{video.duration}</span>
						<span class="playOverlay">
							<span class="playBtn">
								<svg
									class="playIcon"
									width="24"
									height="24"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<polygon points="6 3 20 12 6 21 6 3" />
								</svg>
							</span>
						</span>
					</div>
					<div class="meta">
						<h3 class="cardTitle">{video.title}</h3>
						<p class="cardViews">{video.views.toLocaleString()} views</p>
					</div>
				</button>
			{/each}
		</div>
	</div>
</div>

<style>
	.row {
		position: relative;
		margin-bottom: 1rem;
	}

	.rowTitle {
		font-family: var(--font-serif, "Iowan Old Style", "Georgia", serif);
		font-size: 1.5rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: #f2f1ed;
		margin: 0 0 1rem;
		transition: color 200ms ease;
	}

	.row:hover .rowTitle {
		color: #f54e00;
	}

	.rowScrollWrap {
		position: relative;
	}

	.scrollBtn {
		position: absolute;
		top: 0;
		z-index: 20;
		display: none;
		align-items: center;
		height: 100%;
		width: 3rem;
		background: transparent;
		border: 0;
		cursor: pointer;
		opacity: 0;
		transition: opacity 200ms ease;
	}

	@media (min-width: 1024px) {
		.scrollBtn {
			display: flex;
		}
		.row:hover .scrollBtn {
			opacity: 1;
		}
	}

	.scrollBtnLeft {
		left: 0;
		justify-content: flex-start;
		background: linear-gradient(
			to right,
			rgba(26, 25, 22, 0.95),
			rgba(26, 25, 22, 0.6),
			transparent
		);
	}

	.scrollBtnRight {
		right: 0;
		justify-content: flex-end;
		background: linear-gradient(
			to left,
			rgba(26, 25, 22, 0.95),
			rgba(26, 25, 22, 0.6),
			transparent
		);
	}

	.scrollBtnInner {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 4rem;
		background: rgba(26, 25, 22, 0.5);
		backdrop-filter: blur(4px);
		border-radius: 0.25rem;
		transition: background-color 150ms ease;
	}

	.scrollBtnLeft .scrollBtnInner {
		border-top-left-radius: 0;
		border-bottom-left-radius: 0;
	}

	.scrollBtnRight .scrollBtnInner {
		border-top-right-radius: 0;
		border-bottom-right-radius: 0;
	}

	.scrollBtnInner:hover {
		background: rgba(245, 78, 0, 0.2);
	}

	.scrollBtnIcon {
		width: 2rem;
		height: 2rem;
		color: #f2f1ed;
	}

	.cards {
		display: flex;
		gap: 1rem;
		overflow-x: auto;
		scroll-behavior: smooth;
		scrollbar-width: none;
		-ms-overflow-style: none;
		scroll-snap-type: x mandatory;
		-webkit-overflow-scrolling: touch;
		overscroll-behavior-x: contain;
		padding-bottom: 0.25rem;
	}

	.cards::-webkit-scrollbar {
		display: none;
	}

	@media (min-width: 1024px) {
		.cards {
			scroll-snap-type: none;
		}
	}

	.card {
		flex-shrink: 0;
		width: clamp(200px, 20vw, 320px);
		scroll-snap-align: start;
		background: transparent;
		border: 0;
		padding: 0;
		color: inherit;
		text-align: left;
		cursor: pointer;
		transition: transform 300ms ease;
	}

	.card:active {
		transform: scale(0.98);
	}

	.thumbWrap {
		position: relative;
		aspect-ratio: 16 / 9;
		overflow: hidden;
		border-radius: 0.5rem;
		background: #2b2a27;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.35),
			0 0 0 1px rgb(242 241 237 / 0.06);
		transition: transform 300ms ease, box-shadow 300ms ease;
	}

	@media (min-width: 1024px) {
		.card:hover .thumbWrap {
			transform: scale(1.1);
			box-shadow: 0 6px 14px rgb(0 0 0 / 0.48),
				0 0 0 1px rgb(242 241 237 / 0.09);
		}
	}

	.thumb {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		transition: transform 500ms ease;
	}

	.card:hover .thumb {
		transform: scale(1.1);
	}

	.mockBadge {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		padding: 0.25rem 0.5rem;
		border-radius: 999px;
		background: #f54e00;
		color: #ffffff;
		font-size: 0.625rem;
		font-weight: 700;
	}

	.durationBadge {
		position: absolute;
		bottom: 0.5rem;
		right: 0.5rem;
		padding: 0.125rem 0.5rem;
		border-radius: 0.25rem;
		background: rgba(0, 0, 0, 0.8);
		color: #ffffff;
		font-size: 0.75rem;
		font-weight: 500;
		backdrop-filter: blur(4px);
	}

	.playOverlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0);
		transition: background-color 300ms ease;
	}

	.card:hover .playOverlay {
		background: rgba(0, 0, 0, 0.5);
	}

	.playBtn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 999px;
		background: #f54e00;
		box-shadow: 0 0 24px rgba(245, 78, 0, 0.5);
		transform: scale(0);
		transition: transform 300ms ease;
	}

	.card:hover .playBtn {
		transform: scale(1);
	}

	.playIcon {
		width: 1.5rem;
		height: 1.5rem;
		color: #ffffff;
		fill: #ffffff;
	}

	.meta {
		margin-top: 0.5rem;
		padding: 0 0.25rem;
	}

	.cardTitle {
		font-size: 0.875rem;
		font-weight: 600;
		color: #f2f1ed;
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cardViews {
		font-size: 0.75rem;
		color: rgba(242, 241, 237, 0.6);
		margin: 0.125rem 0 0;
	}
</style>
