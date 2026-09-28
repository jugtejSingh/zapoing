<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	/** Which resources the draft used, and where they disagreed. */
	let { resources, conflicts }: { resources: { id: string; name: string }[]; conflicts: string[] } =
		$props();

	let names = $derived.by(() => {
		const list: string[] = [];

		for (const resource of resources) {
			list.push(resource.name);
		}

		return list.join(', ');
	});
</script>

{#if resources.length > 0}
	<p class="text-muted-foreground text-xs">Used: {names}</p>
{/if}

{#each conflicts as conflict, index (index)}
	<p
		class="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200"
	>
		<TriangleAlertIcon class="mt-0.5 size-3.5 shrink-0" />
		<span>Resources disagree: {conflict}</span>
	</p>
{/each}
