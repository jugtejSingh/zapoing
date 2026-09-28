<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import DraftFiles from '$lib/components/draft/DraftFiles.svelte';
	import DraftResources from '$lib/components/draft/DraftResources.svelte';
	import WhyPanel from '$lib/components/draft/WhyPanel.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import type { ThreadDrafts } from '$lib/types';

	/** Draft controls above the reply box: regenerate, discard, merge, draft anyway. */
	let { drafts }: { drafts: ThreadDrafts } = $props();

	/** One flag for every form: model calls take a while and must not be double-clicked. */
	let busy = $state(false);
	let instruction = $state('');

	function submitAction() {
		busy = true;

		return async ({ result }: { result: { type: string; data?: { message?: string } } }) => {
			busy = false;

			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Something went wrong');
				return;
			}

			if (result.type === 'success') {
				instruction = '';
				toast.success(result.data?.message ?? 'Done');
				await invalidateAll();
			}
		};
	}
</script>

{#if drafts.latestWaitingId !== null && (drafts.active !== null || drafts.canDraft)}
	<div class="grid gap-2 border-t px-4 pt-3 text-sm">
		{#if drafts.active !== null}
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-muted-foreground text-xs">
					{#if drafts.pendingCount === 1}
						1 draft for this thread
					{:else}
						{drafts.pendingCount} drafts for this thread, showing the newest
					{/if}
				</span>

				{#if drafts.pendingCount >= 2}
					<form method="post" action="?/merge" use:enhance={submitAction}>
						<input type="hidden" name="emailId" value={drafts.latestWaitingId} />
						<Button type="submit" size="sm" variant="secondary" disabled={busy}>
							Merge into one reply
						</Button>
					</form>
				{/if}

				<form method="post" action="?/discard" use:enhance={submitAction} class="ms-auto">
					<input type="hidden" name="draftId" value={drafts.active.id} />
					<Button type="submit" size="sm" variant="ghost" disabled={busy}>Discard</Button>
				</form>
			</div>

			<form
				method="post"
				action="?/regenerate"
				use:enhance={submitAction}
				class="flex items-center gap-2"
			>
				<input type="hidden" name="draftId" value={drafts.active.id} />
				<Input
					name="instruction"
					bind:value={instruction}
					placeholder="Optional: how should it change? e.g. shorter, more formal"
					class="h-8"
				/>
				<Button type="submit" size="sm" variant="outline" disabled={busy}>
					{#if busy}
						Working…
					{:else}
						Regenerate
					{/if}
				</Button>
			</form>

			<DraftResources resources={drafts.active.resources} conflicts={drafts.active.conflicts} />
			<DraftFiles files={drafts.active.files} />
			<WhyPanel draft={drafts.active} />
		{:else}
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-muted-foreground text-xs">
					{#if drafts.skippedReason !== null}
						No draft written: {drafts.skippedReason}
					{:else}
						No draft for this email yet.
					{/if}
				</span>
				<form method="post" action="?/draftAnyway" use:enhance={submitAction} class="ms-auto">
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
	</div>
{/if}
