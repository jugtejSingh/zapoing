import { createHash } from 'node:crypto';
import { copyFile, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { contact, document, documentVersion, email } from '$lib/server/db/schema';
import { queueIngest } from '$lib/server/fileIndex';
import { isReadableByAI } from '$lib/server/files/allowlist';
import {
	attachmentFilePath,
	dataDir,
	documentDir,
	documentMetaPath,
	documentWorkingInfoPath,
	documentWorkingPath
} from '$lib/server/storage/paths';
import type { PersonDocument } from '$lib/types';

type VersionRow = typeof documentVersion.$inferSelect;

async function versionsOf(documentId: string): Promise<VersionRow[]> {
	return db
		.select()
		.from(documentVersion)
		.where(eq(documentVersion.documentId, documentId))
		.orderBy(asc(documentVersion.version));
}

export function sha256Of(content: Uint8Array): string {
	return createHash('sha256').update(content).digest('hex');
}

/** "Contract.md.docx" → "Contract": every file-type ending is dropped, so the same file in another format has the same name. */
export function nameWithoutExtensions(filename: string): string {
	return filename.replace(/(\.(md|docx|pdf|xlsx))+$/i, '').trim();
}

/** The person's document with this name, ignoring file type and case; the pdf and the docx of one contract are one document. */
export async function findContactDocumentByName(
	contactId: string,
	filename: string
): Promise<string | null> {
	const wanted = nameWithoutExtensions(filename).toLowerCase();
	const rows = await db
		.select({ id: document.id, name: document.name })
		.from(document)
		.where(eq(document.contactId, contactId))
		.orderBy(asc(document.createdAt));

	for (const row of rows) {
		if (nameWithoutExtensions(row.name).toLowerCase() === wanted) {
			return row.id;
		}
	}

	return null;
}

/** True when this exact file is already one of the person's document versions. */
export async function isStoredForContact(contactId: string, hash: string): Promise<boolean> {
	const rows = await db
		.select({ id: documentVersion.id })
		.from(documentVersion)
		.innerJoin(document, eq(documentVersion.documentId, document.id))
		.where(and(eq(document.contactId, contactId), eq(documentVersion.sha256, hash)))
		.limit(1);

	return rows.length > 0;
}

export async function latestVersion(documentId: string): Promise<VersionRow | null> {
	const rows = await db
		.select()
		.from(documentVersion)
		.where(eq(documentVersion.documentId, documentId))
		.orderBy(desc(documentVersion.version))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0];
}

export type NewVersion = {
	emailId: string | null;
	sender: string;
	receivedAt: Date | null;
	filename: string;
	contentType: string;
	content: Buffer;
};

/** The person's primary address, the top folder of their received files. */
async function personEmailOf(documentId: string): Promise<string> {
	const rows = await db
		.select({ emails: contact.emails })
		.from(document)
		.innerJoin(contact, eq(document.contactId, contact.id))
		.where(eq(document.id, documentId))
		.limit(1);

	if (rows.length === 0 || rows[0].emails.length === 0) {
		return 'unknown';
	}

	return rows[0].emails[0];
}

/**
 * Writes the file as the next version of the document, under the person's email
 * and the day it was received, records it, queues its ingestion and refreshes meta.json.
 */
export async function addDocumentVersion(documentId: string, file: NewVersion): Promise<number> {
	const rows = await db
		.select({ highest: max(documentVersion.version) })
		.from(documentVersion)
		.where(eq(documentVersion.documentId, documentId));
	const version = (rows[0]?.highest ?? 0) + 1;
	const target = await attachmentFilePath(
		await personEmailOf(documentId),
		file.receivedAt ?? new Date(),
		file.filename
	);

	await writeFile(target, file.content);
	const inserted = await db
		.insert(documentVersion)
		.values({
			documentId,
			version,
			emailId: file.emailId,
			sender: file.sender,
			receivedAt: file.receivedAt,
			sha256: sha256Of(file.content),
			filename: file.filename,
			contentType: file.contentType,
			size: file.content.length,
			path: target,
			readable: isReadableByAI(file.filename, file.contentType)
		})
		.returning({ id: documentVersion.id });
	await writeDocumentMeta(documentId);
	await queueIngest('attachment', inserted[0].id);

	return version;
}

