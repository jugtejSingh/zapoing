import { eq } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { db } from '$lib/server/db';
import { email } from '$lib/server/db/schema';
import { createClient, findSentMailbox } from '$lib/server/mail';
import { getMailAccountCredentials, type MailAccountCredentials } from '$lib/server/mailAccount';
import { bareAddresses, replyRecipients } from '$lib/server/replyAddresses';
import { requestSync } from '$lib/server/syncWorker';
import { hasPlaceholders } from '$lib/placeholders';

/** Gmail's own cap on a message; the reply form enforces the same number. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type ReplyAttachment = {
	filename: string;
	contentType: string;
	content: Buffer;
};

export type ReplyInput = {
	body: string;
	/** Edited Cc text, empty for none. */
	cc: string;
	attachments: ReplyAttachment[];
};

/** Fallback when the account has no smtp_host: imap.x becomes smtp.x, which holds for Gmail, Outlook, Yahoo and iCloud. */
function smtpHostFor(imapHost: string): string {
	if (imapHost.startsWith('imap.')) {
		return 'smtp.' + imapHost.slice('imap.'.length);
	}

	return imapHost;
}

function transportFor(account: MailAccountCredentials) {
	let host = smtpHostFor(account.host);

	if (account.smtpHost) {
		host = account.smtpHost;
	}

	let port = 465;

	if (account.smtpPort) {
		port = account.smtpPort;
	}

	/** 465 is implicit TLS; any other port starts plain and upgrades with STARTTLS. */
	let secure = false;

	if (port === 465) {
		secure = true;
	}

	return nodemailer.createTransport({
		host,
		port,
		secure,
		auth: {
			user: account.username,
			pass: account.password
		}
	});
}

/** Gmail files every SMTP-sent message in Sent by itself; appending would duplicate it. */
function serverSavesSentMail(account: MailAccountCredentials): boolean {
	return account.host === 'imap.gmail.com';
}

function replySubject(subject: string): string {
	if (/^re:/i.test(subject.trim())) {
		return subject;
	}

	return 'Re: ' + subject;
}

function totalBytes(attachments: ReplyAttachment[]): number {
	let total = 0;

	for (const attachment of attachments) {
		total += attachment.content.length;
	}

	return total;
}

async function appendToSent(account: MailAccountCredentials, raw: Buffer): Promise<void> {
	const client = createClient(account);
	await client.connect();

	try {
		const sentPath = await findSentMailbox(client);

		if (sentPath) {
			await client.append(sentPath, raw, ['\\Seen']);
		}
	} finally {
		await client.logout();
	}
}

/**
 * Replies to a cached email from the account it arrived on, threaded with the
 * headers stored at sync time. A sent email gets a follow-up to its recipients.
 * Throws if the email is not this user's, it has no one to send to, the
 * attachments are too big, or the SMTP server refuses it.
 */
export async function sendReply(userId: string, emailId: string, input: ReplyInput): Promise<void> {
	/** A draft's [[gaps]] must never reach the recipient, whatever the page allowed. */
	if (hasPlaceholders(input.body)) {
		throw new Error('Fill in every [[placeholder]] before sending');
	}

	if (totalBytes(input.attachments) > MAX_ATTACHMENT_BYTES) {
		throw new Error('Attachments are over the 25 MB limit');
	}

	const rows = await db.select().from(email).where(eq(email.id, emailId)).limit(1);

	if (rows.length === 0) {
		throw new Error('Email not found');
	}

	const row = rows[0];

	/** Scoped to the user, so another user's email id finds no account. */
	const account = await getMailAccountCredentials(userId, row.accountId);

	if (!account) {
		throw new Error('Email not found');
	}

	const to = replyRecipients(row, account.username).to;
	const cc = input.cc.trim();

	const envelopeTo = bareAddresses(to);

	if (envelopeTo.length === 0) {
		throw new Error('The original message has no one to reply to');
	}

	for (const address of bareAddresses(cc)) {
		envelopeTo.push(address);
	}

	const references: string[] = [];

	for (const reference of row.references) {
		references.push(reference);
	}

	if (row.messageId) {
		references.push(row.messageId);
	}

	let ccHeader: string | undefined = undefined;

	if (cc.length > 0) {
		ccHeader = cc;
	}

	let inReplyTo: string | undefined = undefined;

	if (row.messageId) {
		inReplyTo = row.messageId;
	}

	/** Raw bytes, so the exact same message is sent and filed in Sent. */
	const raw = await new MailComposer({
		from: account.username,
		to,
		cc: ccHeader,
		subject: replySubject(row.subject),
		inReplyTo,
		references,
		text: input.body,
		attachments: input.attachments
	})
		.compile()
		.build();

	await transportFor(account).sendMail({
		envelope: {
			from: account.username,
			to: envelopeTo
		},
		raw
	});

	/** The send already succeeded; a failed Sent copy must not report it as unsent. */
	if (!serverSavesSentMail(account)) {
		try {
			await appendToSent(account, raw);
		} catch (appendError) {
			console.error('Reply sent but not saved to Sent:', appendError);
		}
	}

	/** Pull the reply into the cache so it shows in the thread. */
	void requestSync();
}
