import { ImapFlow } from 'imapflow';
import type { ParsedMail } from 'mailparser';
import type { MailAccountCredentials } from '$lib/server/mailAccount';
import type { Email, EmailAttachment, ThreadSummary } from '$lib/types';

export type { Email, EmailAttachment, ThreadSummary };

/**
 * ponytail: one connection per account per sync run, pool it if syncs get frequent.
 */
export function createClient(account: MailAccountCredentials): ImapFlow {
	const client = new ImapFlow({
		host: account.host,
		port: account.port,
		secure: account.secure,
		auth: {
			user: account.username,
			pass: account.password
		},
		logger: false
	});

	// Without a listener, Node treats an emitted 'error' (e.g. socket timeout) as fatal and kills the process.
	// Pending commands still reject on their own, so callers' try/finally cleanup is unaffected.
	client.on('error', (error: Error & { code?: string }) => {
		console.error('IMAP connection error', error.code, error.message);
	});

	return client;
}

function addressText(value: ParsedMail['to']): string {
	if (!value) {
		return '';
	}

	if (Array.isArray(value)) {
		const parts: string[] = [];

		for (const item of value) {
			parts.push(item.text);
		}

		return parts.join(', ');
	}

	return value.text;
}

export function makeSnippet(text: string, length = 140): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();

	if (collapsed.length <= length) {
		return collapsed;
	}

	return collapsed.slice(0, length) + '…';
}

/** True for parts the HTML body references with a cid: url, e.g. signature logos. */
function isInlineImage(attachment: ParsedMail['attachments'][number]): boolean {
	if (!attachment.cid) {
		return false;
	}

	return attachment.related === true || attachment.contentDisposition === 'inline';
}

/**
 * Swap every cid: reference for a data: url so the sandboxed iframe can show it.
 * ponytail: inlines the bytes into the page. Fine for signature logos, move to a
 * /attachment/[cid] endpoint if someone starts mailing megabyte hero images.
 */
function inlineCidImages(html: string, parsed: ParsedMail): string {
	let result = html;

	for (const attachment of parsed.attachments) {
		if (!isInlineImage(attachment) || !attachment.cid) {
			continue;
		}

		const dataUri =
			'data:' + attachment.contentType + ';base64,' + attachment.content.toString('base64');

		result = result.split('cid:' + attachment.cid).join(dataUri);
	}

	return result;
}

/**
 * The real file attachments, without inline images. Index N here is index N in
 * the email row's `attachments`, which is how downloads and ingestion find a file.
 */
export function fileAttachments(parsed: ParsedMail): ParsedMail['attachments'] {
	const files: ParsedMail['attachments'] = [];

	for (const attachment of parsed.attachments) {
		if (!isInlineImage(attachment)) {
			files.push(attachment);
		}
	}

	return files;
}

/** Name for an attachment that has none. */
export function attachmentFilename(attachment: ParsedMail['attachments'][number]): string {
	if (attachment.filename) {
		return attachment.filename;
	}

	return 'unnamed';
}

function toAttachments(parsed: ParsedMail): EmailAttachment[] {
	const attachments: EmailAttachment[] = [];

	for (const attachment of fileAttachments(parsed)) {
		attachments.push({
			filename: attachmentFilename(attachment),
			contentType: attachment.contentType,
			size: attachment.size
		});
	}

	return attachments;
}

/**
 * Gmail and any OBJECTID server hand us a thread id. Everyone else gets one
 * derived from the reply chain: the root of References, then In-Reply-To, then
 * the message's own id — which is what a new thread's first message uses.
 */
function deriveThreadId(uid: number, parsed: ParsedMail, serverThreadId?: string): string {
	if (serverThreadId) {
		return serverThreadId;
	}

	const references = parsed.references;

	if (typeof references === 'string') {
		return references;
	}

	if (Array.isArray(references) && references.length > 0) {
		return references[0];
	}

	if (parsed.inReplyTo) {
		return parsed.inReplyTo;
	}

	if (parsed.messageId) {
		return parsed.messageId;
	}

	return 'uid:' + uid;
}

export function toEmail(
	uid: number,
	parsed: ParsedMail,
	serverThreadId?: string
): Email {
	let from = '';

	if (parsed.from) {
		from = parsed.from.text;
	}

	let html: string | null = null;

	if (parsed.html) {
		html = inlineCidImages(parsed.html, parsed);
	}

	let replyTo: string | null = null;

	if (parsed.replyTo) {
		replyTo = parsed.replyTo.text;
	}

	let references: string[] = [];

	if (Array.isArray(parsed.references)) {
		references = parsed.references;
	} else if (typeof parsed.references === 'string') {
		references = [parsed.references];
	}

	return {
		uid,
		threadId: deriveThreadId(uid, parsed, serverThreadId),
		from,
		to: addressText(parsed.to),
		cc: addressText(parsed.cc),
		replyTo,
		messageId: parsed.messageId ?? null,
		references,
		subject: parsed.subject ?? '',
		date: parsed.date ?? null,
		text: parsed.text ?? '',
		html,
		attachments: toAttachments(parsed)
	};
}

/** Path of the account's Sent folder, found by its \Sent special-use flag. Null if it has none. */
export async function findSentMailbox(client: ImapFlow): Promise<string | null> {
	const mailboxes = await client.list();

	for (const mailbox of mailboxes) {
		if (mailbox.specialUse === '\\Sent') {
			return mailbox.path;
		}
	}

	return null;
}
