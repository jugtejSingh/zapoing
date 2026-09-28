import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { mailboxState } from '$lib/server/db/schema';

export type MailboxState = {
	uidValidity: number;
	lastUid: number;
	/** CONDSTORE HIGHESTMODSEQ at the end of the last completed sync. Null before the first. */
	highestModseq: bigint | null;
};

/** Where sync stands for one folder, or null if it has never been synced. */
export async function getMailboxState(
	accountId: string,
	mailbox: string
): Promise<MailboxState | null> {
	const rows = await db
		.select()
		.from(mailboxState)
		.where(and(eq(mailboxState.accountId, accountId), eq(mailboxState.mailbox, mailbox)))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	const row = rows[0];
	let highestModseq: bigint | null = null;

	if (row.highestModseq !== null) {
		highestModseq = BigInt(row.highestModseq);
	}

	return {
		uidValidity: row.uidValidity,
		lastUid: row.lastUid,
		highestModseq
	};
}

/** Records where sync stands for one folder, creating the row the first time. */
export async function saveMailboxState(
	accountId: string,
	mailbox: string,
	state: MailboxState
): Promise<void> {
	let highestModseq: string | null = null;

	if (state.highestModseq !== null) {
		highestModseq = state.highestModseq.toString();
	}

	await db
		.insert(mailboxState)
		.values({
			accountId,
			mailbox,
			uidValidity: state.uidValidity,
			lastUid: state.lastUid,
			highestModseq
		})
		.onConflictDoUpdate({
			target: [mailboxState.accountId, mailboxState.mailbox],
			set: {
				uidValidity: state.uidValidity,
				lastUid: state.lastUid,
				highestModseq
			}
		});
}
