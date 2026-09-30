<script lang="ts">
	import { resolve } from '$app/paths';
	import PersonCard from '$lib/components/person/PersonCard.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>People · Zapoing</title>
</svelte:head>

<main class="mx-auto grid max-w-3xl gap-6 p-6">
	<div class="flex items-center justify-between gap-4">
		<h1 class="text-xl font-semibold">People</h1>
		<a href={resolve('/home')} class="text-muted-foreground text-sm hover:underline">Back to inbox</a>
	</div>

	{#if data.people.length === 0}
		<p class="text-muted-foreground text-sm">
			No tracked people yet. Track someone from their page to have the AI keep a memory of them.
		</p>
	{:else}
		{#each data.people as person (person.id)}
			<PersonCard {person} />
		{/each}
	{/if}
</main>