/** Rewrites `meta.json` from the database: every version, who sent it, and which version it replaced. */
export async function writeDocumentMeta(documentId: string): Promise<void> {
	const rows = await db.select().from(document).where(eq(document.id, documentId)).limit(1);

	if (rows.length === 0) {
		return;
	}

	const versions = await versionsOf(documentId);
	const emailIds: string[] = [];

	for (const version of versions) {
		if (version.emailId !== null) {
			emailIds.push(version.emailId);
		}
	}

	const messageIds = new Map<string, string | null>();

	if (emailIds.length > 0) {
		const emails = await db
			.select({ id: email.id, messageId: email.messageId })
			.from(email)
			.where(inArray(email.id, emailIds));

		for (const row of emails) {
			messageIds.set(row.id, row.messageId);
		}
	}

	const entries = [];

	for (const version of versions) {
		let replaces: number | null = null;

		if (version.version > 1) {
			replaces = version.version - 1;
		}

		let messageId: string | null = null;

		if (version.emailId !== null) {
			messageId = messageIds.get(version.emailId) ?? null;
		}

		entries.push({
			version: version.version,
			file: path.relative(dataDir(), version.path),
			filename: version.filename,
			sender: version.sender,
			messageId,
			receivedAt: version.receivedAt,
			sha256: version.sha256,
			readable: version.readable,
			replaces
		});
	}

	const meta = { id: documentId, name: rows[0].name, versions: entries };
	await writeFile(await documentMetaPath(documentId), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/** The person's documents with every version, newest version first. Empty for another user's contact. */
export async function listContactDocuments(
	userId: string,
	contactId: string
): Promise<PersonDocument[]> {
	const documents = await db
		.select({ document })
		.from(document)
		.innerJoin(contact, eq(document.contactId, contact.id))
		.where(and(eq(document.contactId, contactId), eq(contact.userId, userId)))
		.orderBy(asc(document.createdAt));

	const result: PersonDocument[] = [];

	for (const row of documents) {
		const versions = await versionsOf(row.document.id);
		const list: PersonDocument['versions'] = [];

		for (let index = versions.length - 1; index >= 0; index--) {
			const version = versions[index];
			list.push({
				id: version.id,
				version: version.version,
				filename: version.filename,
				sender: version.sender,
				receivedAt: version.receivedAt,
				size: version.size,
				readable: version.readable,
				emailId: version.emailId
			});
		}

		result.push({ id: row.document.id, name: row.document.name, versions: list });
	}

	return result;
}

/** The version, only if its document belongs to one of the user's contacts. */
export async function getOwnedVersion(
	userId: string,
	versionId: string
): Promise<VersionRow | null> {
	const rows = await db
		.select({ documentVersion })
		.from(documentVersion)
		.innerJoin(document, eq(documentVersion.documentId, document.id))
		.innerJoin(contact, eq(document.contactId, contact.id))
		.where(and(eq(documentVersion.id, versionId), eq(contact.userId, userId)))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0].documentVersion;
}

async function ownedDocument(userId: string, documentId: string) {
	const rows = await db
		.select({ document })
		.from(document)
		.innerJoin(contact, eq(document.contactId, contact.id))
		.where(and(eq(document.id, documentId), eq(contact.userId, userId)))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0].document;
}

