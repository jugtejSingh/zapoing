import { readFile, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { email, generatedFile, template, type TemplateField } from '$lib/server/db/schema';
import { recordAgentRun } from '$lib/server/ai/agentRun';
import {
	cleanName,
	errorText,
	type DocumentRequest,
	type DraftForDocuments
} from '$lib/server/ai/agents/document';
import { callModel, type ModelFile } from '$lib/server/ai/model';
import {
	documentText,
	fillFields,
	markersIn,
	markFields,
	type FieldText
} from '$lib/server/files/fill/officeXml';
import { indexedText } from '$lib/server/fileIndex';
import { readBranding } from '$lib/server/branding';
import { renderPdf } from '$lib/server/files/render/pdf';
import { registerJobHandler } from '$lib/server/jobs/worker';
import {
	generatedFilePath,
	templateInfoPath,
	templateMarkedPath,
	templateOriginalPath
} from '$lib/server/storage/paths';
import type { TemplateRow } from '$lib/server/templates';
import { fillPlaceholder, listPlaceholders } from '$lib/placeholders';

type EmailRow = typeof email.$inferSelect;

export type TemplatePreparePayload = {
	templateId: string;
};

const FIELD_RULES = `- A field is anything that changes from one use to the next: the other party's name, company and address, dates, amounts, durations, signatory names and titles.
- Leave out what is the same every time, like the user's own company details and the standard clauses.
- name is short, lowercase and dashed, e.g. "counterparty-name", "effective-date". Each name once.
- description says what goes there in a few words.`;

const PREPARE_OFFICE_PROMPT = `You find the fields in templates.
The document's text is given one paragraph per line.
Return JSON only, with no code fence: {"fields": [{"name": "counterparty-name", "description": "the other party's company name", "text": ["Acme Ltd"]}]}

${FIELD_RULES}
- text lists the exact text the field replaces (a sample value, a blank like "________" or a "[Company Name]" prompt), copied character for character from the document. Several entries if it appears in different forms.
- A text must belong to that field alone: if the same blank is used for different fields, leave it out of text.`;

const PREPARE_PDF_PROMPT = `You find the fields in templates.
The document's text is below.
Return JSON only, with no code fence: {"fields": [{"name": "counterparty-name", "description": "the other party's company name"}], "markdown": "the whole document"}

${FIELD_RULES}
- markdown is the whole document in GitHub Markdown, word for word, with [[name]] wherever a field goes, in place of the sample value or blank.
- No images, no HTML.`;

const FILL_PROMPT = `You fill templates for the user.
Return JSON only, with no code fence: {"values": {"field-name": "value or null"}, "change_note": "Markdown list"}

- One entry in values for every field listed.
- Use only facts from the background, the reply and the request. A value you do not have is null. Never guess or invent.
- change_note has one line per filled field saying where the value came from, e.g. "- counterparty-name: Acme Ltd (from the email signature)". Then one line listing the fields left empty.`;

function stripFence(raw: string): string {
	let text = raw.trim();
	text = text.replace(/^```(?:json)?\s*/i, '');
	text = text.replace(/\s*```$/, '');
	return text;
}

/** Same shape as the reply placeholders: no brackets, no newlines, not blank. */
function cleanFieldName(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const name = value
		.replace(/[[\]\n\r]/g, '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.slice(0, 60);

	if (name.length === 0) {
		return null;
	}

	return name;
}

type ModelField = FieldText & { description: string };

export function parsePrepareReply(raw: string): { fields: ModelField[]; markdown: string | null } {
	let parsed: { fields?: unknown; markdown?: unknown };

	try {
		parsed = JSON.parse(stripFence(raw));
	} catch {
		throw new Error('The model did not return valid JSON for the template');
	}

	const fields: ModelField[] = [];

	if (Array.isArray(parsed.fields)) {
		for (const entry of parsed.fields) {
			const candidate = entry as { name?: unknown; description?: unknown; text?: unknown };
			const name = cleanFieldName(candidate.name);

			if (name === null || fields.some((field) => field.name === name)) {
				continue;
			}

			let description = '';

			if (typeof candidate.description === 'string') {
				description = candidate.description.trim();
			}

			const texts: string[] = [];

			if (Array.isArray(candidate.text)) {
				for (const text of candidate.text) {
					if (typeof text === 'string' && text.trim().length > 0) {
						texts.push(text);
					}
				}
			} else if (typeof candidate.text === 'string' && candidate.text.trim().length > 0) {
				texts.push(candidate.text);
			}

			fields.push({ name, description, texts });
		}
	}

	let markdown: string | null = null;

	if (typeof parsed.markdown === 'string' && parsed.markdown.trim().length > 0) {
		markdown = parsed.markdown;
	}

	return { fields, markdown };
}

async function loadTemplate(templateId: string): Promise<TemplateRow | null> {
	const rows = await db.select().from(template).where(eq(template.id, templateId)).limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0];
}

function countOf(text: string, marker: string): number {
	return text.split(marker).length - 1;
}

/** Finds the fields and writes the marked copy. */
async function prepare(row: TemplateRow): Promise<TemplateField[]> {
	const original = await readFile(await templateOriginalPath(row.id, row.format));
	const markedPath = await templateMarkedPath(row.id, row.format);

	if (row.format === 'pdf') {
		/** The ingestion job already read the PDF, so this model only needs its text. */
		const pdfText = await indexedText('template', row.id);

		if (pdfText === null) {
			throw new Error('The PDF has not been read yet');
		}

		const raw = await recordAgentRun('template.prepare', null, () => {
			return callModel('template', [
				{ role: 'system', content: PREPARE_PDF_PROMPT },
				{
					role: 'user',
					content:
						'Template: ' + row.name + '\n' + row.description + '\n\nThe document:\n' + pdfText
				}
			]);
		});
		const reply = parsePrepareReply(raw);

		if (reply.markdown === null) {
			throw new Error('The model returned no text for the PDF');
		}

		await writeFile(markedPath, reply.markdown, 'utf8');

		const fields: TemplateField[] = [];

		for (const field of reply.fields) {
			fields.push({
				name: field.name,
				description: field.description,
				found: countOf(reply.markdown, '[[' + field.name + ']]')
			});
		}

		return fields;
	}

	const text = await documentText(original, row.format);
	const raw = await recordAgentRun('template.prepare', null, () => {
		return callModel('template', [
			{ role: 'system', content: PREPARE_OFFICE_PROMPT },
			{
				role: 'user',
				content: 'Template: ' + row.name + '\n' + row.description + '\n\nThe document:\n' + text
			}
		]);
	});
	const reply = parsePrepareReply(raw);
	const marked = await markFields(original, row.format, reply.fields);
	await writeFile(markedPath, marked.content);

	const fields: TemplateField[] = [];

	for (const field of reply.fields) {
		fields.push({
			name: field.name,
			description: field.description,
			found: marked.found.get(field.name) ?? 0
		});
	}

	return fields;
}

/**
 * The template.prepare job. A failure marks the template failed with the reason
 * rather than retrying. ponytail: the user retries by replacing the file; add
 * a Retry button if model hiccups make that common.
 */
export async function prepareTemplate(payload: TemplatePreparePayload): Promise<void> {
	const row = await loadTemplate(payload.templateId);

	if (row === null) {
		return;
	}

	try {
		const fields = await prepare(row);

		if (fields.length === 0) {
			throw new Error('No fields were found in the template');
		}

		await writeFile(
			await templateInfoPath(row.id),
			JSON.stringify({ name: row.name, description: row.description, fields }, null, 2) + '\n',
			'utf8'
		);
		await db
			.update(template)
			.set({ fields, status: 'ready', error: null })
			.where(eq(template.id, row.id));
	} catch (caught) {
		console.error('Template preparation failed:', caught);
		await db
			.update(template)
			.set({ status: 'failed', error: errorText(caught) })
			.where(eq(template.id, row.id));
	}
}

/** The templates section of the drafting context. */
export function describeTemplates(rows: TemplateRow[]): string {
	const lines: string[] = ['[TEMPLATES]'];

	for (const row of rows) {
		const names: string[] = [];

		for (const field of row.fields) {
			names.push(field.name);
		}

		lines.push(
			'- id: ' +
				row.id +
				' | ' +
				row.name +
				' | ' +
				row.description +
				' | fields: ' +
				names.join(', ')
		);
	}

	if (lines.length === 1) {
		lines.push('None.');
	}

	return lines.join('\n');
}

export function parseFillReply(raw: string): { values: Map<string, string>; changeNote: string } {
	let parsed: { values?: unknown; change_note?: unknown };

	try {
		parsed = JSON.parse(stripFence(raw));
	} catch {
		throw new Error('The model did not return valid JSON for the template values');
	}

	const values = new Map<string, string>();

	if (typeof parsed.values === 'object' && parsed.values !== null) {
		for (const [name, value] of Object.entries(parsed.values)) {
			/** Null or blank stays a [[field]] for the user to fill. */
			if (typeof value === 'string' && value.trim().length > 0) {
				values.set(name, value.trim());
			} else if (typeof value === 'number') {
				values.set(name, String(value));
			}
		}
	}

	let changeNote = '';

	if (typeof parsed.change_note === 'string') {
		changeNote = parsed.change_note.trim();
	}

	return { values, changeNote };
}

function fillMessage(
	row: TemplateRow,
	request: DocumentRequest,
	replyBody: string,
	background: string
): string {
	const fields: string[] = [];

	for (const field of row.fields) {
		fields.push('- ' + field.name + ': ' + field.description);
	}

	return [
		'Background (the user, the person and the thread):\n' + background,
		'Template: ' + row.name,
		'Fields:\n' + fields.join('\n'),
		'What was asked for: ' + request.change,
		'The email reply it goes with:\n' + replyBody
	].join('\n\n');
}

async function ownedReadyTemplate(userId: string, templateId: string): Promise<TemplateRow> {
	const row = await loadTemplate(templateId);

	if (row === null || row.userId !== userId) {
		throw new Error('The model asked for a template that does not exist');
	}

	if (row.status !== 'ready') {
		throw new Error('The template "' + row.name + '" is not ready');
	}

	return row;
}

/**
 * Fills a template for a draft: one model call for the values, then local
 * substitution into the marked copy, so the layout stays the user's. Fields
 * without a value stay as [[field]]. Like generateDocument, a problem becomes
 * a generated_file row with `error` set.
 */
export async function generateFromTemplate(
	draftRow: DraftForDocuments,
	row: EmailRow,
	request: DocumentRequest,
	owner: { userId: string; contactName: string | null },
	background: string,
	resourceFiles: ModelFile[] = []
): Promise<void> {
	const id = crypto.randomUUID();
	const threadKey = row.threadId ?? row.id;
	let templateId: string | null = null;
	let format: TemplateRow['format'] = 'pdf';
	let filename = 'Template.pdf';

	try {
		if (request.templateId === null) {
			throw new Error('No template was given');
		}

		const templateRow = await ownedReadyTemplate(owner.userId, request.templateId);
		templateId = templateRow.id;
		format = templateRow.format;
		filename = cleanName(templateRow.name) + '.' + format;

		if (owner.contactName !== null && owner.contactName.trim().length > 0) {
			filename = cleanName(templateRow.name + ' - ' + owner.contactName) + '.' + format;
		}

		let agent: 'template' | 'financial' = 'template';

		if (format === 'xlsx') {
			agent = 'financial';
		}

		const raw = await recordAgentRun('template.fill', row.id, () => {
			return callModel(
				agent,
				[
					{ role: 'system', content: FILL_PROMPT },
					{ role: 'user', content: fillMessage(templateRow, request, draftRow.body, background) }
				],
				resourceFiles
			);
		});
		const reply = parseFillReply(raw);
		const marked = await templateMarkedPath(templateRow.id, format);
		const filePath = await generatedFilePath(threadKey, id, filename);
		let sourcePath: string | null = null;
		let placeholders: string[] = [];

		if (format === 'pdf') {
			let source = await readFile(marked, 'utf8');

			for (const [name, value] of reply.values) {
				source = fillPlaceholder(source, name, value);
			}

			sourcePath = await generatedFilePath(threadKey, id, 'source.md');
			await writeFile(sourcePath, source, 'utf8');
			await writeFile(filePath, await renderPdf(source, await readBranding()));
			placeholders = listPlaceholders(source);
		} else {
			const filled = await fillFields(await readFile(marked), format, reply.values);
			await writeFile(filePath, filled);
			placeholders = await markersIn(filled, format);
		}

		await writeFile(
			await generatedFilePath(threadKey, id, filename + '.changes.md'),
			reply.changeNote + '\n',
			'utf8'
		);

		await db.insert(generatedFile).values({
			id,
			draftId: draftRow.id,
			templateId,
			change: request.change,
			filename,
			format,
			path: filePath,
			sourcePath,
			changeNote: reply.changeNote,
			placeholders,
			sendAsPdf: format === 'docx' && request.deliverAs !== 'docx'
		});
	} catch (caught) {
		console.error('Template fill failed:', caught);
		await db.insert(generatedFile).values({
			id,
			draftId: draftRow.id,
			templateId,
			change: request.change,
			filename,
			format,
			error: errorText(caught)
		});
	}
}

export function registerTemplateAgent(): void {
	registerJobHandler('template.prepare', async (payload) => {
		await prepareTemplate(payload as TemplatePreparePayload);
	});
}
