import { readFile } from 'node:fs/promises';
import { error } from '@sveltejs/kit';
import { downloadHeaders } from '$lib/server/attachments';
import { getOwnedVersion } from '$lib/server/files/documents';
import type { RequestHandler } from './$types';

/** Downloads one stored version of a tracked person's document. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		error(401, 'Not signed in');
	}

	const version = await getOwnedVersion(locals.user.id, params.versionId);

	if (version === null) {
		error(404, 'File not found');
	}

	let content: Buffer;

	try {
		content = await readFile(version.path);
	} catch {
		error(404, 'File not found');
	}

	return new Response(new Uint8Array(content), {
		headers: downloadHeaders(version.filename, content.length)
	});
};
