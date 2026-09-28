<script lang="ts">
	import { listPlaceholders } from '$lib/placeholders';

	/** The reply text; lists the [[gaps]] still left in it. */
	let { body }: { body: string } = $props();

	let names = $derived(listPlaceholders(body));
</script>

{#if names.length > 0}
	<div class="flex flex-wrap items-center gap-1 text-xs">
		<span class="text-muted-foreground">Fill in before sending (Tab jumps to the next):</span>
		{#each names as name (name)}
			<span
				class="rounded bg-amber-100 px-1.5 font-mono text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
			>
				[[{name}]]
			</span>
		{/each}
	</div>
{/if}
