import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { contact, document, documentVersion, email } from '$lib/server/db/schema';
import { isReadableByAI } from '$lib/server/files/allowlist';
import {
	documentDir,
	documentMetaPath,
	documentVersionPath,
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

/** Writes the file as the next version of the document, records it and refreshes meta.json. */
export async function addDocumentVersion(documentId: string, file: NewVersion): Promise<number> {
	const rows = await db
		.select({ highest: max(documentVersion.version) })
		.from(documentVersion)
		.where(eq(documentVersion.documentId, documentId));
	const version = (rows[0]?.highest ?? 0) + 1;
	const target = await documentVersionPath(documentId, version, file.filename);

	await writeFile(target, file.content);
	await db.insert(documentVersion).values({
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
	});
	await writeDocumentMeta(documentId);

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
			file: 'v' + String(version.version) + version.path.slice(version.path.lastIndexOf('.')),
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
 * received order, moves the files into the kept document's folder and deletes
 * the emptied document. Both must be the same person's documents.
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

	/** Two steps, so renaming v2 to v3 never overwrites a v3 that has not moved yet. */
	const staged: string[] = [];

	for (const version of all) {
		const temporary = version.path + '.merging';
		await rename(version.path, temporary);
		staged.push(temporary);
	}

	for (let index = 0; index < all.length; index++) {
		const number = index + 1;
		const target = await documentVersionPath(keepId, number, all[index].filename);
		await rename(staged[index], target);
		await db
			.update(documentVersion)
			.set({ documentId: keepId, version: number, path: target })
			.where(eq(documentVersion.id, all[index].id));
	}

	await db.delete(document).where(eq(document.id, mergeId));
	await rm(documentDir(mergeId), { recursive: true, force: true });
	await writeDocumentMeta(keepId);
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
