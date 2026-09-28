import { error, fail, redirect } from '@sveltejs/kit';
import {
	createTemplate,
	deleteTemplate,
	listTemplates,
	replaceTemplateFile,
	TemplateInputError,
	updateTemplate
} from '$lib/server/templates';
import type { TemplateSummary } from '$lib/types';
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
	if (caught instanceof TemplateInputError) {
		return fail(400, { message: caught.message });
	}

	throw caught;
}

export const load: PageServerLoad = async (event) => {
	if (!event.locals.user) {
		redirect(302, '/');
	}

	const templates: TemplateSummary[] = [];

	for (const row of await listTemplates(event.locals.user.id)) {
		templates.push({
			id: row.id,
			name: row.name,
			description: row.description,
			filename: row.filename,
			format: row.format,
			status: row.status,
			error: row.error,
			fields: row.fields
		});
	}

	return { templates };
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
			await createTemplate(locals.user.id, {
				name: field(formData, 'name'),
				description: field(formData, 'description'),
				file
			});
		} catch (caught) {
			return inputFailure(caught);
		}

		return { message: 'Template uploaded. Finding its fields…' };
	},

	update: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();

		try {
			const updated = await updateTemplate(locals.user.id, field(formData, 'templateId'), {
				name: field(formData, 'name'),
				description: field(formData, 'description')
			});

			if (!updated) {
				return fail(404, { message: 'Template not found' });
			}
		} catch (caught) {
			return inputFailure(caught);
		}

		return { message: 'Template saved' };
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
			if (!(await replaceTemplateFile(locals.user.id, field(formData, 'templateId'), file))) {
				return fail(404, { message: 'Template not found' });
			}
		} catch (caught) {
			return inputFailure(caught);
		}

		return { message: 'File replaced. Finding its fields…' };
	},

	delete: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();

		if (!(await deleteTemplate(locals.user.id, field(formData, 'templateId')))) {
			return fail(404, { message: 'Template not found' });
		}

		return { message: 'Template deleted' };
	}
};
