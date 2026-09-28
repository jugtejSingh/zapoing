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
		labels: ['\\Inbox']
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
		labels: ['\\Inbox']
	});
	deliver(workInbox, {
		subject: 'Sale',
		date: new Date('2026-03-02T09:00:00Z'),
		threadId: 'thread-sale',
		labels: ['\\CategoryPromotions']
	});

	const personalServer = createFakeServer('me@example.com');
	const personalInbox = folderOf(personalServer, 'INBOX');

	deliver(personalInbox, {
		subject: 'Dinner',
		date: new Date('2026-03-03T18:00:00Z'),
		threadId: 'thread-dinner',
		labels: ['\\Inbox']
	});
	deliver(personalInbox, {
		subject: 'New reply in your topic',
		date: new Date('2026-03-04T08:00:00Z'),
		threadId: 'thread-forum',
		labels: ['\\CategoryForums']
	});

	await syncAccount(work);
	await syncAccount(personal);
});

describe('listCachedThreads', () => {
	it('combines every account into one primary inbox, newest first', async () => {
		const { threads } = await listCachedThreads('user-1', null);

		const summary: string[] = [];

		for (const thread of threads) {
			summary.push(
				thread.accountLabel + ': ' + thread.subject + ' x' + String(thread.messageCount)
			);
		}

		/** Sent replies stay out of the list, so the contract thread counts its two received messages. */
		expect(summary).toEqual(['me@example.com: Dinner x1', 'Work: Re: Contract x2']);
	});

	it('shows each tab only its own category, across accounts', async () => {
		const promotions = (await listCachedThreads('user-1', 'promotions')).threads;
		expect(promotions).toHaveLength(1);
		expect(promotions[0].subject).toBe('Sale');
		expect(promotions[0].accountId).toBe(work.id);

		const forums = (await listCachedThreads('user-1', 'forums')).threads;
		expect(forums).toHaveLength(1);
		expect(forums[0].accountId).toBe(personal.id);

		expect((await listCachedThreads('user-1', 'social')).threads).toEqual([]);
	});

	it('shows nothing to another user', async () => {
		await createTestUser('user-2');

		expect((await listCachedThreads('user-2', null)).threads).toEqual([]);
	});
});

describe('getCachedThread', () => {
	it('returns the whole thread, including the reply sent from this account, oldest first', async () => {
		const { threads } = await listCachedThreads('user-1', null);
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
		const { threads } = await listCachedThreads('user-1', null);

		expect(await getCachedThread('user-2', threads[0].id)).toEqual([]);
	});

	it('returns nothing for an unknown id', async () => {
		expect(await getCachedThread('user-1', 'no-such-id')).toEqual([]);
	});
});
