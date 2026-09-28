import { and, count, eq, inArray, ne } from 'drizzle-orm';
import type { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db } from '$lib/server/db';
import { email, mailAccount } from '$lib/server/db/schema';
import { generatedFoldersForEmails, removeFolders } from '$lib/server/files/generated';
import {
	categoryFromLabels,
	createClient,
	findSentMailbox,
	makeSnippet,
	toEmail
} from '$lib/server/mail';
import { getMailboxState, saveMailboxState, type MailboxState } from '$lib/server/mailboxState';
import type { MailAccountCredentials } from '$lib/server/mailAccount';
import { recordInsertedEmails } from '$lib/server/threads';
import type { EmailCategory, EmailDirection } from '$lib/types';

/** Rows written per insert. lastUid is saved after each, so a crash resumes here. */
const BATCH_SIZE = 100;

/** Ids per delete statement, to stay well under SQLite's parameter limit. */
const DELETE_CHUNK_SIZE = 500;

/**
 * Hands the event loop back between chunks of sync work, so a big backfill
 * doesn't run start-to-finish without ever letting a pending HTTP request in.
 */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Milliseconds since `start`, for the timing logs below. */
function elapsedMs(start: number): number {
	return Date.now() - start;
}

/** Called as messages land, with how many the folder holds locally and on the server. */
export type SyncProgress = (done: number, total: number) => void;

type EmailRow = typeof email.$inferInsert;

async function countStored(accountId: string, mailbox: string): Promise<number> {
	const rows = await db
		.select({ value: count() })
		.from(email)
		.where(and(eq(email.accountId, accountId), eq(email.mailbox, mailbox)));

	return rows[0].value;
}

/**
 * Deletes the emails; the database drops their drafts and generated-file rows.
 * The generated folders on disk go only after the delete succeeded, so a failed
 * delete never leaves rows pointing at missing files.
 */
async function deleteEmails(ids: string[]): Promise<void> {
	if (ids.length === 0) {
		return;
	}

	const start = Date.now();
	console.log('[mailSync] deleteEmails: deleting ' + ids.length + ' rows');

	for (let chunkStart = 0; chunkStart < ids.length; chunkStart += DELETE_CHUNK_SIZE) {
		const chunk = ids.slice(chunkStart, chunkStart + DELETE_CHUNK_SIZE);
		const folderStart = Date.now();
		const folders = await generatedFoldersForEmails(chunk);
		console.log(
			'[mailSync] deleteEmails: looked up generated folders for ' +
				chunk.length +
				' rows in ' +
				elapsedMs(folderStart) +
				'ms'
		);

		const deleteStart = Date.now();
		await db.delete(email).where(inArray(email.id, chunk));
		console.log('[mailSync] deleteEmails: db delete of ' + chunk.length + ' rows took ' + elapsedMs(deleteStart) + 'ms');

		const removeStart = Date.now();
		await removeFolders(folders);
		console.log('[mailSync] deleteEmails: removed ' + folders.length + ' folders in ' + elapsedMs(removeStart) + 'ms');

		await yieldToEventLoop();
	}

	console.log('[mailSync] deleteEmails: finished deleting ' + ids.length + ' rows in ' + elapsedMs(start) + 'ms');
}

/**
 * Drops every row in the folder that belongs to another UIDVALIDITY. The server
 * has said those uids mean nothing any more, so the folder is fetched again.
 */
async function deleteOtherGenerations(
	accountId: string,
	mailbox: string,
	uidValidity: number
): Promise<void> {
	const start = Date.now();
	const rows = await db
		.select({ id: email.id })
		.from(email)
		.where(
			and(
				eq(email.accountId, accountId),
				eq(email.mailbox, mailbox),
				ne(email.uidValidity, uidValidity)
			)
		);
	const ids: string[] = [];

	for (const row of rows) {
		ids.push(row.id);
	}

	console.log(
		'[mailSync] ' +
			mailbox +
			': found ' +
			ids.length +
			' rows from a stale uidValidity in ' +
			elapsedMs(start) +
			'ms'
	);

	await deleteEmails(ids);
}

