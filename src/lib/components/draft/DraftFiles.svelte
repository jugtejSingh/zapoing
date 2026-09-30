<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { toast } from 'svelte-sonner';
	import FileFieldsForm from '$lib/components/draft/FileFieldsForm.svelte';
	import { Button } from '$lib/components/ui/button';
	import type { DraftFile } from '$lib/types';

	/** The documents the reply will carry: download, what changed, or why it failed. */
	let { files }: { files: DraftFile[] } = $props();

	let busy = $state(false);

	function submitRemove() {
		busy = true;

		return async ({ result }: { result: { type: string; data?: { message?: string } } }) => {
			busy = false;

			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Could not remove the file');
				return;
			}

			if (result.type === 'success') {
				await invalidateAll();
			}
		};
	}
</script>

{#if files.length > 0}
	<ul class="grid gap-1">
		{#each files as file (file.id)}
			<li class="rounded-md border px-2 py-1.5">
				<div class="flex items-center gap-2">
					{#if file.error === null}
						<FileTextIcon class="size-4 shrink-0" />
						<a
							href={resolve('/generated/[id]', { id: file.id })}
							class="truncate font-medium underline-offset-2 hover:underline"
						>
							{file.filename}
						</a>
						{#if file.isNewDocument}
							<span class="text-muted-foreground text-xs">new</span>
						{/if}
					{:else}
						<TriangleAlertIcon class="text-destructive size-4 shrink-0" />
						<span class="truncate">{file.filename}</span>
					{/if}

					<form method="post" action="?/removeGenerated" use:enhance={submitRemove} class="ms-auto">
						<input type="hidden" name="generatedId" value={file.id} />
						<Button type="submit" size="sm" variant="ghost" disabled={busy}>Remove</Button>
					</form>
				</div>

				{#if file.error !== null}
					<p class="text-destructive text-xs">Could not make "{file.change}": {file.error}</p>
				{:else if file.changeNote.length > 0}
					<details open class="text-sm">
						<summary class="cursor-pointer font-medium">What changed</summary>
						<p class="mt-1 whitespace-pre-wrap">{file.changeNote}</p>
					</details>
				{/if}

				{#if file.error === null && file.placeholders.length > 0}
					<FileFieldsForm fileId={file.id} placeholders={file.placeholders} />
				{/if}
			</li>
		{/each}
	</ul>
{/if}
