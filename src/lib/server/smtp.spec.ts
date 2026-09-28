import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { DATABASE_URL: ':memory:', CREDENTIALS_KEY: 'a'.repeat(64) }
}));

vi.mock('imapflow', async () => ({
	ImapFlow: (await import('./testing/fakeImap')).FakeImapFlow
}));

/** Tests must never send real mail: every transport records instead of sending. */
const smtp = vi.hoisted(() => ({
	transportOptions: [] as unknown[],
	sent: [] as { envelope: { from: string; to: string[] }; raw: Buffer }[],
	failWith: null as Error | null
}));

vi.mock('nodemailer', () => ({
	default: {
		createTransport: (options: unknown) => {
			smtp.transportOptions.push(options);

			return {
				sendMail: async (mail: { envelope: { from: string; to: string[] }; raw: Buffer }) => {
					if (smtp.failWith) {
						throw smtp.failWith;
					}

					smtp.sent.push(mail);
				}
			};
		}
	}
}));

vi.mock('./syncWorker', () => ({ requestSync: async () => {} }));

import { and, eq } from 'drizzle-orm';
import { simpleParser } from 'mailparser';
import { db } from '$lib/server/db';
import { email } from '$lib/server/db/schema';
import { createMailAccount, listAllMailAccountCredentials } from './mailAccount';
import type { MailAccountCredentials } from './mailAccount';
import { syncAccount } from './mailSync';
import { MAX_ATTACHMENT_BYTES, sendReply } from './smtp';
import {
	addFolder,
	createFakeServer,
	deliver,
	folderOf,
	resetFakeServers,
	type FakeServer
} from './testing/fakeImap';
import { createTestAccount, createTestUser, migrateTestDb, resetTestDb } from './testing/testDb';

async function cachedEmailId(accountId: string, uid: number): Promise<string> {
	const rows = await db
		.select()
		.from(email)
		.where(and(eq(email.accountId, accountId), eq(email.uid, uid)));

	return rows[0].id;
}

async function createGmailAccount(
	userId: string,
	username: string
): Promise<MailAccountCredentials> {
	await createMailAccount(userId, {
		label: null,
		host: 'imap.gmail.com',
		port: 993,
		secure: true,
		username,
		password: 'secret'
	});

	for (const account of await listAllMailAccountCredentials()) {
		if (account.username === username) {
			return account;
		}
	}

	throw new Error('Account was not stored');
}

/** Delivers a message to INBOX and syncs it, returning the cached email id. */
async function receive(server: FakeServer, account: MailAccountCredentials): Promise<string> {
	const uid = deliver(folderOf(server, 'INBOX'), {
		subject: 'Quarterly numbers',
		from: 'Boss <boss@example.com>'
	});

	await syncAccount(account);

	return cachedEmailId(account.id, uid);
}

beforeAll(() => {
	migrateTestDb();
});

beforeEach(async () => {
	await resetTestDb();
	resetFakeServers();
	smtp.transportOptions = [];
	smtp.sent = [];
	smtp.failWith = null;
	await createTestUser('user-1');
});

