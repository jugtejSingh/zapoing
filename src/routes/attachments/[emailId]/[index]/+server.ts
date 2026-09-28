import { error } from '@sveltejs/kit';
import { AttachmentGoneError, downloadHeaders, fetchEmailAttachments } from '$lib/server/attachments';
import type { RequestHandler } from './$types';

/** Downloads one attachment of any of the user's emails, fetched live from IMAP. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		error(401, 'Not signed in');
	}

	const index = Number(params.index);

	if (!Number.isInteger(index) || index < 0) {
		error(404, 'Attachment not found');
	}

	let files;

	try {
		files = await fetchEmailAttachments(locals.user.id, params.emailId);
	} catch (caught) {
		if (caught instanceof AttachmentGoneError) {
			error(410, caught.message);
		}

		throw caught;
	}

	if (files === null || index >= files.length) {
		error(404, 'Attachment not found');
	}

	const file = files[index];

	return new Response(new Uint8Array(file.content), {
		headers: downloadHeaders(file.filename, file.content.length)
	});
};
