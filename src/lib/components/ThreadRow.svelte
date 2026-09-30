<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatDate } from '$lib/format';
	import type { ThreadSummary } from '$lib/types';

	/** One thread in the inbox list: who, when, what about, and a one-line peek. */
	let {
		thread,
		active,
		showAccount
	}: { thread: ThreadSummary; active: boolean; showAccount: boolean } = $props();

	let from = $derived.by(() => {
		if (thread.from.length === 0) {
			return '(unknown sender)';
		}

		return thread.from;
	});

	let subject = $derived.by(() => {
		if (thread.subject.length === 0) {
			return '(no subject)';
		}

		return thread.subject;
	});

	let hasMeta = $derived(thread.messageCount > 1 || thread.draftCount > 0 || showAccount);
</script>

<a
	href={resolve('/home/[id]', { id: thread.id })}
	data-active={active}
	class="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent flex flex-col items-start gap-1 border-b px-4 py-3 leading-tight last:border-b-0"
>
	<div class="flex w-full items-baseline gap-2">
		<span class="truncate text-sm font-semibold">{from}</span>
		<span class="text-muted-foreground ms-auto shrink-0 text-xs">{formatDate(thread.date)}</span>
	</div>

	<span class="w-full truncate text-sm">{subject}</span>

	<span class="text-muted-foreground w-full truncate text-xs">{thread.snippet}</span>

	{#if hasMeta}
		<div class="flex w-full items-center gap-2 text-xs">
			{#if thread.draftCount > 0}
				<span class="bg-primary text-primary-foreground shrink-0 rounded px-1.5">Draft</span>
			{/if}
			{#if thread.messageCount > 1}
				<span class="bg-muted text-muted-foreground shrink-0 rounded px-1.5">
					{thread.messageCount} messages
				</span>
			{/if}
			{#if showAccount}
				<span class="text-muted-foreground truncate">{thread.accountLabel}</span>
			{/if}
		</div>
	{/if}
</a>
