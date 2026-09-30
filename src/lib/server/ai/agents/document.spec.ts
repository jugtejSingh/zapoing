import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
	return 'document-spec-' + String(Date.now());
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

/** Real Chromium is covered by render.spec; here a PDF is a stub that can be told to fail. */
const pdf = vi.hoisted(() => ({ fail: false }));

vi.mock('$lib/server/files/render/pdf', () => ({
	renderPdf: async (source: string) => {
		if (pdf.fail) {
			throw new Error('Chromium crashed');
		}

		return Buffer.from('%PDF-stub\n' + source);
	}
}));

/** LibreOffice is covered by render.spec; here converting a Word file is a stub that can be told to fail. */
const word = vi.hoisted(() => ({ converted: 0 }));

vi.mock('$lib/server/files/render/docxToPdf', () => ({
	docxToPdf: async () => {
		word.converted = word.converted + 1;

		return Buffer.from('%PDF-from-docx');
	}
}));

/** Tests must never send real mail. */
const smtp = vi.hoisted(() => ({
	sent: [] as { raw: Buffer }[]
}));

vi.mock('nodemailer', () => ({
	default: {
		createTransport: () => ({
			sendMail: async (mail: { raw: Buffer }) => {
				smtp.sent.push(mail);
			}
		})
	}
}));

vi.mock('$lib/server/syncWorker', () => ({ requestSync: async () => {} }));

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { simpleParser } from 'mailparser';
import { db } from '$lib/server/db';
import { agentRun, document, documentVersion, draft, email, generatedFile } from '$lib/server/db/schema';
import { getOwnedRunOutput } from '$lib/server/ai/agentRun';
import { addDocumentVersion, latestVersion } from '$lib/server/files/documents';
import { listDraftFiles, removeErroredSince, removeGenerated } from '$lib/server/files/generated';
import { ingestFile } from '$lib/server/fileIndex';
import { readFileText } from '$lib/server/ai/graph/readFile';
import { syncAccount } from '$lib/server/mailSync';
import type { MailAccountCredentials } from '$lib/server/mailAccount';
import {
	createFakeServer,
	deliver,
	expunge,
	renumber,
	resetFakeServers,
	folderOf,
	type FakeFolder,
	type FakeServer
} from '$lib/server/testing/fakeImap';
import {
	createTestAccount,
	createTestUser,
	migrateTestDb,
	resetTestDb
} from '$lib/server/testing/testDb';
import { fakePlannerReply, PLANNER_PREFIX } from '$lib/server/testing/fakePlanner';
import { addTrackedPerson, findContactByEmail } from '$lib/server/trackedPerson';
import { actions } from '../../../../routes/home/[id]/+page.server';
import { outputFormat } from './document';
import { createDraftForEmail, mergeDrafts } from './drafting';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type ModelRequest = { messages: { role: string; content: unknown }[] };

const fetchMock = vi.fn();
let draftReply = '';
let documentReply = '';
/** Every request the document agent made, to check what it was given to edit. */
let documentRequests: ModelRequest[] = [];

function okReply(text: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
		status: 200
	});
}

function systemText(request: ModelRequest): string {
	return String(request.messages[0].content);
}

/** The last user message as text, whether or not files were attached to it. */
function userText(request: ModelRequest): string {
	const content = request.messages[request.messages.length - 1].content;

	if (typeof content === 'string') {
		return content;
	}

	return (content as { type: string; text?: string }[])[0].text ?? '';
}

function attachedFileCount(request: ModelRequest): number {
	const content = request.messages[request.messages.length - 1].content;

	if (typeof content === 'string') {
		return 0;
	}

	return (content as unknown[]).length - 1;
}

function asksFor(
	documentId: string | null,
	change: string,
	extra: Record<string, unknown> = {}
): string {
	return JSON.stringify({
		reply_needed: true,
		reason: 'asks for a change',
		body: 'Updated file attached.',
		documents: [{ document_id: documentId, change, ...extra }]
	});
}

