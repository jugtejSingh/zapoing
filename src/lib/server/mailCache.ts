import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { email, mailAccount } from '$lib/server/db/schema';
import type { CachedEmail, EmailCategory, ThreadPage, ThreadSummary } from '$lib/types';
import { pendingDraftCounts } from '$lib/server/drafts';

/** Thread id for a row, with a stand-in for rows cached before threading existed. */
function rowThreadId(row: { threadId: string | null; uid: number }): string {
	if (row.threadId) {
		return row.threadId;
	}

	return 'uid:' + row.uid;
}

function accountLabel(account: { label: string | null; username: string }): string {
	if (account.label) {
		return account.label;
	}

	return account.username;
}

/**
 * The combined inbox: threads across every account the user has, newest first,
 * one entry per thread carrying its newest received message. Paginated with a
 * plain offset — `offset` is a multiple of `limit` (the number of pages already
 * loaded), which keeps scrolling simple at the size of one person's inbox.
 *
 * ponytail: groups the newest `limit` received messages in JS, so a thread whose
 * older replies fall outside that window shows a smaller count.
 */
export async function listCachedThreads(
	userId: string,
	category: EmailCategory | null,
	draftsOnly = false,
	limit = 20,
	offset = 0
): Promise<ThreadPage> {
	const start = Date.now();
	const conditions = [eq(mailAccount.userId, userId), eq(email.direction, 'in')];

	/** ponytail: drafts mode spans every category but still reads only the newest `limit` emails. */
	if (!draftsOnly) {
		if (category === null) {
			conditions.push(isNull(email.category));
		} else {
			conditions.push(eq(email.category, category));
		}
	}

	const queryStart = Date.now();
	const rows = await db
		.select({
			id: email.id,
			uid: email.uid,
			accountId: email.accountId,
			threadId: email.threadId,
			from: email.from,
			subject: email.subject,
			date: email.date,
			snippet: email.snippet,
			attachmentCount: sql<number>`json_array_length(${email.attachments})`,
			category: email.category,
			label: mailAccount.label,
			username: mailAccount.username
		})
		.from(email)
		.innerJoin(mailAccount, eq(email.accountId, mailAccount.id))
		.where(and(...conditions))
		.orderBy(desc(email.date), desc(email.uid))
		.limit(limit)
		.offset(offset);
	console.log(
		'[mailCache] listCachedThreads: page query returned ' +
			rows.length +
			' rows in ' +
			(Date.now() - queryStart) +
			'ms'
	);

	const threads: ThreadSummary[] = [];
	const seen = new Map<string, ThreadSummary>();

	for (const row of rows) {
		const threadId = rowThreadId(row);
		const key = row.accountId + '\n' + threadId;
		const existing = seen.get(key);

		if (existing) {
			existing.messageCount += 1;
			continue;
		}

		const summary: ThreadSummary = {
			id: row.id,
			threadId,
			accountId: row.accountId,
			accountLabel: accountLabel(row),
			from: row.from,
			subject: row.subject,
			date: row.date,
			snippet: row.snippet,
			attachmentCount: row.attachmentCount,
			messageCount: 1,
			category: row.category,
			draftCount: 0
		};

		seen.set(key, summary);
		threads.push(summary);
	}

	const draftCountStart = Date.now();
	const counts = await pendingDraftCounts(userId);
	console.log(
		'[mailCache] listCachedThreads: pendingDraftCounts took ' + (Date.now() - draftCountStart) + 'ms'
	);

	const listed: ThreadSummary[] = [];

	for (const summary of threads) {
		summary.draftCount = counts.get(summary.accountId + '\n' + summary.threadId) ?? 0;

		if (!draftsOnly || summary.draftCount > 0) {
			listed.push(summary);
		}
	}

	console.log('[mailCache] listCachedThreads: total ' + (Date.now() - start) + 'ms');

	return { threads: listed, hasMore: rows.length === limit };
}

/**
 * Every cached message in the thread that `emailId` belongs to — received and
 * sent — oldest first. Empty when the id is unknown or belongs to another user.
 */
export async function getCachedThread(userId: string, emailId: string): Promise<CachedEmail[]> {
	const start = Date.now();
	const anchorStart = Date.now();
	const anchors = await db
		.select({ email })
		.from(email)
		.innerJoin(mailAccount, eq(email.accountId, mailAccount.id))
		.where(and(eq(email.id, emailId), eq(mailAccount.userId, userId)))
		.limit(1);
	console.log('[mailCache] getCachedThread: anchor lookup took ' + (Date.now() - anchorStart) + 'ms');

	if (anchors.length === 0) {
		console.log('[mailCache] getCachedThread: no anchor found for ' + emailId);
		return [];
	}

	const anchor = anchors[0].email;
	let rows = [anchor];

	if (anchor.threadId) {
		const threadStart = Date.now();
		rows = await db
			.select()
			.from(email)
			.where(and(eq(email.accountId, anchor.accountId), eq(email.threadId, anchor.threadId)))
			.orderBy(asc(email.date), asc(email.uid));
		console.log(
			'[mailCache] getCachedThread: thread query returned ' +
				rows.length +
				' rows in ' +
				(Date.now() - threadStart) +
				'ms'
		);
	}

	const messages: CachedEmail[] = [];

	for (const row of rows) {
		messages.push({
			id: row.id,
			accountId: row.accountId,
			uid: row.uid,
			mailbox: row.mailbox,
			direction: row.direction,
			threadId: rowThreadId(row),
			from: row.from,
			to: row.to,
			cc: row.cc,
			replyTo: row.replyTo,
			messageId: row.messageId,
			references: row.references,
			subject: row.subject,
			date: row.date,
			text: row.text,
			html: row.html,
			attachments: row.attachments,
			category: row.category
		});
	}

	console.log('[mailCache] getCachedThread: total ' + (Date.now() - start) + 'ms');

	return messages;
}
