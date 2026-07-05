<script lang="ts">
	import AffiliateDashboard from '$lib/components/AffiliateDashboard.svelte';
	import { AFFILIATE_STATS } from '$lib/data/affiliate-data';
</script>

<svelte:head>
	<title>LP-OS Member · Affiliate</title>
</svelte:head>

<AffiliateDashboard stats={AFFILIATE_STATS} />
