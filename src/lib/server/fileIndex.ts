import { readFile } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import JSZip from 'jszip';
import { recordAgentRun } from '$lib/server/ai/agentRun';
import { callModel } from '$lib/server/ai/model';
import { db } from '$lib/server/db';
import {
	contact,
	document,
	documentVersion,
	fileIndex,
	job,
	resource,
	template
} from '$lib/server/db/schema';
import { documentText } from '$lib/server/files/fill/officeXml';
import { enqueueJob, registerJobHandler } from '$lib/server/jobs/worker';
import { templateOriginalPath } from '$lib/server/storage/paths';

/**
 * One ingestion path for every file the AI may use: templates (uploaded by the
 * user), resources (uploaded by the user) and attachments (received by email).
 * A background job reads each file once and stores its text and a short
 * description in `file_index`. Agents pick a file by its description, then read
 * its text from the row; they never search and never see the file itself.
 */

export type IndexKind = 'template' | 'resource' | 'attachment';
export type IndexRow = typeof fileIndex.$inferSelect;

type IngestPayload = { kind: IndexKind; refId: string };

/** What the ingest job needs to know about the file, whichever table it came from. */
type Source = {
	userId: string;
	name: string;
	filename: string;
	contentType: string;
	path: string;
};

/** Enough for a long price list; the rest of a huge file adds little. */
const MAX_TEXT_CHARS = 200_000;

/** The description is written from the start of the text; that is enough to tell what a file is. */
const DESCRIBE_INPUT_CHARS = 20_000;
const MAX_DESCRIPTION_CHARS = 400;

/**
 * A DOCX or XLSX that unzips past this is refused, so a zip bomb can't fill memory.
 * ponytail: trusts the sizes in the zip's own headers; uploads and attachments are the user's own mail.
 */
const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;

const PLAIN_TEXT = ['txt', 'md', 'csv'];
const OFFICE = ['docx', 'xlsx'];

const FORMAT_MIME: Record<string, string> = {
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	pdf: 'application/pdf'
};

const TRANSCRIBE_PROMPT = [
	'You turn a file into plain text.',
	'Write out all the text in the file, in reading order: headings, paragraphs, table rows (cells separated by " | "), prices, names and numbers exactly as written.',
	'If the file is a picture with little or no text, describe what it shows in a few sentences and list the key terms.',
	'Reply with the text only: no introduction, no commentary, no Markdown code fences.'
].join('\n');

const DESCRIBE_PROMPT = [
	'You label a file so another assistant can decide whether it is the right one to use.',
	'Reply with one or two plain sentences: what kind of document it is (for example "mutual NDA", "2026 price list", "signed service agreement"), who or what it is about, and when it would be used.',
	'No introduction, no Markdown, under 400 characters.'
].join('\n');

function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf('.');

	if (dot === -1) {
		return '';
	}

	return filename.slice(dot + 1).toLowerCase();
}

/** True when the app can read the file itself; everything else (PDFs, images) needs the model. */
export function readsLocally(filename: string): boolean {
	const extension = extensionOf(filename);

	return PLAIN_TEXT.includes(extension) || OFFICE.includes(extension);
}

async function checkUnzippedSize(content: Buffer): Promise<void> {
	const zip = await JSZip.loadAsync(content);
	let total = 0;

	for (const entry of Object.values(zip.files)) {
		const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
		total = total + (data?.uncompressedSize ?? 0);
	}

	if (total > MAX_UNZIPPED_BYTES) {
		throw new Error('The file unzips to more than 100 MB, so it is not read');
	}
}

async function readLocalText(source: Source): Promise<string> {
	const content = await readFile(source.path);
	const extension = extensionOf(source.filename);

	if (PLAIN_TEXT.includes(extension)) {
		return content.toString('utf8');
	}

	await checkUnzippedSize(content);

	if (extension === 'docx') {
		return documentText(content, 'docx');
	}

	return documentText(content, 'xlsx');
}

async function transcribe(source: Source): Promise<string> {
	const content = await readFile(source.path);

	return recordAgentRun('file.transcribe', null, () => {
		return callModel(
			'ingestion',
			[
				{ role: 'system', content: TRANSCRIBE_PROMPT },
				{ role: 'user', content: 'File: ' + source.filename }
			],
			[{ filename: source.filename, mime: source.contentType, content }]
		);
	});
}

