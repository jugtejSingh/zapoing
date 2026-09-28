<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';

	/** Name, when to use it, and the Word, Excel or PDF file. */
	let busy = $state(false);

	function submitUpload() {
		busy = true;

		return async ({
			result,
			formElement
		}: {
			result: { type: string; data?: { message?: string } };
			formElement: HTMLFormElement;
		}) => {
			busy = false;

			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Could not upload the template');
				return;
			}

			if (result.type === 'success') {
				formElement.reset();
				toast.success(result.data?.message ?? 'Template uploaded');
				await invalidateAll();
			}
		};
	}
</script>

<form
	method="post"
	action="?/upload"
	enctype="multipart/form-data"
	use:enhance={submitUpload}
	class="grid gap-3 rounded-lg border p-4"
>
	<h2 class="font-medium">Add a template</h2>
	<div class="grid gap-1.5">
		<Label for="template-name">Name</Label>
		<Input id="template-name" name="name" placeholder="e.g. Mutual NDA" required />
	</div>
	<div class="grid gap-1.5">
		<Label for="template-description">When to use it</Label>
		<Textarea
			id="template-description"
			name="description"
			rows={2}
			placeholder="e.g. Before any deal talks with a new company"
		/>
	</div>
	<div class="grid gap-1.5">
		<Label for="template-file">File</Label>
		<input
			id="template-file"
			type="file"
			name="file"
			accept=".docx,.xlsx,.pdf"
			required
			class="text-sm"
		/>
		<p class="text-muted-foreground text-xs">
			Word, Excel or PDF. Word and Excel keep their exact layout when filled; a PDF is filled as
			text.
		</p>
	</div>
	<div>
		<Button type="submit" disabled={busy}>
			{#if busy}
				Uploading…
			{:else}
				Upload
			{/if}
		</Button>
	</div>
</form>
