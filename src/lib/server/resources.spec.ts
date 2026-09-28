import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
	return 'resources-spec-' + String(Date.now());
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

vi.mock('imapflow', async () => ({
	ImapFlow: (await import('$lib/server/testing/fakeImap')).FakeImapFlow
}));

vi.mock('$lib/server/syncWorker', () => ({ requestSync: async () => {} }));

import { existsSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { db } from '$lib/server/db';
import { draft, email, job, resource } from '$lib/server/db/schema';
import { createDraftForEmail } from '$lib/server/ai/agents/drafting';
import { syncAccount } from '$lib/server/mailSync';
import type { MailAccountCredentials } from '$lib/server/mailAccount';
import { requestJobRun } from '$lib/server/jobs/worker';
import { indexPendingResources, registerResourceIndexing } from '$lib/server/resourceIndex';
import { resourceDir } from '$lib/server/storage/paths';
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
import {
	createResource,
	deleteResource,
	replaceResourceFile,
	ResourceInputError,
	searchResources
} from './resources';

type ModelPart = { type: string; text?: string; file?: { filename: string } };
type ModelRequest = { messages: { role: string; content: string | ModelPart[] }[] };

const fetchMock = vi.fn();
let draftReply = '';
let draftRequest: ModelRequest | null = null;
/** What the model "reads" out of a PDF or image; null makes the call fail. */
let transcript: string | null = '';
let transcribeRequests: ModelRequest[] = [];

function okReply(text: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
		status: 200
	});
}

function textFile(name: string, content: string): File {
	return new File([content], name, { type: 'text/plain' });
}

async function addResource(name: string, keywords: string, tags: string, filename: string) {
	return createResource('u1', {
		name,
		keywords,
		tags,
		file: textFile(filename, name + ' contents')
	});
}

let account: MailAccountCredentials;
let inbox: FakeFolder;
let contactId: string;

async function receive(subject: string, body: string): Promise<string> {
	const delivered = deliver(inbox, {
		subject,
		body,
		from: 'Anna <anna@acme.test>',
		date: new Date(Date.UTC(2026, 0, 1)),
		threadId: 't1'
	});
	await syncAccount(account);

	const rows = await db
		.select()
		.from(email)
		.where(and(eq(email.accountId, account.id), eq(email.uid, delivered)));

	return rows[0].id;
}

/** The filenames attached to the drafting call. */
function sentFilenames(request: ModelRequest | null): string[] {
	const names: string[] = [];

	if (request === null) {
		return names;
	}

	const last = request.messages[request.messages.length - 1];

	if (typeof last.content === 'string') {
		return names;
	}

	for (const part of last.content) {
		if (part.file) {
			names.push(part.file.filename);
		}
	}

	return names;
}

function sentText(request: ModelRequest | null): string {
	if (request === null) {
		return '';
	}

	const last = request.messages[request.messages.length - 1];

	if (typeof last.content === 'string') {
		return last.content;
	}

	return last.content[0].text ?? '';
}

beforeAll(() => {
	migrateTestDb();
});

beforeEach(async () => {
	delete (globalThis as { __zapoingJobWorker?: unknown }).__zapoingJobWorker;
	registerResourceIndexing();
	draftRequest = null;
	transcript = '';
	transcribeRequests = [];
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
		const request = JSON.parse(init.body) as ModelRequest;
		const system = String(request.messages[0].content);

		if (system.startsWith('You write email replies')) {
			draftRequest = request;
			return okReply(draftReply);
		}

		if (system.startsWith('You turn a file into plain text')) {
			transcribeRequests.push(request);

			if (transcript === null) {
				return new Response('overloaded', { status: 503 });
			}

			return okReply(transcript);
		}

		return okReply('## Who they are\nAnna, buyer at Acme.');
	});

	await resetTestDb();
	resetFakeServers();
	await createTestUser('u1');
	await createTestUser('u2');
	inbox = folderOf(createFakeServer('me@example.com'), 'INBOX');
	account = await createTestAccount('u1', 'me@example.com');
	await addTrackedPerson('u1', 'anna@acme.test');

	const found = await findContactByEmail('u1', 'anna@acme.test');

	if (found === null) {
		throw new Error('contact missing');
	}

	contactId = found.id;
});

describe('searchResources', () => {
	it('ranks a resource whose name matches above one that only has the word as a tag', async () => {
		await addResource('Company overview', 'about us history', 'pricing', 'overview.txt');
		await addResource('Pricing sheet', 'rates', 'finance', 'pricing.txt');
		await addResource('Holiday calendar', 'days off', 'hr', 'holidays.txt');

		const found = await searchResources('u1', 'Hi, could you share your pricing for next year?');
		const names: string[] = [];

		for (const row of found) {
			names.push(row.name);
		}

		expect(names).toEqual(['Pricing sheet', 'Company overview']);
		expect(await searchResources('u2', 'pricing')).toEqual([]);
	});

	it('matches word prefixes and returns at most three', async () => {
		for (let index = 1; index <= 5; index++) {
			await addResource('Prices ' + String(index), '', '', 'list' + String(index) + '.txt');
		}

		expect(await searchResources('u1', 'what is your price')).toHaveLength(3);
	});

	it('does not break on FTS syntax in the email', async () => {
		await addResource('Pricing sheet', 'rates', 'finance', 'pricing.txt');

		expect(await searchResources('u1', 'pricing" OR * NEAR( "rates*')).toHaveLength(1);
		expect(await searchResources('u1', '"*" ** ()')).toEqual([]);
		expect(await searchResources('u1', '')).toEqual([]);
	});
});

