<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import UserIcon from '@lucide/svelte/icons/user';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import type { TrackedPerson } from '$lib/server/trackedPerson';

	let { trackedPeople }: { trackedPeople: TrackedPerson[] } = $props();

	let saving = $state(false);

	// The actions live on /home, so posting works from the message routes too.
	function submitAdd() {
		saving = true;

		return async ({ result }: { result: { type: string; data?: { message?: string } } }) => {
			saving = false;

			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Could not track that address');
				return;
			}

			if (result.type === 'success') {
				await invalidateAll();
			}
		};
	}

	function submitRemove() {
		return async ({ result }: { result: { type: string; data?: { message?: string } } }) => {
			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Could not stop tracking that address');
				return;
			}

			if (result.type === 'success') {
				await invalidateAll();
			}
		};
	}
</script>

<div class="grid gap-2">
	<Label>Tracked people</Label>
	<p class="text-muted-foreground text-xs leading-relaxed">
		AI features only run on mail to or from these addresses, so everyone else stays free.
	</p>

	{#if trackedPeople.length > 0}
		<ul class="grid gap-2">
			{#each trackedPeople as person (person.id)}
				<li class="flex items-center gap-2 text-sm">
					<UserIcon class="text-muted-foreground size-4 shrink-0" />
					<a href={resolve("/people/[id]", { id: person.id })} class="truncate hover:underline">{person.email}</a>
					<form
						method="post"
						action="/home?/removeTrackedPerson"
						use:enhance={submitRemove}
						class="ml-auto"
					>
						<input type="hidden" name="id" value={person.id} />
						<Button type="submit" variant="ghost" size="icon" class="size-6">
							<XIcon class="size-3.5" />
						</Button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}

	<form
		method="post"
		action="/home?/addTrackedPerson"
		use:enhance={submitAdd}
		class="flex items-end gap-2"
	>
		<Input name="email" type="email" placeholder="someone@example.com" required class="flex-1" />
		<Button type="submit" disabled={saving}>
			{#if saving}
				Adding…
			{:else}
				Track
			{/if}
		</Button>
	</form>
</div>
