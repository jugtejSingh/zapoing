import { error } from '@sveltejs/kit';
import { listMailAccounts } from '$lib/server/mailAccount';
import { listCachedThreads } from '$lib/server/mailCache';
import { getSyncStatuses } from '$lib/server/syncWorker';
import { listTrackedPeople } from '$lib/server/trackedPerson';
import type { EmailCategory, SyncStatus, ThreadSummary } from '$lib/types';
import type { LayoutServerLoad } from './$types';

const CATEGORIES: EmailCategory[] = ['promotions', 'social', 'updates', 'forums'];

/** The `?category=` param, or null for the primary inbox (the default). */
function categoryFromParam(value: string | null): EmailCategory | null {
	if (value !== null && (CATEGORIES as string[]).includes(value)) {
		return value as EmailCategory;
	}

	return null;
}

/**
 * The list pane: the combined inbox across every account. Lives in the layout
 * so clicking between messages does not refetch it. Reads the local cache only —
 * the background worker keeps that cache up to date, so page loads never wait on IMAP.
 */
export const load: LayoutServerLoad = async (event) => {
	if (!event.locals.user) {
		error(401, 'Not signed in');
	}

	/** Lets the page re-run just this load while a sync is filling the cache. */
	event.depends('app:inbox');

	const userId = event.locals.user.id;
	const accounts = await listMailAccounts(userId);
	const trackedPeople = await listTrackedPeople(userId);

	const category = categoryFromParam(event.url.searchParams.get('category'));
	/** `?drafts=1`: only threads with a draft waiting, across every category. */
	const draftsOnly = event.url.searchParams.get('drafts') === '1';

	const accountIds = new Set<string>();

	for (const account of accounts) {
		accountIds.add(account.id);
	}

	const syncStatuses: SyncStatus[] = [];
	let mailError: string | null = null;

	for (const status of getSyncStatuses()) {
		if (!accountIds.has(status.accountId)) {
			continue;
		}

		syncStatuses.push(status);

		if (status.error) {
			mailError = status.error;
		}
	}

	let threads: ThreadSummary[] = [];
	let hasMoreThreads = false;

	if (accounts.length > 0) {
		const page = await listCachedThreads(userId, category, draftsOnly);
		threads = page.threads;
		hasMoreThreads = page.hasMore;
	}

	return {
		accounts,
		trackedPeople,
		threads,
		hasMoreThreads,
		category,
		draftsOnly,
		mailError,
		syncStatuses,
		user: event.locals.user
	};
};
