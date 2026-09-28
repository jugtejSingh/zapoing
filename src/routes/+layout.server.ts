import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async (event) => {
	if (event.locals.user && event.url.pathname === '/') {
		redirect(302, '/home');
	}

	return {};
};
