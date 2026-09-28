<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import type { PersonDocument } from '$lib/types';

	let { keep, others }: { keep: PersonDocument; others: PersonDocument[] } = $props();

	let merging = $state(false);

	type Result = { type: string; data?: { message?: string } };

	function submitMerge() {
		merging = true;

		return async ({ result }: { result: Result }) => {
			merging = false;

			if (result.type === 'success') {
				toast.success('Documents merged');
				await invalidateAll();
			} else {
				toast.error(result.data?.message ?? 'Could not merge the documents');
			}
		};
	}
</script>

<!-- ponytail: no confirm step; merging only moves versions, nothing is lost. -->
<form
	method="post"
	action="?/mergeDocuments"
	use:enhance={submitMerge}
	class="flex items-center gap-2"
>
	<input type="hidden" name="keepId" value={keep.id} />
	<label class="text-muted-foreground text-xs" for={'merge-' + keep.id}>Merge in</label>
	<select
		id={'merge-' + keep.id}
		name="mergeId"
		required
		class="border-input bg-background h-8 max-w-48 rounded-md border px-2 text-xs"
	>
		<option value="">Pick a document…</option>
		{#each others as other (other.id)}
			<option value={other.id}>{other.name}</option>
		{/each}
	</select>
	<Button type="submit" variant="outline" size="sm" disabled={merging}>Merge</Button>
</form>
