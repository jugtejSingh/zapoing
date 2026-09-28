<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';

	/** The name, keywords and tags inputs, shared by the upload and edit forms. */
	let {
		idPrefix,
		name,
		keywords,
		tags
	}: { idPrefix: string; name: string; keywords: string; tags: string } = $props();
</script>

<div class="grid gap-1.5">
	<Label for="{idPrefix}-name">Name</Label>
	<Input
		id="{idPrefix}-name"
		name="name"
		value={name}
		placeholder="e.g. Price list 2026"
		required
	/>
</div>
<div class="grid gap-1.5">
	<Label for="{idPrefix}-keywords">Keywords</Label>
	<Input
		id="{idPrefix}-keywords"
		name="keywords"
		value={keywords}
		placeholder="Words an email would use, e.g. price rate quote discount"
	/>
</div>
<div class="grid gap-1.5">
	<Label for="{idPrefix}-tags">Tags</Label>
	<Input id="{idPrefix}-tags" name="tags" value={tags} placeholder="e.g. finance, pricing" />
</div>