async function describe(source: Source, text: string): Promise<string> {
	const raw = await recordAgentRun('file.describe', null, () => {
		return callModel('ingestion', [
			{ role: 'system', content: DESCRIBE_PROMPT },
			{
				role: 'user',
				content:
					'File name: ' +
					source.name +
					' (' +
					source.filename +
					')\n\nStart of the file:\n' +
					text.slice(0, DESCRIBE_INPUT_CHARS)
			}
		]);
	});

	return raw.trim().slice(0, MAX_DESCRIPTION_CHARS);
}

async function templateSource(refId: string): Promise<Source | null> {
	const rows = await db.select().from(template).where(eq(template.id, refId)).limit(1);

	if (rows.length === 0) {
		return null;
	}

	const row = rows[0];

	return {
		userId: row.userId,
		name: row.name,
		filename: row.filename,
		contentType: FORMAT_MIME[row.format],
		path: await templateOriginalPath(row.id, row.format)
	};
}

async function resourceSource(refId: string): Promise<Source | null> {
	const rows = await db.select().from(resource).where(eq(resource.id, refId)).limit(1);

	if (rows.length === 0) {
		return null;
	}

	const row = rows[0];

	return {
		userId: row.userId,
		name: row.name,
		filename: row.filename,
		contentType: row.contentType,
		path: row.path
	};
}

/** Attachments the AI may not read (decision F) are not indexed at all. */
async function attachmentSource(refId: string): Promise<Source | null> {
	const rows = await db
		.select({ version: documentVersion, name: document.name, userId: contact.userId })
		.from(documentVersion)
		.innerJoin(document, eq(documentVersion.documentId, document.id))
		.innerJoin(contact, eq(document.contactId, contact.id))
		.where(eq(documentVersion.id, refId))
		.limit(1);

	if (rows.length === 0 || !rows[0].version.readable) {
		return null;
	}

	return {
		userId: rows[0].userId,
		name: rows[0].name,
		filename: rows[0].version.filename,
		contentType: rows[0].version.contentType,
		path: rows[0].version.path
	};
}

async function sourceOf(kind: IndexKind, refId: string): Promise<Source | null> {
	if (kind === 'template') {
		return templateSource(refId);
	}

	if (kind === 'resource') {
		return resourceSource(refId);
	}

	return attachmentSource(refId);
}

function reasonOf(caught: unknown): string {
	if (caught instanceof Error) {
		return caught.message;
	}

	return String(caught);
}

async function saveRow(
	source: Source,
	kind: IndexKind,
	refId: string,
	result: { description: string; text: string; status: IndexRow['status']; error: string | null }
): Promise<void> {
	await db
		.insert(fileIndex)
		.values({ userId: source.userId, kind, refId, ...result })
		.onConflictDoUpdate({
			target: [fileIndex.kind, fileIndex.refId],
			set: { ...result, updatedAt: new Date() }
		});
}

/**
 * Reads the file and stores its text and description. A failure is stored as
 * "failed" with the reason instead of retried: the user retries by replacing the file.
 * Returns true when the file is ready to use.
 */
export async function ingestFile(kind: IndexKind, refId: string): Promise<boolean> {
	const source = await sourceOf(kind, refId);

	if (source === null) {
		return false;
	}

	try {
		let text: string;

		if (readsLocally(source.filename)) {
			text = await readLocalText(source);
		} else {
			text = await transcribe(source);
		}

		text = text.trim().slice(0, MAX_TEXT_CHARS);
		const description = await describe(source, text);
		await saveRow(source, kind, refId, { description, text, status: 'ready', error: null });

		return true;
	} catch (caught) {
		await saveRow(source, kind, refId, {
			description: '',
			text: '',
			status: 'failed',
			error: reasonOf(caught)
		});

		return false;
	}
}

/**
 * Marks the file "pending" and queues the ingest job. Never throws for a file
 * that is missing or not readable by the AI; it just has no index row.
 */
