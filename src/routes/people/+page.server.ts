import { redirect } from '@sveltejs/kit';
import { listPeopleWithMemory } from '$lib/server/peopleList';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(302, '/');
	}

	return { people: await listPeopleWithMemory(locals.user.id) };
};
