<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import ResourceFields from '$lib/components/resource/ResourceFields.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { RESOURCE_ACCEPT } from '$lib/components/resource/accept';

	/** Name, keywords, tags and the file. */
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
				toast.error(result.data?.message ?? 'Could not add the resource');
				return;
			}

			if (result.type === 'success') {
				formElement.reset();
				toast.success(result.data?.message ?? 'Resource added');
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
	<h2 class="font-medium">Add a resource</h2>
	<ResourceFields idPrefix="new" name="" keywords="" tags="" />
	<div class="grid gap-1.5">
		<Label for="resource-file">File</Label>
		<input
			id="resource-file"
			type="file"
			name="file"
			accept={RESOURCE_ACCEPT}
			required
			class="text-sm"
		/>
		<p class="text-muted-foreground text-xs">
			PDF, Word, Excel, CSV, text, Markdown or an image, up to 25 MB.
		</p>
	</div>
	<div>
		<Button type="submit" disabled={busy}>
			{#if busy}
				Uploading…
			{:else}
				Add
			{/if}
		</Button>
	</div>
</form>