describe('sendReply', () => {
	it('replies from the receiving account with threading headers', async () => {
		const server = createFakeServer('me@example.com');
		addFolder(server, 'Sent', '\\Sent');
		const account = await createTestAccount('user-1', 'me@example.com');
		const emailId = await receive(server, account);

		await sendReply('user-1', emailId, { body: 'Looks good.', cc: '', attachments: [] });

		expect(smtp.sent).toHaveLength(1);
		expect(smtp.transportOptions[0]).toMatchObject({
			host: 'smtp.example.com',
			port: 465,
			secure: true,
			auth: { user: 'me@example.com', pass: 'secret' }
		});
		expect(smtp.sent[0].envelope).toEqual({
			from: 'me@example.com',
			to: ['boss@example.com']
		});

		const original = await simpleParser(folderOf(server, 'INBOX').messages[0].source);
		const reply = await simpleParser(smtp.sent[0].raw);

		expect(reply.subject).toBe('Re: Quarterly numbers');
		expect(reply.from?.text).toBe('me@example.com');
		expect(reply.inReplyTo).toBe(original.messageId);
		expect(reply.references).toBe(original.messageId);
		expect(reply.text?.trim()).toBe('Looks good.');

		/** Non-Gmail servers need the copy filed in Sent by us. */
		const sent = folderOf(server, 'Sent').messages;
		expect(sent).toHaveLength(1);
		expect(sent[0].source.equals(smtp.sent[0].raw)).toBe(true);
	});

	it('does not file a copy in Sent on Gmail', async () => {
		const server = createFakeServer('me@gmail.com');
		addFolder(server, '[Gmail]/Sent Mail', '\\Sent');
		const account = await createGmailAccount('user-1', 'me@gmail.com');
		const emailId = await receive(server, account);

		await sendReply('user-1', emailId, { body: 'Thanks', cc: '', attachments: [] });

		expect(smtp.transportOptions[0]).toMatchObject({ host: 'smtp.gmail.com' });
		expect(smtp.sent).toHaveLength(1);
		expect(folderOf(server, '[Gmail]/Sent Mail').messages).toHaveLength(0);
	});

	it("refuses to reply to another user's email", async () => {
		await createTestUser('user-2');
		const server = createFakeServer('me@example.com');
		const account = await createTestAccount('user-1', 'me@example.com');
		const emailId = await receive(server, account);

		await expect(
			sendReply('user-2', emailId, { body: 'Hi', cc: '', attachments: [] })
		).rejects.toThrow('Email not found');
		expect(smtp.sent).toHaveLength(0);
	});

	it('reports a refused send and files nothing in Sent', async () => {
		const server = createFakeServer('me@example.com');
		addFolder(server, 'Sent', '\\Sent');
		const account = await createTestAccount('user-1', 'me@example.com');
		const emailId = await receive(server, account);
		smtp.failWith = new Error('535 Authentication failed');

		await expect(
			sendReply('user-1', emailId, { body: 'Hi', cc: '', attachments: [] })
		).rejects.toThrow('535');
		expect(folderOf(server, 'Sent').messages).toHaveLength(0);
	});

	it('follows up a sent email to its original recipients', async () => {
		const server = createFakeServer('me@example.com');
		const sentFolder = addFolder(server, 'Sent', '\\Sent');
		const account = await createTestAccount('user-1', 'me@example.com');
		const uid = deliver(sentFolder, {
			subject: 'Proposal',
			from: 'me@example.com',
			to: 'Client <client@example.com>'
		});
		await syncAccount(account);
		const emailId = await cachedEmailId(account.id, uid);

		await sendReply('user-1', emailId, { body: 'Any thoughts?', cc: '', attachments: [] });

		expect(smtp.sent[0].envelope.to).toEqual(['client@example.com']);
	});

	it('copies the Cc addresses into the header and the envelope', async () => {
		const server = createFakeServer('me@example.com');
		const account = await createTestAccount('user-1', 'me@example.com');
		const emailId = await receive(server, account);

		await sendReply('user-1', emailId, {
			body: 'Looping in finance.',
			cc: 'Finance <finance@example.com>',
			attachments: []
		});

		expect(smtp.sent[0].envelope.to).toEqual(['boss@example.com', 'finance@example.com']);

		const reply = await simpleParser(smtp.sent[0].raw);
		let ccText = '';

		if (reply.cc && !Array.isArray(reply.cc)) {
			ccText = reply.cc.text;
		}

		expect(ccText).toContain('finance@example.com');
	});

	it('sends attachments and files them with the Sent copy', async () => {
		const server = createFakeServer('me@example.com');
		addFolder(server, 'Sent', '\\Sent');
		const account = await createTestAccount('user-1', 'me@example.com');
		const emailId = await receive(server, account);

		await sendReply('user-1', emailId, {
			body: 'Numbers attached.',
			cc: '',
			attachments: [
				{ filename: 'q3.csv', contentType: 'text/csv', content: Buffer.from('a,b\n1,2\n') }
			]
		});

		const reply = await simpleParser(smtp.sent[0].raw);
		expect(reply.attachments).toHaveLength(1);
		expect(reply.attachments[0].filename).toBe('q3.csv');
		expect(reply.attachments[0].content.toString()).toBe('a,b\n1,2\n');

		const sent = folderOf(server, 'Sent').messages;
		expect(sent[0].source.equals(smtp.sent[0].raw)).toBe(true);
	});

	it('uses a custom SMTP server with STARTTLS off port 465', async () => {
		const server = createFakeServer('me@custom.com');
		await createMailAccount('user-1', {
			label: null,
			host: 'imap.custom.com',
			port: 993,
			secure: true,
			username: 'me@custom.com',
			password: 'secret',
			smtpHost: 'mail.custom.com',
			smtpPort: 587
		});
		const accounts = await listAllMailAccountCredentials();
		const emailId = await receive(server, accounts[0]);

		await sendReply('user-1', emailId, { body: 'Hi', cc: '', attachments: [] });

		expect(smtp.transportOptions[0]).toMatchObject({
			host: 'mail.custom.com',
			port: 587,
			secure: false
		});
	});

	it('refuses attachments over the size limit and sends nothing', async () => {
		const server = createFakeServer('me@example.com');
		const account = await createTestAccount('user-1', 'me@example.com');
		const emailId = await receive(server, account);
		const tooBig = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);

		await expect(
			sendReply('user-1', emailId, {
				body: 'Hi',
				cc: '',
				attachments: [
					{ filename: 'big.bin', contentType: 'application/octet-stream', content: tooBig }
				]
			})
		).rejects.toThrow('25 MB');
		expect(smtp.sent).toHaveLength(0);
	});

	it('refuses a reply that still has placeholders and sends nothing', async () => {
		const server = createFakeServer('me@example.com');
		const account = await createTestAccount('user-1', 'me@example.com');
		const emailId = await receive(server, account);

		await expect(
			sendReply('user-1', emailId, { body: 'Free at [[start-time]].', cc: '', attachments: [] })
		).rejects.toThrow('placeholder');
		expect(smtp.sent).toHaveLength(0);
	});
});
