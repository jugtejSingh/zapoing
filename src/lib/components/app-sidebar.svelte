<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import CommandIcon from '@lucide/svelte/icons/command';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import UsersIcon from '@lucide/svelte/icons/users';
	import PencilLineIcon from '@lucide/svelte/icons/pencil-line';
	import LayoutTemplateIcon from '@lucide/svelte/icons/layout-template';
	import LibraryIcon from '@lucide/svelte/icons/library';
	import BotIcon from '@lucide/svelte/icons/bot';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { useSidebar } from '$lib/components/ui/sidebar/context.svelte.js';
	import { infiniteScroll } from '$lib/actions/infiniteScroll';
	import NavUser from './nav-user.svelte';
	import ThreadRow from './ThreadRow.svelte';
	import ThemeToggle from './ThemeToggle.svelte';
	import SyncStatusBar from './SyncStatusBar.svelte';
	import type { SafeMailAccount } from '$lib/server/mailAccount';
	import type { SyncStatus, ThreadPage, ThreadSummary } from '$lib/types';

	let {
		threads,
		hasMoreThreads,
		accounts,
		user,
		mailError,
		draftsOnly,
		syncStatuses,
		onOpenSettings
	}: {
		threads: ThreadSummary[];
		hasMoreThreads: boolean;
		accounts: SafeMailAccount[];
		user: { name: string; email: string };
		mailError: string | null;
		draftsOnly: boolean;
		syncStatuses: SyncStatus[];
		onOpenSettings: () => void;
	} = $props();

	function threadKey(thread: ThreadSummary): string {
		return thread.accountId + '\n' + thread.threadId;
	}

	/** `base` followed by the entries of `extra` whose thread is not already in it. */
	function appendUnique(base: ThreadSummary[], extra: ThreadSummary[]): ThreadSummary[] {
		const seen = new SvelteSet<string>();
		const merged: ThreadSummary[] = [];

		for (const thread of base) {
			seen.add(threadKey(thread));
			merged.push(thread);
		}

		for (const thread of extra) {
			if (!seen.has(threadKey(thread))) {
				seen.add(threadKey(thread));
				merged.push(thread);
			}
		}

		return merged;
	}

	let loadedThreads = $state<ThreadSummary[]>([]);
	let hasMore = $state(false);
	let loadingMore = false;
	let loadedFor = '';

	/**
	 * The layout reloads every few seconds while syncing. A reload of the same list
	 * refreshes the first page but keeps the pages already scrolled in; switching
	 * tab or drafts starts over from the server's first page.
	 */
	$effect(() => {
		const listKey = String(draftsOnly);
		const firstPage = threads;
		const firstHasMore = hasMoreThreads;

		if (listKey !== loadedFor) {
			loadedFor = listKey;
			loadedThreads = firstPage;
			hasMore = firstHasMore;
			return;
		}

		const previous = untrack(() => loadedThreads);
		const scrolledIn = previous.slice(firstPage.length);

		loadedThreads = appendUnique(firstPage, scrolledIn);

		/** Only a still-full first page can have more; otherwise keep what the loaded pages said. */
		if (scrolledIn.length === 0) {
			hasMore = firstHasMore;
		}
	});

	/** Server-side search results; null while the box is empty and the normal list shows. */
	let searchResults = $state<ThreadSummary[] | null>(null);
	let searchHasMore = $state(false);
	let searchRun = 0;

	async function fetchThreads(offset: number, search: string): Promise<ThreadPage> {
		const params: string[] = ['offset=' + String(offset)];

		if (draftsOnly) {
			params.push('drafts=1');
		}

		if (search.length > 0) {
			params.push('q=' + encodeURIComponent(search));
		}

		const response = await fetch('/home/threads?' + params.join('&'));
		const page: ThreadPage = await response.json();

		/** JSON turns dates into strings, but the list (and formatDate) expect Date objects. */
		for (const thread of page.threads) {
			if (thread.date !== null) {
				thread.date = new Date(thread.date);
			}
		}

		return page;
	}

	async function loadMore(): Promise<void> {
		if (loadingMore) {
			return;
		}

		const needle = query.trim();
		loadingMore = true;

		try {
			if (needle.length > 0) {
				if (searchResults === null || !searchHasMore) {
					return;
				}

				const run = searchRun;
				const page = await fetchThreads(searchResults.length, needle);

				/** The query changed while this page was loading, so it belongs to a stale search. */
				if (run === searchRun && searchResults !== null) {
					searchResults = appendUnique(searchResults, page.threads);
					searchHasMore = page.hasMore;
				}

				return;
			}

			if (!hasMore) {
				return;
			}

			const page = await fetchThreads(loadedThreads.length, '');

			loadedThreads = appendUnique(loadedThreads, page.threads);
			hasMore = page.hasMore;
		} finally {
			loadingMore = false;
		}
	}

	const sidebar = useSidebar();

	let query = $state('');

	/** Searches the whole mailbox on the server once typing pauses; drafts changes re-run it. */
	$effect(() => {
		const needle = query.trim();
		const run = ++searchRun;

		/** Read so switching to or from drafts re-runs the search. */
		void draftsOnly;

		if (needle.length === 0) {
			searchResults = null;
			searchHasMore = false;
			return;
		}

		const timer = setTimeout(async () => {
			const page = await fetchThreads(0, needle);

			if (run === searchRun) {
				searchResults = page.threads;
				searchHasMore = page.hasMore;
			}
		}, 300);

		return () => clearTimeout(timer);
	});

	let visible = $derived(searchResults ?? loadedThreads);
	let showLoadMore = $derived(query.trim().length > 0 ? searchHasMore : hasMore);

	let mailboxName = $derived.by(() => {
		if (accounts.length === 0) {
			return 'No mailbox';
		}

		if (accounts.length > 1) {
			return 'All inboxes';
		}

		const account = accounts[0];

		if (account.label) {
			return account.label;
		}

		return account.username;
	});

	function openSettings() {
		sidebar.setOpen(true);
		onOpenSettings();
	}

	let headerLabel = $derived.by(() => {
		if (draftsOnly) {
			return 'Drafts waiting';
		}

		return 'Inbox';
	});
