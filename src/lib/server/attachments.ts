import { simpleParser } from 'mailparser';
import { getOwnedEmail } from '$lib/server/drafts';
import { attachmentFilename, createClient, fileAttachments } from '$lib/server/mail';
import { getMailAccountCredentials } from '$lib/server/mailAccount';

export type AttachmentFile = {
	filename: string;
	contentType: string;
	content: Buffer;
};

/** The email is gone from the server, or its mailbox was renumbered since it was cached. */
export class AttachmentGoneError extends Error {
	constructor() {
		super('This email is no longer on the mail server');
	}
}

/**
 * The email's file attachments, fetched from IMAP by uid, in the same order as
 * the row's `attachments`. Nothing is stored. Null when the email is not the user's.
 * ponytail: one IMAP connection per call; cache the source if people download a lot.
 */
export async function fetchEmailAttachments(
	userId: string,
	emailId: string
): Promise<AttachmentFile[] | null> {
	const row = await getOwnedEmail(userId, emailId);

	if (row === null) {
		return null;
	}

	const account = await getMailAccountCredentials(userId, row.accountId);

	if (account === null) {
		return null;
	}

	const client = createClient(account);
	await client.connect();
	let source: Buffer | null = null;

	try {
		const lock = await client.getMailboxLock(row.mailbox);

		try {
			/** A uid only means the same message while uidvalidity is unchanged. */
			if (client.mailbox === false || Number(client.mailbox.uidValidity) !== row.uidValidity) {
				throw new AttachmentGoneError();
			}

			const range = String(row.uid) + ':' + String(row.uid);

			for await (const message of client.fetch(range, { source: true }, { uid: true })) {
				if (message.uid === row.uid && message.source) {
					source = message.source;
				}
			}
		} finally {
			lock.release();
		}
	} finally {
		await client.logout();
	}

	if (source === null) {
		throw new AttachmentGoneError();
	}

	const parsed = await simpleParser(source);
	const files: AttachmentFile[] = [];

	for (const attachment of fileAttachments(parsed)) {
		files.push({
			filename: attachmentFilename(attachment),
			contentType: attachment.contentType,
			content: attachment.content
		});
	}

	return files;
}

/** RFC 6266 header that forces a download, with the original name kept for non-ASCII too. */
export function downloadHeaders(filename: string, size: number): Record<string, string> {
	const asciiName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

	return {
		/** Never the real type: an HTML or SVG attachment must not run in the app's origin. */
		'Content-Type': 'application/octet-stream',
		'Content-Disposition':
			'attachment; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename),
		'Content-Length': String(size),
		'X-Content-Type-Options': 'nosniff'
	};
}
