<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ResourceCard from '$lib/components/resource/ResourceCard.svelte';
	import ResourceUploadForm from '$lib/components/resource/ResourceUploadForm.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let indexing = $derived(data.resources.some((item) => item.indexStatus === 'pending'));

	/** While the AI is reading a file, check back every few seconds. */
	$effect(() => {
		if (!indexing) {
			return;
		}

		const timer = setInterval(() => {
			void invalidateAll();
		}, 4000);

		return () => {
			clearInterval(timer);
		};
	});
</script>

<svelte:head>
	<title>Resources · Zapoing</title>
</svelte:head>

<main class="mx-auto grid max-w-2xl gap-6 p-6">
	<div class="flex items-center justify-between">
		<h1 class="text-xl font-semibold">Resources</h1>
		<a href={resolve('/home')} class="text-muted-foreground text-sm hover:underline">
			Back to inbox
		</a>
	</div>

	<p class="text-muted-foreground text-sm">
		Reference files like your price list or standard terms. Each file is read once by the AI when
		you add it, and the description it writes is what the drafting AI picks files by. If files
		disagree, the newest one is used and the draft warns you.
	</p>

	<ResourceUploadForm />

	{#if data.resources.length === 0}
		<p class="text-muted-foreground text-sm">No resources yet.</p>
	{:else}
		<ul class="grid gap-3">
			{#each data.resources as item (item.id)}
				<ResourceCard {item} />
			{/each}
		</ul>
	{/if}
</main>
