<script lang="ts">
	import DraftBar from '$lib/components/draft/DraftBar.svelte';
	import ReplyBox from '$lib/components/ReplyBox.svelte';
	import ThreadMessage from '$lib/components/ThreadMessage.svelte';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let subject = $derived.by(() => {
		const first = data.messages[0];

		if (first.subject.length === 0) {
			return '(no subject)';
		}

		return first.subject;
	});

	/** A new thread or a new draft resets the reply box to the draft's text. */
	let replyKey = $derived.by(() => {
		if (data.drafts.active === null) {
			return data.reply.emailId;
		}

		return data.reply.emailId + ':' + data.drafts.active.id;
	});
</script>

<svelte:head>
	<title>{subject} · Zapoing</title>
</svelte:head>

<div class="flex h-full flex-col">
	<div class="flex items-baseline gap-2 border-b p-4">
		<h1 class="text-base font-semibold">{subject}</h1>
		{#if data.messages.length > 1}
			<span class="text-muted-foreground text-xs">{data.messages.length} messages</span>
		{/if}
	</div>

	<ScrollArea class="flex-1">
		{#each data.messages as message, index (message.id)}
			<ThreadMessage email={message} open={index === data.messages.length - 1} />
		{/each}
	</ScrollArea>

	<DraftBar drafts={data.drafts} />

	{#key replyKey}
		<ReplyBox {...data.reply} draft={data.drafts.active} />
	{/key}
</div>
