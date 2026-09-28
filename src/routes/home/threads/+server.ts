import { error, json } from '@sveltejs/kit';
import { listCachedThreads } from '$lib/server/mailCache';
import type { EmailCategory } from '$lib/types';
import type { RequestHandler } from './$types';

const CATEGORIES: EmailCategory[] = ['promotions', 'social', 'updates', 'forums'];
const PAGE_SIZE = 20;

function categoryFromParam(value: string | null): EmailCategory | null {
	if (value !== null && (CATEGORIES as string[]).includes(value)) {
		return value as EmailCategory;
	}

	return null;
}

/** One more page of the combined inbox, for the sidebar's infinite scroll. */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) {
		error(401, 'Not signed in');
	}

	const category = categoryFromParam(event.url.searchParams.get('category'));
	const draftsOnly = event.url.searchParams.get('drafts') === '1';
	const offset = Number(event.url.searchParams.get('offset') ?? '0');

	const page = await listCachedThreads(
		event.locals.user.id,
		category,
		draftsOnly,
		PAGE_SIZE,
		offset
	);

	return json(page);
};
