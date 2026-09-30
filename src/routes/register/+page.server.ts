import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import { auth } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

/** Signed-in users have no reason to register again. */
export const load: PageServerLoad = async (event) => {
	if (event.locals.user) {
		redirect(302, '/home');
	}
};

export const actions: Actions = {
	default: async (event) => {
		const formData = await event.request.formData();
		const email = formData.get('email')?.toString() ?? '';
		const password = formData.get('password')?.toString() ?? '';
		const name = formData.get('name')?.toString() ?? '';

		if (email.length === 0 || password.length === 0) {
			return fail(400, { message: 'Email and password are required' });
		}

		let displayName = name;

		if (displayName.length === 0) {
			displayName = email;
		}

		try {
			await auth.api.signUpEmail({
				body: { email, password, name: displayName },
				headers: event.request.headers
			});
		} catch (error) {
			if (error instanceof APIError) {
				return fail(400, { message: error.message || 'Registration failed' });
			}

			return fail(500, { message: 'Unexpected error' });
		}

		redirect(302, '/home');
	}
};