function editedMarkdown(markdown: string, contract = false): string {
	return JSON.stringify({
		contract,
		name: 'Supply agreement',
		change_note: '- Payment terms: 30 → 45 days',
		markdown
	});
}

let account: MailAccountCredentials;
let server: FakeServer;
let inbox: FakeFolder;
let contactId: string;
let uid = 0;

async function receive(subject: string): Promise<string> {
	uid = uid + 1;
	const delivered = deliver(inbox, {
		subject,
		from: 'Anna <anna@acme.test>',
		date: new Date(Date.UTC(2026, 0, uid)),
		threadId: 't1'
	});
	await syncAccount(account);

	const rows = await db
		.select()
		.from(email)
		.where(and(eq(email.accountId, account.id), eq(email.uid, delivered)));

	return rows[0].id;
}

async function draftFor(emailId: string) {
	await createDraftForEmail({ contactId, emailId });
	const rows = await db.select().from(draft).where(eq(draft.emailId, emailId));

	return rows[0];
}

async function filesOf(draftId: string) {
	return db.select().from(generatedFile).where(eq(generatedFile.draftId, draftId));
}

/** A document the person sent earlier, stored the way ingestion stores it. */
async function storedDocument(
	filename: string,
	contentType: string,
	content: Buffer
): Promise<string> {
	const inserted = await db.insert(document).values({ contactId, name: filename }).returning();
	await addDocumentVersion(inserted[0].id, {
		emailId: null,
		sender: 'anna@acme.test',
		receivedAt: new Date(Date.UTC(2025, 11, 1)),
		filename,
		contentType,
		content
	});

	return inserted[0].id;
}

type ReplyEvent = Parameters<typeof actions.reply>[0];

async function sendDraft(emailId: string, draftId: string, body: string) {
	const form = new FormData();
	form.set('emailId', emailId);
	form.set('draftId', draftId);
	form.set('body', body);
	form.set('cc', '');
	const event = {
		request: new Request('http://localhost/home/' + emailId + '?/reply', {
			method: 'POST',
			body: form
		}),
		locals: { user: { id: 'u1' } }
	} as unknown as ReplyEvent;

	return actions.reply(event);
}

beforeAll(() => {
	migrateTestDb();
});

beforeEach(async () => {
	delete (globalThis as { __zapoingJobWorker?: unknown }).__zapoingJobWorker;
	pdf.fail = false;
	word.converted = 0;
	smtp.sent = [];
	documentRequests = [];
	uid = 0;
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
		const request = JSON.parse(init.body) as ModelRequest;

		if (systemText(request).startsWith(PLANNER_PREFIX)) {
			return okReply(fakePlannerReply(draftReply, request.messages));
		}

		if (systemText(request).startsWith('You write email replies')) {
			return okReply(draftReply);
		}

		if (systemText(request).startsWith('You edit documents')) {
			documentRequests.push(request);
			return okReply(documentReply);
		}

		return okReply('## Who they are\nAnna, buyer at Acme.');
	});

	await resetTestDb();
	resetFakeServers();
	await createTestUser('u1');
	server = createFakeServer('me@example.com');
	inbox = folderOf(server, 'INBOX');
	account = await createTestAccount('u1', 'me@example.com');
	await addTrackedPerson('u1', 'anna@acme.test');

	const found = await findContactByEmail('u1', 'anna@acme.test');

	if (found === null) {
		throw new Error('contact missing');
	}

	contactId = found.id;
});

describe('outputFormat', () => {
	it('keeps spreadsheets and Word, and makes contracts and everything else a PDF', () => {
		expect(outputFormat('Prices.xlsx', false)).toBe('xlsx');
		expect(outputFormat('prices.csv', true)).toBe('xlsx');
		expect(outputFormat('Notes v2.docx', false)).toBe('docx');
		expect(outputFormat('Contract.docx', true)).toBe('pdf');
		expect(outputFormat('Scan.pdf', false)).toBe('pdf');
		expect(outputFormat(null, false)).toBe('pdf');
	});
});

