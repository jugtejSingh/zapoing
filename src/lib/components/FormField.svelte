<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';

	let {
		name,
		label,
		value,
		hint = '',
		multiline = false
	}: { name: string; label: string; value: string; hint?: string; multiline?: boolean } = $props();
</script>

<div class="grid gap-1.5">
	<Label for={name}>{label}</Label>
	{#if multiline}
		<Textarea id={name} {name} {value} rows={4} />
	{:else}
		<Input id={name} {name} {value} />
	{/if}
	{#if hint.length > 0}
		<p class="text-muted-foreground text-xs">{hint}</p>
	{/if}
</div>