/** Removes local rows whose uid the server no longer has, i.e. mail deleted on the server. */
async function deleteMissing(
	accountId: string,
	mailbox: string,
	serverUids: number[]
): Promise<void> {
	const start = Date.now();
	const onServer = new Set<number>();

	for (const uid of serverUids) {
		onServer.add(uid);
	}

	const localRows = await db
		.select({ id: email.id, uid: email.uid })
		.from(email)
		.where(and(eq(email.accountId, accountId), eq(email.mailbox, mailbox)));

	const missingIds: string[] = [];

	for (const row of localRows) {
		if (!onServer.has(row.uid)) {
			missingIds.push(row.id);
		}
	}

	console.log(
		'[mailSync] ' +
			mailbox +
			': compared ' +
			localRows.length +
			' local rows against ' +
			serverUids.length +
			' server uids in ' +
			elapsedMs(start) +
			'ms, found ' +
			missingIds.length +
			' missing'
	);

	await deleteEmails(missingIds);
}

/**
 * Fetches every message after state.lastUid, storing them BATCH_SIZE at a time
 * and saving lastUid after each batch. Returns the new lastUid.
 *
 * ponytail: parses each message's full source, so the first backfill of a big
 * mailbox takes a while. It runs once, in the background.
 */
async function fetchNewMessages(
	client: ImapFlow,
	accountId: string,
	mailbox: string,
	direction: EmailDirection,
	state: MailboxState,
	total: number,
	onProgress?: SyncProgress
): Promise<number> {
	const syncStart = Date.now();
	let lastUid = state.lastUid;
	let done = await countStored(accountId, mailbox);
	let batch: EmailRow[] = [];

	/** Time spent waiting on the IMAP server to hand over the next message. */
	let imapWaitMs = 0;

	/** Time spent in simpleParser + toEmail turning raw source into a row. */
	let parseMs = 0;

	console.log(
		'[mailSync] ' +
			mailbox +
			': fetching from uid ' +
			(state.lastUid + 1) +
			' (' +
			total +
			' messages on the server, ' +
			done +
			' already stored)'
	);

	/** Reports the real count even when this mailbox has nothing new to fetch. */
	onProgress?.(Math.min(done, total), total);

	async function flush(): Promise<void> {
		if (batch.length === 0) {
			return;
		}

		const insertStart = Date.now();

		/** Already-stored uids (e.g. the rows from before full sync existed) are skipped, not duplicated. */
		const inserted = await db.insert(email).values(batch).onConflictDoNothing().returning();
		const insertMs = elapsedMs(insertStart);

		const threadsStart = Date.now();
		await recordInsertedEmails(inserted);
		const threadsMs = elapsedMs(threadsStart);

		for (const row of batch) {
			if (row.uid > lastUid) {
				lastUid = row.uid;
			}
		}

		const stateStart = Date.now();
		await saveMailboxState(accountId, mailbox, {
			uidValidity: state.uidValidity,
			lastUid,
			highestModseq: state.highestModseq
		});
		const stateMs = elapsedMs(stateStart);

		console.log(
			'[mailSync] ' +
				mailbox +
				': flushed a batch of ' +
				batch.length +
				' — insert ' +
				insertMs +
				'ms, thread linking ' +
				threadsMs +
				'ms, save state ' +
				stateMs +
				'ms (' +
				(done + batch.length) +
				'/' +
				total +
				' done, imap wait so far ' +
				imapWaitMs +
				'ms, parse so far ' +
				parseMs +
				'ms)'
		);

		done += batch.length;
		batch = [];

		if (onProgress) {
			onProgress(Math.min(done, total), total);
		}
	}

	const range = String(state.lastUid + 1) + ':*';
	let waitStart = Date.now();

	for await (const message of client.fetch(
		range,
		{ uid: true, source: true, threadId: true, labels: true },
		{ uid: true }
	)) {
		imapWaitMs += elapsedMs(waitStart);

		if (!message.source) {
			waitStart = Date.now();
			continue;
		}

		/** An empty `n:*` range still yields the newest message, which we already have. */
		if (message.uid <= state.lastUid) {
			waitStart = Date.now();
			continue;
		}

		const parseStart = Date.now();
		const parsed = await simpleParser(message.source);
		const parsedEmail = toEmail(
			message.uid,
			parsed,
			message.threadId,
			categoryFromLabels(message.labels)
		);
		parseMs += elapsedMs(parseStart);

		batch.push({
			accountId,
			mailbox,
			uid: parsedEmail.uid,
			uidValidity: state.uidValidity,
			from: parsedEmail.from,
			to: parsedEmail.to,
			cc: parsedEmail.cc,
			replyTo: parsedEmail.replyTo,
			messageId: parsedEmail.messageId,
			references: parsedEmail.references,
			subject: parsedEmail.subject,
			date: parsedEmail.date,
			text: parsedEmail.text,
			html: parsedEmail.html,
			snippet: makeSnippet(parsedEmail.text),
			threadId: parsedEmail.threadId,
			attachments: parsedEmail.attachments,
			category: parsedEmail.category,
			direction
		});

		if (batch.length >= BATCH_SIZE) {
			await flush();
		}

		/** Yielding after every message, not just every batch, is what actually keeps a click responsive during a big backfill. */
		await yieldToEventLoop();

		waitStart = Date.now();
	}

	await flush();

	console.log(
		'[mailSync] ' +
			mailbox +
			': fetch loop finished in ' +
			elapsedMs(syncStart) +
			'ms total — imap wait ' +
			imapWaitMs +
			'ms, parsing ' +
			parseMs +
			'ms'
	);

	return lastUid;
}

