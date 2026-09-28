<script lang="ts">
	import { tick } from 'svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';

	let { tracked }: { tracked: boolean } = $props();

	let form: HTMLFormElement;
	let checked = $derived(tracked);

	async function changed() {
		/** Lets the hidden input pick up the new value before the form posts. */
		await tick();
		form.requestSubmit();
	}

	function submitToggle() {
		return async ({ result }: { result: { type: string } }) => {
			if (result.type !== 'success') {
				toast.error('Could not change tracking');
			}

			await invalidateAll();
		};
	}
</script>

<form bind:this={form} method="post" action="?/toggleTracked" use:enhance={submitToggle}>
	<input type="hidden" name="tracked" value={String(checked)} />
	<div class="flex items-center gap-2">
		<Switch id="tracked" bind:checked onCheckedChange={changed} />
		<Label for="tracked">Tracked</Label>
	</div>
</form>
