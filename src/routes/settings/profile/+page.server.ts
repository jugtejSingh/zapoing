import { error, redirect } from '@sveltejs/kit';
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

	return { profile: await readProfile() };
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
			standingRules: lines(formData, 'standingRules')
		};

		await saveProfile(profile);

		return { saved: true };
	}
};
