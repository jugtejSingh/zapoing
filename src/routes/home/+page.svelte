<script lang="ts">
	import MailOpenIcon from '@lucide/svelte/icons/mail-open';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import {
		Empty,
		EmptyHeader,
		EmptyMedia,
		EmptyTitle,
		EmptyDescription
	} from '$lib/components/ui/empty/index.js';
</script>

<div class="flex h-full flex-col">
	<div class="border-b p-4">
		<Sidebar.Trigger class="-ms-1" />
	</div>

<Empty class="flex-1">
	<EmptyHeader>
		<EmptyMedia variant="icon">
			<MailOpenIcon />
		</EmptyMedia>
		<EmptyTitle>No message selected</EmptyTitle>
		<EmptyDescription>Pick a message from the list to read it here.</EmptyDescription>
	</EmptyHeader>
</Empty>
</div>
