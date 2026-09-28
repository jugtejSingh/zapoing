<script lang="ts">
	import CommandIcon from '@lucide/svelte/icons/command';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import MegaphoneIcon from '@lucide/svelte/icons/megaphone';
	import UsersIcon from '@lucide/svelte/icons/users';
	import BellIcon from '@lucide/svelte/icons/bell';
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import UserRoundIcon from '@lucide/svelte/icons/user-round';
	import PencilLineIcon from '@lucide/svelte/icons/pencil-line';
	import LayoutTemplateIcon from '@lucide/svelte/icons/layout-template';
	import LibraryIcon from '@lucide/svelte/icons/library';
	import BotIcon from '@lucide/svelte/icons/bot';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { useSidebar } from '$lib/components/ui/sidebar/context.svelte.js';
	import { formatDate } from '$lib/format';
	import { infiniteScroll } from '$lib/actions/infiniteScroll';
	import NavUser from './nav-user.svelte';
	import ThemeToggle from './ThemeToggle.svelte';
	import SyncStatusBar from './SyncStatusBar.svelte';
	import type { SafeMailAccount } from '$lib/server/mailAccount';
	import type { EmailCategory, SyncStatus, ThreadPage, ThreadSummary } from '$lib/types';

	let {
		threads,
		hasMoreThreads,
		accounts,
		user,
		mailError,
		category,
		draftsOnly,
		syncStatuses,
		onOpenSettings
	}: {
		threads: ThreadSummary[];
		hasMoreThreads: boolean;
		accounts: SafeMailAccount[];
		user: { name: string; email: string };
		mailError: string | null;
		category: EmailCategory | null;
		draftsOnly: boolean;
		syncStatuses: SyncStatus[];
		onOpenSettings: () => void;
	} = $props();

	/**
	 * ponytail: resets to the server's first page whenever it changes, which also
	 * happens on the background sync's periodic invalidate — so a scrolled-down list
	 * can snap back to page 1 mid-sync. Acceptable for now; revisit if that's jarring.
	 */
	let loadedThreads = $state<ThreadSummary[]>([]);
	let hasMore = $state(false);
	let loadingMore = false;

	$effect(() => {
		loadedThreads = threads;
		hasMore = hasMoreThreads;
	});

	async function loadMore(): Promise<void> {
		if (loadingMore || !hasMore) {
			return;
		}

		loadingMore = true;

		try {
			const params: string[] = ['offset=' + String(loadedThreads.length)];

			if (category !== null) {
				params.push('category=' + category);
			}

			if (draftsOnly) {
				params.push('drafts=1');
			}

			const response = await fetch('/home/threads?' + params.join('&'));
			const page: ThreadPage = await response.json();

			loadedThreads = [...loadedThreads, ...page.threads];
			hasMore = page.hasMore;
		} finally {
			loadingMore = false;
		}
	}

	const CATEGORY_TABS: { value: EmailCategory | null; label: string; icon: typeof InboxIcon }[] = [
		{ value: null, label: 'Inbox', icon: InboxIcon },
		{ value: 'promotions', label: 'Promotions', icon: MegaphoneIcon },
		{ value: 'social', label: 'Social', icon: UsersIcon },
		{ value: 'updates', label: 'Updates', icon: BellIcon },
		{ value: 'forums', label: 'Forums', icon: MessagesSquareIcon }
	];

	function categoryHref(value: EmailCategory | null): string {
		if (value === null) {
			return resolve('/home');
		}

		return resolve('/home') + '?category=' + value;
	}

	const sidebar = useSidebar();

	let query = $state('');

	let visible = $derived.by(() => {
		const needle = query.trim().toLowerCase();

		if (needle.length === 0) {
			return loadedThreads;
		}

		const matches: ThreadSummary[] = [];

		for (const thread of loadedThreads) {
			const haystack = (thread.from + ' ' + thread.subject + ' ' + thread.snippet).toLowerCase();

			if (haystack.includes(needle)) {
				matches.push(thread);
			}
		}

		return matches;
	});

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

	function displayFrom(value: string): string {
		if (value.length === 0) {
			return '(unknown sender)';
		}

		return value;
	}

	function draftLabel(count: number): string {
		if (count === 1) {
			return '1 draft';
		}

		return String(count) + ' drafts';
	}

	let headerLabel = $derived.by(() => {
		if (draftsOnly) {
			return 'Drafts waiting';
		}

		for (const tab of CATEGORY_TABS) {
			if (tab.value === category) {
				return tab.label;
			}
		}

		return 'Inbox';
	});

	function displaySubject(value: string): string {
		if (value.length === 0) {
			return '(no subject)';
		}

		return value;
	}
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
						{#each CATEGORY_TABS as tab (tab.label)}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton
									tooltipContentProps={{ hidden: false }}
									isActive={!draftsOnly && category === tab.value}
									class="px-2.5 md:px-2"
								>
									{#snippet tooltipContent()}
										{tab.label}
									{/snippet}
									{#snippet child({ props })}
										<a href={categoryHref(tab.value)} {...props}>
											<tab.icon />
											<span>{tab.label}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						{/each}

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
							<a
								href={resolve('/home/[id]', { id: thread.id })}
								data-active={page.params.id === thread.id}
								class="hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent flex flex-col items-start gap-2 border-b p-4 text-sm leading-tight whitespace-nowrap last:border-b-0"
							>
								<div class="flex w-full items-center gap-2">
									<span class="truncate">{displayFrom(thread.from)}</span>
									{#if thread.messageCount > 1}
										<span class="bg-muted text-muted-foreground shrink-0 rounded px-1.5 text-xs">
											{thread.messageCount}
										</span>
									{/if}
									{#if thread.draftCount > 0}
										<span
											class="bg-primary text-primary-foreground shrink-0 rounded px-1.5 text-xs"
										>
											{draftLabel(thread.draftCount)}
										</span>
									{/if}
									<span class="ms-auto shrink-0 text-xs">{formatDate(thread.date)}</span>
								</div>
								<span class="w-full truncate font-medium">{displaySubject(thread.subject)}</span>
								{#if accounts.length > 1}
									<span class="text-muted-foreground w-full truncate text-xs">
										{thread.accountLabel}
									</span>
								{/if}
								<span class="line-clamp-2 w-full text-xs whitespace-break-spaces">
									{thread.snippet}
								</span>
							</a>
						{/each}
						{#if hasMore && query.trim().length === 0}
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
