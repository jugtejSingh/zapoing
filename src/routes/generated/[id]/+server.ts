import { error } from '@sveltejs/kit';
import { downloadHeaders } from '$lib/server/attachments';
import { deliverable, getOwnedGenerated } from '$lib/server/files/generated';
import type { RequestHandler } from './$types';

/** Downloads a file the document agent made for a draft, as the recipient will get it. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		error(401, 'Not signed in');
	}

	const generated = await getOwnedGenerated(locals.user.id, params.id);

	if (generated === null || generated.path === null) {
		error(404, 'File not found');
	}

	let file: Awaited<ReturnType<typeof deliverable>>;

	try {
		file = await deliverable(generated);
	} catch (caught) {
		console.error('Could not prepare the download:', caught);
		error(500, caught instanceof Error ? caught.message : 'Could not prepare the file');
	}

	return new Response(new Uint8Array(file.content), {
		headers: downloadHeaders(file.filename, file.content.length)
	});
};
