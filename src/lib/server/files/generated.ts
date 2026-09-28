import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { document, draft, email, generatedFile, mailAccount } from '$lib/server/db/schema';
import {
	addDocumentVersion,
	isStoredForContact,
	sha256Of,
	writeWorkingCopy,
	type WorkingKind
} from '$lib/server/files/documents';
import { fillFields, markersIn } from '$lib/server/files/fill/officeXml';
import { renderDocx } from '$lib/server/files/render/docx';
import { renderPdf } from '$lib/server/files/render/pdf';
import { renderXlsx, type Sheet } from '$lib/server/files/render/xlsx';
import type { ReplyAttachment } from '$lib/server/smtp';
import { fillPlaceholder, listPlaceholders } from '$lib/placeholders';
import type { DraftFile } from '$lib/types';

type GeneratedRow = typeof generatedFile.$inferSelect;

const MIME_BY_FORMAT: Record<GeneratedRow['format'], string> = {
	pdf: 'application/pdf',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

async function rowsFor(draftId: string): Promise<GeneratedRow[]> {
	return db
		.select()
		.from(generatedFile)
		.where(eq(generatedFile.draftId, draftId))
		.orderBy(asc(generatedFile.createdAt));
}

/** Only files that rendered; a failed one has no path. */
function sendable(rows: GeneratedRow[]): GeneratedRow[] {
	const result: GeneratedRow[] = [];

	for (const row of rows) {
		if (row.error === null && row.path !== null) {
			result.push(row);
		}
	}

	return result;
}

export async function listDraftFiles(draftId: string): Promise<DraftFile[]> {
	const result: DraftFile[] = [];

	for (const row of await rowsFor(draftId)) {
		result.push({
			id: row.id,
			filename: row.filename,
			change: row.change,
			changeNote: row.changeNote,
			error: row.error,
			isNewDocument: row.documentId === null,
			placeholders: row.placeholders
		});
	}

	return result;
}

/** The generated file, only if its draft's email belongs to one of the user's accounts. */
export async function getOwnedGenerated(userId: string, id: string): Promise<GeneratedRow | null> {
	const rows = await db
		.select({ generatedFile })
		.from(generatedFile)
		.innerJoin(draft, eq(generatedFile.draftId, draft.id))
		.innerJoin(email, eq(draft.emailId, email.id))
		.innerJoin(mailAccount, eq(email.accountId, mailAccount.id))
		.where(and(eq(generatedFile.id, id), eq(mailAccount.userId, userId)))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0].generatedFile;
}

/** Deletes the row and its folder: the file, its change note and its source. */
export async function removeGenerated(userId: string, id: string): Promise<boolean> {
	const row = await getOwnedGenerated(userId, id);

	if (row === null) {
		return false;
	}

	await deleteGeneratedRow(row);

	return true;
}

/** The folder holding a generated file, its notes and its source; null when nothing was written. */
function folderOf(row: GeneratedRow): string | null {
	if (row.path !== null) {
		return path.dirname(row.path);
	}

	if (row.sourcePath !== null) {
		return path.dirname(row.sourcePath);
	}

	return null;
}

async function deleteGeneratedRow(row: GeneratedRow): Promise<void> {
	await db.delete(generatedFile).where(eq(generatedFile.id, row.id));
	const folder = folderOf(row);

	if (folder !== null) {
		await rm(folder, { recursive: true, force: true });
	}
}

/**
 * The folders of files made for drafts on these emails. Read before the emails
 * are deleted: the delete cascades to the drafts and their rows, but not to disk.
 */
export async function generatedFoldersForEmails(emailIds: string[]): Promise<string[]> {
	if (emailIds.length === 0) {
		return [];
	}

	const rows = await db
		.select({ file: generatedFile })
		.from(generatedFile)
		.innerJoin(draft, eq(generatedFile.draftId, draft.id))
		.where(inArray(draft.emailId, emailIds));
	const folders: string[] = [];

	for (const row of rows) {
		const folder = folderOf(row.file);

		if (folder !== null) {
			folders.push(folder);
		}
	}

	return folders;
}

export async function removeFolders(folders: string[]): Promise<void> {
	for (const folder of folders) {
		await rm(folder, { recursive: true, force: true });
	}
}

/** Files of the same document, or filled from the same template, are versions of one file. New documents stand alone. */
function versionKey(row: GeneratedRow): string | null {
	if (row.documentId !== null) {
		return 'document:' + row.documentId;
	}

	if (row.templateId !== null) {
		return 'template:' + row.templateId;
	}

	return null;
}

/** The newest file that rendered, else the newest of them all. Rows are oldest first. */
function newestVersion(rows: GeneratedRow[]): GeneratedRow {
	let kept = rows[rows.length - 1];

	for (const row of rows) {
		if (row.error === null && row.path !== null) {
			kept = row;
		}
	}

	return kept;
}

/**
 * After a merge: of several versions of the same document, only the newest
 * stays. A later draft builds on the earlier draft's file, so the newest
 * already has every change; the change notes are combined, oldest first.
 * The older files are deleted with their folders.
 */
