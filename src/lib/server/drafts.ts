import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { forgetDraftState } from '$lib/server/ai/graph/checkpointer';
import { draft, email, mailAccount } from '$lib/server/db/schema';
import { threadEmails } from '$lib/server/threads';

type EmailRow = typeof email.$inferSelect;
type DraftRow = typeof draft.$inferSelect;

/** Drafts the user still has to act on. */
const OPEN_STATUSES: DraftRow['status'][] = ['pending', 'skipped'];

/**
 * The incoming emails after the user's last reply in the thread, oldest first.
 * These are the ones still waiting for an answer, and the only ones a merge covers.
 */
export function unansweredEmails<T extends { direction: string }>(thread: T[]): T[] {
	let lastOut = -1;

	for (let index = 0; index < thread.length; index++) {
		if (thread[index].direction === 'out') {
			lastOut = index;
		}
	}

	const waiting: T[] = [];

	for (let index = lastOut + 1; index < thread.length; index++) {
		if (thread[index].direction === 'in') {
			waiting.push(thread[index]);
		}
	}

	return waiting;
}

/** The email, only if it belongs to one of the user's accounts. */
export async function getOwnedEmail(userId: string, emailId: string): Promise<EmailRow | null> {
	const rows = await db
		.select({ email })
		.from(email)
		.innerJoin(mailAccount, eq(email.accountId, mailAccount.id))
		.where(and(eq(email.id, emailId), eq(mailAccount.userId, userId)))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0].email;
}

/** The draft, only if its email belongs to one of the user's accounts. */
export async function getOwnedDraft(userId: string, draftId: string): Promise<DraftRow | null> {
	const rows = await db
		.select({ draft })
		.from(draft)
		.innerJoin(email, eq(draft.emailId, email.id))
		.innerJoin(mailAccount, eq(email.accountId, mailAccount.id))
		.where(and(eq(draft.id, draftId), eq(mailAccount.userId, userId)))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0].draft;
}

/** Pending and skipped drafts on these emails, newest first. */
export async function openDraftsFor(emailIds: string[]): Promise<DraftRow[]> {
	if (emailIds.length === 0) {
		return [];
	}

	return db
		.select()
		.from(draft)
		.where(and(inArray(draft.emailId, emailIds), inArray(draft.status, OPEN_STATUSES)))
		.orderBy(desc(draft.createdAt));
}

export async function setDraftStatus(draftId: string, status: DraftRow['status']): Promise<void> {
	await db.update(draft).set({ status }).where(eq(draft.id, draftId));

	/** Only pending and skipped drafts can still be talked about; the planner's memory goes with the rest. */
	if (!OPEN_STATUSES.includes(status)) {
		await forgetDraftState(draftId);
	}
}

/** Retires the open drafts on one email, before a regenerate or "draft anyway" writes a new one. */
export async function discardOpenDrafts(emailId: string): Promise<void> {
	for (const open of await openDraftsFor([emailId])) {
		await setDraftStatus(open.id, 'discarded');
	}
}

/**
 * After the user replies, nothing in the thread is waiting any more: the draft
 * they sent (if any) becomes 'sent' and every other open draft is discarded.
 */
export async function closeThreadDrafts(anchor: EmailRow, sentDraftId: string | null): Promise<void> {
	const emailIds: string[] = [];

	for (const row of await threadEmails(anchor)) {
		emailIds.push(row.id);
	}

	for (const open of await openDraftsFor(emailIds)) {
		if (open.id === sentDraftId) {
			await setDraftStatus(open.id, 'sent');
		} else {
			await setDraftStatus(open.id, 'discarded');
		}
	}
}

/** Pending drafts per thread for the inbox badge, keyed `accountId\nthreadId`. */
export async function pendingDraftCounts(userId: string): Promise<Map<string, number>> {
	const rows = await db
		.select({ accountId: email.accountId, threadId: email.threadId, uid: email.uid })
		.from(draft)
		.innerJoin(email, eq(draft.emailId, email.id))
		.innerJoin(mailAccount, eq(email.accountId, mailAccount.id))
		.where(and(eq(mailAccount.userId, userId), eq(draft.status, 'pending')));

	const counts = new Map<string, number>();

	for (const row of rows) {
		let threadId = 'uid:' + row.uid;

		if (row.threadId) {
			threadId = row.threadId;
		}

		const key = row.accountId + '\n' + threadId;
		const current = counts.get(key) ?? 0;
		counts.set(key, current + 1);
	}

	return counts;
}
