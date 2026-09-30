<script lang="ts">
	import DraftChat from '$lib/components/draft/DraftChat.svelte';
	import type { ThreadDrafts } from '$lib/types';

	/** The chat with the planner about the current draft. The draft itself sits above the reply box. */
	let { drafts }: { drafts: ThreadDrafts } = $props();
</script>

{#if drafts.active !== null}
	<div class="min-h-0 flex-1 p-3">
		<DraftChat draftId={drafts.active.id} messages={drafts.active.messages} />
	</div>
{/if}