describe('generateDocument', () => {
	it('edits a received DOCX into the next version, sending the file to the model', async () => {
		const documentId = await storedDocument(
			'Notes v2.docx',
			DOCX_MIME,
			Buffer.from('PK fake docx')
		);
		const emailId = await receive('Please update the notes');
		draftReply = asksFor(documentId, 'Payment terms to 45 days');
		documentReply = editedMarkdown('# Notes\n\nPayment within 45 days.');

		const written = await draftFor(emailId);
		const files = await filesOf(written.id);

		expect(written.status).toBe('pending');
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			filename: 'Notes v3.docx',
			format: 'docx',
			error: null,
			documentId
		});
		expect((await readFile(files[0].path ?? '')).subarray(0, 2).toString()).toBe('PK');
		expect(files[0].changeNote).toContain('45 days');
		expect(files[0].changeNote).toContain('Rebuilt from the text');
		expect(attachedFileCount(documentRequests[0])).toBe(1);
	});

	it('turns a contract into a PDF even when it came as DOCX', async () => {
		const documentId = await storedDocument(
			'Contract.docx',
			DOCX_MIME,
			Buffer.from('PK fake docx')
		);
		const emailId = await receive('Contract change');
		draftReply = asksFor(documentId, 'Term to 2 years');
		documentReply = editedMarkdown('# Contract\n\nTerm: 2 years.', true);

		const files = await filesOf((await draftFor(emailId)).id);

		expect(files[0]).toMatchObject({ filename: 'Contract v2.pdf', format: 'pdf', error: null });
	});

	it('keeps a spreadsheet a spreadsheet', async () => {
		const documentId = await storedDocument('Prices.xlsx', XLSX_MIME, Buffer.from('PK fake xlsx'));
		const emailId = await receive('New price');
		draftReply = asksFor(documentId, 'Widgets to 130');
		documentReply = JSON.stringify({
			contract: false,
			name: 'Prices',
			change_note: '- Widgets: 120 → 130',
			sheets: [
				{
					name: 'Prices',
					rows: [
						['Item', 'Price'],
						['Widgets', 130]
					]
				}
			]
		});

		const files = await filesOf((await draftFor(emailId)).id);
		expect(files[0]).toMatchObject({ filename: 'Prices v2.xlsx', format: 'xlsx', error: null });

		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load((await readFile(files[0].path ?? '')) as unknown as ArrayBuffer);
		expect(workbook.worksheets[0].getCell('B2').value).toBe(130);
		expect(files[0].sourcePath?.endsWith('source.sheets.json')).toBe(true);
	});

	it("builds on another pending draft's version instead of the received file", async () => {
		const documentId = await storedDocument('Notes.docx', DOCX_MIME, Buffer.from('PK fake docx'));
		const first = await receive('Change one');
		draftReply = asksFor(documentId, 'Payment to 45 days');
		documentReply = editedMarkdown('# Notes\n\nPayment within 45 days.');
		await draftFor(first);

		const second = await receive('Change two');
		draftReply = asksFor(documentId, 'Add a delivery clause');
		documentReply = editedMarkdown('# Notes\n\nPayment within 45 days.\n\nDelivery in 2 weeks.');
		const files = await filesOf((await draftFor(second)).id);

		expect(userText(documentRequests[1])).toContain('Payment within 45 days.');
		expect(attachedFileCount(documentRequests[1])).toBe(0);
		expect(files[0].filename).toBe('Notes v3.docx');
	});

	it('shows a failed render on the draft, and Remove deletes it', async () => {
		const emailId = await receive('Send me a quote');
		draftReply = asksFor(null, 'A quote for 100 widgets');
		documentReply = editedMarkdown('# Quote\n\n100 widgets: [[price]].');
		pdf.fail = true;

		const written = await draftFor(emailId);
		const shown = await listDraftFiles(written.id);

		expect(written.status).toBe('pending');
		expect(shown).toHaveLength(1);
		expect(shown[0]).toMatchObject({ error: 'Chromium crashed', isNewDocument: true });

		expect(await removeGenerated('u1', shown[0].id)).toBe(true);
		expect(await listDraftFiles(written.id)).toHaveLength(0);
	});
});

