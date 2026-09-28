import { readFile } from 'node:fs/promises';
import { error } from '@sveltejs/kit';
import { downloadHeaders } from '$lib/server/attachments';
import { getOwnedGenerated } from '$lib/server/files/generated';
import type { RequestHandler } from './$types';

/** Downloads a file the document agent made for a draft. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		error(401, 'Not signed in');
	}

	const generated = await getOwnedGenerated(locals.user.id, params.id);

	if (generated === null || generated.path === null) {
		error(404, 'File not found');
	}

	let content: Buffer;

	try {
		content = await readFile(generated.path);
	} catch {
		error(404, 'File not found');
	}

	return new Response(new Uint8Array(content), {
		headers: downloadHeaders(generated.filename, content.length)
	});
};
