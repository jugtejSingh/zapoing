<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';

	/** One input per [[field]] still in a generated file. Blank inputs leave that field as it is. */
	let { fileId, placeholders }: { fileId: string; placeholders: string[] } = $props();

	let busy = $state(false);

	function submitFill() {
		busy = true;

		return async ({ result }: { result: { type: string; data?: { message?: string } } }) => {
			busy = false;

			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Could not update the file');
				return;
			}

			if (result.type === 'success') {
				toast.success('File updated');
				await invalidateAll();
			}
		};
	}
</script>

<form method="post" action="?/fillGenerated" use:enhance={submitFill} class="mt-1 grid gap-1.5">
	<input type="hidden" name="generatedId" value={fileId} />
	<p class="text-muted-foreground text-xs">Fill these before sending:</p>
	{#each placeholders as name (name)}
		<div class="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-2">
			<Label for="field-{fileId}-{name}" class="truncate text-xs">{name}</Label>
			<Input id="field-{fileId}-{name}" name="value:{name}" class="h-7" />
		</div>
	{/each}
	<div>
		<Button type="submit" size="sm" variant="secondary" disabled={busy}>
			{#if busy}
				Updating…
			{:else}
				Update file
			{/if}
		</Button>
	</div>
</form>
