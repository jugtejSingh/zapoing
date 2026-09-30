import { and, asc, desc, eq, inArray, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db } from '$lib/server/db';
import { email, mailAccount } from '$lib/server/db/schema';
import type { CachedEmail, ThreadPage, ThreadSummary } from '$lib/types';
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

/** Makes `%`, `_` and the escape character in user input match literally inside LIKE. */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * The combined inbox: one entry per thread across every account the user has,
 * newest first. Pagination is in threads — `limit` threads per page and `offset`
 * threads skipped — so a thread with many messages still takes one slot.
 *
 * A thread is listed once, at its newest received message (its "head"): a row
 * only qualifies when no newer received message with the same filter exists in
 * the same thread. Message counts then cover every cached message in the thread,
 * received and sent.
 *
 * `search` matches the sender, recipients and subject (case-insensitive for ASCII)
 * across the whole mailbox; bodies are not searched.
 *
 * ponytail: drafts mode filters by draft after the page is read, so a page can
 * come back short. Push the draft thread keys into the query if that matters.
 */
export async function listCachedThreads(
	userId: string,
	draftsOnly = false,
	limit = 20,
	offset = 0,
	search = ''
): Promise<ThreadPage> {
	const start = Date.now();
	const searching = search.trim().length > 0;
	const newer = alias(email, 'newer');
	const conditions = [eq(mailAccount.userId, userId), eq(email.direction, 'in')];
	const newerConditions = [
		eq(newer.accountId, email.accountId),
		eq(newer.threadId, email.threadId),
		eq(newer.direction, 'in'),
		sql`(coalesce(${newer.date}, 0), ${newer.uid}) > (coalesce(${email.date}, 0), ${email.uid})`
	];

	if (searching) {
		const pattern = '%' + escapeLike(search.trim()) + '%';

		conditions.push(
			sql`(${email.from} like ${pattern} escape '\\' or ${email.to} like ${pattern} escape '\\' or ${email.subject} like ${pattern} escape '\\')`
		);
	}

	conditions.push(
		notExists(
			db
				.select({ one: sql`1` })
				.from(newer)
				.where(and(...newerConditions))
		)
	);

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
			' threads in ' +
			(Date.now() - queryStart) +
			'ms'
	);

	const messageCounts = await threadMessageCounts(rows);

	const threads: ThreadSummary[] = [];

	for (const row of rows) {
		const threadId = rowThreadId(row);
		const count = messageCounts.get(row.accountId + '\n' + threadId) ?? 1;

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
			messageCount: count,
			draftCount: 0
		};

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
 * How many cached messages (received and sent) each listed thread holds, keyed by
 * account + thread id. Rows with no server thread id are absent — they are alone.
 */
async function threadMessageCounts(
	rows: { accountId: string; threadId: string | null }[]
): Promise<Map<string, number>> {
	const accountIds = new Set<string>();
	const threadIds = new Set<string>();

	for (const row of rows) {
		if (row.threadId) {
			accountIds.add(row.accountId);
			threadIds.add(row.threadId);
		}
	}

	const counts = new Map<string, number>();

	if (threadIds.size === 0) {
		return counts;
	}

	const found = await db
		.select({
			accountId: email.accountId,
			threadId: email.threadId,
			count: sql<number>`count(*)`
		})
		.from(email)
		.where(and(inArray(email.accountId, [...accountIds]), inArray(email.threadId, [...threadIds])))
		.groupBy(email.accountId, email.threadId);

	for (const row of found) {
		counts.set(row.accountId + '\n' + row.threadId, row.count);
	}

	return counts;
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
			attachments: row.attachments
		});
	}

	console.log('[mailCache] getCachedThread: total ' + (Date.now() - start) + 'ms');

	return messages;
}
