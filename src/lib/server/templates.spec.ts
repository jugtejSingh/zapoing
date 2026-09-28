import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
	return 'templates-spec-' + String(Date.now());
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

vi.mock('$lib/server/files/render/pdf', () => ({
	renderPdf: async (source: string) => Buffer.from('%PDF-stub\n' + source)
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
import { and, eq } from 'drizzle-orm';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import JSZip from 'jszip';
import { db } from '$lib/server/db';
import { draft, email, generatedFile, template } from '$lib/server/db/schema';
import { prepareTemplate } from '$lib/server/ai/agents/template';
import { createDraftForEmail } from '$lib/server/ai/agents/drafting';
import { documentText, markFields } from '$lib/server/files/fill/officeXml';
import { syncAccount } from '$lib/server/mailSync';
import type { MailAccountCredentials } from '$lib/server/mailAccount';
import { templateDir } from '$lib/server/storage/paths';
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
import { actions } from '../../routes/home/[id]/+page.server';
import { createTemplate, deleteTemplate, TemplateInputError } from './templates';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type ModelRequest = { messages: { role: string; content: unknown }[] };

const fetchMock = vi.fn();
let draftReply = '';
let fillReply = '';

const PREPARE_REPLY = JSON.stringify({
	fields: [
		{ name: 'counterparty-name', description: "the other party's company", text: ['Acme Ltd'] },
		{ name: 'effective-date', description: 'when it starts', text: ['________'] },
		{ name: 'governing-law', description: 'which law applies', text: ['England & Wales'] },
		{ name: 'notice-period', description: 'days of notice', text: ['sixty days'] }
	]
});

function okReply(text: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
		status: 200
	});
}

/** A small NDA. "Acme Ltd" is split over two runs with different formatting, as Word often does. */
async function sampleNda(): Promise<Buffer> {
	const document = new Document({
		sections: [
			{
				children: [
					new Paragraph({ children: [new TextRun('Mutual Non-Disclosure Agreement')] }),
					new Paragraph({
						children: [
							new TextRun('This agreement is between Northwind Ltd and '),
							new TextRun({ text: 'Acme ', bold: true }),
							new TextRun('Ltd.')
						]
					}),
					new Paragraph({ children: [new TextRun('Effective date: ________')] }),
					new Paragraph({ children: [new TextRun('Governed by the laws of England & Wales.')] }),
					new Paragraph({ children: [new TextRun('Signed for Acme Ltd')] })
				]
			}
		]
	});

	return Packer.toBuffer(document);
}

async function bodyXml(content: Buffer): Promise<string> {
	const zip = await JSZip.loadAsync(content);
	return (await zip.file('word/document.xml')?.async('string')) ?? '';
}

function docxFile(content: Buffer, name = 'NDA.docx'): File {
	return new File([new Uint8Array(content)], name, { type: DOCX_MIME });
}

let account: MailAccountCredentials;
let inbox: FakeFolder;
let contactId: string;

async function receive(subject: string): Promise<string> {
	const delivered = deliver(inbox, {
		subject,
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

async function readyNda(): Promise<string> {
	const row = await createTemplate('u1', {
		name: 'Mutual NDA',
		description: 'Before any deal talks',
		file: docxFile(await sampleNda())
	});
	await prepareTemplate({ templateId: row.id });

	return row.id;
}

type ActionEvent = Parameters<typeof actions.reply>[0];

function actionEvent(emailId: string, action: string, form: FormData): ActionEvent {
	return {
		request: new Request('http://localhost/home/' + emailId + '?/' + action, {
			method: 'POST',
			body: form
		}),
		locals: { user: { id: 'u1' } }
	} as unknown as ActionEvent;
}

function sendForm(emailId: string, draftId: string): FormData {
	const form = new FormData();
	form.set('emailId', emailId);
	form.set('draftId', draftId);
	form.set('body', 'NDA attached.');
	form.set('cc', '');
	return form;
}

beforeAll(() => {
	migrateTestDb();
});

beforeEach(async () => {
	delete (globalThis as { __zapoingJobWorker?: unknown }).__zapoingJobWorker;
	smtp.sent = [];
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
		const request = JSON.parse(init.body) as ModelRequest;
		const system = String(request.messages[0].content);

		if (system.startsWith('You find the fields')) {
			return okReply(PREPARE_REPLY);
		}

		if (system.startsWith('You fill templates')) {
			return okReply(fillReply);
		}

		if (system.startsWith('You write email replies')) {
			return okReply(draftReply);
		}

		return okReply('## Who they are\nAnna, buyer at Acme.');
	});

	await resetTestDb();
	resetFakeServers();
	await createTestUser('u1');
	inbox = folderOf(createFakeServer('me@example.com'), 'INBOX');
	account = await createTestAccount('u1', 'me@example.com');
	await addTrackedPerson('u1', 'anna@acme.test');

	const found = await findContactByEmail('u1', 'anna@acme.test');

	if (found === null) {
		throw new Error('contact missing');
	}

	contactId = found.id;
});

describe('markFields', () => {
	it('marks text split over runs, keeps the formatting of the first run, and counts', async () => {
		const nda = await sampleNda();

		expect(await documentText(nda, 'docx')).toContain('between Northwind Ltd and Acme Ltd.');

		const marked = await markFields(nda, 'docx', [
			{ name: 'counterparty-name', texts: ['Acme Ltd', 'Acme'] },
			{ name: 'governing-law', texts: ['England & Wales'] },
			{ name: 'notice-period', texts: ['sixty days'] }
		]);
		const xml = await bodyXml(marked.content);

		expect(xml).toContain('[[counterparty-name]]');
		expect(xml).not.toContain('Acme');
		expect(xml).toContain('[[governing-law]]');
		expect(xml).toContain('<w:b/>');
		expect(marked.found.get('counterparty-name')).toBe(2);
		expect(marked.found.get('governing-law')).toBe(1);
		expect(marked.found.get('notice-period')).toBeUndefined();
		expect(await documentText(marked.content, 'docx')).toContain(
			'between Northwind Ltd and [[counterparty-name]].'
		);
	});
});

describe('templates', () => {
	it('finds the fields of an uploaded NDA and flags the ones not in the file', async () => {
		const templateId = await readyNda();
		const rows = await db.select().from(template).where(eq(template.id, templateId));

		expect(rows[0].status).toBe('ready');
		expect(rows[0].fields).toEqual([
			{ name: 'counterparty-name', description: "the other party's company", found: 2 },
			{ name: 'effective-date', description: 'when it starts', found: 1 },
			{ name: 'governing-law', description: 'which law applies', found: 1 },
			{ name: 'notice-period', description: 'days of notice', found: 0 }
		]);
		expect(existsSync(templateDir(templateId) + '/template.json')).toBe(true);
		expect(await bodyXml(await readFile(templateDir(templateId) + '/template.docx'))).toContain(
			'[[effective-date]]'
		);
	});

	it('only accepts Word, Excel and PDF files', async () => {
		const text = new File(['hello'], 'notes.txt', { type: 'text/plain' });
		const renamed = new File(['MZ'], 'nda.docx', { type: 'application/x-msdownload' });

		await expect(
			createTemplate('u1', { name: 'Notes', description: '', file: text })
		).rejects.toBeInstanceOf(TemplateInputError);
		await expect(
			createTemplate('u1', { name: 'NDA', description: '', file: renamed })
		).rejects.toBeInstanceOf(TemplateInputError);
		expect(await db.select().from(template)).toHaveLength(0);
	});

	it('delete removes the row and the folder', async () => {
		const templateId = await readyNda();

		expect(await deleteTemplate('u2', templateId)).toBe(false);
		expect(await deleteTemplate('u1', templateId)).toBe(true);
		expect(await db.select().from(template)).toHaveLength(0);
		expect(existsSync(templateDir(templateId))).toBe(false);
	});

	it('fills the template for a draft, leaves unknown fields, and blocks Send until they are filled', async () => {
		const templateId = await readyNda();
		const emailId = await receive('Can you send your NDA?');
		draftReply = JSON.stringify({
			reply_needed: true,
			reason: 'asks for the NDA',
			body: 'NDA attached.',
			documents: [{ template_id: templateId, change: 'NDA for Acme' }]
		});
		fillReply = JSON.stringify({
			values: {
				'counterparty-name': 'Acme Ltd',
				'effective-date': null,
				'governing-law': 'England & Wales',
				'notice-period': null
			},
			change_note: '- counterparty-name: Acme Ltd (from the signature)'
		});

		await createDraftForEmail({ contactId, emailId });
		const drafts = await db.select().from(draft).where(eq(draft.emailId, emailId));
		const files = await db
			.select()
			.from(generatedFile)
			.where(eq(generatedFile.draftId, drafts[0].id));

		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({ templateId, format: 'docx', error: null, sourcePath: null });
		expect(files[0].filename).toMatch(/^Mutual NDA.*\.docx$/);
		expect(files[0].placeholders).toEqual(['effective-date']);

		const filled = await bodyXml(await readFile(files[0].path ?? ''));

		expect(filled).toContain('Acme Ltd');
		expect(filled).toContain('England &amp; Wales');
		expect(filled).toContain('[[effective-date]]');

		const blocked = await actions.reply(
			actionEvent(emailId, 'reply', sendForm(emailId, drafts[0].id))
		);

		expect(blocked).toMatchObject({ status: 400 });
		expect(smtp.sent).toHaveLength(0);

		const values = new FormData();
		values.set('generatedId', files[0].id);
		values.set('value:effective-date', '1 March 2026');
		await actions.fillGenerated(actionEvent(emailId, 'fillGenerated', values));

		const after = await db.select().from(generatedFile).where(eq(generatedFile.id, files[0].id));

		expect(after[0].placeholders).toEqual([]);
		expect(await bodyXml(await readFile(after[0].path ?? ''))).toContain('1 March 2026');

		await actions.reply(actionEvent(emailId, 'reply', sendForm(emailId, drafts[0].id)));

		expect(smtp.sent).toHaveLength(1);
	});

	it('makes nothing when no template fits, and says so on the draft', async () => {
		const emailId = await receive('Can you send your NDA?');
		draftReply = JSON.stringify({
			reply_needed: true,
			reason: 'asks for the NDA',
			body: 'NDA to follow.',
			documents: [{ missing_template: 'NDA', change: 'send the NDA' }]
		});

		await createDraftForEmail({ contactId, emailId });
		const drafts = await db.select().from(draft).where(eq(draft.emailId, emailId));
		const files = await db
			.select()
			.from(generatedFile)
			.where(eq(generatedFile.draftId, drafts[0].id));

		expect(files).toHaveLength(1);
		expect(files[0].path).toBeNull();
		expect(files[0].error).toContain('No template fits "NDA"');
	});
});
