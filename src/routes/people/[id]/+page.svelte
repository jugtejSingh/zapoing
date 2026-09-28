<script lang="ts">
	import { resolve } from '$app/paths';
	import PersonDocuments from '$lib/components/person/PersonDocuments.svelte';
	import PersonEmails from '$lib/components/person/PersonEmails.svelte';
	import SummaryEditor from '$lib/components/person/SummaryEditor.svelte';
	import TrackingToggle from '$lib/components/person/TrackingToggle.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let title = $derived.by(() => {
		if (data.person.name) {
			return data.person.name;
		}

		return data.person.emails.join(', ');
	});
</script>

<svelte:head>
	<title>{title} · Zapoing</title>
</svelte:head>

<main class="mx-auto grid max-w-3xl gap-8 p-6">
	<div class="flex items-start justify-between gap-4">
		<div class="grid gap-1">
			<h1 class="text-xl font-semibold">{title}</h1>
			{#if data.person.company}
				<p class="text-muted-foreground text-sm">{data.person.company}</p>
			{/if}
			<p class="text-muted-foreground text-sm">{data.person.emails.join(', ')}</p>
		</div>
		<div class="flex items-center gap-4">
			<TrackingToggle tracked={data.person.tracked} />
			<a href={resolve('/home')} class="text-muted-foreground text-sm hover:underline">Back to inbox</a>
		</div>
	</div>

	<SummaryEditor summary={data.summary} />
	<PersonEmails personId={data.person.id} emails={data.emails} hasMoreEmails={data.hasMoreEmails} />
	<PersonDocuments documents={data.documents} />
</main>
