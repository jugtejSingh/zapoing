<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import ResourceFields from '$lib/components/resource/ResourceFields.svelte';
	import ResourceIndexStatus from '$lib/components/resource/ResourceIndexStatus.svelte';
	import { RESOURCE_ACCEPT } from '$lib/components/resource/accept';
	import { Button } from '$lib/components/ui/button';
	import { formatDate } from '$lib/format';
	import type { ResourceSummary } from '$lib/types';

	/** One resource: its details, and forms to edit, replace the file or delete it. */
	let { item }: { item: ResourceSummary } = $props();

	let busy = $state(false);
	let confirmingDelete = $state(false);

	function submitAction() {
		busy = true;

		return async ({
			result,
			formElement
		}: {
			result: { type: string; data?: { message?: string } };
			formElement: HTMLFormElement;
		}) => {
			busy = false;
			confirmingDelete = false;

			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Something went wrong');
				return;
			}

			if (result.type === 'success') {
				if (formElement.enctype === 'multipart/form-data') {
					formElement.reset();
				}

				toast.success(result.data?.message ?? 'Done');
				await invalidateAll();
			}
		};
	}
</script>

<li class="grid gap-3 rounded-lg border p-4">
	<div class="flex flex-wrap items-center gap-2">
		<h2 class="font-medium">{item.name}</h2>
		<span class="text-muted-foreground text-xs">{item.filename}</span>
		<span class="text-muted-foreground ms-auto text-xs">Updated {formatDate(item.updatedAt)}</span>
	</div>

	<ResourceIndexStatus {item} />

	<details class="text-sm">
		<summary class="text-muted-foreground cursor-pointer">Edit</summary>

		<form method="post" action="?/update" use:enhance={submitAction} class="mt-2 grid gap-2">
			<input type="hidden" name="resourceId" value={item.id} />
			<ResourceFields idPrefix={item.id} name={item.name} />
			<div>
				<Button type="submit" size="sm" variant="secondary" disabled={busy}>Save</Button>
			</div>
		</form>

		<form
			method="post"
			action="?/replace"
			enctype="multipart/form-data"
			use:enhance={submitAction}
			class="mt-3 flex flex-wrap items-center gap-2"
		>
			<input type="hidden" name="resourceId" value={item.id} />
			<input
				type="file"
				name="file"
				accept={RESOURCE_ACCEPT}
				required
				aria-label="New file for {item.name}"
				class="text-xs"
			/>
			<Button type="submit" size="sm" variant="outline" disabled={busy}>Replace file</Button>
		</form>

		<form method="post" action="?/delete" use:enhance={submitAction} class="mt-3">
			<input type="hidden" name="resourceId" value={item.id} />
			{#if confirmingDelete}
				<span class="text-xs">Delete this resource and its file?</span>
				<Button type="submit" size="sm" variant="destructive" disabled={busy}>Delete</Button>
				<Button type="button" size="sm" variant="ghost" onclick={() => (confirmingDelete = false)}>
					Cancel
				</Button>
			{:else}
				<Button type="button" size="sm" variant="ghost" onclick={() => (confirmingDelete = true)}>
					Delete…
				</Button>
			{/if}
		</form>
	</details>
</li>
