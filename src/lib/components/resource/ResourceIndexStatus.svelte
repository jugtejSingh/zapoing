<script lang="ts">
	import type { ResourceSummary } from '$lib/types';

	/** Whether the file's contents are searchable yet. */
	let { item }: { item: ResourceSummary } = $props();
</script>

{#if item.indexStatus === 'pending'}
	<p class="text-muted-foreground text-xs">Reading the file for search…</p>
{:else if item.indexStatus === 'ready'}
	<p class="text-muted-foreground text-xs">Contents searchable</p>
{:else}
	<p class="text-destructive text-xs">
		Contents not searchable: {item.indexError ?? 'unknown error'}. It is still found by name,
		keywords and tags; replace the file to try again.
	</p>
{/if}
