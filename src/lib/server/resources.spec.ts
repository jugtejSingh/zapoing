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
import { draft, email, fileIndex, generatedFile, job, resource } from '$lib/server/db/schema';
import { createDraftForEmail } from '$lib/server/ai/agents/drafting';
import { syncAccount } from '$lib/server/mailSync';
import type { MailAccountCredentials } from '$lib/server/mailAccount';
import { requestJobRun } from '$lib/server/jobs/worker';
import { indexedText, ingestMissingFiles, registerFileIngest } from '$lib/server/fileIndex';
import { readFileText } from '$lib/server/ai/graph/readFile';
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
import { fakePlannerReply, PLANNER_PREFIX } from '$lib/server/testing/fakePlanner';
import { addTrackedPerson, findContactByEmail } from '$lib/server/trackedPerson';
import {
	createResource,
	deleteResource,
	describeResources,
	listResources,
	replaceResourceFile,
	ResourceInputError
} from './resources';

type ModelPart = { type: string; text?: string; file?: { filename: string } };
type ModelRequest = { messages: { role: string; content: string | ModelPart[] }[] };

const fetchMock = vi.fn();
let draftReply = '';
let draftRequest: ModelRequest | null = null;
/** What the model "reads" out of a PDF or image; null makes the call fail. */
let transcript: string | null = '';
/** What the document maker writes when it is asked to change a resource. */
let editedDocument = '';
let transcribeRequests: ModelRequest[] = [];

function okReply(text: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
		status: 200
	});
}

function textFile(name: string, content: string): File {
	return new File([content], name, { type: 'text/plain' });
}

