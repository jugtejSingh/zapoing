<script lang="ts">
	import DraftPane from '$lib/components/draft/DraftPane.svelte';
	import DraftSummary from '$lib/components/draft/DraftSummary.svelte';
	import ReplyBox from '$lib/components/ReplyBox.svelte';
	import ThreadMessage from '$lib/components/ThreadMessage.svelte';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
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

	/** A new thread, a new draft, or a rewrite by the planner resets the reply box to the draft's text. */
	let replyKey = $derived.by(() => {
		if (data.drafts.active === null) {
			return data.reply.emailId;
		}

		return data.reply.emailId + ':' + data.drafts.active.id + ':' + data.drafts.active.body;
	});

	/** The chat pane only exists when there is a draft to talk about. */
	let showPane = $derived(data.drafts.active !== null);

	/** Collapsed it is a thin bar. Below the wide layout, open, it replaces the thread instead of sitting beside it. */
	let paneOpen = $state(false);

	let threadClass = $derived.by(() => {
		if (paneOpen) {
			return 'hidden lg:flex';
		}

		return 'flex';
	});

	let paneClass = $derived.by(() => {
		if (paneOpen) {
			return 'flex w-full lg:w-96';
		}

		return 'hidden w-10 lg:flex';
	});
</script>

<svelte:head>
	<title>{subject} · Zapoing</title>
</svelte:head>

<div class="flex h-full flex-col">
	<div class="flex items-center gap-2 border-b p-4">
		<Sidebar.Trigger class="-ms-1" />
		<h1 class="text-base font-semibold">{subject}</h1>
		{#if data.messages.length > 1}
			<span class="text-muted-foreground text-xs">{data.messages.length} messages</span>
		{/if}

		{#if showPane}
			<Button
				size="sm"
				variant="outline"
				class="ms-auto lg:hidden"
				onclick={() => (paneOpen = !paneOpen)}
			>
				{#if paneOpen}
					Back to email
				{:else}
					Draft chat
				{/if}
			</Button>
		{/if}
	</div>

	<div class="flex min-h-0 flex-1">
		<div class="min-w-0 flex-1 flex-col {threadClass}">
			<ScrollArea class="min-h-0 flex-1">
				{#each data.messages as message, index (message.id)}
					<ThreadMessage email={message} open={index === data.messages.length - 1} />
				{/each}
			</ScrollArea>

			<div class="border-t">
				<DraftSummary drafts={data.drafts} />

				{#key replyKey}
					<ReplyBox {...data.reply} draft={data.drafts.active} />
				{/key}
			</div>
		</div>

		{#if showPane}
			<aside class="shrink-0 flex-col border-s {paneClass}">
				{#if paneOpen}
					<div class="flex items-center justify-between border-b p-2">
						<span class="ps-1 text-sm font-medium">Chat</span>
						<Button size="icon-sm" variant="ghost" aria-label="Close chat" onclick={() => (paneOpen = false)}>
							<XIcon class="size-4" />
						</Button>
					</div>
					<DraftPane drafts={data.drafts} />
				{:else}
					<button
						type="button"
						class="hover:bg-muted text-muted-foreground flex-1 px-2 py-4 text-sm font-medium [writing-mode:vertical-rl]"
						onclick={() => (paneOpen = true)}
					>
						Chat
					</button>
				{/if}
			</aside>
		{/if}
	</div>
</div>
