<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import type { DraftChatMessage } from '$lib/types';

	/** The chat with the planner about one draft. Everything about the draft is changed from here. */
	let { draftId, messages }: { draftId: string; messages: DraftChatMessage[] } = $props();

	let text = $state('');
	/** The message being answered, shown right away while the planner works. */
	let sending = $state<string | null>(null);
	let list: HTMLDivElement | undefined = $state();

	$effect(() => {
		/** Re-runs when a message arrives or is being sent. */
		void messages.length;
		void sending;

		if (list !== undefined) {
			list.scrollTop = list.scrollHeight;
		}
	});

	function bubbleClass(role: DraftChatMessage['role']): string {
		if (role === 'user') {
			return 'bg-primary text-primary-foreground ms-auto';
		}

		return 'bg-muted';
	}

	function submitChat() {
		sending = text.trim();

		return async ({ result }: { result: { type: string; data?: { message?: string } } }) => {
			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Something went wrong');
			}

			if (result.type === 'success') {
				text = '';
			}

			await invalidateAll();
			sending = null;
		};
	}
</script>

<div class="flex h-full min-h-0 flex-col gap-2">
	<div bind:this={list} class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pe-1">
		{#if messages.length === 0 && sending === null}
			<p class="text-muted-foreground text-xs">
				Tell the AI what to change, e.g. "the terms are the 2023 ones", "make it shorter" or
				"attach our NDA".
			</p>
		{/if}

		{#each messages as message (message.id)}
			<div
				class="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap {bubbleClass(
					message.role
				)}"
			>
				{message.content}
			</div>
		{/each}

		{#if sending !== null}
			<div
				class="bg-primary text-primary-foreground ms-auto max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
			>
				{sending}
			</div>
			<div class="bg-muted text-muted-foreground max-w-[85%] rounded-lg px-3 py-2 text-sm">
				Working…
			</div>
		{/if}
	</div>

	<form method="post" action="?/chat" use:enhance={submitChat} class="flex items-center gap-2">
		<input type="hidden" name="draftId" value={draftId} />
		<Input
			name="message"
			bind:value={text}
			placeholder="Message the AI"
			class="h-8"
			autocomplete="off"
			disabled={sending !== null}
		/>
		<Button
			type="submit"
			size="sm"
			variant="outline"
			disabled={sending !== null || text.trim().length === 0}
		>
			Send
		</Button>
	</form>
</div>