describe('Word or PDF for the person who receives it', () => {
	it('builds Word and sends it as a PDF converted at send time when the planner says pdf', async () => {
		const emailId = await receive('Send me a contract');
		draftReply = asksFor(null, 'A supply agreement', { deliver_as: 'pdf' });
		documentReply = editedMarkdown('# Supply agreement\n\nTerm: 1 year.', true);

		const written = await draftFor(emailId);
		const files = await filesOf(written.id);

		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			filename: 'Supply agreement.docx',
			format: 'docx',
			sendAsPdf: true,
			error: null
		});
		expect((await readFile(files[0].path ?? '')).subarray(0, 2).toString()).toBe('PK');
		expect((await listDraftFiles(written.id))[0].sendAsPdf).toBe(true);
		expect(word.converted).toBe(0);

		expect(await sendDraft(emailId, written.id, 'Contract attached.')).toEqual({
			message: 'Reply sent'
		});

		const sent = await simpleParser(smtp.sent[0].raw);
		expect(sent.attachments).toHaveLength(1);
		expect(sent.attachments[0].filename).toBe('Supply agreement.pdf');
		expect(sent.attachments[0].contentType).toBe('application/pdf');
		expect(sent.attachments[0].content.toString()).toBe('%PDF-from-docx');
		expect(word.converted).toBe(1);
	});

	it('keeps a contract as Word when the planner says docx', async () => {
		const documentId = await storedDocument('Contract.docx', DOCX_MIME, Buffer.from('PK fake docx'));
		const emailId = await receive('Contract change');
		draftReply = asksFor(documentId, 'Term to 2 years', { deliver_as: 'docx' });
		documentReply = editedMarkdown('# Contract\n\nTerm: 2 years.', true);

		const written = await draftFor(emailId);
		const files = await filesOf(written.id);

		expect(files[0]).toMatchObject({
			filename: 'Contract v2.docx',
			format: 'docx',
			sendAsPdf: false,
			error: null
		});

		await sendDraft(emailId, written.id, 'Updated contract attached.');

		const sent = await simpleParser(smtp.sent[0].raw);
		expect(sent.attachments[0].filename).toBe('Contract v2.docx');
		expect(sent.attachments[0].content.subarray(0, 2).toString()).toBe('PK');
		expect(word.converted).toBe(0);
	});

	it('turns a received PDF into Word that goes back out as a PDF', async () => {
		const documentId = await storedDocument(
			'Offer.pdf',
			'application/pdf',
			Buffer.from('%PDF-1.4 fake')
		);
		const emailId = await receive('Change the offer');
		draftReply = asksFor(documentId, 'Price to 90', { deliver_as: 'pdf' });
		documentReply = editedMarkdown('# Offer\n\nPrice: 90.');

		const files = await filesOf((await draftFor(emailId)).id);

		expect(files[0]).toMatchObject({
			filename: 'Offer v2.docx',
			format: 'docx',
			sendAsPdf: true,
			documentId
		});
	});

	it('sends a received DOCX as a PDF when deliver_as is missing', async () => {
		const documentId = await storedDocument('Notes.docx', DOCX_MIME, Buffer.from('PK fake docx'));
		const emailId = await receive('Update the notes');
		draftReply = asksFor(documentId, 'Payment to 45 days');
		documentReply = editedMarkdown('# Notes\n\nPayment within 45 days.');

		const written = await draftFor(emailId);
		const files = await filesOf(written.id);

		expect(files[0]).toMatchObject({ filename: 'Notes v2.docx', sendAsPdf: true });

		await sendDraft(emailId, written.id, 'Attached.');

		const sent = await simpleParser(smtp.sent[0].raw);
		expect(sent.attachments[0].filename).toBe('Notes v2.pdf');
		expect(word.converted).toBe(1);
	});

	it('does not turn a spreadsheet into Word, whatever deliver_as says', async () => {
		const documentId = await storedDocument('Prices.xlsx', XLSX_MIME, Buffer.from('PK fake xlsx'));
		const emailId = await receive('New price');
		draftReply = asksFor(documentId, 'Widgets to 130', { deliver_as: 'pdf' });
		documentReply = JSON.stringify({
			contract: false,
			name: 'Prices',
			change_note: '- Widgets: 130',
			sheets: [{ name: 'Prices', rows: [['Widgets', 130]] }]
		});

		const files = await filesOf((await draftFor(emailId)).id);

		expect(files[0]).toMatchObject({ format: 'xlsx', sendAsPdf: false });
	});

	it('stores the Word file, not the PDF, as the version that was sent', async () => {
		const emailId = await receive('Send me a contract');
		draftReply = asksFor(null, 'A supply agreement', { deliver_as: 'pdf' });
		documentReply = editedMarkdown('# Supply agreement\n\nTerm: 1 year.', true);
		const written = await draftFor(emailId);
		await sendDraft(emailId, written.id, 'Contract attached.');

		const documents = await db.select().from(document).where(eq(document.contactId, contactId));
		const stored = await latestVersion(documents[documents.length - 1].id);

		expect(stored?.filename).toBe('Supply agreement.docx');
	});
});

