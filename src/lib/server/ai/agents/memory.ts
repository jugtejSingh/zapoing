import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { and, eq, isNull } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { contact, email, summaryVersion, thread } from '$lib/server/db/schema';
import { callModel } from '$lib/server/ai/model';
import {
	cutThread,
	formatThread,
	logThreadCut,
	threadBudgetTokens,
	type ThreadCut,
	type ThreadMessage
} from '$lib/server/ai/context/cutThread';
import { enqueueJob, registerJobHandler } from '$lib/server/jobs/worker';
import { summaryHistoryPath, summaryPath } from '$lib/server/storage/paths';
import { listContactEmails, threadEmails, type MemoryUpdatePayload } from '$lib/server/threads';

type EmailRow = typeof email.$inferSelect;
type ContactRow = typeof contact.$inferSelect;
type SummaryReason = 'update' | 'rebuild' | 'user_edit';

const MY_NOTES_HEADING = '## My notes';

const SYSTEM_PROMPT = `You keep a running memory of one person the user emails with.
You get the current summary (may be empty) and an email thread. Return the full updated summary in Markdown, nothing else.
Use exactly these sections:

## Who they are
Role, company, relationship to the user, anything stable worth knowing.

## How to write to them
Tone, length, language, greetings and sign-offs that work with them.

## Active threads
One ### subsection per open conversation, with: what it is about, decisions made, open asks and who owes what, dates and deadlines, files exchanged.

## Closed threads
One line per finished conversation.

Keep facts from the current summary unless the thread contradicts them. Move a thread to Closed threads when it is done.
Do not write a "${MY_NOTES_HEADING}" section, the user owns it.`;

/** The "## My notes" section (heading included) up to the next "## " heading, or '' if absent. */
export function extractMyNotes(summary: string): string {
	const lines = summary.split(/\r?\n/);
	const kept: string[] = [];
	let inside = false;

	for (const line of lines) {
		if (line.trim() === MY_NOTES_HEADING) {
			inside = true;
			kept.push(line);
			continue;
		}

		if (inside && line.startsWith('## ')) {
			break;
		}

		if (inside) {
			kept.push(line);
		}
	}

	return kept.join('\n').trim();
}

/** The summary with any "## My notes" section cut out. */
function withoutMyNotes(summary: string): string {
	const lines = summary.split(/\r?\n/);
	const kept: string[] = [];
	let inside = false;

	for (const line of lines) {
		if (line.trim() === MY_NOTES_HEADING) {
			inside = true;
			continue;
		}

		if (inside && line.startsWith('## ')) {
			inside = false;
		}

		if (!inside) {
			kept.push(line);
		}
	}

	return kept.join('\n').trim();
}

export async function readSummary(contactId: string): Promise<string> {
	try {
		return await readFile(await summaryPath(contactId), 'utf8');
	} catch {
		return '';
	}
}

/**
 * Replaces summary.md. The old file is archived to summary_history/ with a
 * summary_version row. For model-written summaries the user's "## My notes"
 * section is carried over verbatim; a user edit is taken as-is.
 */
export async function writeSummary(
	contactId: string,
	text: string,
	reason: SummaryReason
): Promise<void> {
	const current = await readSummary(contactId);
	const file = await summaryPath(contactId);

	if (current !== '') {
		const archive = await summaryHistoryPath(contactId, new Date());
		await copyFile(file, archive);
		await db.insert(summaryVersion).values({ contactId, path: archive, reason });
	}

	let next = text.trim();

	if (reason !== 'user_edit') {
		next = withoutMyNotes(next);
		const notes = extractMyNotes(current);

		if (notes !== '') {
			next = next + '\n\n' + notes;
		}
	}

	await writeFile(file, next + '\n', 'utf8');
}

const DEFAULT_REBUILD_BUDGET_TOKENS = 32000;

/** How much mail one rebuild call may carry. Most people's whole history fits in one call. */
function rebuildBudgetTokens(): number {
	const parsed = Number(env.REBUILD_BUDGET_TOKENS);

	if (Number.isFinite(parsed) && parsed > 0) {
		return parsed;
	}

	return DEFAULT_REBUILD_BUDGET_TOKENS;
}

/** Fits one thread into the per-thread budget, keeping `newId`, and logs what was dropped. */
async function cutRows(contactRow: ContactRow, rows: EmailRow[], newId: string): Promise<ThreadCut> {
	const messages: ThreadMessage[] = [];

	for (const row of rows) {
		messages.push({ id: row.id, from: row.from, date: row.date, text: row.text });
	}

	const cut = cutThread(messages, newId, threadBudgetTokens());
	await logThreadCut('memory', contactRow.id, cut);

	return cut;
}

/** One model call: the current summary plus the mail to fold into it. */
async function askModel(
	contactRow: ContactRow,
	currentSummary: string,
	mailHeading: string,
	mailText: string
): Promise<string> {
	let summaryText = withoutMyNotes(currentSummary);

	if (summaryText === '') {
		summaryText = '(empty, nothing known yet)';
	}

	const userContent =
		'Person: ' +
		contactRow.emails.join(', ') +
		'\n\nCurrent summary:\n' +
		summaryText +
		'\n\n' +
		mailHeading +
		':\n\n' +
		mailText;

	return callModel('memory', [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: userContent }
	]);
}

