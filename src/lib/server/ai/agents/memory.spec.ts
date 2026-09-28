import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
	return 'memory-spec-' + String(Date.now());
});

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const nodePath = await import('node:path');
	const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), dataDir));

	return {
		env: {
			MODEL_API_KEY: 'test-key',
			MODEL_BASE_URL: 'https://model.test/v1/',
			DATABASE_URL: ':memory:',
			CREDENTIALS_KEY: 'a'.repeat(64),
			DATA_DIR: dir
		}
	};
});

import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { email, summaryVersion } from '$lib/server/db/schema';
import { addTrackedPerson, findContactByEmail } from '$lib/server/trackedPerson';
import { createTestAccount, createTestUser, migrateTestDb, resetTestDb } from '$lib/server/testing/testDb';
import { extractMyNotes, readSummary, rebuildSummary, saveUserEdit, updateSummary } from './memory';

const fetchMock = vi.fn();

function okReply(text: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

const MODEL_SUMMARY = '## Who they are\nAnna, buyer at Acme.\n\n## How to write to them\nShort.\n\n## Active threads\n### Order\nWants a quote.\n\n## Closed threads\n';

let contactId: string;
let emailId: string;
let accountId: string;

async function insertEmail(accountId: string, uid: number, text: string, threadId = 't1'): Promise<string> {
	const rows = await db
		.insert(email)
		.values({
			accountId,
			uid,
			uidValidity: 1,
			from: 'Anna <anna@acme.test>',
			to: 'me@example.com',
			subject: 'Order',
			date: new Date(),
			text,
			snippet: text,
			threadId
		})
		.returning();

	return rows[0].id;
}

beforeAll(() => {
	migrateTestDb();
});

beforeEach(async () => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockImplementation(async () => {
		return okReply(MODEL_SUMMARY);
	});

	await resetTestDb();
	await createTestUser('u1');
	accountId = (await createTestAccount('u1', 'me@example.com')).id;
	await addTrackedPerson('u1', 'anna@acme.test');

	const found = await findContactByEmail('u1', 'anna@acme.test');

	if (found === null) {
		throw new Error('contact missing');
	}

	contactId = found.id;
	emailId = await insertEmail(accountId, 1, 'Can you send a quote?');
});

describe('extractMyNotes', () => {
	it('returns the section up to the next heading', () => {
		const text = '## Who they are\nx\n\n## My notes\nlikes tea\n\n## Active threads\ny';
		expect(extractMyNotes(text)).toBe('## My notes\nlikes tea');
	});
});

describe('memory agent', () => {
	it('writes a summary from a new message', async () => {
		await updateSummary({ contactId, emailId });

		expect(await readSummary(contactId)).toContain('Anna, buyer at Acme.');
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(body.messages[1].content).toContain('[NEW MESSAGE]');
		expect(body.messages[1].content).toContain('Can you send a quote?');
	});

	it('keeps My notes verbatim and archives the old summary', async () => {
		await saveUserEdit('u1', contactId, '## Who they are\nold\n\n## My notes\nNever call before 10.');
		await updateSummary({ contactId, emailId });

		const summary = await readSummary(contactId);
		expect(summary).toContain('Anna, buyer at Acme.');
		expect(summary).toContain('## My notes\nNever call before 10.');
		expect(summary).not.toContain('\nold\n');

		const versions = await db.select().from(summaryVersion);
		expect(versions.length).toBe(1);
		expect(versions[0].reason).toBe('update');
		expect(existsSync(versions[0].path)).toBe(true);
		expect(await readFile(versions[0].path, 'utf8')).toContain('old');
	});

	it('stores a user edit as-is', async () => {
		await saveUserEdit('u1', contactId, 'just my text');
		expect(await readSummary(contactId)).toBe('just my text\n');
	});

	it('ignores edits to someone else\'s contact', async () => {
		await createTestUser('u2');
		await saveUserEdit('u2', contactId, 'hijack');
		expect(await readSummary(contactId)).toBe('');
	});

	it('rebuilds from all mail with the person', async () => {
		await rebuildSummary('u1', contactId);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await readSummary(contactId)).toContain('Anna, buyer at Acme.');
	});

	it('packs every thread and lone email into one call when it fits', async () => {
		await insertEmail(accountId, 2, 'Invoice attached', 't2');
		await insertEmail(accountId, 3, 'Quick question', 't3');

		await rebuildSummary('u1', contactId);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(body.messages[1].content).toContain('Can you send a quote?');
		expect(body.messages[1].content).toContain('Invoice attached');
		expect(body.messages[1].content).toContain('Quick question');
	});

	it('splits a history that is over the rebuild budget into several calls', async () => {
		await insertEmail(accountId, 2, 'Invoice attached', 't2');
		await insertEmail(accountId, 3, 'Quick question', 't3');
		env.REBUILD_BUDGET_TOKENS = '1';

		try {
			await rebuildSummary('u1', contactId);
		} finally {
			delete env.REBUILD_BUDGET_TOKENS;
		}

		expect(fetchMock).toHaveBeenCalledTimes(3);
		/** Each call builds on the summary the previous one returned. */
		const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
		expect(secondBody.messages[1].content).toContain('Anna, buyer at Acme.');
	});
});

