<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';

	/** One model name per agent. Blank uses the default. */
	let {
		agents,
		models,
		defaultModel
	}: { agents: string[]; models: Record<string, string>; defaultModel: string } = $props();
</script>

<fieldset class="grid gap-2">
	<legend class="mb-1 text-sm font-medium">Model per agent</legend>
	{#each agents as agent (agent)}
		<div class="grid grid-cols-[8rem_1fr] items-center gap-2">
			<Label for="model-{agent}" class="capitalize">{agent}</Label>
			<Input
				id="model-{agent}"
				name="model-{agent}"
				value={models[agent]}
				placeholder={defaultModel}
			/>
		</div>
	{/each}
</fieldset>
