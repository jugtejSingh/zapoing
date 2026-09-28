import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import JSZip from 'jszip';
import { recordAgentRun } from '$lib/server/ai/agentRun';
import { callModel } from '$lib/server/ai/model';
import { db } from '$lib/server/db';
import { job, resource } from '$lib/server/db/schema';
import { documentText } from '$lib/server/files/fill/officeXml';
import { enqueueJob, registerJobHandler } from '$lib/server/jobs/worker';

/**
 * Makes a resource's contents searchable. Text and Office files are read here;
 * PDFs and images go to the model once, in the resource.index job. The text is
 * only for search: it is never shown, and drafts still get the original file.
 */

type ResourceRow = typeof resource.$inferSelect;
type ResourceIndexPayload = { resourceId: string };

/** Enough for a long price list; the rest of a huge file adds little to search. */
const MAX_CONTENT_CHARS = 200_000;

/**
 * A DOCX or XLSX that unzips past this is refused, so a zip bomb can't fill memory.
 * ponytail: trusts the sizes in the zip's own headers; the upload is the user's own file.
 */
const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;

const PLAIN_TEXT = ['txt', 'md', 'csv'];
const OFFICE = ['docx', 'xlsx'];

const TRANSCRIBE_PROMPT = [
	'You turn a file into plain text for a search index.',
	'Write out all the text in the file, in reading order: headings, paragraphs, table rows (cells separated by " | "), prices, names and numbers exactly as written.',
	'If the file is a picture with little or no text, describe what it shows in a few sentences and list the key terms.',
	'Reply with the text only: no introduction, no commentary, no Markdown code fences.'
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
		throw new Error('The file unzips to more than 100 MB, so its contents are not searched');
	}
}

/** The file's text, read without the model. */
async function readLocalText(row: ResourceRow): Promise<string> {
	const content = await readFile(row.path);
	const extension = extensionOf(row.filename);

	if (PLAIN_TEXT.includes(extension)) {
		return content.toString('utf8');
	}

	await checkUnzippedSize(content);

	if (extension === 'docx') {
		return documentText(content, 'docx');
	}

	return documentText(content, 'xlsx');
}

async function transcribe(row: ResourceRow): Promise<string> {
	const content = await readFile(row.path);

	return recordAgentRun('resource.index', null, () => {
		return callModel(
			'ingestion',
			[
				{ role: 'system', content: TRANSCRIBE_PROMPT },
				{ role: 'user', content: 'File: ' + row.filename }
			],
			[{ filename: row.filename, mime: row.contentType, content }]
		);
	});
}

/**
 * Stores the result. updatedAt is kept as it was, so indexing never changes
 * which resource counts as newest in a conflict.
 */
async function saveResult(
	row: ResourceRow,
	result: { content: string; indexStatus: 'ready' | 'failed'; indexError: string | null }
): Promise<void> {
	await db
		.update(resource)
		.set({
			content: result.content.trim().slice(0, MAX_CONTENT_CHARS),
			indexStatus: result.indexStatus,
			indexError: result.indexError,
			updatedAt: row.updatedAt
		})
		.where(eq(resource.id, row.id));
}

function reasonOf(caught: unknown): string {
	if (caught instanceof Error) {
		return caught.message;
	}

	return String(caught);
}

async function loadResource(resourceId: string): Promise<ResourceRow | null> {
	const rows = await db.select().from(resource).where(eq(resource.id, resourceId)).limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0];
}

/**
 * The resource.index job, and the local path too. A failure marks the resource
 * "not searchable" with the reason instead of retrying.
 * ponytail: the user retries by replacing the file; add a Retry button if model hiccups make that common.
 */
export async function indexResourceNow(resourceId: string): Promise<void> {
	const row = await loadResource(resourceId);

	if (row === null) {
		return;
	}

	try {
		let text: string;

		if (readsLocally(row.filename)) {
			text = await readLocalText(row);
		} else {
			text = await transcribe(row);
		}

		await saveResult(row, { content: text, indexStatus: 'ready', indexError: null });
	} catch (caught) {
		await saveResult(row, { content: '', indexStatus: 'failed', indexError: reasonOf(caught) });
	}
}

/**
 * Called after an upload or a replaced file. Local files are searchable at once;
 * PDFs and images wait for the job. Never throws, so an upload never fails here.
 */
export async function indexResource(resourceId: string): Promise<void> {
	const row = await loadResource(resourceId);

	if (row === null) {
		return;
	}

	await db
		.update(resource)
		.set({ content: '', indexStatus: 'pending', indexError: null, updatedAt: row.updatedAt })
		.where(eq(resource.id, row.id));

	if (readsLocally(row.filename)) {
		await indexResourceNow(row.id);
		return;
	}

	await enqueueJob('resource.index', { resourceId: row.id } satisfies ResourceIndexPayload);
}

async function hasQueuedJob(resourceId: string): Promise<boolean> {
	const queued = await db
		.select({ payload: job.payload })
		.from(job)
		.where(and(eq(job.type, 'resource.index'), eq(job.status, 'pending')));

	for (const row of queued) {
		if ((row.payload as ResourceIndexPayload).resourceId === resourceId) {
			return true;
		}
	}

	return false;
}

/** On startup: resources added before contents were searched (or left pending by a crash) get indexed. */
export async function indexPendingResources(): Promise<void> {
	const pending = await db.select().from(resource).where(eq(resource.indexStatus, 'pending'));

	for (const row of pending) {
		if (readsLocally(row.filename)) {
			await indexResourceNow(row.id);
		} else if (!(await hasQueuedJob(row.id))) {
			await enqueueJob('resource.index', { resourceId: row.id } satisfies ResourceIndexPayload);
		}
	}
}

export function registerResourceIndexing(): void {
	registerJobHandler('resource.index', async (payload) => {
		await indexResourceNow((payload as ResourceIndexPayload).resourceId);
	});
}
