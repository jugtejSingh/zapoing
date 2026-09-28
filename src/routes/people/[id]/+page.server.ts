import { error, fail, redirect } from '@sveltejs/kit';
import { readSummary, saveUserEdit, type MemoryRebuildPayload } from '$lib/server/ai/agents/memory';
import { listContactDocuments, mergeDocuments } from '$lib/server/files/documents';
import { enqueueJob } from '$lib/server/jobs/worker';
import { listContactEmailsPage } from '$lib/server/threads';
import { getContact, setTracked } from '$lib/server/trackedPerson';
import type { Actions, PageServerLoad } from './$types';

export const PERSON_EMAILS_PAGE_SIZE = 20;

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) {
		redirect(302, '/');
	}

	const person = await getContact(locals.user.id, params.id);

	if (person === null) {
		error(404, 'Person not found');
	}

	const summary = await readSummary(person.id);
	/** Newest first. Only threads with contactId set, i.e. found by the initial sync or a Rebuild. */
	const page = await listContactEmailsPage(locals.user.id, person.id, PERSON_EMAILS_PAGE_SIZE, 0);

	return {
		person: {
			id: person.id,
			name: person.name,
			company: person.company,
			emails: person.emails,
			tracked: person.tracked
		},
		summary,
		emails: page.emails,
		hasMoreEmails: page.hasMore,
		documents: await listContactDocuments(locals.user.id, person.id)
	};
};

export const actions: Actions = {
	saveSummary: async ({ params, locals, request }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();
		const summary = formData.get('summary')?.toString() ?? '';

		if (summary.trim().length === 0) {
			return fail(400, { message: 'The summary is empty' });
		}

		await saveUserEdit(locals.user.id, params.id, summary);
		return { saved: true };
	},

	rebuild: async ({ params, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const person = await getContact(locals.user.id, params.id);

		if (person === null) {
			return fail(404, { message: 'Person not found' });
		}

		const payload: MemoryRebuildPayload = { userId: locals.user.id, contactId: person.id };
		await enqueueJob('memory.rebuild', payload);
		return { rebuilding: true };
	},

	toggleTracked: async ({ params, locals, request }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();
		const tracked = formData.get('tracked')?.toString() === 'true';

		await setTracked(locals.user.id, params.id, tracked);
		return { tracked };
	},

	/** Folds one document's versions into another when the filename match missed a revision. */
	mergeDocuments: async ({ locals, request }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();
		const keepId = formData.get('keepId')?.toString() ?? '';
		const mergeId = formData.get('mergeId')?.toString() ?? '';

		if (keepId.length === 0 || mergeId.length === 0) {
			return fail(400, { message: 'Pick a document to merge' });
		}

		try {
			await mergeDocuments(locals.user.id, keepId, mergeId);
		} catch (caught) {
			let message = 'Could not merge the documents';

			if (caught instanceof Error) {
				message = caught.message;
			}

			return fail(400, { message });
		}

		return { merged: true };
	}
};
