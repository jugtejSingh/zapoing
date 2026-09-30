<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PersonListItem } from '$lib/server/peopleList';

	let { person }: { person: PersonListItem } = $props();

	let title = $derived.by(() => {
		if (person.name) {
			return person.name;
		}

		if (person.emails.length > 0) {
			return person.emails[0];
		}

		return 'Unknown person';
	});
</script>

<article class="grid gap-3 rounded-lg border p-4">
	<div class="grid gap-1">
		<h2 class="font-medium">{title}</h2>
		{#if person.company}
			<p class="text-muted-foreground text-sm">{person.company}</p>
		{/if}
		<ul class="text-muted-foreground text-sm">
			{#each person.emails as address (address)}
				<li>{address}</li>
			{/each}
		</ul>
	</div>

	{#if person.preview.length > 0}
		<p class="text-muted-foreground text-sm whitespace-pre-line">{person.preview}</p>
	{:else}
		<p class="text-muted-foreground text-sm italic">No memory yet.</p>
	{/if}

	<a href={resolve('/people/[id]', { id: person.id })} class="text-sm underline">Open memory</a>
</article>
