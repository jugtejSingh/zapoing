import { error, fail, redirect } from '@sveltejs/kit';
import { cleanColor, cleanFont, hasLogo, removeLogo, saveLogo } from '$lib/server/branding';
import { readProfile, saveProfile, type UserProfile } from '$lib/server/profile';
import type { Actions, PageServerLoad } from './$types';

function field(formData: FormData, name: string): string {
	const value = formData.get(name);

	if (value === null) {
		return '';
	}

	return value.toString().trim();
}

/** One entry per non-blank line. */
function lines(formData: FormData, name: string): string[] {
	const result: string[] = [];

	for (const line of field(formData, name).split('\n')) {
		const trimmed = line.trim();

		if (trimmed.length > 0) {
			result.push(trimmed);
		}
	}

	return result;
}

export const load: PageServerLoad = async (event) => {
	if (!event.locals.user) {
		redirect(302, '/');
	}

	return { profile: await readProfile(), hasLogo: await hasLogo() };
};

export const actions: Actions = {
	save: async (event) => {
		if (!event.locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await event.request.formData();
		const profile: UserProfile = {
			name: field(formData, 'name'),
			role: field(formData, 'role'),
			company: field(formData, 'company'),
			companyDescription: field(formData, 'companyDescription'),
			signature: field(formData, 'signature'),
			signOff: field(formData, 'signOff'),
			writingStyle: {
				tone: field(formData, 'tone'),
				length: field(formData, 'length'),
				phrasesUse: lines(formData, 'phrasesUse'),
				phrasesAvoid: lines(formData, 'phrasesAvoid')
			},
			timezone: field(formData, 'timezone'),
			workingHours: field(formData, 'workingHours'),
			standingRules: lines(formData, 'standingRules'),
			branding: {
				font: cleanFont(field(formData, 'font')),
				primaryColor: cleanColor(field(formData, 'primaryColor')),
				headerText: field(formData, 'headerText'),
				footerText: field(formData, 'footerText')
			}
		};

		await saveProfile(profile);

		return { saved: true };
	},

	logo: async (event) => {
		if (!event.locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await event.request.formData();
		const file = formData.get('logo');

		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Choose a PNG or JPEG file' });
		}

		const saved = await saveLogo(Buffer.from(await file.arrayBuffer()));

		if (!saved) {
			return fail(400, { message: 'The logo must be a PNG or JPEG under 2 MB' });
		}

		return { saved: true };
	},

	removeLogo: async (event) => {
		if (!event.locals.user) {
			error(401, 'Not signed in');
		}

		await removeLogo();

		return { saved: true };
	}
};