describe('resources', () => {
	it('refuses files the AI cannot read', async () => {
		const zip = new File(['PK'], 'prices.zip', { type: 'application/zip' });
		const renamed = new File(['MZ'], 'prices.txt', { type: 'application/x-msdownload' });

		await expect(
			createResource('u1', { name: 'Prices', keywords: '', tags: '', file: zip })
		).rejects.toBeInstanceOf(ResourceInputError);
		await expect(
			createResource('u1', { name: 'Prices', keywords: '', tags: '', file: renamed })
		).rejects.toBeInstanceOf(ResourceInputError);
		expect(await db.select().from(resource)).toHaveLength(0);
	});

	it('delete removes the folder and the resource from search', async () => {
		const row = await addResource('Pricing sheet', 'rates', 'finance', 'pricing.txt');
		expect(existsSync(resourceDir(row.id))).toBe(true);

		expect(await deleteResource('u2', row.id)).toBe(false);
		expect(await deleteResource('u1', row.id)).toBe(true);

		expect(existsSync(resourceDir(row.id))).toBe(false);
		expect(await searchResources('u1', 'pricing')).toEqual([]);
	});

	it('search follows edits and a replaced file', async () => {
		const row = await addResource('Pricing sheet', 'rates', 'finance', 'pricing.txt');
		await replaceResourceFile('u1', row.id, textFile('pricing-2026.txt', 'new prices'));

		const found = await searchResources('u1', 'pricing');
		expect(found).toHaveLength(1);
		expect(found[0].filename).toBe('pricing-2026.txt');
		expect(found[0].updatedAt.getTime()).toBeGreaterThanOrEqual(row.updatedAt.getTime());
	});
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function docxWith(text: string): Promise<File> {
	const zip = new JSZip();
	zip.file(
		'word/document.xml',
		'<w:document><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>'
	);

	return new File([await zip.generateAsync({ type: 'arraybuffer' })], 'terms.docx', {
		type: DOCX_MIME
	});
}

async function xlsxWith(text: string): Promise<File> {
	const workbook = new ExcelJS.Workbook();
	workbook.addWorksheet('Prices').addRow([text, 12]);
	const buffer = await workbook.xlsx.writeBuffer();

	return new File([new Uint8Array(buffer as ArrayBuffer)], 'prices.xlsx', { type: XLSX_MIME });
}

async function upload(name: string, file: File) {
	return createResource('u1', { name, keywords: '', tags: '', file });
}

async function namesFound(text: string): Promise<string[]> {
	const names: string[] = [];

	for (const row of await searchResources('u1', text)) {
		names.push(row.name);
	}

	return names;
}

async function storedResource(id: string) {
	const rows = await db.select().from(resource).where(eq(resource.id, id));

	return rows[0];
}

describe('searching inside resource files', () => {
	it('finds words that are only inside a DOCX, an XLSX or a CSV, without calling the model', async () => {
		await upload('Terms', await docxWith('Warranty lasts eighteen months'));
		await upload('Sheet', await xlsxWith('Galvanised bracket'));
		await upload(
			'List',
			new File(['sku,item\n1,Titanium hinge'], 'list.csv', { type: 'text/csv' })
		);

		expect(await namesFound('How long is the warranty?')).toEqual(['Terms']);
		expect(await namesFound('Do you stock galvanised parts?')).toEqual(['Sheet']);
		expect(await namesFound('Any titanium options?')).toEqual(['List']);
		expect(transcribeRequests).toHaveLength(0);
	});

	it('ranks a name match above a match inside a file', async () => {
		await upload(
			'Notes',
			new File(['Our shipping partners and routes'], 'notes.txt', { type: 'text/plain' })
		);
		await upload('Shipping', new File(['Couriers.'], 'ship.txt', { type: 'text/plain' }));

		expect(await namesFound('What are your shipping options?')).toEqual(['Shipping', 'Notes']);
	});

	it('has the model read a PDF once, in the background, and searches what it wrote', async () => {
		transcript = 'Service catalogue\nOnboarding workshop | 2 days';
		const row = await upload(
			'Catalogue',
			new File(['%PDF-1.4 fake'], 'catalogue.pdf', { type: 'application/pdf' })
		);

		expect((await storedResource(row.id)).indexStatus).toBe('pending');
		expect(await namesFound('Can you run an onboarding workshop?')).toEqual([]);

		await requestJobRun();

		const indexed = await storedResource(row.id);
		expect(indexed.indexStatus).toBe('ready');
		expect(indexed.updatedAt.getTime()).toBe(row.updatedAt.getTime());
		expect(transcribeRequests).toHaveLength(1);
		expect(sentFilenames(transcribeRequests[0])).toEqual(['catalogue.pdf']);
		expect(await namesFound('Can you run an onboarding workshop?')).toEqual(['Catalogue']);
	});

	it('keeps a resource usable when the model cannot read it', async () => {
		transcript = null;
		const row = await upload(
			'Brochure',
			new File([new Uint8Array([137, 80, 78, 71])], 'brochure.png', { type: 'image/png' })
		);
		await requestJobRun();

		const failed = await storedResource(row.id);
		expect(failed.indexStatus).toBe('failed');
		expect(failed.indexError).toContain('503');
		expect(await namesFound('Please send the brochure')).toEqual(['Brochure']);
	});

	it('does not unpack a DOCX that unzips too large, but still saves it', async () => {
		const zip = new JSZip();
		zip.file('word/document.xml', '0'.repeat(101 * 1024 * 1024));
		const bomb = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
		const row = await upload('Big', new File([bomb], 'big.docx', { type: DOCX_MIME }));

		const stored = await storedResource(row.id);
		expect(stored.indexStatus).toBe('failed');
		expect(stored.indexError).toContain('100 MB');
		expect(await namesFound('big')).toEqual(['Big']);
	});

	it('on startup, reads resources added before contents were searched', async () => {
		const text = await upload(
			'Old text',
			new File(['Legacy gasket'], 'old.txt', { type: 'text/plain' })
		);
		const pdf = await upload('Old pdf', new File(['%PDF'], 'old.pdf', { type: 'application/pdf' }));
		await db.delete(job);
		await db.update(resource).set({ content: '', indexStatus: 'pending' });

		transcript = 'Ceramic valve';
		await indexPendingResources();
		await indexPendingResources();

		expect((await storedResource(text.id)).indexStatus).toBe('ready');
		expect(await namesFound('legacy gasket')).toEqual(['Old text']);

		await requestJobRun();

		expect(transcribeRequests).toHaveLength(1);
		expect((await storedResource(pdf.id)).indexStatus).toBe('ready');
		expect(await namesFound('ceramic valve')).toEqual(['Old pdf']);
	});
});

describe('drafting with resources', () => {
	it('sends the matching files, records them on the draft, and stores a conflict', async () => {
		await addResource('Pricing 2025', 'rates', 'finance', 'pricing-2025.txt');
		await addResource('Pricing 2026', 'rates', 'finance', 'pricing-2026.txt');
		await addResource('Holiday calendar', 'days off', 'hr', 'holidays.txt');

		const emailId = await receive('Rates', 'What is your pricing for consulting?');
		draftReply = JSON.stringify({
			reply_needed: true,
			reason: 'asks for prices',
			body: 'Our rate is 45 EUR/h.',
			documents: [],
			conflicts: ['Pricing 2025 says 40 EUR/h, Pricing 2026 says 45 EUR/h; used Pricing 2026']
		});

		await createDraftForEmail({ contactId, emailId });

		const filenames = sentFilenames(draftRequest);
		expect(filenames).toHaveLength(2);
		expect(filenames).toContain('pricing-2025.txt');
		expect(filenames).toContain('pricing-2026.txt');
		expect(sentText(draftRequest)).toContain('[RESOURCES]');
		expect(sentText(draftRequest)).toContain('Pricing 2026');

		const drafts = await db.select().from(draft).where(eq(draft.emailId, emailId));
		expect(drafts).toHaveLength(1);
		expect(drafts[0].conflicts).toEqual([
			'Pricing 2025 says 40 EUR/h, Pricing 2026 says 45 EUR/h; used Pricing 2026'
		]);

		const names: string[] = [];

		for (const used of drafts[0].resources) {
			names.push(used.name);
		}

		expect(names.sort()).toEqual(['Pricing 2025', 'Pricing 2026']);
	});

	it('sends no files and records none when nothing matches', async () => {
		await addResource('Holiday calendar', 'days off', 'hr', 'holidays.txt');

		const emailId = await receive('Lunch', 'Are you free for lunch on Friday?');
		draftReply = JSON.stringify({
			reply_needed: true,
			reason: 'asks',
			body: 'Yes.',
			documents: []
		});

		await createDraftForEmail({ contactId, emailId });

		expect(sentFilenames(draftRequest)).toEqual([]);
		expect(sentText(draftRequest)).toContain('[RESOURCES]\nNone.');

		const drafts = await db.select().from(draft).where(eq(draft.emailId, emailId));
		expect(drafts[0].resources).toEqual([]);
		expect(drafts[0].conflicts).toEqual([]);
	});
});
