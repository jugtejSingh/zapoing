import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { DATABASE_URL: ':memory:', CREDENTIALS_KEY: 'a'.repeat(64) }
}));

vi.mock('imapflow', async () => ({
	ImapFlow: (await import('./testing/fakeImap')).FakeImapFlow
}));

import { and, asc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { email } from '$lib/server/db/schema';
import { getMailboxState } from './mailboxState';
import { syncAccount } from './mailSync';
import type { MailAccountCredentials } from './mailAccount';
import {
	addFolder,
	createFakeServer,
	deliver,
	expunge,
	folderOf,
	relabel,
	renumber,
	resetFakeServers,
	type FakeFolder,
	type FakeServer
} from './testing/fakeImap';
import { createTestAccount, createTestUser, migrateTestDb, resetTestDb } from './testing/testDb';

async function storedRows(accountId: string, mailbox: string) {
	return db
		.select()
		.from(email)
		.where(and(eq(email.accountId, accountId), eq(email.mailbox, mailbox)))
		.orderBy(asc(email.uid));
}

async function storedUids(accountId: string, mailbox: string): Promise<number[]> {
	const uids: number[] = [];

	for (const row of await storedRows(accountId, mailbox)) {
		uids.push(row.uid);
	}

	return uids;
}

function deliverMany(folder: FakeFolder, howMany: number): void {
	for (let index = 1; index <= howMany; index++) {
		deliver(folder, { subject: 'Message ' + String(index) });
	}
}

let server: FakeServer;
let inbox: FakeFolder;
let account: MailAccountCredentials;

beforeAll(() => {
	migrateTestDb();
});

beforeEach(async () => {
	await resetTestDb();
	resetFakeServers();

	await createTestUser('user-1');
	account = await createTestAccount('user-1', 'me@example.com');
	server = createFakeServer('me@example.com');
	inbox = folderOf(server, 'INBOX');
});

describe('first sync (backfill)', () => {
	it('stores every message in INBOX and Sent, not just the newest few', async () => {
		deliverMany(inbox, 250);
		const sent = addFolder(server, '[Gmail]/Sent Mail', '\\Sent');
		deliverMany(sent, 3);

		await syncAccount(account);

		const inboxRows = await storedRows(account.id, 'INBOX');
		expect(inboxRows).toHaveLength(250);
		expect(inboxRows[0].uid).toBe(1);
		expect(inboxRows[249].uid).toBe(250);

		for (const row of inboxRows) {
			expect(row.direction).toBe('in');
		}

		const sentRows = await storedRows(account.id, '[Gmail]/Sent Mail');
		expect(sentRows).toHaveLength(3);

		for (const row of sentRows) {
			expect(row.direction).toBe('out');
		}

		/** The whole folder is asked for by uid, never by sequence number. */
		expect(server.fetchLog[0]).toBe('1:*');

		const state = await getMailboxState(account.id, 'INBOX');
		expect(state?.lastUid).toBe(250);
		expect(state?.uidValidity).toBe(1);
	});

	it('keeps rows cached before full sync existed and does not duplicate them', async () => {
		deliverMany(inbox, 250);

		/** The old code cached the newest 25 with no mailbox_state row. */
		const oldIds: string[] = [];

		for (let uid = 226; uid <= 250; uid++) {
			const inserted = await db
				.insert(email)
				.values({
					accountId: account.id,
					mailbox: 'INBOX',
					uid,
					uidValidity: 1,
					from: 'old',
					to: 'old',
					subject: 'old ' + String(uid),
					text: '',
					snippet: ''
				})
				.returning({ id: email.id });
			oldIds.push(inserted[0].id);
		}

		await syncAccount(account);

		const rows = await storedRows(account.id, 'INBOX');
		expect(rows).toHaveLength(250);

		const ids = new Set<string>();

		for (const row of rows) {
			ids.add(row.id);
		}

		for (const oldId of oldIds) {
			expect(ids.has(oldId)).toBe(true);
		}
	});

	it('works when the account has no Sent folder', async () => {
		deliverMany(inbox, 2);

		await syncAccount(account);

		expect(await storedUids(account.id, 'INBOX')).toEqual([1, 2]);
		expect(server.fetchLog).toEqual(['1:*']);
	});

	it('resumes an interrupted backfill from the last saved batch', async () => {
		deliverMany(inbox, 250);
		server.failAfterMessages = 150;

		await expect(syncAccount(account)).rejects.toThrow('Connection dropped');

		/** Batch one (100 rows) was committed before the drop, the 50 after it were not. */
		expect(await storedRows(account.id, 'INBOX')).toHaveLength(100);
		expect((await getMailboxState(account.id, 'INBOX'))?.lastUid).toBe(100);

		server.failAfterMessages = null;
		await syncAccount(account);

		expect(server.fetchLog[server.fetchLog.length - 1]).toBe('101:*');
		expect(await storedRows(account.id, 'INBOX')).toHaveLength(250);
		expect((await getMailboxState(account.id, 'INBOX'))?.lastUid).toBe(250);
	});

	it('reports progress as batches land', async () => {
		deliverMany(inbox, 250);
		const reports: string[] = [];

		await syncAccount(account, (done, total) => {
			reports.push(String(done) + '/' + String(total));
		});

		/** The initial 0/250 fires immediately, so the UI never freezes on a stale count. */
		expect(reports).toEqual(['0/250', '100/250', '200/250', '250/250']);
	});

	it('stores the headers a reply is addressed and threaded from', async () => {
		deliver(inbox, {
			subject: 'Headers',
			cc: 'Team <team@example.com>',
			replyTo: 'Desk <desk@example.com>'
		});

		await syncAccount(account);

		const [row] = await storedRows(account.id, 'INBOX');
		expect(row.cc).toContain('team@example.com');
		expect(row.replyTo).toContain('desk@example.com');
		expect(row.messageId).not.toBeNull();
		expect(row.references).toEqual([]);
	});
});

describe('later syncs', () => {
	it('fetches only uids after the last one seen', async () => {
		deliverMany(inbox, 5);
		await syncAccount(account);
		server.fetchLog = [];

		deliver(inbox, { subject: 'New one' });
		deliver(inbox, { subject: 'New two' });
		await syncAccount(account);

		/** Bodies come only from 6 on. The second fetch is the flags-only category check on 1–5. */
		expect(server.fetchLog).toEqual(['6:*', '1:5 changedSince=6']);
		expect(await storedUids(account.id, 'INBOX')).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	it('stores nothing new when there is no new mail, even though n:* returns the newest message', async () => {
		deliverMany(inbox, 3);
		await syncAccount(account);
		const before = await storedRows(account.id, 'INBOX');

		await syncAccount(account);

		expect(await storedRows(account.id, 'INBOX')).toEqual(before);
	});

	it('handles uid gaps left by deletes', async () => {
		deliverMany(inbox, 5);
		await syncAccount(account);

		/** Deleting the newest message: its uid is gone for good, the next mail gets 6. */
		expunge(inbox, 5);
		expunge(inbox, 2);
		await syncAccount(account);

		expect(await storedUids(account.id, 'INBOX')).toEqual([1, 3, 4]);
		expect((await getMailboxState(account.id, 'INBOX'))?.lastUid).toBe(5);

		deliver(inbox, { subject: 'After the delete' });
		await syncAccount(account);

		expect(await storedUids(account.id, 'INBOX')).toEqual([1, 3, 4, 6]);
	});

	it('removes a message deleted on the server', async () => {
		deliverMany(inbox, 3);
		await syncAccount(account);

		expunge(inbox, 2);
		await syncAccount(account);

		expect(await storedUids(account.id, 'INBOX')).toEqual([1, 3]);
	});

	it('removes every local message when the server folder is emptied', async () => {
		deliverMany(inbox, 3);
		await syncAccount(account);

		expunge(inbox, 1);
		expunge(inbox, 2);
		expunge(inbox, 3);
		await syncAccount(account);

		expect(await storedUids(account.id, 'INBOX')).toEqual([]);
	});

	it('deletes nothing when the uid search fails', async () => {
		deliverMany(inbox, 3);
		await syncAccount(account);

		expunge(inbox, 2);
		server.searchFails = true;
		await syncAccount(account);

		expect(await storedUids(account.id, 'INBOX')).toEqual([1, 2, 3]);
	});

	it('refetches the folder when UIDVALIDITY changes, dropping the old generation', async () => {
		deliverMany(inbox, 3);
		expunge(inbox, 1);
		await syncAccount(account);
		expect(await storedUids(account.id, 'INBOX')).toEqual([2, 3]);

		renumber(inbox);
		await syncAccount(account);

		const rows = await storedRows(account.id, 'INBOX');
		expect(rows).toHaveLength(2);

		for (const row of rows) {
			expect(row.uidValidity).toBe(2);
		}

		expect(await storedUids(account.id, 'INBOX')).toEqual([1, 2]);

		const state = await getMailboxState(account.id, 'INBOX');
		expect(state?.uidValidity).toBe(2);
		expect(state?.lastUid).toBe(2);
	});
});

describe('categories', () => {
	it('tags each message with its Gmail tab on backfill', async () => {
		deliver(inbox, { subject: 'Primary', labels: ['\\Inbox'] });
		deliver(inbox, { subject: 'Promo', labels: ['\\Inbox', '\\CategoryPromotions'] });
		deliver(inbox, { subject: 'Social', labels: ['\\CategorySocial'] });
		deliver(inbox, { subject: 'Updates', labels: ['\\CategoryUpdates'] });
		deliver(inbox, { subject: 'Forums', labels: ['\\CategoryForums'] });
		deliver(inbox, { subject: 'Not Gmail' });

		await syncAccount(account);

		const categories: Record<string, string | null> = {};

		for (const row of await storedRows(account.id, 'INBOX')) {
			categories[row.subject] = row.category;
		}

		expect(categories).toEqual({
			Primary: null,
			Promo: 'promotions',
			Social: 'social',
			Updates: 'updates',
			Forums: 'forums',
			'Not Gmail': null
		});
	});

	it('picks up a message moved to another tab, fetching only changed flags', async () => {
		deliver(inbox, { subject: 'One', labels: ['\\Inbox'] });
		deliver(inbox, { subject: 'Two', labels: ['\\Inbox'] });
		await syncAccount(account);

		const modseqBefore = inbox.highestModseq;
		relabel(inbox, 1, ['\\Inbox', '\\CategoryPromotions']);
		await syncAccount(account);

		const rows = await storedRows(account.id, 'INBOX');
		expect(rows[0].category).toBe('promotions');
		expect(rows[1].category).toBe(null);

		expect(server.fetchLog).toContain('1:2 changedSince=' + String(modseqBefore));
	});

	it('skips the category refresh on a server without CONDSTORE', async () => {
		inbox.noModseq = true;
		deliverMany(inbox, 2);
		await syncAccount(account);
		await syncAccount(account);

		for (const entry of server.fetchLog) {
			expect(entry).not.toContain('changedSince');
		}
	});
});