/** Incremental update: the thread of the new message, with that message marked. */
async function summarise(
	contactRow: ContactRow,
	currentSummary: string,
	rows: EmailRow[],
	newId: string
): Promise<string> {
	const cut = await cutRows(contactRow, rows, newId);
	return askModel(contactRow, currentSummary, 'Thread (oldest first)', formatThread(cut.kept, [newId]));
}

type CutThread = {
	subject: string;
	cut: ThreadCut;
};

/** Several whole threads in one call, each under its own subject line. */
async function summariseBatch(
	contactRow: ContactRow,
	currentSummary: string,
	batch: CutThread[]
): Promise<string> {
	const parts: string[] = [];

	for (const item of batch) {
		parts.push('=== Thread: ' + item.subject + ' ===\n\n' + formatThread(item.cut.kept, []));
	}

	return askModel(contactRow, currentSummary, 'Past threads (oldest first)', parts.join('\n\n'));
}

async function loadContact(contactId: string): Promise<ContactRow | null> {
	const rows = await db.select().from(contact).where(eq(contact.id, contactId)).limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0];
}

/** The memory.update job: fold one new message into the person's summary. */
export async function updateSummary(payload: MemoryUpdatePayload): Promise<void> {
	const contactRow = await loadContact(payload.contactId);

	if (contactRow === null || !contactRow.tracked) {
		return;
	}

	const emailRows = await db.select().from(email).where(eq(email.id, payload.emailId)).limit(1);

	if (emailRows.length === 0) {
		return;
	}

	const rows = await threadEmails(emailRows[0]);
	const current = await readSummary(contactRow.id);
	const next = await summarise(contactRow, current, rows, payload.emailId);

	await writeSummary(contactRow.id, next, 'update');
}

/**
 * Rebuilds the summary from nothing over all of the person's mail, and links
 * their threads. Whole threads (a lone email counts as a thread of one) are
 * packed oldest first into calls of up to REBUILD_BUDGET_TOKENS, so most people
 * take a single call and long histories a few, each building on the last.
 */
export async function rebuildSummary(userId: string, contactId: string): Promise<void> {
	const contactRow = await loadContact(contactId);

	if (contactRow === null || contactRow.userId !== userId) {
		return;
	}

	/** One entry per thread (or lone email) that involves the person, in first-seen order. */
	const threadStarts = new Map<string, EmailRow>();

	for (const row of await listContactEmails(userId, contactRow)) {
		let key = 'email:' + row.id;

		if (row.threadId !== null) {
			key = row.accountId + ':' + row.threadId;
		}

		if (!threadStarts.has(key)) {
			threadStarts.set(key, row);
		}
	}

	const budget = rebuildBudgetTokens();
	let summary = '';
	let batch: CutThread[] = [];
	let batchTokens = 0;

	for (const first of threadStarts.values()) {
		const rows = await threadEmails(first);
		const last = rows[rows.length - 1];

		if (first.threadId !== null) {
			await db
				.update(thread)
				.set({ contactId: contactRow.id })
				.where(
					and(
						eq(thread.accountId, first.accountId),
						eq(thread.threadId, first.threadId),
						isNull(thread.contactId)
					)
				);
		}

		const cut = await cutRows(contactRow, rows, last.id);

		/** A thread that would overflow the batch goes into the next call instead. */
		if (batch.length > 0 && batchTokens + cut.tokens > budget) {
			summary = await summariseBatch(contactRow, summary, batch);
			batch = [];
			batchTokens = 0;
		}

		batch.push({ subject: first.subject, cut });
		batchTokens = batchTokens + cut.tokens;
	}

	if (batch.length > 0) {
		summary = await summariseBatch(contactRow, summary, batch);
	}

	if (summary === '') {
		return;
	}

	await writeSummary(contactRow.id, summary, 'rebuild');
}

export async function saveUserEdit(userId: string, contactId: string, text: string): Promise<void> {
	const contactRow = await loadContact(contactId);

	if (contactRow === null || contactRow.userId !== userId) {
		return;
	}

	await writeSummary(contactId, text, 'user_edit');
}

export type MemoryRebuildPayload = {
	userId: string;
	contactId: string;
};

export function registerMemoryAgent(): void {
	/** The draft is queued only after the summary is updated, so it is written with the new summary. */
	registerJobHandler('memory.update', async (payload) => {
		const update = payload as MemoryUpdatePayload;
		await updateSummary(update);
		await enqueueJob('draft.create', update);
	});

	/** A job because a rebuild is one model call per thread and can outlast a request. */
	registerJobHandler('memory.rebuild', async (payload) => {
		const rebuild = payload as MemoryRebuildPayload;
		await rebuildSummary(rebuild.userId, rebuild.contactId);
	});
}
