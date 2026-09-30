import { readFile, writeFile } from 'node:fs/promises';
import { and, asc, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { document, draft, email, generatedFile } from '$lib/server/db/schema';
import { recordAgentRun } from '$lib/server/ai/agentRun';
import { callModel, type ModelFile } from '$lib/server/ai/model';
import { indexedText, indexRows } from '$lib/server/fileIndex';
import { getOwnedResource } from '$lib/server/resources';
import {
	latestVersion,
	nameWithoutExtensions,
	readWorkingCopy,
	type WorkingKind
} from '$lib/server/files/documents';
import { renderDocx } from '$lib/server/files/render/docx';
import { readBranding } from '$lib/server/branding';
import { renderPdf } from '$lib/server/files/render/pdf';
import { renderXlsx, type Sheet, type SheetCell } from '$lib/server/files/render/xlsx';
import { generatedFilePath } from '$lib/server/storage/paths';
import { listPlaceholders } from '$lib/placeholders';

type EmailRow = typeof email.$inferSelect;
type DocumentRow = typeof document.$inferSelect;
type VersionRow = NonNullable<Awaited<ReturnType<typeof latestVersion>>>;
type Format = 'pdf' | 'docx' | 'xlsx';

/**
 * What the drafting model asked for: a change to a stored document, a new one
 * when documentId is null, a filled template, or (missingTemplate) a new
 * document standing in for a standard one no template fits.
 */
export type DocumentRequest = {
	documentId: string | null;
	/** A resource to make a changed copy of; the original is never touched. */
	sourceResourceId: string | null;
	templateId: string | null;
	missingTemplate: string | null;
	/** A new or changed spreadsheet: the financial agent's work. */
	spreadsheet: boolean;
	/**
	 * What the user receives: a Word file, or a PDF made from the Word file with LibreOffice.
	 * null keeps the old rule: Word stays Word, everything else is a PDF.
	 */
	deliverAs: 'docx' | 'pdf' | null;
	change: string;
};

export type DraftForDocuments = {
	id: string;
	emailId: string;
	contactId: string;
	body: string;
};

const SHEET_EXTENSIONS = ['xlsx', 'xls', 'csv'];

const REBUILD_NOTE =
	'Rebuilt from the text of the previous version: its exact layout, fonts, images and formulas are not kept.';

const NO_TEMPLATE_NOTE =
	'No template fits this document, so it was written from scratch. Check it before sending.';

function systemPrompt(kind: WorkingKind): string {
	let output = '"markdown": "the full document in GitHub Markdown"';

	if (kind === 'sheets') {
		output = '"sheets": [{"name": "Sheet1", "rows": [["cell", 1, true, null]]}]';
	}

	return `You edit documents for the user.
Return JSON only, with no code fence: {"contract": true or false, "name": "short document name", "change_note": "Markdown list of what changed", ${output}}

- Return the whole document, not just the changed part. Keep everything that was not asked to change, word for word.
- Make exactly the change asked for. Anything you would have to invent (a date, price, name or figure you do not have) becomes a placeholder like [[price]].
- contract is true when the document is a contract, agreement or other legally binding terms.
- change_note lists each change in one line, e.g. "- Payment terms: 30 → 45 days".
- No images, no HTML.`;
}

function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf('.');

	if (dot === -1) {
		return '';
	}

	return filename.slice(dot + 1).toLowerCase();
}

function baseNameOf(filename: string): string {
	const dot = filename.lastIndexOf('.');

	if (dot <= 0) {
		return filename;
	}

	return filename.slice(0, dot);
}

/** Letters, digits, spaces and a few marks; nothing a file system or a header chokes on. */
export function cleanName(value: string): string {
	const cleaned = value
		.replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 80);

	if (cleaned.length === 0) {
		return 'Document';
	}

	return cleaned;
}

/** "Contract v3" → "Contract", so the next file can be "Contract v4". */
function stripVersionSuffix(name: string): string {
	const stripped = name.replace(/[\s_-]*v\d+$/i, '').trim();

	if (stripped.length === 0) {
		return name;
	}

	return stripped;
}

function kindForVersion(latest: VersionRow | null): WorkingKind {
	if (latest !== null && SHEET_EXTENSIONS.includes(extensionOf(latest.filename))) {
		return 'sheets';
	}

	return 'markdown';
}

/** Spreadsheets stay spreadsheets, Word stays Word unless it is a contract, everything else is a PDF. */
export function outputFormat(latestFilename: string | null, contract: boolean): Format {
	if (latestFilename === null) {
		return 'pdf';
	}

	const extension = extensionOf(latestFilename);

	if (SHEET_EXTENSIONS.includes(extension)) {
		return 'xlsx';
	}

	if (extension === 'docx' && !contract) {
		return 'docx';
	}

	return 'pdf';
}