describe('the financial agent', () => {
	function sheetReply(price: number): string {
		return JSON.stringify({
			contract: false,
			name: 'Prices',
			change_note: '- Widgets: 120 → ' + String(price),
			sheets: [
				{
					name: 'Prices',
					rows: [
						['Item', 'Price'],
						['Widgets', price]
					]
				}
			]
		});
	}

	it('makes a new spreadsheet', async () => {
		const emailId = await receive('Send me the price list');
		draftReply = asksFor(null, 'A price list with widgets at 130', { spreadsheet: true });
		documentReply = sheetReply(130);

		const files = await filesOf((await draftFor(emailId)).id);

		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			filename: 'Prices.xlsx',
			format: 'xlsx',
			sendAsPdf: false,
			error: null
		});

		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load((await readFile(files[0].path ?? '')) as unknown as ArrayBuffer);
		expect(workbook.worksheets[0].getCell('B2').value).toBe(130);
	});

	it('changes a received spreadsheet into the next version', async () => {
		const documentId = await storedDocument('Prices.xlsx', XLSX_MIME, Buffer.from('PK fake xlsx'));
		const emailId = await receive('New price');
		draftReply = asksFor(documentId, 'Widgets to 130', { spreadsheet: true });
		documentReply = sheetReply(130);

		const files = await filesOf((await draftFor(emailId)).id);

		expect(files[0]).toMatchObject({ filename: 'Prices v2.xlsx', format: 'xlsx', documentId });
	});

	it('removes its failed attempt and hands the same request to the document maker', async () => {
		const emailId = await receive('Send me the price list');
		draftReply = asksFor(null, 'A price list with widgets at 130', { spreadsheet: true });
		documentReply = 'this is not the sheet json';

		const files = await filesOf((await draftFor(emailId)).id);

		/** The financial agent tried, then the document maker did, and only its failure is left to see. */
		expect(documentRequests).toHaveLength(2);
		expect(files).toHaveLength(1);
		expect(files[0].error).not.toBeNull();
	});
});

describe('removeErroredSince', () => {
	it('keeps a good file', async () => {
		const emailId = await receive('Send me a quote');
		draftReply = asksFor(null, 'A quote for 100 widgets');
		documentReply = editedMarkdown('# Quote\n\n100 widgets.');
		const written = await draftFor(emailId);

		await removeErroredSince(written.id, new Set());

		expect(await filesOf(written.id)).toHaveLength(1);
	});

	it('removes a failed file made after the snapshot, and keeps one that was already there', async () => {
		const emailId = await receive('Send me a quote');
		draftReply = asksFor(null, 'A quote for 100 widgets');
		documentReply = editedMarkdown('# Quote\n\n100 widgets.');
		pdf.fail = true;
		const written = await draftFor(emailId);
		const failed = await filesOf(written.id);

		expect(failed).toHaveLength(1);
		expect(failed[0].error).not.toBeNull();

		await removeErroredSince(written.id, new Set([failed[0].id]));
		expect(await filesOf(written.id)).toHaveLength(1);

		await removeErroredSince(written.id, new Set());
		expect(await filesOf(written.id)).toHaveLength(0);
	});
});

