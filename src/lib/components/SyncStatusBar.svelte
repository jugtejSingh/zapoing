<script lang="ts">
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import type { SyncStatus } from '$lib/types';

	let { syncStatuses }: { syncStatuses: SyncStatus[] } = $props();

	/** Totals across every account that is mid-sync, so one line covers the combined inbox. */
	let progress = $derived.by(() => {
		let syncing = false;
		let done = 0;
		let total = 0;

		for (const status of syncStatuses) {
			if (!status.syncing) {
				continue;
			}

			syncing = true;
			done = done + status.done;
			total = total + status.total;
		}

		return { syncing, done, total };
	});
</script>

{#if progress.syncing}
	<div
		class="text-muted-foreground flex items-center gap-2 border-b px-4 py-2 text-xs"
		role="status"
	>
		<RefreshCwIcon class="size-3 animate-spin" />
		{#if progress.total > 0}
			<span>Syncing {progress.done} of {progress.total}</span>
		{:else}
			<span>Checking for new mail…</span>
		{/if}
	</div>
{/if}
