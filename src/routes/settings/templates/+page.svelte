<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import TemplateCard from '$lib/components/template/TemplateCard.svelte';
	import TemplateUploadForm from '$lib/components/template/TemplateUploadForm.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let processing = $derived(data.templates.some((item) => item.status === 'processing'));

	/** While the model is finding fields, check back every few seconds. */
	$effect(() => {
		if (!processing) {
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
	<title>Templates · Zapoing</title>
</svelte:head>

<main class="mx-auto grid max-w-2xl gap-6 p-6">
	<div class="flex items-center justify-between">
		<h1 class="text-xl font-semibold">Templates</h1>
		<a href={resolve('/home')} class="text-muted-foreground text-sm hover:underline">
			Back to inbox
		</a>
	</div>

	<p class="text-muted-foreground text-sm">
		Your standard documents, like an NDA. When someone asks for one, the draft fills in their
		details and attaches it. Anything it cannot find is left for you to fill before sending.
	</p>

	<TemplateUploadForm />

	{#if data.templates.length === 0}
		<p class="text-muted-foreground text-sm">No templates yet.</p>
	{:else}
		<ul class="grid gap-3">
			{#each data.templates as item (item.id)}
				<TemplateCard {item} />
			{/each}
		</ul>
	{/if}
</main>