/** Received order: by the date of the email, then by when it was stored. */
function compareReceived(a: VersionRow, b: VersionRow): number {
	const aTime = a.receivedAt?.getTime() ?? a.createdAt.getTime();
	const bTime = b.receivedAt?.getTime() ?? b.createdAt.getTime();

	if (aTime !== bTime) {
		return aTime - bTime;
	}

	return a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * Moves every version of `mergeId` into `keepId`, renumbers all of them in
 * received order and deletes the emptied document. Both must be the same person's documents.
 */
export async function mergeDocuments(
	userId: string,
	keepId: string,
	mergeId: string
): Promise<void> {
	if (keepId === mergeId) {
		throw new Error('Pick a different document to merge');
	}

	const keep = await ownedDocument(userId, keepId);
	const merge = await ownedDocument(userId, mergeId);

	if (keep === null || merge === null) {
		throw new Error('Document not found');
	}

	if (keep.contactId !== merge.contactId) {
		throw new Error('Only documents of the same person can be merged');
	}

	const all: VersionRow[] = [];

	for (const version of await versionsOf(keepId)) {
		all.push(version);
	}

	for (const version of await versionsOf(mergeId)) {
		all.push(version);
	}

	all.sort(compareReceived);

	/** The files stay where they are; only the numbering and the owning document change. */
	for (let index = 0; index < all.length; index++) {
		await db
			.update(documentVersion)
			.set({ documentId: keepId, version: index + 1 })
			.where(eq(documentVersion.id, all[index].id));
	}

	await db.delete(document).where(eq(document.id, mergeId));
	await removeDocumentFolder(mergeId);
	await writeDocumentMeta(keepId);
}

/** Removes the merged document's meta and working copy, and its folder once nothing else is in it. */
async function removeDocumentFolder(documentId: string): Promise<void> {
	await rm(await documentMetaPath(documentId), { force: true });
	await rm(await documentWorkingInfoPath(documentId), { force: true });
	await rm(await documentWorkingPath(documentId, 'markdown'), { force: true });
	await rm(await documentWorkingPath(documentId, 'sheets'), { force: true });

	try {
		await rmdir(documentDir(documentId));
	} catch {
		/** Not empty: files from before the received-files layout still live here. */
	}
}

/**
 * Copies files stored in the old per-document folders into the person/date layout and
 * repoints their rows. The originals are left in place. Safe to run again.
 */
export async function relocateAttachments(): Promise<number> {
	const rows = await db
		.select({ version: documentVersion, emails: contact.emails })
		.from(documentVersion)
		.innerJoin(document, eq(documentVersion.documentId, document.id))
		.innerJoin(contact, eq(document.contactId, contact.id));
	let moved = 0;

	for (const row of rows) {
		const version = row.version;

		if (!version.path.startsWith(documentDir(version.documentId) + path.sep)) {
			continue;
		}

		let personEmail = 'unknown';

		if (row.emails.length > 0) {
			personEmail = row.emails[0];
		}

		const target = await attachmentFilePath(
			personEmail,
			version.receivedAt ?? version.createdAt,
			version.filename
		);

		try {
			await copyFile(version.path, target);
		} catch {
			/** A file missing from disk stays as it is. */
			continue;
		}

		await db
			.update(documentVersion)
			.set({ path: target })
			.where(eq(documentVersion.id, version.id));
		await writeDocumentMeta(version.documentId);
		moved = moved + 1;
	}

	return moved;
}

export type WorkingKind = 'markdown' | 'sheets';

/**
 * The editable copy of the document: the Markdown or JSON sheets of the last
 * version the user sent. Null when there is none or a newer version was received
 * since, because then the received file is the one to edit.
 */
export async function readWorkingCopy(
	documentId: string,
	kind: WorkingKind,
	latestVersionNumber: number
): Promise<string | null> {
	try {
		const info = JSON.parse(await readFile(await documentWorkingInfoPath(documentId), 'utf8')) as {
			fromVersion?: unknown;
		};

		if (info.fromVersion !== latestVersionNumber) {
			return null;
		}

		return await readFile(await documentWorkingPath(documentId, kind), 'utf8');
	} catch {
		return null;
	}
}

export async function writeWorkingCopy(
	documentId: string,
	kind: WorkingKind,
	source: string,
	fromVersion: number
): Promise<void> {
	await writeFile(await documentWorkingPath(documentId, kind), source, 'utf8');
	await writeFile(
		await documentWorkingInfoPath(documentId),
		JSON.stringify({ fromVersion }, null, 2) + '\n',
		'utf8'
	);
}
