<script lang="ts">
	import { untrack } from 'svelte';
	import { invalidate } from '$app/navigation';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import AppSidebar from '$lib/components/app-sidebar.svelte';
	import MailAccountDialog from '$lib/components/MailAccountDialog.svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	// Nothing connected yet means an empty inbox with no hint, so open it for them.
	let settingsOpen = $state(untrack(() => data.accounts.length === 0));

	function openSettings() {
		settingsOpen = true;
	}

	/** Re-reads the cache while a sync is filling it (fast), otherwise picks up the 5-minute syncs (slow). */
	$effect(() => {
		let anySyncing = false;

		for (const status of data.syncStatuses) {
			if (status.syncing) {
				anySyncing = true;
			}
		}

		let delay = 60_000;

		if (anySyncing) {
			delay = 3_000;
		}

		// PAUSED: inbox polling off (each tick re-ran the slow thread query).
		// const timer = setInterval(() => {
		// 	invalidate('app:inbox');
		// }, delay);

		return () => {
			// clearInterval(timer);
		};
	});
</script>

<svelte:head>
	<title>Inbox · Zapoing</title>
</svelte:head>

<Sidebar.Provider style="--sidebar-width: 480px;">
	<AppSidebar
		threads={data.threads}
		hasMoreThreads={data.hasMoreThreads}
		accounts={data.accounts}
		user={data.user}
		mailError={data.mailError}
		draftsOnly={data.draftsOnly}
		syncStatuses={data.syncStatuses}
		onOpenSettings={openSettings}
	/>

	<Sidebar.Inset>
		<div class="flex flex-1 flex-col overflow-hidden">
			{@render children()}
		</div>
	</Sidebar.Inset>
</Sidebar.Provider>

<MailAccountDialog
	accounts={data.accounts}
	trackedPeople={data.trackedPeople}
	bind:open={settingsOpen}
/>