async function addResource(name: string, filename: string) {
	return createResource('u1', {
		name,
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
	registerFileIngest();
	draftRequest = null;
	transcript = '';
	transcribeRequests = [];
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
		const request = JSON.parse(init.body) as ModelRequest;
		const system = String(request.messages[0].content);

		if (system.startsWith(PLANNER_PREFIX)) {
			return okReply(fakePlannerReply(draftReply, request.messages));
		}

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

		if (system.startsWith('You edit documents')) {
			return okReply(editedDocument);
		}

		if (system.startsWith('You label a file')) {
			return okReply('Description of the file.');
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

describe('resources', () => {
	it('refuses files the AI cannot read', async () => {
		const zip = new File(['PK'], 'prices.zip', { type: 'application/zip' });
		const renamed = new File(['MZ'], 'prices.txt', { type: 'application/x-msdownload' });

		await expect(createResource('u1', { name: 'Prices', file: zip })).rejects.toBeInstanceOf(
			ResourceInputError
		);
		await expect(createResource('u1', { name: 'Prices', file: renamed })).rejects.toBeInstanceOf(
			ResourceInputError
		);
		expect(await db.select().from(resource)).toHaveLength(0);
	});

	it('delete removes the folder and the index row', async () => {
		const row = await addResource('Pricing sheet', 'pricing.txt');
		await requestJobRun();
		expect(existsSync(resourceDir(row.id))).toBe(true);
		expect(await indexedText('resource', row.id)).not.toBeNull();

		expect(await deleteResource('u2', row.id)).toBe(false);
		expect(await deleteResource('u1', row.id)).toBe(true);

		expect(existsSync(resourceDir(row.id))).toBe(false);
		expect(await db.select().from(fileIndex)).toHaveLength(0);
	});

	it('reads a replaced file again', async () => {
		const row = await addResource('Pricing sheet', 'pricing.txt');
		await requestJobRun();
		await replaceResourceFile('u1', row.id, textFile('pricing-2026.txt', 'new prices'));
		await requestJobRun();

		expect(await indexedText('resource', row.id)).toContain('new prices');
		expect((await listResources('u1'))[0].filename).toBe('pricing-2026.txt');
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
	return createResource('u1', { name, file });
}

async function storedIndex(id: string) {
	const rows = await db.select().from(fileIndex).where(eq(fileIndex.refId, id));

	return rows[0];
}

describe('reading resource files', () => {
	it('reads a DOCX, an XLSX and a CSV on this computer, without the transcription call', async () => {
		const terms = await upload('Terms', await docxWith('Warranty lasts eighteen months'));
		const sheet = await upload('Sheet', await xlsxWith('Galvanised bracket'));
		const list = await upload(
			'List',
			new File(['sku,item\n1,Titanium hinge'], 'list.csv', { type: 'text/csv' })
		);
		await requestJobRun();

		expect(await indexedText('resource', terms.id)).toContain('eighteen months');
		expect(await indexedText('resource', sheet.id)).toContain('Galvanised bracket');
		expect(await indexedText('resource', list.id)).toContain('Titanium hinge');
		expect((await storedIndex(terms.id)).description).toBe('Description of the file.');
		expect(transcribeRequests).toHaveLength(0);
	});

	it('has the model read a PDF once, in the background', async () => {
		transcript = 'Service catalogue\nOnboarding workshop | 2 days';
		const row = await upload(
			'Catalogue',
			new File(['%PDF-1.4 fake'], 'catalogue.pdf', { type: 'application/pdf' })
		);

		expect((await storedIndex(row.id)).status).toBe('pending');
		expect(await indexedText('resource', row.id)).toBeNull();

		await requestJobRun();

		expect((await storedIndex(row.id)).status).toBe('ready');
		expect(transcribeRequests).toHaveLength(1);
		expect(sentFilenames(transcribeRequests[0])).toEqual(['catalogue.pdf']);
		expect(await indexedText('resource', row.id)).toContain('Onboarding workshop');
	});

	it('records why the model could not read a file', async () => {
		transcript = null;
		const row = await upload(
			'Brochure',
			new File([new Uint8Array([137, 80, 78, 71])], 'brochure.png', { type: 'image/png' })
		);
		await requestJobRun();

		const failed = await storedIndex(row.id);
		expect(failed.status).toBe('failed');
		expect(failed.error).toContain('503');
		expect(await indexedText('resource', row.id)).toBeNull();
	});

	it('does not unpack a DOCX that unzips too large', async () => {
		const zip = new JSZip();
		zip.file('word/document.xml', '0'.repeat(101 * 1024 * 1024));
		const bomb = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
		const row = await upload('Big', new File([bomb], 'big.docx', { type: DOCX_MIME }));
		await requestJobRun();

		const stored = await storedIndex(row.id);
		expect(stored.status).toBe('failed');
		expect(stored.error).toContain('100 MB');
	});

	it('on startup, reads files that have no index row yet', async () => {
		const row = await upload(
			'Old text',
			new File(['Legacy gasket'], 'old.txt', { type: 'text/plain' })
		);
		await db.delete(job);
		await db.delete(fileIndex);

		await ingestMissingFiles();
		await ingestMissingFiles();
		await requestJobRun();

		expect(await indexedText('resource', row.id)).toContain('Legacy gasket');
	});
});

describe('drafting with resources', () => {
	it('lists every resource with its description and keeps the conflict the reply writer found', async () => {
		await addResource('Pricing 2025', 'pricing-2025.txt');
		await addResource('Pricing 2026', 'pricing-2026.txt');
		await requestJobRun();

		const emailId = await receive('Rates', 'What is your pricing for consulting?');
		draftReply = JSON.stringify({
			reason: 'asks for prices',
			body: 'Our rate is 45 EUR/h.',
			conflicts: ['Pricing 2025 says 40 EUR/h, Pricing 2026 says 45 EUR/h; used Pricing 2026']
		});

		await createDraftForEmail({ contactId, emailId });

		const text = sentText(draftRequest);
		expect(text).toContain('[RESOURCES]');
		expect(text).toContain('Pricing 2025');
		expect(text).toContain('Pricing 2026');
		expect(text).toContain('Description of the file.');
		expect(sentFilenames(draftRequest)).toEqual([]);

		const drafts = await db.select().from(draft).where(eq(draft.emailId, emailId));
		expect(drafts).toHaveLength(1);
		expect(drafts[0].conflicts).toEqual([
			'Pricing 2025 says 40 EUR/h, Pricing 2026 says 45 EUR/h; used Pricing 2026'
		]);
	});

	it('says there are none when the user has no resources', async () => {
		expect(await describeResources([])).toBe('[RESOURCES]\nNone.');
	});
});

describe('changing a resource into a new file', () => {
	function documentJson(): string {
		return JSON.stringify({
			contract: false,
			name: 'Pricing',
			change_note: '- Rate: 40 → 45 EUR/h',
			markdown: '# Pricing\n\nConsulting: 45 EUR/h.'
		});
	}

	it('builds a Word copy that goes out as a PDF, and leaves the original alone', async () => {
		const row = await addResource('Pricing', 'pricing.txt');
		await requestJobRun();

		const emailId = await receive('Rates', 'Can you send your pricing at 45 EUR/h?');
		draftReply = JSON.stringify({
			reply_needed: true,
			reason: 'asks for prices',
			body: 'Pricing attached.',
			documents: [{ resource_id: row.id, deliver_as: 'pdf', change: 'Rate to 45 EUR/h' }]
		});
		editedDocument = documentJson();

		await createDraftForEmail({ contactId, emailId });

		const drafts = await db.select().from(draft).where(eq(draft.emailId, emailId));
		const files = await db.select().from(generatedFile).where(eq(generatedFile.draftId, drafts[0].id));

		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			filename: 'pricing v2.docx',
			format: 'docx',
			sendAsPdf: true,
			documentId: null,
			error: null
		});
		expect(existsSync(resourceDir(row.id))).toBe(true);
		expect(await indexedText('resource', row.id)).toContain('Pricing contents');
	});

	it("shows an error on the draft when the resource does not exist or is someone else's", async () => {
		const theirs = await createResource('u2', {
			name: 'Their pricing',
			file: textFile('their.txt', 'Their pricing contents')
		});
		await requestJobRun();

		const emailId = await receive('Rates', 'Can you send your pricing?');
		draftReply = JSON.stringify({
			reply_needed: true,
			reason: 'asks for prices',
			body: 'Pricing attached.',
			documents: [
				{ resource_id: 'not-a-resource', change: 'Rate to 45 EUR/h' },
				{ resource_id: theirs.id, change: 'Rate to 45 EUR/h' }
			]
		});
		editedDocument = documentJson();

		await createDraftForEmail({ contactId, emailId });

		const drafts = await db.select().from(draft).where(eq(draft.emailId, emailId));
		const files = await db.select().from(generatedFile).where(eq(generatedFile.draftId, drafts[0].id));

		expect(files).toHaveLength(2);
		expect(files[0].error).toContain('does not exist');
		expect(files[1].error).toContain('does not exist');
	});
});

describe('read_file', () => {
	it('gives the text of a resource, and refuses another user or an unknown id', async () => {
		const row = await addResource('Pricing sheet', 'pricing.txt');
		await requestJobRun();

		expect(await readFileText('u1', contactId, row.id)).toContain('Pricing sheet contents');
		expect(await readFileText('u2', contactId, row.id)).toContain('no file with that id');
		expect(await readFileText('u1', contactId, 'nope')).toContain('no file with that id');
	});
});
