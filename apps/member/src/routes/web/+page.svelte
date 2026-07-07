<script lang="ts">
	// The Member/App dashboard is the Web view's initial page (matching the
	// original LifePreneur member web app: sidebar + dashboard). The other
	// workspaces live in the /web/* sub-routes linked from the sidebar layout.
	import MemberDashboardV2 from '$lib/components/MemberDashboardV2.svelte';
</script>

<svelte:head>
	<title>LP-OS Member · Web</title>
</svelte:head>

<MemberDashboardV2 />
