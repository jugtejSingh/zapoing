<script lang="ts">
	import MailOpenIcon from '@lucide/svelte/icons/mail-open';
	import {
		Empty,
		EmptyHeader,
		EmptyMedia,
		EmptyTitle,
		EmptyDescription
	} from '$lib/components/ui/empty/index.js';
</script>

<Empty class="flex-1">
	<EmptyHeader>
		<EmptyMedia variant="icon">
			<MailOpenIcon />
		</EmptyMedia>
		<EmptyTitle>No message selected</EmptyTitle>
		<EmptyDescription>Pick a message from the list to read it here.</EmptyDescription>
	</EmptyHeader>
</Empty>
