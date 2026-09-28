<script lang="ts">
	import RunLog from '$lib/components/draft/RunLog.svelte';
	import type { ThreadDrafts } from '$lib/types';

	/** Why the draft says what it says: reason, intents, thread cut, resources, and the agent log. */
	let { draft }: { draft: NonNullable<ThreadDrafts['active']> } = $props();

	let resourceNames = $derived.by(() => {
		const names: string[] = [];

		for (const resource of draft.resources) {
			names.push(resource.name);
		}

		return names.join(', ');
	});
</script>

<details class="text-xs">
	<summary class="text-muted-foreground cursor-pointer">Why this draft?</summary>

	<dl class="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
		<dt class="text-muted-foreground">Reason</dt>
		<dd>{draft.reason ?? 'Not recorded'}</dd>

		<dt class="text-muted-foreground">Asked for</dt>
		<dd>
			{#if draft.intents.length === 0}
				Nothing specific
			{:else}
				<ol class="list-decimal ps-4">
					{#each draft.intents as intent, index (index)}
						<li>{intent}</li>
					{/each}
				</ol>
			{/if}
		</dd>

		<dt class="text-muted-foreground">Thread</dt>
		<dd>
			{#if draft.threadCut}
				Cut to fit the budget: the oldest messages were left out
			{:else}
				Sent in full
			{/if}
		</dd>

		<dt class="text-muted-foreground">Resources</dt>
		<dd>
			{#if draft.resources.length === 0}
				None
			{:else}
				{resourceNames}
			{/if}
		</dd>
	</dl>

	<RunLog runs={draft.runs} />
</details>
