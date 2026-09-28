<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';

	let { summary }: { summary: string } = $props();

	let saving = $state(false);
	let rebuilding = $state(false);

	type Result = { type: string; data?: { message?: string } };

	function submitSave() {
		saving = true;

		return async ({ result }: { result: Result }) => {
			saving = false;

			if (result.type === 'success') {
				toast.success('Summary saved');
				await invalidateAll();
			} else {
				toast.error(result.data?.message ?? 'Could not save the summary');
			}
		};
	}

	function submitRebuild() {
		rebuilding = true;

		return async ({ result }: { result: Result }) => {
			rebuilding = false;

			if (result.type === 'success') {
				toast.success('Rebuilding from all their mail. Refresh in a minute.');
			} else {
				toast.error(result.data?.message ?? 'Could not start the rebuild');
			}
		};
	}
</script>

<section class="grid gap-2">
	<div class="flex items-center justify-between">
		<h2 class="font-medium">Summary</h2>
		<form method="post" action="?/rebuild" use:enhance={submitRebuild}>
			<Button type="submit" variant="outline" size="sm" disabled={rebuilding}>Rebuild</Button>
		</form>
	</div>
	<p class="text-muted-foreground text-xs">
		Updated by the AI on every message. Anything under "## My notes" is yours and is never changed.
	</p>

	<form method="post" action="?/saveSummary" use:enhance={submitSave} class="grid gap-2">
		{#key summary}
			<Textarea
				name="summary"
				value={summary}
				rows={20}
				class="font-mono text-sm"
				placeholder="No summary yet. It fills in with the next message, or press Rebuild."
			/>
		{/key}
		<div>
			<Button type="submit" disabled={saving}>Save</Button>
		</div>
	</form>
</section>
