<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';

	/** The name input, shared by the upload and edit forms. */
	let { idPrefix, name }: { idPrefix: string; name: string } = $props();
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
