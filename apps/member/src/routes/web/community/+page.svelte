<script lang="ts">
	import CommunityHub from '$lib/components/CommunityHub.svelte';
	import { ANNOUNCEMENTS, CAN_CONNECT_DISCORD, PLATFORMS } from '$lib/data/community-data';
</script>

<svelte:head>
	<title>LP-OS Member · Community</title>
</svelte:head>

<CommunityHub
	canConnectDiscord={CAN_CONNECT_DISCORD}
	platforms={PLATFORMS}
	announcements={ANNOUNCEMENTS}
/>
