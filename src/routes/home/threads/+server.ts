import { error, json } from '@sveltejs/kit';
import { listCachedThreads } from '$lib/server/mailCache';
import type { RequestHandler } from './$types';

const PAGE_SIZE = 20;

/** One more page of the combined inbox, for the sidebar's infinite scroll. */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) {
		error(401, 'Not signed in');
	}

	const draftsOnly = event.url.searchParams.get('drafts') === '1';
	const offset = Number(event.url.searchParams.get('offset') ?? '0');

	const search = event.url.searchParams.get('q') ?? '';

	const page = await listCachedThreads(
		event.locals.user.id,
		draftsOnly,
		PAGE_SIZE,
		offset,
		search
	);

	return json(page);
};