describe('read_file on a received document', () => {
	it('gives the text once it is read, says so before, and refuses another contact', async () => {
		const documentId = await storedDocument(
			'Terms.txt',
			'text/plain',
			Buffer.from('Payment is due within thirty days.')
		);
		const latest = await latestVersion(documentId);

		expect(await readFileText('u1', contactId, documentId)).toContain('has not been read yet');

		expect(await ingestFile('attachment', latest?.id ?? '')).toBe(true);

		const text = await readFileText('u1', contactId, documentId);
		expect(text).toContain('Payment is due within thirty days.');
		expect(text).toContain('Terms');

		expect(await readFileText('u1', 'another-contact', documentId)).toContain(
			'no file with that id'
		);
		expect(await readFileText('u1', contactId, 'nope')).toContain('no file with that id');
	});
});

async function mergedDraft(emailId: string) {
	const rows = await db
		.select()
		.from(draft)
		.where(and(eq(draft.emailId, emailId), eq(draft.status, 'pending')));

	return rows[0];
}

describe('merging drafts with documents', () => {
	it('keeps only the newest version of a document, deletes the older one, and combines the notes', async () => {
		const documentId = await storedDocument('Notes.docx', DOCX_MIME, Buffer.from('PK fake docx'));
		const first = await receive('Change one');
		draftReply = asksFor(documentId, 'Payment to 45 days');
		documentReply = editedMarkdown('# Notes\n\nPayment within 45 days: [[price]].');
		const older = (await filesOf((await draftFor(first)).id))[0];

		const second = await receive('Change two');
		draftReply = asksFor(documentId, 'Add a delivery clause');
		documentReply = JSON.stringify({
			contract: false,
			name: 'Notes',
			change_note: '- Delivery: 2 weeks',
			markdown: '# Notes\n\nPayment within 45 days: [[price]].\n\nDelivery in 2 weeks.'
		});
		await draftFor(second);

		draftReply = JSON.stringify({
			reply_needed: true,
			reason: 'two changes to the notes',
			body: 'Both changes are in the attached file.'
		});
		await mergeDrafts('u1', second);

		const merged = await mergedDraft(second);
		const files = await filesOf(merged.id);

		expect(files).toHaveLength(1);
		expect(files[0].filename).toBe('Notes v3.docx');
		expect(files[0].placeholders).toEqual(['price']);
		expect(files[0].changeNote).toContain('From Notes v2.docx:\n- Payment terms: 30 → 45 days');
		expect(files[0].changeNote).toContain('- Delivery: 2 weeks');
		expect(await filesOf(older.draftId)).toHaveLength(0);
		expect(existsSync(path.dirname(older.path ?? ''))).toBe(false);

		expect(merged.reason).toBe('two changes to the notes');
	});

	it('keeps two different new documents', async () => {
		const first = await receive('Send a quote');
		draftReply = asksFor(null, 'A quote for 100 widgets');
		documentReply = editedMarkdown('# Quote\n\n100 widgets.');
		await draftFor(first);

		const second = await receive('And an invoice');
		draftReply = asksFor(null, 'An invoice for last month');
		documentReply = editedMarkdown('# Invoice\n\nMarch.');
		await draftFor(second);

		draftReply = JSON.stringify({ reply_needed: true, reason: 'both', body: 'Both attached.' });
		await mergeDrafts('u1', second);

		expect(await filesOf((await mergedDraft(second)).id)).toHaveLength(2);
	});

	it('only the owner can read a run\'s output', async () => {
		const emailId = await receive('Send a quote');
		draftReply = JSON.stringify({ reply_needed: true, reason: 'asks', body: 'Here it is.' });
		await draftFor(emailId);

		const runs = await db.select().from(agentRun).where(eq(agentRun.emailId, emailId));
		const drafting = runs.find((run) => run.agent === 'drafting.reply');

		expect(drafting).toMatchObject({ ok: true });
		expect(await getOwnedRunOutput('u1', drafting?.id ?? '')).toContain('Here it is.');
		expect(await getOwnedRunOutput('someone-else', drafting?.id ?? '')).toBeNull();
	});
});

