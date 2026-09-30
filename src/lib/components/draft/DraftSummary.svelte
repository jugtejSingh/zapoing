<script lang="ts">
	import DraftActions from '$lib/components/draft/DraftActions.svelte';
	import DraftConflicts from '$lib/components/draft/DraftConflicts.svelte';
	import DraftFiles from '$lib/components/draft/DraftFiles.svelte';
	import type { ThreadDrafts } from '$lib/types';

	/**
	 * The draft's controls, conflicts and documents, shown right above the reply box so the
	 * attachments sit with the message they go out with. Not inside the reply form: the
	 * documents have forms of their own.
	 */
	let { drafts }: { drafts: ThreadDrafts } = $props();
</script>

{#if drafts.latestWaitingId !== null && (drafts.active !== null || drafts.canDraft)}
	<div class="grid gap-2 p-4 pb-0 text-sm">
		<DraftActions {drafts} />

		{#if drafts.active !== null}
			<DraftConflicts conflicts={drafts.active.conflicts} />
			<DraftFiles files={drafts.active.files} />
		{/if}
	</div>
{/if}
