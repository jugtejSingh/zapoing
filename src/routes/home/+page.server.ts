import { error, fail, redirect } from '@sveltejs/kit';
import { createMailAccount } from '$lib/server/mailAccount';
import { requestSync } from '$lib/server/syncWorker';
import { addTrackedPerson, removeTrackedPerson } from '$lib/server/trackedPerson';
import { auth } from '$lib/server/auth';
import type { Actions } from './$types';

export const actions: Actions = {
	addAccount: async (event) => {
		if (!event.locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await event.request.formData();
		const label = formData.get('label')?.toString().trim() ?? '';
		const host = formData.get('host')?.toString().trim() ?? '';
		const port = Number(formData.get('port')?.toString() ?? '993');
		const username = formData.get('username')?.toString().trim() ?? '';
		const password = formData.get('password')?.toString() ?? '';

		if (host.length === 0 || username.length === 0 || password.length === 0) {
			return fail(400, { message: 'Host, email address and password are required' });
		}

		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			return fail(400, { message: 'Port must be a number between 1 and 65535' });
		}

		/** Blank SMTP fields mean "work it out from the IMAP host" at send time. */
		const smtpHostText = formData.get('smtpHost')?.toString().trim() ?? '';
		const smtpPortText = formData.get('smtpPort')?.toString().trim() ?? '';
		let smtpHost: string | null = null;
		let smtpPort: number | null = null;

		if (smtpHostText.length > 0) {
			smtpHost = smtpHostText;
		}

		if (smtpPortText.length > 0) {
			smtpPort = Number(smtpPortText);

			if (!Number.isInteger(smtpPort) || smtpPort <= 0 || smtpPort > 65535) {
				return fail(400, { message: 'SMTP port must be a number between 1 and 65535' });
			}
		}

		let storedLabel: string | null = label;

		if (label.length === 0) {
			storedLabel = null;
		}

		try {
			await createMailAccount(event.locals.user.id, {
				label: storedLabel,
				host,
				port,
				secure: true,
				username,
				password,
				smtpHost,
				smtpPort
			});
		} catch {
			return fail(400, { message: 'That mailbox is already connected' });
		}

		/** Start the new account's backfill now rather than at the next 5-minute tick. */
		void requestSync();

		return { message: 'Mailbox connected' };
	},

	addTrackedPerson: async (event) => {
		if (!event.locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await event.request.formData();
		const email = formData.get('email')?.toString().trim() ?? '';

		if (email.length === 0) {
			return fail(400, { message: 'Email address is required' });
		}

		await addTrackedPerson(event.locals.user.id, email);

		return { message: 'Now tracking that address' };
	},

	removeTrackedPerson: async (event) => {
		if (!event.locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await event.request.formData();
		const id = formData.get('id')?.toString() ?? '';

		if (id.length === 0) {
			return fail(400, { message: 'Missing id' });
		}

		await removeTrackedPerson(event.locals.user.id, id);

		return { message: 'Stopped tracking that address' };
	},

	signOut: async (event) => {
		await auth.api.signOut({ headers: event.request.headers });

		redirect(302, '/');
	}
};
