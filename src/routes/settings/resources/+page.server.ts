import { error, fail, redirect } from '@sveltejs/kit';
import {
	createResource,
	deleteResource,
	listResources,
	replaceResourceFile,
	ResourceInputError,
	updateResource
} from '$lib/server/resources';
import { indexRows } from '$lib/server/fileIndex';
import type { ResourceSummary } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

function field(formData: FormData, name: string): string {
	const value = formData.get(name);

	if (typeof value !== 'string') {
		return '';
	}

	return value.trim();
}

/** An empty file input still posts one nameless, empty file. */
function uploadedFile(formData: FormData): File | null {
	const value = formData.get('file');

	if (value instanceof File && value.size > 0) {
		return value;
	}

	return null;
}

/** A problem the user can fix becomes a 400 with its message; anything else is rethrown. */
function inputFailure(caught: unknown) {
	if (caught instanceof ResourceInputError) {
		return fail(400, { message: caught.message });
	}

	throw caught;
}

export const load: PageServerLoad = async (event) => {
	if (!event.locals.user) {
		redirect(302, '/');
	}

	const resources: ResourceSummary[] = [];

	const rows = await listResources(event.locals.user.id);
	const ids: string[] = [];

	for (const row of rows) {
		ids.push(row.id);
	}

	const index = await indexRows('resource', ids);

	for (const row of rows) {
		let description = '';
		let indexStatus: ResourceSummary['indexStatus'] = 'pending';
		let indexError: string | null = null;
		const indexed = index.get(row.id);

		if (indexed !== undefined) {
			description = indexed.description;
			indexStatus = indexed.status;
			indexError = indexed.error;
		}

		resources.push({
			id: row.id,
			name: row.name,
			filename: row.filename,
			updatedAt: row.updatedAt,
			description,
			indexStatus,
			indexError
		});
	}

	return { resources };
};

export const actions: Actions = {
	upload: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();
		const file = uploadedFile(formData);

		if (file === null) {
			return fail(400, { message: 'Choose a file' });
		}

		try {
			await createResource(locals.user.id, {
				name: field(formData, 'name'),
				file
			});
		} catch (caught) {
			return inputFailure(caught);
		}

		return { message: 'Resource added' };
	},

	update: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();

		try {
			const updated = await updateResource(locals.user.id, field(formData, 'resourceId'), {
				name: field(formData, 'name')
			});

			if (!updated) {
				return fail(404, { message: 'Resource not found' });
			}
		} catch (caught) {
			return inputFailure(caught);
		}

		return { message: 'Resource saved' };
	},

	replace: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();
		const file = uploadedFile(formData);

		if (file === null) {
			return fail(400, { message: 'Choose a file' });
		}

		try {
			if (!(await replaceResourceFile(locals.user.id, field(formData, 'resourceId'), file))) {
				return fail(404, { message: 'Resource not found' });
			}
		} catch (caught) {
			return inputFailure(caught);
		}

		return { message: 'File replaced' };
	},

	delete: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();

		if (!(await deleteResource(locals.user.id, field(formData, 'resourceId')))) {
			return fail(404, { message: 'Resource not found' });
		}

		return { message: 'Resource deleted' };
	}
};
