import { error, json } from '@sveltejs/kit';
import { listContactEmailsPage } from '$lib/server/threads';
import type { RequestHandler } from './$types';

const PAGE_SIZE = 20;

/** One more page of a contact's emails, for the person page's infinite scroll. */
export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) {
		error(401, 'Not signed in');
	}

	const offset = Number(event.url.searchParams.get('offset') ?? '0');

	const page = await listContactEmailsPage(
		event.locals.user.id,
		event.params.id,
		PAGE_SIZE,
		offset
	);

	return json(page);
};
