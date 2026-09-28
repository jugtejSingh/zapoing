<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatDate } from '$lib/format';
	import type { AgentRunSummary } from '$lib/types';

	/** The agent runs for the draft's emails. A run's model output loads when it is opened. */
	let { runs }: { runs: AgentRunSummary[] } = $props();

	let outputs = $state<Record<string, string>>({});

	async function loadOutput(event: Event, run: AgentRunSummary) {
		const details = event.currentTarget as HTMLDetailsElement;

		if (!details.open || outputs[run.id] !== undefined) {
			return;
		}

		outputs[run.id] = 'Loading…';
		const response = await fetch(resolve('/runs/[id]', { id: run.id }));

		if (response.ok) {
			outputs[run.id] = await response.text();
		} else {
			outputs[run.id] = 'Could not load the output';
		}
	}
</script>

<div class="mt-3 grid gap-1">
	<p class="text-muted-foreground">Agent log</p>

	{#if runs.length === 0}
		<p>No runs recorded.</p>
	{/if}

	{#each runs as run (run.id)}
		<details ontoggle={(event) => loadOutput(event, run)} class="rounded border px-2 py-1">
			<summary class="flex cursor-pointer flex-wrap gap-2">
				<span class="font-medium">{run.agent}</span>
				<span class="text-muted-foreground">{formatDate(run.createdAt)}</span>
				<span class="text-muted-foreground">{(run.durationMs / 1000).toFixed(1)} s</span>
				{#if run.ok}
					<span class="text-green-700 dark:text-green-400">ok</span>
				{:else}
					<span class="text-destructive">failed</span>
				{/if}
			</summary>

			{#if run.error !== null}
				<p class="text-destructive mt-1 break-words">{run.error}</p>
			{/if}

			{#if run.hasOutput}
				<pre class="bg-muted mt-1 max-h-64 overflow-auto rounded p-2 whitespace-pre-wrap">{outputs[
						run.id
					] ?? ''}</pre>
			{:else if run.ok}
				<p class="text-muted-foreground mt-1">No model output was kept for this run.</p>
			{/if}
		</details>
	{/each}
</div>
