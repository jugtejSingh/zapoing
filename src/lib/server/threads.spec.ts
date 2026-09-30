import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { DATABASE_URL: ':memory:', CREDENTIALS_KEY: 'a'.repeat(64) }
}));

vi.mock('imapflow', async () => ({
	ImapFlow: (await import('./testing/fakeImap')).FakeImapFlow
}));

import { eq } from 'drizzle-orm';
import { db } from './db';
import { contact, thread } from './db/schema';
import { listContactEmails, listContactEmailsPage } from './threads';
import { syncAccount } from './mailSync';
import type { MailAccountCredentials } from './mailAccount';
import {
	addFolder,
	createFakeServer,
	deliver,
	folderOf,
	resetFakeServers,
	type FakeFolder
} from './testing/fakeImap';
import { createTestAccount, createTestUser, migrateTestDb, resetTestDb } from './testing/testDb';

let account: MailAccountCredentials;
let inboxFolder: FakeFolder;

beforeAll(() => {
	migrateTestDb();
});

/** Five separate threads from the same sender, all attributed to one tracked contact. */
beforeEach(async () => {
	await resetTestDb();
	resetFakeServers();
	await createTestUser('user-1');

	account = await createTestAccount('user-1', 'work@example.com', 'Work');
	const server = createFakeServer('work@example.com');
	const inbox = folderOf(server, 'INBOX');
	inboxFolder = inbox;
	addFolder(server, 'Sent', '\\Sent');

	for (let index = 0; index < 5; index++) {
		deliver(inbox, {
			subject: 'Message ' + String(index),
			from: 'ally@example.com',
			date: new Date(2026, 2, index + 1),
			threadId: 'thread-' + String(index),
			labels: ['\\Inbox']
		});
	}

	await syncAccount(account);

	await db.insert(contact).values({ id: 'contact-1', userId: 'user-1', emails: ['ally@example.com'] });

	/** Stands in for what recordInsertedEmails/Rebuild would set once the contact is tracked. */
	await db.update(thread).set({ contactId: 'contact-1' }).where(eq(thread.accountId, account.id));
});

describe('listContactEmails', () => {
	it('returns only the contact\'s mail, oldest first, as full rows', async () => {
		deliver(inboxFolder, {
			subject: 'Not from the contact',
			from: 'stranger@example.com',
			date: new Date(2026, 2, 3),
			threadId: 'thread-stranger',
			labels: ['\\Inbox']
		});

		await syncAccount(account);

		const [contactRow] = await db.select().from(contact).where(eq(contact.id, 'contact-1'));
		const rows = await listContactEmails('user-1', contactRow);

		expect(rows.map((row) => row.subject)).toEqual([
			'Message 0',
			'Message 1',
			'Message 2',
			'Message 3',
			'Message 4'
		]);
		expect(rows[0].text).toBeDefined();
	});

	it('finds every match across several scan chunks', async () => {
		const inbox = inboxFolder;
		const extra = 1200;
		let expected = 5;

		for (let index = 0; index < extra; index++) {
			let sender = 'stranger@example.com';

			if (index % 3 === 0) {
				sender = 'ally@example.com';
				expected = expected + 1;
			}

			deliver(inbox, {
				subject: 'Bulk ' + String(index),
				from: sender,
				date: new Date(2026, 3, 1, 0, index),
				threadId: 'bulk-' + String(index),
				labels: ['\\Inbox']
			});
		}

		await syncAccount(account);

		const [contactRow] = await db.select().from(contact).where(eq(contact.id, 'contact-1'));
		const rows = await listContactEmails('user-1', contactRow);

		expect(rows.length).toBe(expected);

		for (let index = 1; index < rows.length; index++) {
			expect(rows[index].date!.getTime()).toBeGreaterThanOrEqual(rows[index - 1].date!.getTime());
		}
	}, 60_000);
});

describe('listContactEmailsPage', () => {
	it('pages newest first and reports whether another page follows', async () => {
		const first = await listContactEmailsPage('user-1', 'contact-1', 2, 0);
		expect(first.emails.map((row) => row.subject)).toEqual(['Message 4', 'Message 3']);
		expect(first.hasMore).toBe(true);

		const last = await listContactEmailsPage('user-1', 'contact-1', 2, 4);
		expect(last.emails.map((row) => row.subject)).toEqual(['Message 0']);
		expect(last.hasMore).toBe(false);
	});

	it('shows nothing for another user or another contact', async () => {
		await createTestUser('user-2');

		expect((await listContactEmailsPage('user-2', 'contact-1', 20, 0)).emails).toEqual([]);
		expect((await listContactEmailsPage('user-1', 'contact-2', 20, 0)).emails).toEqual([]);
	});
});