/**
 * Picks up Gmail moving stored messages between tabs, using CONDSTORE so only
 * flags of changed messages come back (no bodies).
 */
async function refreshCategories(
	client: ImapFlow,
	accountId: string,
	mailbox: string,
	lastUid: number,
	changedSince: bigint
): Promise<void> {
	const start = Date.now();
	const updates: { uid: number; category: EmailCategory | null }[] = [];

	for await (const message of client.fetch(
		'1:' + String(lastUid),
		{ uid: true, labels: true },
		{ uid: true, changedSince }
	)) {
		/** Non-Gmail servers send no labels, so there is nothing to update. */
		if (!message.labels) {
			continue;
		}

		updates.push({ uid: message.uid, category: categoryFromLabels(message.labels) });
	}

	console.log(
		'[mailSync] ' +
			mailbox +
			': fetched ' +
			updates.length +
			' changed categories in ' +
			elapsedMs(start) +
			'ms'
	);

	const updateStart = Date.now();

	for (const update of updates) {
		await db
			.update(email)
			.set({ category: update.category })
			.where(
				and(eq(email.accountId, accountId), eq(email.mailbox, mailbox), eq(email.uid, update.uid))
			);
	}

	console.log(
		'[mailSync] ' +
			mailbox +
			': wrote ' +
			updates.length +
			' category updates in ' +
			elapsedMs(updateStart) +
			'ms'
	);
}

/**
 * Brings one folder up to date:
 * 1. a UIDVALIDITY change (or first sync) drops rows from other generations
 * 2. everything after lastUid is fetched — the whole folder on the first run
 * 3. rows the server no longer has are deleted, only if the uid search succeeded
 * 4. Gmail category changes since the last run are applied
 * The final state (with the new modseq) is saved only once all of that worked.
 */
