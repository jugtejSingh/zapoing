<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import type { ThreadDrafts } from '$lib/types';

	/** What can be done to the drafts of a thread: discard, merge, or write one anyway. */
	let { drafts }: { drafts: ThreadDrafts } = $props();

	/** One flag for every form: model calls take a while and must not be double-clicked. */
	let busy = $state(false);

	function submitAction() {
		busy = true;

		return async ({ result }: { result: { type: string; data?: { message?: string } } }) => {
			busy = false;

			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Something went wrong');
				return;
			}

			if (result.type === 'success') {
				toast.success(result.data?.message ?? 'Done');
				await invalidateAll();
			}
		};
	}
</script>

{#if drafts.active !== null}
	<div class="flex flex-wrap items-center gap-2">
		<span class="text-muted-foreground text-xs">
			{#if drafts.pendingCount === 1}
				1 draft for this thread
			{:else}
				{drafts.pendingCount} drafts, showing the newest
			{/if}
		</span>

		{#if drafts.pendingCount >= 2}
			<form method="post" action="?/merge" use:enhance={submitAction}>
				<input type="hidden" name="emailId" value={drafts.latestWaitingId} />
				<Button type="submit" size="sm" variant="secondary" disabled={busy}>Merge into one</Button>
			</form>
		{/if}

		<form method="post" action="?/discard" use:enhance={submitAction} class="ms-auto">
			<input type="hidden" name="draftId" value={drafts.active.id} />
			<Button type="submit" size="sm" variant="ghost" disabled={busy}>Discard</Button>
		</form>
	</div>
{:else}
	<div class="grid gap-2">
		<p class="text-muted-foreground text-xs">
			{#if drafts.skippedReason !== null}
				No draft written: {drafts.skippedReason}
			{:else}
				No draft for this email yet.
			{/if}
		</p>
		<form method="post" action="?/draftAnyway" use:enhance={submitAction}>
			<input type="hidden" name="emailId" value={drafts.latestWaitingId} />
			<Button type="submit" size="sm" variant="outline" disabled={busy}>
				{#if busy}
					Writing…
				{:else}
					Draft anyway
				{/if}
			</Button>
		</form>
	</div>
{/if}
