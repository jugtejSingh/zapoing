<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';

	/** The key input. The saved key never reaches the browser, only its last 4 characters. */
	let {
		keySource,
		keyEnding
	}: { keySource: 'settings' | 'env' | 'none'; keyEnding: string | null } = $props();
</script>

<div class="grid gap-1.5">
	<Label for="model-api-key">API key</Label>
	<Input
		id="model-api-key"
		name="apiKey"
		type="password"
		autocomplete="off"
		placeholder="Leave blank to keep the current key"
	/>
	<div class="text-muted-foreground flex items-center gap-2 text-xs">
		{#if keySource === 'settings'}
			<span>Saved here, ends in …{keyEnding}</span>
			<Button type="submit" formaction="?/clearKey" formnovalidate variant="outline" size="sm">
				Clear
			</Button>
		{:else if keySource === 'env'}
			<span>Using MODEL_API_KEY from .env</span>
		{:else}
			<span>Not set. Drafting won't work until you add one.</span>
		{/if}
	</div>
</div>
