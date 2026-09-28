<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import TemplateFields from '$lib/components/template/TemplateFields.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import type { TemplateSummary } from '$lib/types';

	/** One template: status, fields, and forms to rename, replace the file or delete it. */
	let { item }: { item: TemplateSummary } = $props();

	let busy = $state(false);
	let confirmingDelete = $state(false);

	const STATUS_LABELS: Record<TemplateSummary['status'], string> = {
		processing: 'Finding fields…',
		ready: 'Ready',
		failed: 'Failed'
	};

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
		<span class="bg-muted ms-auto rounded px-1.5 text-xs">{STATUS_LABELS[item.status]}</span>
	</div>

	{#if item.status === 'failed' && item.error !== null}
		<p class="text-destructive text-sm">{item.error}. Replace the file to try again.</p>
	{/if}

	{#if item.fields.length > 0}
		<TemplateFields fields={item.fields} />
	{/if}

	<details class="text-sm">
		<summary class="text-muted-foreground cursor-pointer">Edit</summary>

		<form method="post" action="?/update" use:enhance={submitAction} class="mt-2 grid gap-2">
			<input type="hidden" name="templateId" value={item.id} />
			<div class="grid gap-1.5">
				<Label for="name-{item.id}">Name</Label>
				<Input id="name-{item.id}" name="name" value={item.name} required />
			</div>
			<div class="grid gap-1.5">
				<Label for="description-{item.id}">When to use it</Label>
				<Textarea id="description-{item.id}" name="description" value={item.description} rows={2} />
			</div>
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
			<input type="hidden" name="templateId" value={item.id} />
			<input
				type="file"
				name="file"
				accept=".docx,.xlsx,.pdf"
				required
				aria-label="New file for {item.name}"
				class="text-xs"
			/>
			<Button type="submit" size="sm" variant="outline" disabled={busy}>Replace file</Button>
		</form>

		<form method="post" action="?/delete" use:enhance={submitAction} class="mt-3">
			<input type="hidden" name="templateId" value={item.id} />
			{#if confirmingDelete}
				<span class="text-xs">Delete this template and its files?</span>
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
