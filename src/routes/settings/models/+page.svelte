<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import AgentModelFields from '$lib/components/models/AgentModelFields.svelte';
	import ApiKeyField from '$lib/components/models/ApiKeyField.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let busy = $state(false);

	function submitSettings() {
		busy = true;

		return async ({
			result,
			formElement
		}: {
			result: { type: string; data?: { message?: string } };
			formElement: HTMLFormElement;
		}) => {
			busy = false;

			if (result.type === 'failure') {
				toast.error(result.data?.message ?? 'Could not save the settings');
				return;
			}

			if (result.type === 'success') {
				const keyInput = formElement.elements.namedItem('apiKey');

				if (keyInput instanceof HTMLInputElement) {
					keyInput.value = '';
				}

				toast.success(result.data?.message ?? 'Settings saved');
				await invalidateAll();
			}
		};
	}
</script>

<svelte:head>
	<title>Models · Zapoing</title>
</svelte:head>

<main class="mx-auto grid max-w-2xl gap-6 p-6">
	<div class="flex items-center justify-between">
		<h1 class="text-xl font-semibold">Models</h1>
		<a href={resolve('/home')} class="text-muted-foreground text-sm hover:underline">
			Back to inbox
		</a>
	</div>

	<p class="text-muted-foreground text-sm">
		Which OpenRouter model each agent uses. These apply to the whole app and override .env. A blank
		model uses the default.
	</p>

	<form
		method="post"
		action="?/save"
		use:enhance={submitSettings}
		class="grid gap-4 rounded-lg border p-4"
	>
		<ApiKeyField keySource={data.settings.keySource} keyEnding={data.settings.keyEnding} />

		<AgentModelFields
			agents={data.agents}
			models={data.settings.models}
			defaultModel={data.defaultModel}
		/>

		<div class="grid gap-1.5">
			<Label for="thread-budget">Thread budget (tokens)</Label>
			<Input
				id="thread-budget"
				name="threadBudgetTokens"
				type="number"
				min={data.minBudget}
				max={data.maxBudget}
				step="1"
				value={data.settings.threadBudgetTokens ?? ''}
				placeholder="8000"
			/>
			<p class="text-muted-foreground text-xs">
				Older messages are cut once a thread goes over this.
			</p>
		</div>

		<div>
			<Button type="submit" disabled={busy}>
				{#if busy}
					Saving…
				{:else}
					Save
				{/if}
			</Button>
		</div>
	</form>
</main>
