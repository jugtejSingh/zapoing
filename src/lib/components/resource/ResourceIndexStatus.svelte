<script lang="ts">
	import type { ResourceSummary } from '$lib/types';

	/** What the AI made of the file: its description, or why there is none. */
	let { item }: { item: ResourceSummary } = $props();
</script>

{#if item.indexStatus === 'pending'}
	<p class="text-muted-foreground text-xs">Reading the file…</p>
{:else if item.indexStatus === 'ready'}
	<p class="text-sm">{item.description}</p>
{:else}
	<p class="text-destructive text-xs">
		The file could not be read: {item.indexError ?? 'unknown error'}. Replace the file to try again.
	</p>
{/if}
