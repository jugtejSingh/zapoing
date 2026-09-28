import { eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { contact, draft, email, generatedFile } from '$lib/server/db/schema';
import { recordAgentRun } from '$lib/server/ai/agentRun';
import {
	describeDocuments,
	generateDocument,
	type DocumentRequest
} from '$lib/server/ai/agents/document';
import {
	describeTemplates,
	generateFromTemplate,
	recordMissingTemplate
} from '$lib/server/ai/agents/template';
import { buildDraftContext } from '$lib/server/ai/context/buildContext';
import { callModel } from '$lib/server/ai/model';
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
import {
	describeResources,
	resourceFiles,
	searchResources,
	usedResources
} from '$lib/server/resources';
import { readyTemplates } from '$lib/server/templates';
import { threadEmails } from '$lib/server/threads';
import { findContactByEmail } from '$lib/server/trackedPerson';
import { listPlaceholders } from '$lib/placeholders';

type EmailRow = typeof email.$inferSelect;
type ContactRow = typeof contact.$inferSelect;

export type DraftCreatePayload = {
	contactId: string;
	emailId: string;
};

const SYSTEM_PROMPT = `You write email replies for the user, in their voice.
Return JSON only, with no code fence: {"reply_needed": true or false, "reason": "one short line", "intents": [], "body": "the reply", "documents": [], "conflicts": []}

reply_needed is false only when nothing needs answering: thanks, acknowledgements, FYI with no question or request. Then body is "".
intents lists what the [NEW MESSAGE] emails ask for, one short line each in the order asked, e.g. "wants the price for 10 seats". [] when they ask for nothing.

Rules for the reply:
- Answer every question and request in the [NEW MESSAGE] emails, in the order they were asked.
- Any date, time, price, number, commitment or fact that is not in the profile, summary or thread becomes a placeholder like [[start-time]], [[price]] or [[signing-date]]. Short, self-explanatory names. The same fact uses the same name. Never guess.
- Never agree to terms or make commitments on the user's behalf; use a placeholder instead.
- Follow the user's tone, length and sign-off, adjusted to how formal the person is.
- Plain text, no subject line. As short as a person would write it.

Resources:
- The files listed in [RESOURCES] are the user's own reference material (prices, terms, company facts). Facts in them may be used without a placeholder.
- When two resources disagree, use the newest one and add a short line to "conflicts", e.g. "Pricing 2025 says 40 EUR/h, Pricing 2026 says 45 EUR/h; used Pricing 2026". Otherwise "conflicts" is [].

Documents:
- Only when a new message asks for a document to be changed, sent or written, add an entry to "documents": {"document_id": an id from [DOCUMENTS] or null for a new document, "change": "exactly what to change or write"}.
- A standard document the user sends to many people (an NDA, contract, agreement, order form) comes from a template: {"template_id": an id from [TEMPLATES], "change": "what to fill in"}.
- If such a document is asked for and no template in [TEMPLATES] fits, add {"missing_template": "what kind of document", "change": "what was asked for"} instead. Never write it yourself or use a template meant for something else.
- Never on your own initiative. When there is an entry, the reply mentions the attached file.`;

export type ModelReply = {
	replyNeeded: boolean;
	reason: string | null;
	body: string;
	intents: string[];
	documents: DocumentRequest[];
	conflicts: string[];
};

function nonEmpty(value: unknown): string | null {
	if (typeof value === 'string' && value.trim().length > 0) {
		return value.trim();
	}

	return null;
}

function readDocumentRequests(value: unknown): DocumentRequest[] {
	const requests: DocumentRequest[] = [];

	if (!Array.isArray(value)) {
		return requests;
	}

	for (const entry of value) {
		const candidate = entry as {
			document_id?: unknown;
			template_id?: unknown;
			missing_template?: unknown;
			change?: unknown;
		};

		if (typeof candidate.change !== 'string' || candidate.change.trim().length === 0) {
			continue;
		}

		requests.push({
			documentId: nonEmpty(candidate.document_id),
			templateId: nonEmpty(candidate.template_id),
			missingTemplate: nonEmpty(candidate.missing_template),
			change: candidate.change.trim()
		});
	}

	return requests;
}

/** A list of short lines from the model, e.g. intents or conflicts. Anything else is dropped. */
function readLines(value: unknown): string[] {
	const lines: string[] = [];

	if (!Array.isArray(value)) {
		return lines;
	}

	for (const entry of value) {
		const text = nonEmpty(entry);

		if (text !== null) {
			lines.push(text.slice(0, 500));
		}
	}

	return lines;
}

/** Reads the model's JSON. Anything that is not valid JSON is taken as the reply text itself. */
export function parseModelReply(raw: string): ModelReply {
	let text = raw.trim();
	text = text.replace(/^```(?:json)?\s*/i, '');
	text = text.replace(/\s*```$/, '');

	try {
		const parsed = JSON.parse(text) as {
			reply_needed?: unknown;
			reason?: unknown;
			body?: unknown;
			intents?: unknown;
			documents?: unknown;
			conflicts?: unknown;
		};
		let body = '';
		let reason: string | null = null;

		if (typeof parsed.body === 'string') {
			body = parsed.body.trim();
		}

		if (typeof parsed.reason === 'string') {
			reason = parsed.reason.trim();
		}

		return {
			replyNeeded: parsed.reply_needed !== false,
			reason,
			body,
			intents: readLines(parsed.intents),
			documents: readDocumentRequests(parsed.documents),
			conflicts: readLines(parsed.conflicts)
		};
	} catch {
		return {
			replyNeeded: true,
			reason: null,
			body: raw.trim(),
			intents: [],
			documents: [],
			conflicts: []
		};
	}
}

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

/** Subject and body of the emails being answered: what resources are searched with. */
function newMessagesText(rows: EmailRow[]): string {
	const parts: string[] = [];

	for (const row of rows) {
		parts.push(row.subject + '\n' + row.text);
	}

	return parts.join('\n');
}

type DraftOptions = {
	/** "Draft anyway": the model must write a reply even if it thinks none is needed. */
	force: boolean;
	instruction: string | null;
};

/** One model call for one incoming email, stored as a pending or skipped draft. */
async function writeDraft(
	contactRow: ContactRow,
	row: EmailRow,
	options: DraftOptions
): Promise<void> {
	const context = await buildDraftContext(contactRow, row, [row.id]);
	const picked = await searchResources(contactRow.userId, newMessagesText([row]));
	const files = await resourceFiles(picked);
	/** The document and template agents get the same background and files as the reply. */
	const background = context.text + '\n\n' + describeResources(picked);
	const templates = describeTemplates(await readyTemplates(contactRow.userId));
	let userContent =
		background + '\n\n' + (await describeDocuments(contactRow.id)) + '\n\n' + templates;

	if (options.instruction !== null && options.instruction.length > 0) {
		userContent = userContent + '\n\nThe user asked for this change: ' + options.instruction;
	}

	if (options.force) {
		userContent = userContent + '\n\nThe user asked for a draft, so reply_needed must be true.';
	}

	const raw = await recordAgentRun('drafting', row.id, () => {
		return callModel(
			'drafting',
			[
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: userContent }
			],
			files
		);
	});

	const reply = parseModelReply(raw);
	let needed = reply.replyNeeded;

	if (options.force) {
		needed = true;
	}

	if (needed && reply.body.length === 0) {
		throw new Error('The model returned an empty draft');
	}

	if (!needed) {
		await db.insert(draft).values({
			emailId: row.id,
			contactId: contactRow.id,
			status: 'skipped',
			reason: reply.reason,
			intents: reply.intents,
			coversEmailIds: [row.id],
			threadCut: context.threadCut
		});
		return;
	}

	const inserted = await db
		.insert(draft)
		.values({
			emailId: row.id,
			contactId: contactRow.id,
			status: 'pending',
			body: reply.body,
			placeholders: listPlaceholders(reply.body),
			reason: reply.reason,
			intents: reply.intents,
			coversEmailIds: [row.id],
			threadCut: context.threadCut,
			instruction: options.instruction,
			resources: usedResources(picked),
			conflicts: reply.conflicts
		})
		.returning();

	/** ponytail: one document at a time; run them in parallel if drafts with several get slow. */
	for (const request of reply.documents) {
		if (request.templateId !== null) {
			await generateFromTemplate(
				inserted[0],
				row,
				request,
				{ userId: contactRow.userId, contactName: contactRow.name },
				background,
				files
			);
		} else if (request.missingTemplate !== null) {
			await recordMissingTemplate(inserted[0], request);
		} else {
			await generateDocument(inserted[0], row, request, background, files);
		}
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

	await writeDraft(contactRow, row, { force: false, instruction: null });
}

/** "Draft anyway" and "Regenerate": replaces the email's open draft with a fresh one. */
export async function redraftEmail(
	userId: string,
	emailId: string,
	instruction: string | null
): Promise<void> {
	const row = await getOwnedEmail(userId, emailId);

	if (row === null) {
		throw new Error('Email not found');
	}

	const contactRow = await senderContact(userId, row);

	if (contactRow === null) {
		throw new Error('Drafts are only written for tracked people');
	}

	await writeDraft(contactRow, row, { force: true, instruction });
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

	for (let index = 0; index < pending.length; index++) {
		draftTexts.push('--- Draft ' + String(index + 1) + ' ---\n' + pending[index].body);
	}

	const context = await buildDraftContext(contactRow, latest, waitingIds);
	const picked = await searchResources(contactRow.userId, newMessagesText(waiting));
	const userContent =
		context.text +
		'\n\n' +
		describeResources(picked) +
		'\n\nA separate draft was written for each new message:\n\n' +
		draftTexts.join('\n\n') +
		'\n\nRewrite them as one reply that answers every new message. Keep every placeholder, each name once. reply_needed must be true.';

	const files = await resourceFiles(picked);
	const raw = await recordAgentRun('drafting.merge', latest.id, () => {
		return callModel(
			'drafting',
			[
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: userContent }
			],
			files
		);
	});

	const reply = parseModelReply(raw);

	if (reply.body.length === 0) {
		throw new Error('The model returned an empty draft');
	}

	await discardOpenDrafts(latest.id);
	const merged = await db
		.insert(draft)
		.values({
			emailId: latest.id,
			contactId: contactRow.id,
			status: 'pending',
			body: reply.body,
			placeholders: listPlaceholders(reply.body),
			reason: reply.reason,
			intents: reply.intents,
			coversEmailIds: waitingIds,
			threadCut: context.threadCut,
			resources: usedResources(picked),
			conflicts: reply.conflicts
		})
		.returning();

	const sourceIds: string[] = [];

	for (const source of pending) {
		sourceIds.push(source.id);
		await setDraftStatus(source.id, 'merged');
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
