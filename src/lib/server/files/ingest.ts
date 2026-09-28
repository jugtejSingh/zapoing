import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { contact, document, documentVersion, email } from '$lib/server/db/schema';
import {
	AttachmentGoneError,
	fetchEmailAttachments,
	type AttachmentFile
} from '$lib/server/attachments';
import { addDocumentVersion, isStoredForContact, sha256Of } from '$lib/server/files/documents';
import { enqueueJob, registerJobHandler } from '$lib/server/jobs/worker';
import { listContactEmails } from '$lib/server/threads';

type EmailRow = typeof email.$inferSelect;
type ContactRow = typeof contact.$inferSelect;

export type AttachmentIngestPayload = {
	contactId: string;
	emailId: string;
};

export type AttachmentBackfillPayload = {
	userId: string;
	contactId: string;
};

function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf('.');

	if (dot === -1) {
		return '';
	}

	return filename.slice(dot + 1).toLowerCase();
}

/**
 * The filename with version noise removed, so "Agreement_v3 (1).pdf" and
 * "agreement-v4-final.pdf" both become "agreement". Falls back to the plain
 * name when nothing is left, so "v2.pdf" does not match every other file.
 */
export function normalizeFilename(filename: string): string {
	let base = filename.toLowerCase();
	const dot = base.lastIndexOf('.');

	if (dot > 0) {
		base = base.slice(0, dot);
	}

	const plain = base.trim();
	let name = base.replace(/[_\-.]+/g, ' ');
	name = name.replace(/\(\d+\)/g, ' ');
	name = name.replace(/\b\d{4} ?\d{2} ?\d{2}\b/g, ' ');
	name = name.replace(/\b\d{1,2} \d{1,2} \d{2,4}\b/g, ' ');
	name = name.replace(/\b(v|ver|version|rev|revision) ?\d+\b/g, ' ');
	name = name.replace(
		/\b(final|draft|signed|updated|revised|copy|new|latest|clean|redline)\b/g,
		' '
	);
	name = name.replace(/\s+/g, ' ').trim();

	if (name.length === 0) {
		return plain;
	}

	return name;
}

/**
 * The person's document this file is a new version of: one with a version from
 * the same thread with the same extension and the same normalized name. Null
 * means a new document. ponytail: names only; reading the email text or comparing
 * contents comes with parsing. The user merges documents by hand when this misses.
 */
async function matchingDocument(
	contactId: string,
	row: EmailRow,
	filename: string
): Promise<string | null> {
	if (row.threadId === null) {
		return null;
	}

	const candidates = await db
		.select({ documentId: documentVersion.documentId, filename: documentVersion.filename })
		.from(documentVersion)
		.innerJoin(document, eq(documentVersion.documentId, document.id))
		.innerJoin(email, eq(documentVersion.emailId, email.id))
		.where(
			and(
				eq(document.contactId, contactId),
				eq(email.accountId, row.accountId),
				eq(email.threadId, row.threadId)
			)
		);

	const wanted = normalizeFilename(filename);
	const extension = extensionOf(filename);

	for (const candidate of candidates) {
		if (
			extensionOf(candidate.filename) === extension &&
			normalizeFilename(candidate.filename) === wanted
		) {
			return candidate.documentId;
		}
	}

	return null;
}

async function storeFile(
	contactRow: ContactRow,
	row: EmailRow,
	file: AttachmentFile
): Promise<void> {
	if (await isStoredForContact(contactRow.id, sha256Of(file.content))) {
		return;
	}

	let documentId = await matchingDocument(contactRow.id, row, file.filename);

	if (documentId === null) {
		const inserted = await db
			.insert(document)
			.values({ contactId: contactRow.id, name: file.filename })
			.returning();
		documentId = inserted[0].id;
	}

	await addDocumentVersion(documentId, {
		emailId: row.id,
		sender: row.from,
		receivedAt: row.date,
		filename: file.filename,
		contentType: file.contentType,
		content: file.content
	});
}

/** The attachments.ingest job: stores and versions the files of one email with a tracked person. */
export async function ingestEmailAttachments(payload: AttachmentIngestPayload): Promise<void> {
	const contacts = await db
		.select()
		.from(contact)
		.where(eq(contact.id, payload.contactId))
		.limit(1);
	const emails = await db.select().from(email).where(eq(email.id, payload.emailId)).limit(1);

	if (contacts.length === 0 || emails.length === 0 || !contacts[0].tracked) {
		return;
	}

	const contactRow = contacts[0];
	const row = emails[0];

	if (row.attachments.length === 0) {
		return;
	}

	let files: AttachmentFile[] | null;

	try {
		files = await fetchEmailAttachments(contactRow.userId, row.id);
	} catch (caught) {
		/** Deleted on the server: nothing to store, and retrying will not bring it back. */
		if (caught instanceof AttachmentGoneError) {
			return;
		}

		throw caught;
	}

	if (files === null) {
		return;
	}

	for (const file of files) {
		await storeFile(contactRow, row, file);
	}
}

/** Queues ingestion for every past email with the person that has attachments. */
export async function backfillContactAttachments(
	payload: AttachmentBackfillPayload
): Promise<void> {
	const contacts = await db
		.select()
		.from(contact)
		.where(eq(contact.id, payload.contactId))
		.limit(1);

	if (contacts.length === 0 || !contacts[0].tracked || contacts[0].userId !== payload.userId) {
		return;
	}

	for (const row of await listContactEmails(payload.userId, contacts[0])) {
		if (row.attachments.length > 0) {
			const ingest: AttachmentIngestPayload = { contactId: payload.contactId, emailId: row.id };
			await enqueueJob('attachments.ingest', ingest);
		}
	}
}

export function registerIngestion(): void {
	registerJobHandler('attachments.ingest', async (payload) => {
		await ingestEmailAttachments(payload as AttachmentIngestPayload);
	});

	registerJobHandler('attachments.backfill', async (payload) => {
		await backfillContactAttachments(payload as AttachmentBackfillPayload);
	});
}
