<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	/** Where the resources disagreed while the reply was written. The newest one was used. */
	let { conflicts }: { conflicts: string[] } = $props();
</script>

{#each conflicts as conflict, index (index)}
	<p
		class="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200"
	>
		<TriangleAlertIcon class="mt-0.5 size-3.5 shrink-0" />
		<span>Resources disagree: {conflict}</span>
	</p>
{/each}
