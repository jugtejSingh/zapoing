import { eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { contact, draft, email, generatedFile } from '$lib/server/db/schema';
import { startPlanner } from '$lib/server/ai/agents/planner';
import {
	discardOpenDrafts,
	getOwnedEmail,
	openDraftsFor,
	setDraftStatus,
	unansweredEmails
} from '$lib/server/drafts';
import { keepLatestVersions } from '$lib/server/files/generated';
import { registerJobHandler } from '$lib/server/jobs/worker';
import { bareAddresses } from '$lib/server/replyAddresses';
import { threadEmails } from '$lib/server/threads';
import { findContactByEmail } from '$lib/server/trackedPerson';

type EmailRow = typeof email.$inferSelect;
type ContactRow = typeof contact.$inferSelect;

export type DraftCreatePayload = {
	contactId: string;
	emailId: string;
};

async function loadContact(contactId: string): Promise<ContactRow | null> {
	const rows = await db.select().from(contact).where(eq(contact.id, contactId)).limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0];
}

async function loadEmail(emailId: string): Promise<EmailRow | null> {
	const rows = await db.select().from(email).where(eq(email.id, emailId)).limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0];
}

/** The tracked contact who sent the email, for drafts the user asks for from the thread page. */
export async function senderContact(userId: string, row: EmailRow): Promise<ContactRow | null> {
	for (const address of bareAddresses(row.from)) {
		const found = await findContactByEmail(userId, address);

		if (found !== null && found.tracked) {
			return found;
		}
	}

	return null;
}

/** A new pending draft for one incoming email, handed to the planner to fill. */
async function writeDraft(contactRow: ContactRow, row: EmailRow, force: boolean): Promise<void> {
	const inserted = await db
		.insert(draft)
		.values({
			emailId: row.id,
			contactId: contactRow.id,
			status: 'pending',
			coversEmailIds: [row.id]
		})
		.returning();

	try {
		await startPlanner(inserted[0], row, contactRow, force);
	} catch (caught) {
		/** An empty pending draft would make a retried job think the email is handled. */
		await setDraftStatus(inserted[0].id, 'discarded');
		throw caught;
	}
}

/** The draft.create job: runs after the memory update of each email from a tracked person. */
export async function createDraftForEmail(payload: DraftCreatePayload): Promise<void> {
	const row = await loadEmail(payload.emailId);
	const contactRow = await loadContact(payload.contactId);

	if (row === null || contactRow === null || !contactRow.tracked || row.direction !== 'in') {
		return;
	}

	/** A retried job must not write a second draft. */
	const existing = await openDraftsFor([row.id]);

	if (existing.length > 0) {
		return;
	}

	await writeDraft(contactRow, row, false);
}

/** "Draft anyway": replaces the email's open draft with a fresh one the planner must write. */
export async function redraftEmail(userId: string, emailId: string): Promise<void> {
	const row = await getOwnedEmail(userId, emailId);

	if (row === null) {
		throw new Error('Email not found');
	}

	const contactRow = await senderContact(userId, row);

	if (contactRow === null) {
		throw new Error('Drafts are only written for tracked people');
	}

	await writeDraft(contactRow, row, true);
	await discardOldDrafts(row.id);
}

/** Keeps only the newest open draft on the email, so a failed regenerate leaves the old one in place. */
async function discardOldDrafts(emailId: string): Promise<void> {
	const open = await openDraftsFor([emailId]);

	for (let index = 1; index < open.length; index++) {
		await setDraftStatus(open[index].id, 'discarded');
	}
}

/**
 * Merges the pending drafts of the thread's unanswered emails into one reply on
 * the latest of them. Only runs when the user asks. The source drafts are kept
 * as 'merged'. Throws if fewer than two drafts are waiting.
 */
export async function mergeDrafts(userId: string, emailId: string): Promise<void> {
	const anchor = await getOwnedEmail(userId, emailId);

	if (anchor === null) {
		throw new Error('Email not found');
	}

	const waiting = unansweredEmails(await threadEmails(anchor));
	const waitingIds: string[] = [];

	for (const row of waiting) {
		waitingIds.push(row.id);
	}

	const pending = [];

	for (const open of await openDraftsFor(waitingIds)) {
		if (open.status === 'pending') {
			pending.push(open);
		}
	}

	if (pending.length < 2) {
		throw new Error('There is nothing to merge');
	}

	const latest = waiting[waiting.length - 1];
	const contactRow = await loadContact(pending[0].contactId);

	if (contactRow === null) {
		throw new Error('Person not found');
	}

	/** Oldest draft first, matching the order the emails arrived. */
	pending.reverse();
	const draftTexts: string[] = [];
	const sourceIds: string[] = [];

	for (let index = 0; index < pending.length; index++) {
		draftTexts.push('--- Draft ' + String(index + 1) + ' ---\n' + pending[index].body);
		sourceIds.push(pending[index].id);
	}

	const seed =
		'A separate draft was written for each new message:\n\n' +
		draftTexts.join('\n\n') +
		'\n\nRewrite them as one reply that answers every new message. Keep every placeholder, each name once.';

	await discardOpenDrafts(latest.id);

	/** A merged draft is a new draft: its own id, so its own fresh planner state. */
	const merged = await db
		.insert(draft)
		.values({
			emailId: latest.id,
			contactId: contactRow.id,
			status: 'pending',
			coversEmailIds: waitingIds
		})
		.returning();

	try {
		await startPlanner(merged[0], latest, contactRow, true, seed);
	} catch (caught) {
		/** The sources go back to the user as they were. */
		await setDraftStatus(merged[0].id, 'discarded');

		for (const sourceId of sourceIds) {
			await setDraftStatus(sourceId, 'pending');
		}

		throw caught;
	}

	for (const sourceId of sourceIds) {
		await setDraftStatus(sourceId, 'merged');
	}

	/** The merged reply sends the files the separate drafts made, one version of each document. */
	await db
		.update(generatedFile)
		.set({ draftId: merged[0].id })
		.where(inArray(generatedFile.draftId, sourceIds));
	await keepLatestVersions(merged[0].id);
}

export function registerDraftingAgent(): void {
	registerJobHandler('draft.create', async (payload) => {
		await createDraftForEmail(payload as DraftCreatePayload);
	});
}