</script>

<Sidebar.Root collapsible="icon" class="overflow-hidden [&>[data-sidebar=sidebar]]:flex-row">
	<!-- This is the first sidebar -->
	<!-- We disable collapsible and adjust width to icon. -->
	<!-- This will make the sidebar appear as icons. -->
	<Sidebar.Root collapsible="none" class="!w-[calc(var(--sidebar-width-icon)_+_1px)] border-e">
		<Sidebar.Header>
			<Sidebar.Menu>
				<Sidebar.MenuItem>
					<Sidebar.MenuButton size="lg" class="md:h-8 md:p-0">
						{#snippet child({ props })}
							<a href={resolve('/home')} {...props}>
								<div
									class="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg"
								>
									<CommandIcon class="size-4" />
								</div>
								<div class="grid flex-1 text-start text-sm leading-tight">
									<span class="truncate font-medium">Zapoing</span>
									<span class="truncate text-xs">{mailboxName}</span>
								</div>
							</a>
						{/snippet}
					</Sidebar.MenuButton>
				</Sidebar.MenuItem>
			</Sidebar.Menu>
		</Sidebar.Header>

		<Sidebar.Content>
			<Sidebar.Group>
				<Sidebar.GroupContent class="px-1.5 md:px-0">
					<Sidebar.Menu>
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								tooltipContentProps={{ hidden: false }}
								isActive={!draftsOnly}
								class="px-2.5 md:px-2"
							>
								{#snippet tooltipContent()}
									Inbox
								{/snippet}
								{#snippet child({ props })}
									<a href={resolve('/home')} {...props}>
										<InboxIcon />
										<span>Inbox</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>

						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								tooltipContentProps={{ hidden: false }}
								isActive={draftsOnly}
								class="px-2.5 md:px-2"
							>
								{#snippet tooltipContent()}
									Drafts waiting
								{/snippet}
								{#snippet child({ props })}
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() takes no query string -->
									<a href={resolve('/home') + '?drafts=1'} {...props}>
										<PencilLineIcon />
										<span>Drafts waiting</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>

						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								tooltipContentProps={{ hidden: false }}
								onclick={openSettings}
								class="px-2.5 md:px-2"
							>
								{#snippet tooltipContent()}
									Mailboxes
								{/snippet}
								<SettingsIcon />
								<span>Mailboxes</span>
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>

						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								tooltipContentProps={{ hidden: false }}
								isActive={page.url.pathname.startsWith('/people')}
								class="px-2.5 md:px-2"
							>
								{#snippet tooltipContent()}
									People
								{/snippet}
								{#snippet child({ props })}
									<a href={resolve('/people')} {...props}>
										<UsersIcon />
										<span>People</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>

						<Sidebar.MenuItem>
							<Sidebar.MenuButton tooltipContentProps={{ hidden: false }} class="px-2.5 md:px-2">
								{#snippet tooltipContent()}
									Your profile
								{/snippet}
								{#snippet child({ props })}
									<a href={resolve('/settings/profile')} {...props}>
										<UserRoundIcon />
										<span>Your profile</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>

						<Sidebar.MenuItem>
							<Sidebar.MenuButton tooltipContentProps={{ hidden: false }} class="px-2.5 md:px-2">
								{#snippet tooltipContent()}
									Templates
								{/snippet}
								{#snippet child({ props })}
									<a href={resolve('/settings/templates')} {...props}>
										<LayoutTemplateIcon />
										<span>Templates</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>

						<Sidebar.MenuItem>
							<Sidebar.MenuButton tooltipContentProps={{ hidden: false }} class="px-2.5 md:px-2">
								{#snippet tooltipContent()}
									Resources
								{/snippet}
								{#snippet child({ props })}
									<a href={resolve('/settings/resources')} {...props}>
										<LibraryIcon />
										<span>Resources</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>

						<Sidebar.MenuItem>
							<Sidebar.MenuButton tooltipContentProps={{ hidden: false }} class="px-2.5 md:px-2">
								{#snippet tooltipContent()}
									Models
								{/snippet}
								{#snippet child({ props })}
									<a href={resolve('/settings/models')} {...props}>
										<BotIcon />
										<span>Models</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		</Sidebar.Content>

		<Sidebar.Footer>
			<NavUser {user} />
		</Sidebar.Footer>
	</Sidebar.Root>

	<!-- This is the second sidebar -->
	<!-- We disable collapsible and let it fill remaining space -->
	<Sidebar.Root collapsible="none" class="hidden w-auto min-w-0 flex-1 md:flex">
		<Sidebar.Header class="gap-3.5 border-b p-4">
			<div class="flex w-full items-center justify-between">
				<div class="text-foreground text-base font-medium">
					{headerLabel}
				</div>
				<ThemeToggle />
			</div>
			<Sidebar.Input placeholder="Type to search..." bind:value={query} />
		</Sidebar.Header>

		<Sidebar.Content>
			<Sidebar.Group class="px-0">
				<Sidebar.GroupContent>
					<SyncStatusBar {syncStatuses} />
					{#if mailError}
						<p class="text-destructive border-b p-4 text-sm">{mailError}</p>
					{/if}
					{#if accounts.length === 0}
						<p class="text-muted-foreground p-4 text-sm">
							No mailbox connected yet. Open Mailboxes to add one.
						</p>
					{:else if visible.length === 0}
						<p class="text-muted-foreground p-4 text-sm">No threads match.</p>
					{:else}
						{#each visible as thread (thread.accountId + thread.threadId)}
							<ThreadRow
								{thread}
								active={page.params.id === thread.id}
								showAccount={accounts.length > 1}
							/>
						{/each}
						{#if showLoadMore}
							<div use:infiniteScroll={loadMore} class="p-4 text-center">
								<span class="text-muted-foreground text-xs">Loading more…</span>
							</div>
						{/if}
					{/if}
				</Sidebar.GroupContent>
			</Sidebar.Group>
		</Sidebar.Content>
	</Sidebar.Root>
</Sidebar.Root>
