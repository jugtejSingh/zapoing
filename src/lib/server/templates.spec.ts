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

vi.mock('$lib/server/files/render/docxToPdf', () => ({
	docxToPdf: async () => Buffer.from('%PDF-from-docx')
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
import { parseTemplateAgentAction } from '$lib/server/ai/agents/templateAgent';
import { ingestFile } from '$lib/server/fileIndex';
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
import { fakePlannerReply, PLANNER_PREFIX } from '$lib/server/testing/fakePlanner';
import { addTrackedPerson, findContactByEmail } from '$lib/server/trackedPerson';
import { actions } from '../../routes/home/[id]/+page.server';
import { createTemplate, deleteTemplate, TemplateInputError } from './templates';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type ModelRequest = { messages: { role: string; content: unknown }[] };

const fetchMock = vi.fn();
let draftReply = '';
let fillReply = '';
/** What the template agent does: read the template before it fills, and how the file goes out. */
let agentReadsFirst = false;
let agentDeliverAs: 'docx' | 'pdf' | null = null;
let agentRequests: ModelRequest[] = [];

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
	agentReadsFirst = false;
	agentDeliverAs = null;
	agentRequests = [];
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
		const request = JSON.parse(init.body) as ModelRequest;
		const system = String(request.messages[0].content);

		if (system.startsWith('You find the fields')) {
			return okReply(PREPARE_REPLY);
		}

		if (system.startsWith('You are the template agent')) {
			agentRequests.push(request);

			let asked: RegExpExecArray | null = null;
			const pattern = /Use template (\S+?): ([^"\\]*)/g;
			const everything = JSON.stringify(request.messages);
			let found = pattern.exec(everything);

			/** The newest ask wins: the agent's history carries the earlier ones. */
			while (found !== null) {
				asked = found;
				found = pattern.exec(everything);
			}

			if (asked === null || asked[1] === 'none') {
				return okReply(JSON.stringify({ action: 'none', reason: 'no NDA template' }));
			}

			let spoken = 0;

			for (const message of request.messages) {
				if (message.role === 'assistant') {
					spoken = spoken + 1;
				}
			}

			if (agentReadsFirst && spoken === 0) {
				return okReply(JSON.stringify({ action: 'read', template_id: asked[1] }));
			}

			const fill: Record<string, unknown> = {
				action: 'fill',
				template_id: asked[1],
				change: asked[2]
			};

			if (agentDeliverAs !== null) {
				fill.deliver_as = agentDeliverAs;
			}

			return okReply(JSON.stringify(fill));
		}

		if (system.startsWith('You fill templates')) {
			return okReply(fillReply);
		}

		if (system.startsWith('You edit documents')) {
			return okReply(
				JSON.stringify({
					contract: true,
					name: 'NDA',
					change_note: '- Written from scratch',
					markdown: '# NDA\n\nBetween us and [[counterparty-name]].'
				})
			);
		}

		if (system.startsWith(PLANNER_PREFIX)) {
			return okReply(fakePlannerReply(draftReply, request.messages));
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
		expect(files[0]).toMatchObject({
			templateId,
			format: 'docx',
			error: null,
			sourcePath: null,
			sendAsPdf: true
		});
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
		expect(smtp.sent[0].raw.toString()).toContain('.pdf');
		expect(smtp.sent[0].raw.toString()).not.toContain('.docx');
	});

	it('writes the document from scratch when no template fits, and flags it', async () => {
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
		expect(files[0].error).toBeNull();
		expect(files[0].templateId).toBeNull();
		expect(files[0].path).not.toBeNull();
		expect(files[0].changeNote).toContain('No template fits this document');
	});
});

const FULL_VALUES = JSON.stringify({
	values: {
		'counterparty-name': 'Acme Ltd',
		'effective-date': '1 March 2026',
		'governing-law': 'England & Wales',
		'notice-period': 'sixty days'
	},
	change_note: '- Everything filled in'
});

async function draftForNda(templateId: string): Promise<{ emailId: string; draftId: string }> {
	const emailId = await receive('Can you send your NDA?');
	draftReply = JSON.stringify({
		reply_needed: true,
		reason: 'asks for the NDA',
		body: 'NDA attached.',
		documents: [{ template_id: templateId, change: 'NDA for Acme' }]
	});

	await createDraftForEmail({ contactId, emailId });
	const drafts = await db.select().from(draft).where(eq(draft.emailId, emailId));

	return { emailId, draftId: drafts[0].id };
}

async function filesOnDraft(draftId: string) {
	return db.select().from(generatedFile).where(eq(generatedFile.draftId, draftId));
}

describe('parseTemplateAgentAction', () => {
	it('reads read, fill and none, with fill going out as a PDF unless Word is asked for', () => {
		expect(parseTemplateAgentAction('{"action":"read","template_id":"t1"}')).toEqual({
			action: 'read',
			templateId: 't1'
		});
		expect(
			parseTemplateAgentAction('{"action":"fill","template_id":"t1","change":"for Acme"}')
		).toEqual({ action: 'fill', templateId: 't1', change: 'for Acme', deliverAs: 'pdf' });
		expect(
			parseTemplateAgentAction(
				'{"action":"fill","template_id":"t1","change":"for Acme","deliver_as":"docx"}'
			)
		).toEqual({ action: 'fill', templateId: 't1', change: 'for Acme', deliverAs: 'docx' });
		expect(
			parseTemplateAgentAction(
				'{"action":"fill","template_id":"t1","change":"for Acme","deliver_as":"rtf"}'
			)
		).toMatchObject({ deliverAs: 'pdf' });
		expect(parseTemplateAgentAction('{"action":"none","reason":"no NDA"}')).toEqual({
			action: 'none',
			reason: 'no NDA'
		});
	});

	it('strips a code fence, and takes anything unusable as none so the document maker takes over', () => {
		const fence = '```';

		expect(
			parseTemplateAgentAction(fence + 'json\n{"action":"read","template_id":"t1"}\n' + fence)
		).toEqual({ action: 'read', templateId: 't1' });
		expect(parseTemplateAgentAction('I think the NDA fits')).toMatchObject({ action: 'none' });
		expect(parseTemplateAgentAction('{"action":"fill","template_id":"t1"}')).toMatchObject({
			action: 'none'
		});
		expect(parseTemplateAgentAction('{"action":"read"}')).toMatchObject({ action: 'none' });
		expect(parseTemplateAgentAction('{"action":"launch"}')).toEqual({
			action: 'none',
			reason: 'No template fits'
		});
	});
});

describe('the template agent', () => {
	it('sends a filled Word template as a PDF by default, converted at send time', async () => {
		const templateId = await readyNda();
		fillReply = FULL_VALUES;
		const { emailId, draftId } = await draftForNda(templateId);

		const files = await filesOnDraft(draftId);
		expect(files[0]).toMatchObject({ format: 'docx', sendAsPdf: true, error: null });
		expect(files[0].placeholders).toEqual([]);

		await actions.reply(actionEvent(emailId, 'reply', sendForm(emailId, draftId)));

		expect(smtp.sent).toHaveLength(1);
		expect(smtp.sent[0].raw.toString()).toContain('.pdf');
		expect(smtp.sent[0].raw.toString()).not.toContain('.docx');
	});

	it('sends it as Word when the agent says docx, and never converts', async () => {
		const templateId = await readyNda();
		fillReply = FULL_VALUES;
		agentDeliverAs = 'docx';
		const { emailId, draftId } = await draftForNda(templateId);

		const files = await filesOnDraft(draftId);
		expect(files[0]).toMatchObject({ format: 'docx', sendAsPdf: false, error: null });

		await actions.reply(actionEvent(emailId, 'reply', sendForm(emailId, draftId)));

		expect(smtp.sent).toHaveLength(1);
		expect(smtp.sent[0].raw.toString()).toContain('.docx');
		expect(smtp.sent[0].raw.toString()).not.toContain('.pdf');
	});

	it('reads the template before it fills it, and only then makes the file', async () => {
		const templateId = await readyNda();
		expect(await ingestFile('template', templateId)).toBe(true);
		fillReply = FULL_VALUES;
		agentReadsFirst = true;
		const { draftId } = await draftForNda(templateId);

		expect(agentRequests).toHaveLength(2);

		const second = JSON.stringify(agentRequests[1].messages);
		expect(second).toContain('Mutual Non-Disclosure Agreement');
		expect(second).toContain('counterparty-name');

		const files = await filesOnDraft(draftId);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({ templateId, error: null });
	});

	it('is told there is no such template when it reads an id that does not exist', async () => {
		fillReply = FULL_VALUES;
		agentReadsFirst = true;
		const emailId = await receive('Can you send your NDA?');
		draftReply = JSON.stringify({
			reply_needed: true,
			reason: 'asks for the NDA',
			body: 'NDA attached.',
			documents: [{ template_id: 'not-a-template', change: 'NDA for Acme' }]
		});

		await createDraftForEmail({ contactId, emailId });

		expect(JSON.stringify(agentRequests[1].messages)).toContain(
			'there is no template with that id'
		);
	});

	it('removes a failed fill from the draft and has the document maker write it instead', async () => {
		const templateId = await readyNda();
		fillReply = 'this is not json';
		const { draftId } = await draftForNda(templateId);

		const files = await filesOnDraft(draftId);

		expect(files).toHaveLength(1);
		expect(files[0].error).toBeNull();
		expect(files[0].templateId).toBeNull();
		expect(files[0].changeNote).toContain('No template fits this document');
	});

	it('does not fill a template that belongs to someone else', async () => {
		await createTestUser('u2');
		const other = await createTemplate('u2', {
			name: 'Their NDA',
			description: 'Not yours',
			file: docxFile(await sampleNda())
		});
		await prepareTemplate({ templateId: other.id });
		fillReply = FULL_VALUES;
		const { draftId } = await draftForNda(other.id);

		const files = await filesOnDraft(draftId);

		expect(files).toHaveLength(1);
		expect(files[0].templateId).toBeNull();
	});
});