export async function queueIngest(kind: IndexKind, refId: string): Promise<void> {
	const source = await sourceOf(kind, refId);

	if (source === null) {
		return;
	}

	await saveRow(source, kind, refId, { description: '', text: '', status: 'pending', error: null });
	await enqueueJob('file.ingest', { kind, refId } satisfies IngestPayload);
}

/** Removes the row when its file is deleted. */
export async function forgetIndex(kind: IndexKind, refId: string): Promise<void> {
	await db.delete(fileIndex).where(and(eq(fileIndex.kind, kind), eq(fileIndex.refId, refId)));
}

/** The index rows for these files, by file id. Files with no row are simply absent. */
export async function indexRows(kind: IndexKind, refIds: string[]): Promise<Map<string, IndexRow>> {
	const found = new Map<string, IndexRow>();

	if (refIds.length === 0) {
		return found;
	}

	const rows = await db
		.select()
		.from(fileIndex)
		.where(and(eq(fileIndex.kind, kind), inArray(fileIndex.refId, refIds)));

	for (const row of rows) {
		found.set(row.refId, row);
	}

	return found;
}

/** The stored text of a ready file, or null when it is not indexed yet or could not be read. */
export async function indexedText(kind: IndexKind, refId: string): Promise<string | null> {
	const rows = await indexRows(kind, [refId]);
	const row = rows.get(refId);

	if (row === undefined || row.status !== 'ready') {
		return null;
	}

	return row.text;
}

async function hasQueuedJob(kind: IndexKind, refId: string): Promise<boolean> {
	const queued = await db
		.select({ payload: job.payload })
		.from(job)
		.where(and(eq(job.type, 'file.ingest'), eq(job.status, 'pending')));

	for (const row of queued) {
		const payload = row.payload as IngestPayload;

		if (payload.kind === kind && payload.refId === refId) {
			return true;
		}
	}

	return false;
}

async function queueIfMissing(
	kind: IndexKind,
	refIds: string[],
	known: Map<string, IndexRow>
): Promise<void> {
	for (const refId of refIds) {
		const row = known.get(refId);

		if (row === undefined) {
			await queueIngest(kind, refId);
		} else if (row.status === 'pending' && !(await hasQueuedJob(kind, refId))) {
			await enqueueJob('file.ingest', { kind, refId } satisfies IngestPayload);
		}
	}
}

/**
 * On startup: files with no index row (added before ingestion existed) or left
 * pending by a crash get queued. Failed files are not retried.
 */
export async function ingestMissingFiles(): Promise<void> {
	const templates = await db.select({ id: template.id }).from(template);
	const resources = await db.select({ id: resource.id }).from(resource);
	const versions = await db
		.select({ id: documentVersion.id })
		.from(documentVersion)
		.where(eq(documentVersion.readable, true));

	const groups: { kind: IndexKind; ids: string[] }[] = [
		{ kind: 'template', ids: idsOf(templates) },
		{ kind: 'resource', ids: idsOf(resources) },
		{ kind: 'attachment', ids: idsOf(versions) }
	];

	for (const group of groups) {
		const known = await indexRows(group.kind, group.ids);
		await queueIfMissing(group.kind, group.ids, known);
	}
}

function idsOf(rows: { id: string }[]): string[] {
	const ids: string[] = [];

	for (const row of rows) {
		ids.push(row.id);
	}

	return ids;
}

/**
 * The file.ingest job. A template goes on to the field-finding job once its text
 * is read; if it can't be read, the template is marked failed with the reason.
 */
export function registerFileIngest(): void {
	registerJobHandler('file.ingest', async (payload) => {
		const { kind, refId } = payload as IngestPayload;
		const ready = await ingestFile(kind, refId);

		if (kind !== 'template') {
			return;
		}

		/** A template that is already ready was only missing its index row; its fields stay as they are. */
		const templates = await db.select().from(template).where(eq(template.id, refId)).limit(1);

		if (templates.length === 0 || templates[0].status !== 'processing') {
			return;
		}

		if (ready) {
			await enqueueJob('template.prepare', { templateId: refId });
			return;
		}

		const rows = await indexRows('template', [refId]);
		const failure = rows.get(refId)?.error ?? 'The file could not be read';
		await db
			.update(template)
			.set({ status: 'failed', error: failure })
			.where(eq(template.id, refId));
	});
}
