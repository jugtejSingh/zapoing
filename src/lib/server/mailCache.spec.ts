import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { DATABASE_URL: ':memory:', CREDENTIALS_KEY: 'a'.repeat(64) }
}));

vi.mock('imapflow', async () => ({
	ImapFlow: (await import('./testing/fakeImap')).FakeImapFlow
}));

import { getCachedThread, listCachedThreads } from './mailCache';
import { syncAccount } from './mailSync';
import type { MailAccountCredentials } from './mailAccount';
import {
	addFolder,
	createFakeServer,
	deliver,
	folderOf,
	resetFakeServers
} from './testing/fakeImap';
import { createTestAccount, createTestUser, migrateTestDb, resetTestDb } from './testing/testDb';

let work: MailAccountCredentials;
let personal: MailAccountCredentials;

beforeAll(() => {
	migrateTestDb();
});

/**
 * Two accounts for one user. Work has a thread with a reply sent from Sent,
 * plus a promotion. Personal has one primary message and one forum post.
 */
beforeEach(async () => {
	await resetTestDb();
	resetFakeServers();
	await createTestUser('user-1');

	work = await createTestAccount('user-1', 'work@example.com', 'Work');
	personal = await createTestAccount('user-1', 'me@example.com');

	const workServer = createFakeServer('work@example.com');
	const workInbox = folderOf(workServer, 'INBOX');
	const workSent = addFolder(workServer, 'Sent', '\\Sent');

	deliver(workInbox, {
		subject: 'Contract',
		date: new Date('2026-03-01T10:00:00Z'),
		threadId: 'thread-contract',
	});
	deliver(workSent, {
		subject: 'Re: Contract',
		from: 'work@example.com',
		date: new Date('2026-03-01T11:00:00Z'),
		threadId: 'thread-contract'
	});
	deliver(workInbox, {
		subject: 'Re: Contract',
		date: new Date('2026-03-01T12:00:00Z'),
		threadId: 'thread-contract',
	});
	deliver(workInbox, {
		subject: 'Sale',
		date: new Date('2026-03-02T09:00:00Z'),
		threadId: 'thread-sale',
	});

	const personalServer = createFakeServer('me@example.com');
	const personalInbox = folderOf(personalServer, 'INBOX');

	deliver(personalInbox, {
		subject: 'Dinner',
		date: new Date('2026-03-03T18:00:00Z'),
		threadId: 'thread-dinner',
	});
	deliver(personalInbox, {
		subject: 'New reply in your topic',
		date: new Date('2026-03-04T08:00:00Z'),
		threadId: 'thread-forum',
	});

	await syncAccount(work);
	await syncAccount(personal);
});

describe('listCachedThreads', () => {
	it('combines every account into one inbox, newest first', async () => {
		const { threads } = await listCachedThreads('user-1');

		const summary: string[] = [];

		for (const thread of threads) {
			summary.push(
				thread.accountLabel + ': ' + thread.subject + ' x' + String(thread.messageCount)
			);
		}

		/** The contract thread is one row, headed by its newest received message, counting the sent reply too. */
		expect(summary).toEqual([
			'me@example.com: New reply in your topic x1',
			'me@example.com: Dinner x1',
			'Work: Sale x1',
			'Work: Re: Contract x3'
		]);
	});

	it('paginates in threads, not messages', async () => {
		const first = await listCachedThreads('user-1', false, 1, 0);
		expect(first.threads.map((thread) => thread.subject)).toEqual(['New reply in your topic']);
		expect(first.hasMore).toBe(true);

		const last = await listCachedThreads('user-1', false, 1, 3);
		expect(last.threads.map((thread) => thread.subject)).toEqual(['Re: Contract']);
		expect(last.threads[0].messageCount).toBe(3);
	});

	it('searches sender and subject across the whole mailbox and treats % literally', async () => {
		const bySubject = await listCachedThreads('user-1', false, 20, 0, 'sale');
		expect(bySubject.threads.map((thread) => thread.subject)).toEqual(['Sale']);

		const wildcard = await listCachedThreads('user-1', false, 20, 0, '%');
		expect(wildcard.threads).toEqual([]);

		const contract = await listCachedThreads('user-1', false, 20, 0, 'contract');
		expect(contract.threads).toHaveLength(1);
		expect(contract.threads[0].messageCount).toBe(3);
	});

	it('shows nothing to another user', async () => {
		await createTestUser('user-2');

		expect((await listCachedThreads('user-2')).threads).toEqual([]);
	});
});

describe('getCachedThread', () => {
	it('returns the whole thread, including the reply sent from this account, oldest first', async () => {
		const { threads } = await listCachedThreads('user-1');
		let contractId = '';

		for (const thread of threads) {
			if (thread.threadId === 'thread-contract') {
				contractId = thread.id;
			}
		}

		const messages = await getCachedThread('user-1', contractId);

		const directions: string[] = [];

		for (const message of messages) {
			directions.push(message.direction + ' ' + message.mailbox);
		}

		expect(directions).toEqual(['in INBOX', 'out Sent', 'in INBOX']);
	});

	it("refuses another user's email id", async () => {
		await createTestUser('user-2');
		const { threads } = await listCachedThreads('user-1');

		expect(await getCachedThread('user-2', threads[0].id)).toEqual([]);
	});

	it('returns nothing for an unknown id', async () => {
		expect(await getCachedThread('user-1', 'no-such-id')).toEqual([]);
	});
});