/** The documents section of the drafting context: what the model may ask to change, by id. */
export async function describeDocuments(contactId: string): Promise<string> {
	const rows = await db
		.select()
		.from(document)
		.where(eq(document.contactId, contactId))
		.orderBy(asc(document.createdAt));
	const lines: string[] = ['[DOCUMENTS]'];

	for (const row of rows) {
		const latest = await latestVersion(row.id);

		if (latest === null) {
			continue;
		}

		let line =
			'- id: ' +
			row.id +
			' | ' +
			row.name +
			' | latest: v' +
			String(latest.version) +
			' "' +
			latest.filename +
			'"';
		const indexed = (await indexRows('attachment', [latest.id])).get(latest.id);

		if (indexed !== undefined && indexed.status === 'ready') {
			line = line + ' | ' + indexed.description;
		}

		lines.push(line);
	}

	if (lines.length === 1) {
		lines.push('None yet.');
	}

	return lines.join('\n');
}

type PendingSource = {
	source: string;
	filename: string;
};

/**
 * The newest file another pending draft made for this document, so a second
 * edit builds on the first. Drafts on the same email are left out: a
 * regenerate replaces them.
 */
async function pendingSource(documentId: string, emailId: string): Promise<PendingSource | null> {
	const rows = await db
		.select({ sourcePath: generatedFile.sourcePath, filename: generatedFile.filename })
		.from(generatedFile)
		.innerJoin(draft, eq(generatedFile.draftId, draft.id))
		.where(
			and(
				eq(generatedFile.documentId, documentId),
				eq(draft.status, 'pending'),
				ne(draft.emailId, emailId),
				isNull(generatedFile.error),
				isNotNull(generatedFile.sourcePath)
			)
		)
		.orderBy(desc(generatedFile.createdAt))
		.limit(1);

	if (rows.length === 0 || rows[0].sourcePath === null) {
		return null;
	}

	return { source: await readFile(rows[0].sourcePath, 'utf8'), filename: rows[0].filename };
}

type ModelDocument = {
	contract: boolean;
	name: string;
	changeNote: string;
	markdown: string;
	sheets: Sheet[];
};

function readCell(value: unknown): SheetCell {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return value;
	}

	return JSON.stringify(value) ?? null;
}

function readSheets(value: unknown): Sheet[] {
	if (!Array.isArray(value)) {
		throw new Error('The model returned no sheets');
	}

	const sheets: Sheet[] = [];

	for (const entry of value) {
		const candidate = entry as { name?: unknown; rows?: unknown };
		let name = 'Sheet';
		const rows: SheetCell[][] = [];

		if (typeof candidate.name === 'string') {
			name = candidate.name;
		}

		if (!Array.isArray(candidate.rows)) {
			throw new Error('A sheet from the model has no rows');
		}

		for (const row of candidate.rows) {
			const cells: SheetCell[] = [];

			if (Array.isArray(row)) {
				for (const cell of row) {
					cells.push(readCell(cell));
				}
			}

			rows.push(cells);
		}

		sheets.push({ name, rows });
	}

	return sheets;
}

export function parseDocumentReply(raw: string, kind: WorkingKind): ModelDocument {
	let text = raw.trim();
	text = text.replace(/^```(?:json)?\s*/i, '');
	text = text.replace(/\s*```$/, '');

	let parsed: {
		contract?: unknown;
		name?: unknown;
		change_note?: unknown;
		markdown?: unknown;
		sheets?: unknown;
	};

	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('The model did not return valid JSON for the document');
	}

	const result: ModelDocument = {
		contract: parsed.contract === true,
		name: '',
		changeNote: '',
		markdown: '',
		sheets: []
	};

	if (typeof parsed.name === 'string') {
		result.name = parsed.name;
	}

	if (typeof parsed.change_note === 'string') {
		result.changeNote = parsed.change_note.trim();
	}

	if (kind === 'sheets') {
		result.sheets = readSheets(parsed.sheets);
	} else {
		if (typeof parsed.markdown !== 'string' || parsed.markdown.trim().length === 0) {
			throw new Error('The model returned an empty document');
		}

		result.markdown = parsed.markdown;
	}

	return result;
}

async function render(format: Format, parsed: ModelDocument): Promise<Buffer> {
	if (format === 'xlsx') {
		return renderXlsx(parsed.sheets);
	}

	const branding = await readBranding();

	if (format === 'docx') {
		return renderDocx(parsed.markdown, branding);
	}

	return renderPdf(parsed.markdown, branding);
}

