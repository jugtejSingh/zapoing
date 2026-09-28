import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { DATABASE_URL: ':memory:', CREDENTIALS_KEY: 'a'.repeat(64) }
}));

vi.mock('imapflow', async () => ({
	ImapFlow: (await import('./testing/fakeImap')).FakeImapFlow
}));

import { db } from '$lib/server/db';
import { email } from '$lib/server/db/schema';
import { GET } from '../../routes/attachments/[emailId]/[index]/+server';
import { syncAccount } from './mailSync';
import {
	createFakeServer,
	deliver,
	folderOf,
	renumber,
	resetFakeServers,
	type FakeFolder
} from './testing/fakeImap';
import { createTestAccount, createTestUser, migrateTestDb, resetTestDb } from './testing/testDb';

let inbox: FakeFolder;
let emailId: string;

type Event = Parameters<typeof GET>[0];

async function download(userId: string, index: string): Promise<Response> {
	const event = {
		params: { emailId, index },
		locals: { user: { id: userId } }
	} as unknown as Event;

	return GET(event);
}

async function statusOf(promise: Promise<Response>): Promise<number> {
	try {
		const response = await promise;
		return response.status;
	} catch (caught) {
		return (caught as { status: number }).status;
	}
}

beforeAll(() => {
	migrateTestDb();
});

beforeEach(async () => {
	await resetTestDb();
	resetFakeServers();

	await createTestUser('u1');
	await createTestUser('u2');
	const account = await createTestAccount('u1', 'me@example.com');
	inbox = folderOf(createFakeServer('me@example.com'), 'INBOX');

	/** A stranger, not a tracked person: downloads work for every email. */
	deliver(inbox, {
		subject: 'Invoice',
		from: 'Shop <shop@stranger.test>',
		attachments: [
			{ filename: 'invoice.pdf', contentType: 'application/pdf', content: 'PDF-BYTES' },
			{ filename: 'page.html', contentType: 'text/html', content: '<script>alert(1)</script>' }
		]
	});
	await syncAccount(account);

	const rows = await db.select().from(email);
	emailId = rows[0].id;
});

describe('attachment download', () => {
	it('serves an untracked sender’s attachment as a forced download', async () => {
		const response = await download('u1', '0');

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('PDF-BYTES');
		expect(response.headers.get('Content-Disposition')).toContain('attachment;');
		expect(response.headers.get('Content-Disposition')).toContain('invoice.pdf');
	});

	it('never serves an HTML attachment as HTML', async () => {
		const response = await download('u1', '1');

		expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});

	it('gives another user a 404', async () => {
		expect(await statusOf(download('u2', '0'))).toBe(404);
	});

	it('gives a 404 for an index past the last attachment', async () => {
		expect(await statusOf(download('u1', '5'))).toBe(404);
	});

	it('gives a 410 once the mailbox was renumbered', async () => {
		renumber(inbox);

		expect(await statusOf(download('u1', '0'))).toBe(410);
	});
});