describe('sending a draft with a document', () => {
	it('attaches the file, stores it as the next version, and the next edit starts from it', async () => {
		const documentId = await storedDocument('Notes.docx', DOCX_MIME, Buffer.from('PK fake docx'));
		const emailId = await receive('Please update');
		draftReply = asksFor(documentId, 'Payment to 45 days');
		documentReply = editedMarkdown('# Notes\n\nPayment within 45 days.');
		const written = await draftFor(emailId);

		const result = await sendDraft(emailId, written.id, 'Updated file attached.');
		expect(result).toEqual({ message: 'Reply sent' });

		const sent = await simpleParser(smtp.sent[0].raw);
		expect(sent.attachments).toHaveLength(1);
		expect(sent.attachments[0].filename).toBe('Notes v2.pdf');

		const latest = await latestVersion(documentId);
		expect(latest).toMatchObject({
			version: 2,
			filename: 'Notes v2.docx',
			emailId: null,
			sender: 'me@example.com'
		});

		/** The next request edits the Markdown that was sent, not the old received file. */
		const next = await receive('One more change');
		draftReply = asksFor(documentId, 'Add a delivery clause');
		documentReply = editedMarkdown('# Notes\n\nPayment within 45 days.\n\nDelivery in 2 weeks.');
		const files = await filesOf((await draftFor(next)).id);

		expect(userText(documentRequests[1])).toContain('Payment within 45 days.');
		expect(attachedFileCount(documentRequests[1])).toBe(0);
		expect(files[0].filename).toBe('Notes v3.docx');

		const versions = await db
			.select()
			.from(documentVersion)
			.where(eq(documentVersion.documentId, documentId));
		expect(versions).toHaveLength(2);
	});
});

describe('emails deleted on the server', () => {
	async function draftWithFile(): Promise<{ emailId: string; folder: string }> {
		const emailId = await receive('Send me a quote');
		draftReply = asksFor(null, 'A quote for 100 widgets');
		documentReply = editedMarkdown('# Quote\n\n100 widgets.');
		const files = await filesOf((await draftFor(emailId)).id);
		const folder = path.dirname(files[0].path ?? '');
		expect(existsSync(folder)).toBe(true);

		return { emailId, folder };
	}

	async function uidOf(emailId: string): Promise<number> {
		const rows = await db.select().from(email).where(eq(email.id, emailId));

		return rows[0].uid;
	}

	it('removes the files made for drafts on an email the server deleted', async () => {
		const { emailId, folder } = await draftWithFile();

		expunge(inbox, await uidOf(emailId));
		await syncAccount(account);

		expect(existsSync(folder)).toBe(false);
		expect(await db.select().from(generatedFile)).toHaveLength(0);
		expect(await db.select().from(draft)).toHaveLength(0);
	});

	it('keeps the files when the server could not say which emails are gone', async () => {
		const { emailId, folder } = await draftWithFile();

		expunge(inbox, await uidOf(emailId));
		server.searchFails = true;
		await syncAccount(account);

		expect(existsSync(folder)).toBe(true);
		expect(await db.select().from(generatedFile)).toHaveLength(1);
	});

	it('removes the files when the folder is renumbered', async () => {
		const { folder } = await draftWithFile();

		renumber(inbox);
		await syncAccount(account);

		expect(existsSync(folder)).toBe(false);
		expect(await db.select().from(generatedFile)).toHaveLength(0);
	});
});
