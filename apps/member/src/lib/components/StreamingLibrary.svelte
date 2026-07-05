<!--
	Port of islands/StreamingLibrary.tsx (itself a port of
	apps/web/modules/saas/content/components/streaming-library.tsx + video-row.tsx).

	Search runs locally over the stub catalog (the original calls
	`orpcClient.content.videos.list` server-side); detail and player modals are
	deferred — clicking a card no-ops for now (see VideoRow.svelte).
-->
<script lang="ts">
	import {
		type Video,
		VIDEO_CATEGORIES,
		type VideoCategory,
		VIDEOS,
	} from "$lib/data/video-data";
	import VideoRow from "./VideoRow.svelte";

	let { initialVideos = VIDEOS }: {
		/** Optional override for the seed catalog — used for tests and fixtures. */
		initialVideos?: Video[];
	} = $props();

	let searchQuery = $state("");
	let activeSearch = $state("");
	let inputEl = $state<HTMLInputElement>();

	const filtered = $derived.by(() => {
		if (!activeSearch.trim()) return initialVideos;
		const q = activeSearch.trim().toLowerCase();
		return initialVideos.filter((v) =>
			v.title.toLowerCase().includes(q) ||
			v.description?.toLowerCase().includes(q) ||
			v.category.toLowerCase().includes(q)
		);
	});

	const byCategory = $derived.by(() => {
		const map: Record<VideoCategory, Video[]> = {
			"Getting Started": [],
			"Advanced Strategies": [],
			"Case Studies": [],
			"Tools & Resources": [],
		};
		for (const v of filtered) {
			if (v.category in map) {
				map[v.category as VideoCategory].push(v);
			}
		}
		return map;
	});

	function handleClear() {
		searchQuery = "";
		activeSearch = "";
		inputEl?.focus();
	}
</script>

<form
	class="searchForm"
	onsubmit={(e) => {
		e.preventDefault();
		activeSearch = searchQuery;
	}}
>
	<div class="searchRow">
		<div class="searchInputWrap">
			<svg
				class="searchIcon"
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
				<circle cx="11" cy="11" r="8" />
				<path d="m21 21-4.3-4.3" />
			</svg>
			<input
				bind:this={inputEl}
				type="text"
				placeholder="Search courses..."
				bind:value={searchQuery}
				class="searchInput"
			/>
			{#if searchQuery}
				<button
					type="button"
					onclick={handleClear}
					class="searchClear"
					aria-label="Clear search"
				>
					<svg
						class="searchClearIcon"
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
						<path d="M18 6 6 18" />
						<path d="m6 6 12 12" />
					</svg>
				</button>
			{/if}
		</div>
		<button
			type="submit"
			disabled={!searchQuery.trim()}
			class="searchSubmit"
		>
			Search
		</button>
	</div>
	{#if activeSearch}
		<p class="searchSummary">
			Showing results for <span class="searchTerm">"{activeSearch}"</span> —
			<button
				type="button"
				onclick={handleClear}
				class="searchClearLink"
			>
				clear
			</button>
		</p>
	{/if}
</form>

<div class="rows">
	{#each VIDEO_CATEGORIES as cat (cat)}
		{#if byCategory[cat].length > 0}
			<VideoRow title={cat} videos={byCategory[cat]} />
		{/if}
	{/each}
</div>

<style>
	.searchForm {
		margin-bottom: 2rem;
	}

	.searchRow {
		display: flex;
		max-width: 28rem;
		gap: 0.5rem;
	}

	.searchInputWrap {
		position: relative;
		flex: 1;
		min-width: 0;
	}

	.searchIcon {
		position: absolute;
		left: 1rem;
		top: 50%;
		transform: translateY(-50%);
		width: 1.25rem;
		height: 1.25rem;
		color: rgba(242, 241, 237, 0.6);
		pointer-events: none;
	}

	.searchInput {
		width: 100%;
		height: 3rem;
		border-radius: 0.5rem;
		border: 1px solid rgba(242, 241, 237, 0.16);
		background: #232220;
		color: #f2f1ed;
		padding: 0 2.5rem 0 3rem;
		font-size: 1rem;
		box-sizing: border-box;
		outline: none;
		transition: border-color 150ms ease, box-shadow 150ms ease;
	}

	.searchInput:focus {
		border-color: #f54e00;
		box-shadow: 0 0 0 2px rgba(245, 78, 0, 0.25);
	}

	.searchClear {
		position: absolute;
		right: 0.75rem;
		top: 50%;
		transform: translateY(-50%);
		background: transparent;
		border: 0;
		padding: 0.25rem;
		color: rgba(242, 241, 237, 0.6);
		cursor: pointer;
		border-radius: 999px;
	}

	.searchClear:hover {
		color: #f2f1ed;
	}

	.searchClearIcon {
		width: 1rem;
		height: 1rem;
	}

	.searchSubmit {
		height: 3rem;
		padding: 0 1.25rem;
		border-radius: 0.5rem;
		border: 0;
		background: #f54e00;
		color: #ffffff;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 150ms ease, opacity 150ms ease;
	}

	.searchSubmit:hover:not(:disabled) {
		background: #e8650a;
	}

	.searchSubmit:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.searchSummary {
		margin-top: 0.5rem;
		font-size: 0.875rem;
		color: rgba(242, 241, 237, 0.6);
	}

	.searchTerm {
		font-weight: 500;
		color: #f2f1ed;
	}

	.searchClearLink {
		background: transparent;
		border: 0;
		padding: 0;
		color: rgba(242, 241, 237, 0.6);
		text-decoration: underline;
		cursor: pointer;
		font: inherit;
	}

	.searchClearLink:hover {
		color: #f2f1ed;
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}
</style>