export async function keepLatestVersions(draftId: string): Promise<void> {
	const groups = new Map<string, GeneratedRow[]>();

	for (const row of await rowsFor(draftId)) {
		const key = versionKey(row);

		if (key === null) {
			continue;
		}

		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}

	for (const group of groups.values()) {
		if (group.length < 2) {
			continue;
		}

		const kept = newestVersion(group);
		const notes: string[] = [];

		for (const row of group) {
			if (row.id === kept.id) {
				continue;
			}

			if (row.error === null && row.changeNote.trim().length > 0) {
				notes.push('From ' + row.filename + ':\n' + row.changeNote.trim());
			}

			await deleteGeneratedRow(row);
		}

		if (notes.length === 0) {
			continue;
		}

		notes.push(kept.changeNote.trim());
		const changeNote = notes.join('\n\n').trim();
		await db.update(generatedFile).set({ changeNote }).where(eq(generatedFile.id, kept.id));

		if (kept.path !== null) {
			await writeFile(kept.path + '.changes.md', changeNote, 'utf8');
		}
	}
}

/** The draft's rendered files, ready to attach to the reply. */
export async function draftAttachments(draftId: string): Promise<ReplyAttachment[]> {
	const attachments: ReplyAttachment[] = [];

	for (const row of sendable(await rowsFor(draftId))) {
		if (row.path === null) {
			continue;
		}

		attachments.push({
			filename: row.filename,
			contentType: MIME_BY_FORMAT[row.format],
			content: await readFile(row.path)
		});
	}

	return attachments;
}

/** Files on the draft that still have [[fields]], by filename. The reply is not sent while any remain. */
export async function unfilledDraftFiles(draftId: string): Promise<string[]> {
	const names: string[] = [];

	for (const row of sendable(await rowsFor(draftId))) {
		if (row.placeholders.length > 0) {
			names.push(row.filename);
		}
	}

	return names;
}

/** Fills the values into a Markdown or JSON-sheets source. JSON values are escaped so the sheets still parse. */
function fillSource(source: string, kind: WorkingKind, values: Map<string, string>): string {
	let result = source;

	for (const [name, value] of values) {
		let text = value;

		if (kind === 'sheets') {
			text = JSON.stringify(value).slice(1, -1);
		}

		result = fillPlaceholder(result, name, text);
	}

	return result;
}

async function renderSource(
	format: GeneratedRow['format'],
	kind: WorkingKind,
	source: string
): Promise<Buffer> {
	if (kind === 'sheets') {
		return renderXlsx(JSON.parse(source) as Sheet[]);
	}

	if (format === 'docx') {
		return renderDocx(source);
	}

	return renderPdf(source);
}

/**
 * The user's values for a file's [[fields]]. A file made from Markdown or
 * sheets is re-rendered from its filled source; a filled Word or Excel template
 * has the values put straight into its XML, keeping the layout. Blank values
 * are ignored, so those fields stay.
 */
export async function fillGenerated(
	userId: string,
	id: string,
	values: Map<string, string>
): Promise<boolean> {
	const row = await getOwnedGenerated(userId, id);

	if (row === null || row.path === null || row.error !== null) {
		return false;
	}

	const filled = new Map<string, string>();

	for (const [name, value] of values) {
		if (value.trim().length > 0 && row.placeholders.includes(name)) {
			filled.set(name, value.trim());
		}
	}

	let placeholders: string[];

	if (row.sourcePath !== null) {
		const kind = sourceKind(row.sourcePath);
		const source = fillSource(await readFile(row.sourcePath, 'utf8'), kind, filled);
		await writeFile(row.path, await renderSource(row.format, kind, source));
		await writeFile(row.sourcePath, source, 'utf8');
		placeholders = listPlaceholders(source);
	} else if (row.format === 'docx' || row.format === 'xlsx') {
		const content = await fillFields(await readFile(row.path), row.format, filled);
		await writeFile(row.path, content);
		placeholders = await markersIn(content, row.format);
	} else {
		return false;
	}

	await db.update(generatedFile).set({ placeholders }).where(eq(generatedFile.id, row.id));

	return true;
}

function sourceKind(sourcePath: string): WorkingKind {
	if (sourcePath.endsWith('.sheets.json')) {
		return 'sheets';
	}

	return 'markdown';
}

/**
 * After the reply went out: every file it carried becomes the next version of
 * its document (or a new document), and its source becomes the working copy
 * the next edit starts from.
 */
export async function recordSentFiles(draftId: string): Promise<void> {
	const owners = await db
		.select({ contactId: draft.contactId, sender: mailAccount.username })
		.from(draft)
		.innerJoin(email, eq(draft.emailId, email.id))
		.innerJoin(mailAccount, eq(email.accountId, mailAccount.id))
		.where(eq(draft.id, draftId))
		.limit(1);

	if (owners.length === 0) {
		return;
	}

	const owner = owners[0];

	for (const row of sendable(await rowsFor(draftId))) {
		if (row.path === null) {
			continue;
		}

		const content = await readFile(row.path);

		if (await isStoredForContact(owner.contactId, sha256Of(content))) {
			continue;
		}

		let documentId = row.documentId;

		if (documentId === null) {
			const inserted = await db
				.insert(document)
				.values({ contactId: owner.contactId, name: row.filename })
				.returning();
			documentId = inserted[0].id;
		}

		const version = await addDocumentVersion(documentId, {
			emailId: null,
			sender: owner.sender,
			receivedAt: new Date(),
			filename: row.filename,
			contentType: MIME_BY_FORMAT[row.format],
			content
		});

		if (row.sourcePath !== null) {
			const source = await readFile(row.sourcePath, 'utf8');
			await writeWorkingCopy(documentId, sourceKind(row.sourcePath), source, version);
		}
	}
}
