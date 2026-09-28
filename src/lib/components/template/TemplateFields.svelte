<script lang="ts">
	import type { TemplateSummary } from '$lib/types';

	/** The fields the model found. One it named but could not place in the file is flagged. */
	let { fields }: { fields: TemplateSummary['fields'] } = $props();
</script>

<ul class="grid gap-1 text-sm">
	{#each fields as field (field.name)}
		<li class="flex flex-wrap items-baseline gap-x-2">
			<code class="bg-muted rounded px-1 text-xs">[[{field.name}]]</code>
			<span class="text-muted-foreground text-xs">{field.description}</span>
			{#if field.found === 0}
				<span class="text-destructive text-xs">not found in the file</span>
			{/if}
		</li>
	{/each}
</ul>