export function errorText(caught: unknown): string {
	if (caught instanceof Error) {
		return caught.message;
	}

	return String(caught);
}

/** "Contract v3.docx" + next version 4 + docx → "Contract v4.docx". */
function nextFilename(previousFilename: string, nextNumber: number, format: Format): string {
	return (
		stripVersionSuffix(cleanName(baseNameOf(previousFilename))) +
		' v' +
		String(nextNumber) +
		'.' +
		format
	);
}

/** The version number in a generated filename ("Contract v4.docx" → 4), if any. */
function versionInFilename(filename: string): number | null {
	const match = /v(\d+)$/i.exec(baseNameOf(filename));

	if (match === null) {
		return null;
	}

	return Number(match[1]);
}

type Plan = {
	documentRow: DocumentRow | null;
	kind: WorkingKind;
	/** Text to edit, from a pending draft or the working copy. */
	sourceText: string | null;
	/** The received file, when there is no text to edit. */
	sourceFile: ModelFile | null;
	/** The filename the new one is named after, and the version it will be. */
	previousFilename: string | null;
	nextNumber: number;
};

async function planSource(documentRow: DocumentRow, row: EmailRow): Promise<Plan> {
	const latest = await latestVersion(documentRow.id);

	if (latest === null) {
		throw new Error('The document has no versions');
	}

	const kind = kindForVersion(latest);
	const plan: Plan = {
		documentRow,
		kind,
		sourceText: null,
		sourceFile: null,
		previousFilename: latest.filename,
		nextNumber: latest.version + 1
	};

	/** "Notes v2.docx" stored as our version 1 still becomes "Notes v3", never a second "Notes v2". */
	const numberInName = versionInFilename(latest.filename);

	if (numberInName !== null && numberInName >= plan.nextNumber) {
		plan.nextNumber = numberInName + 1;
	}

	const pending = await pendingSource(documentRow.id, row.id);

	if (pending !== null) {
		plan.sourceText = pending.source;
		const pendingNumber = versionInFilename(pending.filename);

		if (pendingNumber !== null) {
			plan.nextNumber = pendingNumber + 1;
		}

		return plan;
	}

	const working = await readWorkingCopy(documentRow.id, kind, latest.version);

	if (working !== null) {
		plan.sourceText = working;
		return plan;
	}

	if (!latest.readable) {
		throw new Error('"' + latest.filename + '" is a file type the AI cannot read');
	}

	plan.sourceFile = {
		filename: latest.filename,
		mime: latest.contentType,
		content: await readFile(latest.path)
	};

	return plan;
}

/** A resource as the source of an edit: its ingested text, and a new file named after it. The original stays as it is. */
async function planResource(userId: string, resourceId: string): Promise<Plan> {
	const resourceRow = await getOwnedResource(userId, resourceId);

	if (resourceRow === null) {
		throw new Error('The planner asked for a resource that does not exist');
	}

	const text = await indexedText('resource', resourceRow.id);

	if (text === null) {
		throw new Error('"' + resourceRow.filename + '" has not been read yet');
	}

	let kind: WorkingKind = 'markdown';

	if (SHEET_EXTENSIONS.includes(extensionOf(resourceRow.filename))) {
		kind = 'sheets';
	}

	return {
		documentRow: null,
		kind,
		sourceText: text,
		sourceFile: null,
		previousFilename: resourceRow.filename,
		nextNumber: 2
	};
}

function userMessage(
	plan: Plan,
	request: DocumentRequest,
	replyBody: string,
	background: string
): string {
	const parts: string[] = ['Background (the user, the person and the thread):\n' + background];

	if (plan.documentRow === null) {
		parts.push('Write a new document.');
	} else {
		parts.push('Document: ' + plan.documentRow.name);
	}

	parts.push('Change asked for: ' + request.change);
	parts.push('The email reply it goes with:\n' + replyBody);

	if (plan.sourceText !== null) {
		parts.push('The current document:\n' + plan.sourceText);
	} else if (plan.sourceFile !== null) {
		parts.push('The current document is attached.');
	}

	return parts.join('\n\n');
}

async function findDocument(contactId: string, documentId: string): Promise<DocumentRow | null> {
	const rows = await db
		.select()
		.from(document)
		.where(and(eq(document.id, documentId), eq(document.contactId, contactId)))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0];
}

/**
 * One model call that edits (or writes) a document for a draft, rendered and
 * saved next to it. Never throws for a model or render problem: that becomes a
 * generated_file row with `error` set, so the draft shows it.
 */
