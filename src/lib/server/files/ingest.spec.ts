import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
	return 'ingest-spec-' + String(Date.now());
});

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const nodePath = await import('node:path');
	const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), dataDir));

	return {
		env: { DATABASE_URL: ':memory:', CREDENTIALS_KEY: 'a'.repeat(64), DATA_DIR: dir }
	};
});

vi.mock('imapflow', async () => ({
	ImapFlow: (await import('../testing/fakeImap')).FakeImapFlow
}));

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { asc } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { documentVersion } from '$lib/server/db/schema';
import { requestJobRun } from '$lib/server/jobs/worker';
import type { MailAccountCredentials } from '$lib/server/mailAccount';
import { syncAccount } from '$lib/server/mailSync';
import { documentDir, documentMetaPath } from '$lib/server/storage/paths';
import {
	createFakeServer,
	deliver,
	folderOf,
	resetFakeServers,
	type FakeFolder
} from '$lib/server/testing/fakeImap';
import {
	createTestAccount,
	createTestUser,
	migrateTestDb,
	resetTestDb
} from '$lib/server/testing/testDb';
import { addTrackedPerson, findContactByEmail } from '$lib/server/trackedPerson';
import { listContactDocuments, mergeDocuments } from './documents';
import { normalizeFilename, registerIngestion } from './ingest';

const ANNA = 'Anna <anna@acme.test>';

let account: MailAccountCredentials;
let inbox: FakeFolder;
let day = 1;

function sendFile(
	from: string,
	threadId: string,
	filename: string,
	content: string,
	contentType = 'application/pdf'
): void {
	deliver(inbox, {
		subject: 'Files',
		from,
		threadId,
		date: new Date(Date.UTC(2026, 0, day)),
		attachments: [{ filename, contentType, content }]
	});
	day = day + 1;
}

async function syncAndIngest(): Promise<void> {
	await syncAccount(account);
	await requestJobRun();
}

async function documentsOf(address: string) {
	const found = await findContactByEmail('u1', address);

	if (found === null) {
		throw new Error('contact missing');
	}

	return listContactDocuments('u1', found.id);
}

beforeAll(() => {
	migrateTestDb();
});

beforeEach(async () => {
	delete (globalThis as { __zapoingJobWorker?: unknown }).__zapoingJobWorker;
	registerIngestion();
	await resetTestDb();
	resetFakeServers();
	day = 1;

	await createTestUser('u1');
	account = await createTestAccount('u1', 'me@example.com');
	inbox = folderOf(createFakeServer('me@example.com'), 'INBOX');
	await addTrackedPerson('u1', 'anna@acme.test');
});

describe('normalizeFilename', () => {
	it('drops version noise but keeps the name', () => {
		expect(normalizeFilename('Agreement_v3 (1).pdf')).toBe('agreement');
		expect(normalizeFilename('agreement-v4-final.pdf')).toBe('agreement');
		expect(normalizeFilename('Quote 2026-01-15 signed.docx')).toBe('quote');
		expect(normalizeFilename('v2.pdf')).toBe('v2');
	});
});

describe('ingestion', () => {
	it('stores the same file sent twice once', async () => {
		sendFile(ANNA, 't1', 'report.pdf', 'SAME');
		sendFile(ANNA, 't2', 'report.pdf', 'SAME');
		await syncAndIngest();

		const documents = await documentsOf('anna@acme.test');
		expect(documents).toHaveLength(1);
		expect(documents[0].versions).toHaveLength(1);
	});

	it('makes a revised file in the same thread the next version', async () => {
		sendFile(ANNA, 't1', 'Agreement_v1.pdf', 'FIRST');
		sendFile(ANNA, 't1', 'Agreement_v2 final.pdf', 'SECOND');
		await syncAndIngest();

		const documents = await documentsOf('anna@acme.test');
		expect(documents).toHaveLength(1);
		/** Newest first. */
		expect(documents[0].versions[0].version).toBe(2);
		expect(documents[0].versions[0].filename).toBe('Agreement_v2 final.pdf');

		const meta = JSON.parse(await readFile(await documentMetaPath(documents[0].id), 'utf8'));
		expect(meta.versions[1].replaces).toBe(1);
	});

	it('makes an unrelated file a new document', async () => {
		sendFile(ANNA, 't1', 'agreement.pdf', 'A');
		sendFile(ANNA, 't1', 'invoice.pdf', 'B');
		await syncAndIngest();

		expect(await documentsOf('anna@acme.test')).toHaveLength(2);
	});

	it('stores a disallowed file but marks it unreadable', async () => {
		sendFile(ANNA, 't1', 'setup.exe', 'MZ', 'application/octet-stream');
		await syncAndIngest();

		const rows = await db.select().from(documentVersion);
		expect(rows).toHaveLength(1);
		expect(rows[0].readable).toBe(false);
		expect(existsSync(rows[0].path)).toBe(true);
	});

	it('ignores files from people who are not tracked', async () => {
		sendFile('Bob <bob@other.test>', 't9', 'bob.pdf', 'BOB');
		await syncAndIngest();

		expect(await db.select().from(documentVersion)).toHaveLength(0);
	});

	it('backfills a person’s old files when tracking starts', async () => {
		sendFile('Bob <bob@other.test>', 't9', 'bob.pdf', 'BOB');
		await syncAndIngest();

		await addTrackedPerson('u1', 'bob@other.test');
		/** Once for the backfill job, once for the ingest jobs it queued. */
		await requestJobRun();
		await requestJobRun();

		const documents = await documentsOf('bob@other.test');
		expect(documents).toHaveLength(1);
		expect(documents[0].versions[0].filename).toBe('bob.pdf');
	});
});

describe('mergeDocuments', () => {
	it('moves the versions over, renumbers them by date and removes the other folder', async () => {
		sendFile(ANNA, 't1', 'contract.pdf', 'OLD');
		sendFile(ANNA, 't2', 'contract-signed.pdf', 'NEW');
		await syncAndIngest();

		const before = await documentsOf('anna@acme.test');
		expect(before).toHaveLength(2);

		/** Keep the newer one, so the older file has to become v1. */
		await mergeDocuments('u1', before[1].id, before[0].id);

		const after = await documentsOf('anna@acme.test');
		expect(after).toHaveLength(1);
		expect(after[0].id).toBe(before[1].id);

		const rows = await db.select().from(documentVersion).orderBy(asc(documentVersion.version));
		expect(rows[0].filename).toBe('contract.pdf');
		expect(rows[0].version).toBe(1);
		expect(rows[1].version).toBe(2);
		expect(await readFile(rows[0].path, 'utf8')).toBe('OLD');
		expect(await readFile(rows[1].path, 'utf8')).toBe('NEW');
		expect(existsSync(documentDir(before[0].id))).toBe(false);
	});

	it('refuses to merge another user’s documents', async () => {
		sendFile(ANNA, 't1', 'a.pdf', 'A');
		sendFile(ANNA, 't2', 'b.pdf', 'B');
		await syncAndIngest();

		const documents = await documentsOf('anna@acme.test');
		await expect(mergeDocuments('u2', documents[0].id, documents[1].id)).rejects.toThrow();
	});
});
