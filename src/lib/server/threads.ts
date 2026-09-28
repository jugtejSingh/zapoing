import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { contact, email, mailAccount, thread } from '$lib/server/db/schema';
import { enqueueJob } from '$lib/server/jobs/worker';
import { bareAddresses } from '$lib/server/replyAddresses';
import type { PersonEmailPage } from '$lib/types';

type EmailRow = typeof email.$inferSelect;
type ContactRow = typeof contact.$inferSelect;

export type MemoryUpdatePayload = {
	contactId: string;
	emailId: string;
};

async function upsertThread(row: EmailRow): Promise<void> {
	if (row.threadId === null) {
		return;
	}

	await db
		.insert(thread)
		.values({
			accountId: row.accountId,
			threadId: row.threadId,
			subject: row.subject,
			firstAt: row.date,
			lastAt: row.date
		})
		.onConflictDoUpdate({
			target: [thread.accountId, thread.threadId],
			set: {
				firstAt: sql`min(coalesce(${thread.firstAt}, excluded.first_at), coalesce(excluded.first_at, ${thread.firstAt}))`,
				lastAt: sql`max(coalesce(${thread.lastAt}, excluded.last_at), coalesce(excluded.last_at, ${thread.lastAt}))`,
				subject: sql`case when ${thread.subject} = '' then excluded.subject else ${thread.subject} end`
			}
		});
}

/** The tracked contacts whose address appears in the from/to/cc of `row`. */
function matchingContacts(row: EmailRow, tracked: ContactRow[]): ContactRow[] {
	const addresses = new Set<string>();

	for (const address of bareAddresses([row.from, row.to, row.cc].join(', '))) {
		addresses.add(address.toLowerCase());
	}

	const matches: ContactRow[] = [];

	for (const candidate of tracked) {
		for (const address of candidate.emails) {
			if (addresses.has(address)) {
				matches.push(candidate);
				break;
			}
		}
	}

	return matches;
}

/**
 * Called by sync with the rows it just inserted. Keeps the thread table in step and
 * queues a memory update for each tracked contact on the mail.
 */
export async function recordInsertedEmails(rows: EmailRow[]): Promise<void> {
	if (rows.length === 0) {
		return;
	}

	for (const row of rows) {
		await upsertThread(row);
	}

	// ponytail: one account per batch, which is how sync calls this.
	const accounts = await db
		.select({ userId: mailAccount.userId })
		.from(mailAccount)
		.where(eq(mailAccount.id, rows[0].accountId))
		.limit(1);

	if (accounts.length === 0) {
		return;
	}

	const tracked = await db
		.select()
		.from(contact)
		.where(and(eq(contact.userId, accounts[0].userId), eq(contact.tracked, true)));

	if (tracked.length === 0) {
		return;
	}

	for (const row of rows) {
		for (const match of matchingContacts(row, tracked)) {
			if (row.threadId !== null) {
				await db
					.update(thread)
					.set({ contactId: match.id })
					.where(and(eq(thread.accountId, row.accountId), eq(thread.threadId, row.threadId)));
			}

			/** Files are stored for all of a tracked person's mail, old or new. */
			if (row.attachments.length > 0) {
				await enqueueJob('attachments.ingest', { contactId: match.id, emailId: row.id });
			}

			// ponytail: only mail from after tracking started. Older mail comes in through Rebuild,
			// otherwise the first full sync would queue one model call per historical message.
			if (row.date === null || row.date < match.createdAt) {
				continue;
			}

			const payload: MemoryUpdatePayload = { contactId: match.id, emailId: row.id };
			await enqueueJob('memory.update', payload);
		}
	}
}

/**
 * Every stored email to or from the contact across the user's accounts, oldest first.
 * ponytail: scans all of the user's mail and matches addresses in JS. Fine for one
 * mailbox; add an email_address index table if it gets slow.
 */
export async function listContactEmails(userId: string, contactRow: ContactRow): Promise<EmailRow[]> {
	const accountRows = await db
		.select({ id: mailAccount.id })
		.from(mailAccount)
		.where(eq(mailAccount.userId, userId));

	const accountIds: string[] = [];

	for (const account of accountRows) {
		accountIds.push(account.id);
	}

	if (accountIds.length === 0) {
		return [];
	}

	const allRows = await db
		.select()
		.from(email)
		.where(inArray(email.accountId, accountIds))
		.orderBy(asc(email.date));

	const matches: EmailRow[] = [];

	for (const row of allRows) {
		if (matchingContacts(row, [contactRow]).length > 0) {
			matches.push(row);
		}
	}

	return matches;
}

/**
 * A page of the contact's emails, newest first, via the `thread.contactId` index
 * `recordInsertedEmails`/Rebuild maintain — cheap even at a large mailbox's scale,
 * unlike `listContactEmails`'s full scan.
 */
export async function listContactEmailsPage(
	userId: string,
	contactId: string,
	limit: number,
	offset: number
): Promise<PersonEmailPage> {
	const rows = await db
		.select({
			id: email.id,
			from: email.from,
			subject: email.subject,
			date: email.date,
			snippet: email.snippet,
			direction: email.direction,
			attachments: email.attachments
		})
		.from(email)
		.innerJoin(
			thread,
			and(eq(thread.accountId, email.accountId), eq(thread.threadId, email.threadId))
		)
		.innerJoin(mailAccount, eq(mailAccount.id, email.accountId))
		.where(and(eq(thread.contactId, contactId), eq(mailAccount.userId, userId)))
		.orderBy(desc(email.date), desc(email.uid))
		.limit(limit)
		.offset(offset);

	return { emails: rows, hasMore: rows.length === limit };
}

/** Every stored message of the email's thread, oldest first. Just the email itself when it has no thread. */
export async function threadEmails(row: EmailRow): Promise<EmailRow[]> {
	if (row.threadId === null) {
		return [row];
	}

	return db
		.select()
		.from(email)
		.where(and(eq(email.accountId, row.accountId), eq(email.threadId, row.threadId)))
		.orderBy(asc(email.date));
}
