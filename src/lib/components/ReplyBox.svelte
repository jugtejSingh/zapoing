<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import PlaceholderList from '$lib/components/draft/PlaceholderList.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { hasPlaceholders, nextPlaceholderRange } from '$lib/placeholders';
	import type { DraftFile } from '$lib/types';

	/**
	 * The newest message in the thread, who the reply goes to, and the AI draft
	 * to start from. `cc` and `draft` are only starting values; the parent keys
	 * this component per thread and draft so it resets.
	 */
	let {
		emailId,
		to,
		cc,
		draft
	}: {
		emailId: string;
		to: string;
		cc: string;
		draft: { id: string; body: string; files: DraftFile[] } | null;
	} = $props();

	// svelte-ignore state_referenced_locally
	let ccText = $state(cc);
	let body = $state(initialBody());
	let sending = $state(false);
	let fileInput: HTMLInputElement | undefined = $state();
	let textarea: HTMLTextAreaElement | null = $state(null);

	let unfilled = $derived(hasPlaceholders(body));
	let unfilledFiles = $derived(filesWithFields());

	/** Attached documents that still have [[fields]]; the server refuses to send them too. */
	function filesWithFields(): string[] {
		const names: string[] = [];

		if (draft === null) {
			return names;
		}

		for (const file of draft.files) {
			if (file.error === null && file.placeholders.length > 0) {
				names.push(file.filename);
			}
		}

		return names;
	}

	function initialBody(): string {
		if (draft === null) {
			return '';
		}

		return draft.body;
	}

	function draftId(): string {
		if (draft === null) {
			return '';
		}

		return draft.id;
	}

	/** Tab selects the next [[gap]] so typing replaces it. Plain Tab behaviour returns once all are filled. */
	function jumpToPlaceholder(event: KeyboardEvent) {
		if (event.key !== 'Tab' || event.shiftKey || textarea === null || !unfilled) {
			return;
		}

		const range = nextPlaceholderRange(body, textarea.selectionEnd);

		if (range === null) {
			return;
		}

		event.preventDefault();
		textarea.setSelectionRange(range.start, range.end);
	}

	function submitReply() {
		sending = true;

		return async ({ result }: { result: { type: string; data?: { message?: string } } }) => {
			sending = false;

			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Could not send the reply');
				return;
			}

			if (result.type === 'success') {
				body = '';

				if (fileInput) {
					fileInput.value = '';
				}

				toast.success('Reply sent');
				await invalidateAll();
			}
		};
	}
</script>

<form
	method="post"
	action="?/reply"
	enctype="multipart/form-data"
	use:enhance={submitReply}
	class="grid gap-2 border-t p-4"
>
	<input type="hidden" name="emailId" value={emailId} />
	<input type="hidden" name="draftId" value={draftId()} />
	<p class="text-muted-foreground truncate text-xs">To: {to}</p>
	<div class="flex items-center gap-2">
		<Label for="reply-cc" class="text-muted-foreground text-xs">Cc</Label>
		<Input id="reply-cc" name="cc" bind:value={ccText} class="h-8" />
	</div>
	<Textarea
		name="body"
		bind:value={body}
		bind:ref={textarea}
		onkeydown={jumpToPlaceholder}
		placeholder="Write a reply…"
		rows={4}
		required
	/>
	<PlaceholderList {body} />
	{#if unfilledFiles.length > 0}
		<p class="text-muted-foreground text-xs">
			Fill the fields in {unfilledFiles.join(', ')} above before sending.
		</p>
	{/if}
	<div class="flex items-center justify-between gap-2">
		<input
			bind:this={fileInput}
			type="file"
			name="attachments"
			multiple
			aria-label="Attachments"
			class="text-xs"
		/>
		<Button
			type="submit"
			disabled={sending || unfilled || unfilledFiles.length > 0 || body.trim().length === 0}
		>
			{#if sending}
				Sending…
			{:else}
				Send
			{/if}
		</Button>
	</div>
</form>
