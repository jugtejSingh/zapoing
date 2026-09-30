<script lang="ts">
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import { resolve } from '$app/paths';
	import { Badge } from '$lib/components/ui/badge';
	import { formatDate } from '$lib/format';
	import { infiniteScroll } from '$lib/actions/infiniteScroll';
	import type { PersonEmail, PersonEmailPage } from '$lib/types';

	let {
		personId,
		emails,
		hasMoreEmails
	}: { personId: string; emails: PersonEmail[]; hasMoreEmails: boolean } = $props();

	let loadedEmails = $state<PersonEmail[]>([]);
	let hasMore = $state(false);
	let loadingMore = false;

	$effect(() => {
		loadedEmails = emails;
		hasMore = hasMoreEmails;
	});

	async function loadMore(): Promise<void> {
		if (loadingMore || !hasMore) {
			return;
		}

		loadingMore = true;

		try {
			const response = await fetch(
				resolve('/people/[id]/emails', { id: personId }) + '?offset=' + String(loadedEmails.length)
			);
			const page: PersonEmailPage = await response.json();

			/** JSON turns dates into strings, but formatDate expects Date objects. */
			for (const message of page.emails) {
				if (message.date !== null) {
					message.date = new Date(message.date);
				}
			}

			loadedEmails = [...loadedEmails, ...page.emails];
			hasMore = page.hasMore;
		} finally {
			loadingMore = false;
		}
	}

	function displaySubject(value: string): string {
		if (value.length === 0) {
			return '(no subject)';
		}

		return value;
	}
</script>

<section class="grid gap-2">
	<h2 class="font-medium">Emails</h2>
	{#if loadedEmails.length === 0}
		<p class="text-muted-foreground text-sm">No emails with them yet.</p>
	{:else}
		<ul class="divide-y rounded-md border">
			{#each loadedEmails as message (message.id)}
				<li>
					<a
						href={resolve('/home/[id]', { id: message.id })}
						class="hover:bg-muted grid gap-1 p-3 text-sm"
					>
						<div class="flex items-center gap-2">
							{#if message.direction === 'out'}
								<Badge variant="secondary">Sent</Badge>
							{:else}
								<Badge variant="outline">Received</Badge>
							{/if}
							<span class="truncate font-medium">{displaySubject(message.subject)}</span>
							{#if message.attachments.length > 0}
								<PaperclipIcon class="text-muted-foreground size-3.5 shrink-0" />
							{/if}
							<span class="text-muted-foreground ms-auto shrink-0 text-xs">{formatDate(message.date)}</span>
						</div>
						<span class="text-muted-foreground line-clamp-1 text-xs">{message.snippet}</span>
					</a>
				</li>
			{/each}
		</ul>
		{#if hasMore}
			<div use:infiniteScroll={loadMore} class="p-2 text-center">
				<span class="text-muted-foreground text-xs">Loading more…</span>
			</div>
		{/if}
	{/if}
</section>