export async function generateDocument(
	draftRow: DraftForDocuments,
	row: EmailRow,
	request: DocumentRequest,
	background: string,
	resourceFiles: ModelFile[] = [],
	options: { agent?: 'document' | 'financial'; userId?: string } = {}
): Promise<void> {
	let agent: 'document' | 'financial' = 'document';

	if (options.agent !== undefined) {
		agent = options.agent;
	}

	const id = crypto.randomUUID();
	const threadKey = row.threadId ?? row.id;
	let documentRow: DocumentRow | null = null;
	let format: Format = 'pdf';
	let filename = 'New document.pdf';

	try {
		let plan: Plan = {
			documentRow: null,
			kind: 'markdown',
			sourceText: null,
			sourceFile: null,
			previousFilename: null,
			nextNumber: 1
		};

		/** A new spreadsheet has no source to say so: the request does. */
		if (request.spreadsheet && request.documentId === null && request.sourceResourceId === null) {
			plan.kind = 'sheets';
		}

		if (request.sourceResourceId !== null) {
			if (options.userId === undefined) {
				throw new Error('A resource was asked for without an owner');
			}

			plan = await planResource(options.userId, request.sourceResourceId);
			format = outputFormat(plan.previousFilename, false);
			filename = nextFilename(plan.previousFilename ?? 'Document', plan.nextNumber, format);
		} else if (request.documentId !== null) {
			documentRow = await findDocument(draftRow.contactId, request.documentId);

			if (documentRow === null) {
				throw new Error('The model asked for a document that does not exist');
			}

			plan = await planSource(documentRow, row);

			/** Named before the model call, so a failure still shows which file it was. */
			if (plan.previousFilename !== null) {
				format = outputFormat(plan.previousFilename, false);
				filename = nextFilename(plan.previousFilename, plan.nextNumber, format);
			}
		}

		const files: ModelFile[] = [];

		if (plan.sourceFile !== null) {
			files.push(plan.sourceFile);
		}

		for (const file of resourceFiles) {
			files.push(file);
		}

		const raw = await recordAgentRun('document', row.id, () => {
			return callModel(
				agent,
				[
					{ role: 'system', content: systemPrompt(plan.kind) },
					{ role: 'user', content: userMessage(plan, request, draftRow.body, background) }
				],
				files
			);
		});

		const parsed = parseDocumentReply(raw, plan.kind);
		format = outputFormat(plan.previousFilename, parsed.contract);
		let sendAsPdf = false;

		if (plan.kind === 'sheets') {
			format = 'xlsx';
		} else if (request.deliverAs !== null) {
			/** Built as Word either way; "pdf" is converted when the reply is sent. */
			format = 'docx';
			sendAsPdf = request.deliverAs === 'pdf';
		} else if (format === 'docx') {
			/** The planner said nothing about the format: Word revisions still go out as a PDF. */
			sendAsPdf = true;
		}

		if (plan.previousFilename === null) {
			filename = cleanName(nameWithoutExtensions(parsed.name)) + '.' + format;
		} else {
			filename = nextFilename(plan.previousFilename, plan.nextNumber, format);
		}

		const content = await render(format, parsed);
		let source = parsed.markdown;
		let sourceName = 'source.md';

		if (plan.kind === 'sheets') {
			source = JSON.stringify(parsed.sheets, null, 2) + '\n';
			sourceName = 'source.sheets.json';
		}

		let changeNote = parsed.changeNote;

		if (plan.previousFilename !== null) {
			changeNote = (changeNote + '\n\n' + REBUILD_NOTE).trim();
		}

		/** ponytail: flagged in the note only; a "save as template" action can build on this later. */
		if (request.missingTemplate !== null) {
			changeNote = (changeNote + '\n\n' + NO_TEMPLATE_NOTE).trim();
		}

		const filePath = await generatedFilePath(threadKey, id, filename);
		const sourcePath = await generatedFilePath(threadKey, id, sourceName);
		await writeFile(filePath, content);
		await writeFile(sourcePath, source, 'utf8');
		await writeFile(
			await generatedFilePath(threadKey, id, filename + '.changes.md'),
			changeNote + '\n',
			'utf8'
		);

		await db.insert(generatedFile).values({
			id,
			draftId: draftRow.id,
			documentId: documentRow?.id ?? null,
			change: request.change,
			filename,
			format,
			path: filePath,
			sourcePath,
			changeNote,
			placeholders: listPlaceholders(source),
			sendAsPdf
		});
	} catch (caught) {
		console.error('Document generation failed:', caught);
		await db.insert(generatedFile).values({
			id,
			draftId: draftRow.id,
			documentId: documentRow?.id ?? null,
			change: request.change,
			filename,
			format,
			error: errorText(caught)
		});
	}
}