export async function syncMailbox(
	client: ImapFlow,
	accountId: string,
	mailbox: string,
	direction: EmailDirection,
	onProgress?: SyncProgress
): Promise<void> {
	const syncMailboxStart = Date.now();
	console.log('[mailSync] ' + mailbox + ': acquiring mailbox lock');

	const lockStart = Date.now();
	const lock = await client.getMailboxLock(mailbox);
	console.log('[mailSync] ' + mailbox + ': got lock in ' + elapsedMs(lockStart) + 'ms');

	try {
		if (typeof client.mailbox === 'boolean') {
			console.log('[mailSync] ' + mailbox + ': mailbox not open, skipping');
			return;
		}

		const opened = client.mailbox;
		const uidValidity = Number(opened.uidValidity);

		const stateStart = Date.now();
		let state = await getMailboxState(accountId, mailbox);
		console.log('[mailSync] ' + mailbox + ': loaded local state in ' + elapsedMs(stateStart) + 'ms');

		if (state === null || state.uidValidity !== uidValidity) {
			console.log('[mailSync] ' + mailbox + ': uidValidity changed (or first sync), dropping stale rows');
			await deleteOtherGenerations(accountId, mailbox, uidValidity);
			state = { uidValidity, lastUid: 0, highestModseq: null };
		}

		let lastUid = state.lastUid;

		if (opened.exists > 0) {
			lastUid = await fetchNewMessages(
				client,
				accountId,
				mailbox,
				direction,
				state,
				opened.exists,
				onProgress
			);
		} else {
			console.log('[mailSync] ' + mailbox + ': server reports 0 messages, skipping fetch');
		}

		const searchStart = Date.now();
		const serverUids = await client.search({ all: true }, { uid: true });
		console.log(
			'[mailSync] ' +
				mailbox +
				': server uid search took ' +
				elapsedMs(searchStart) +
				'ms (' +
				(Array.isArray(serverUids) ? serverUids.length + ' uids' : 'search failed') +
				')'
		);

		/** false/undefined means the search failed. Never read that as "the server has nothing". */
		if (Array.isArray(serverUids)) {
			await deleteMissing(accountId, mailbox, serverUids);
		}

		let serverModseq: bigint | null = null;

		if (opened.highestModseq !== undefined && !opened.noModseq) {
			serverModseq = opened.highestModseq;
		}

		if (
			state.highestModseq !== null &&
			serverModseq !== null &&
			serverModseq > state.highestModseq &&
			state.lastUid > 0
		) {
			await refreshCategories(client, accountId, mailbox, state.lastUid, state.highestModseq);
		}

		await saveMailboxState(accountId, mailbox, {
			uidValidity,
			lastUid,
			highestModseq: serverModseq
		});

		console.log(
			'[mailSync] ' + mailbox + ': syncMailbox finished in ' + elapsedMs(syncMailboxStart) + 'ms'
		);
	} finally {
		lock.release();
		console.log('[mailSync] ' + mailbox + ': released lock');
	}
}

/** Syncs an account's INBOX and, if it has one, its Sent folder, over one connection. */
export async function syncAccount(
	account: MailAccountCredentials,
	onProgress?: SyncProgress
): Promise<void> {
	const start = Date.now();
	console.log('[mailSync] ' + account.username + ': connecting');

	const client = createClient(account);

	const connectStart = Date.now();
	await client.connect();
	console.log('[mailSync] ' + account.username + ': connected in ' + elapsedMs(connectStart) + 'ms');

	try {
		await syncMailbox(client, account.id, 'INBOX', 'in', onProgress);

		const sentStart = Date.now();
		const sentMailbox = await findSentMailbox(client);
		console.log(
			'[mailSync] ' +
				account.username +
				': found sent mailbox (' +
				sentMailbox +
				') in ' +
				elapsedMs(sentStart) +
				'ms'
		);

		if (sentMailbox !== null) {
			await syncMailbox(client, account.id, sentMailbox, 'out', onProgress);
		}
	} finally {
		const logoutStart = Date.now();
		await client.logout();
		console.log('[mailSync] ' + account.username + ': logged out in ' + elapsedMs(logoutStart) + 'ms');
	}

	await db
		.update(mailAccount)
		.set({ lastSyncedAt: new Date() })
		.where(eq(mailAccount.id, account.id));

	console.log('[mailSync] ' + account.username + ': syncAccount finished in ' + elapsedMs(start) + 'ms');
}
