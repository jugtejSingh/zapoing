import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { contact, draft, email } from '$lib/server/db/schema';
import { describeDocuments } from '$lib/server/ai/agents/document';
import { describeTemplates } from '$lib/server/ai/agents/template';
import { buildDraftContext } from '$lib/server/ai/context/buildContext';
import { plannerGraph } from '$lib/server/ai/graph/graph';
import type { TurnContext } from '$lib/server/ai/graph/state';
import type { ModelMessage } from '$lib/server/ai/model';
import { addDraftMessage, listDraftMessages } from '$lib/server/draftChat';
import { getOwnedDraft } from '$lib/server/drafts';
import { describeResources, listResources } from '$lib/server/resources';
import { readyTemplates } from '$lib/server/templates';

export { parsePlannerAction } from '$lib/server/ai/agents/plannerActions';
export type { PlannerAction } from '$lib/server/ai/agents/plannerActions';

type DraftRow = typeof draft.$inferSelect;
type EmailRow = typeof email.$inferSelect;
type ContactRow = typeof contact.$inferSelect;

/** Above the planner's own step limit, so the graph never stops the planner before it stops itself. */
const RECURSION_LIMIT = 50;

/** Reads what the planner needs to know right now. The graph remembers the conversation; this is the world. */
async function buildTurn(
	draftRow: DraftRow,
	emailRow: EmailRow,
	contactRow: ContactRow,
	force: boolean
): Promise<TurnContext> {
	const context = await buildDraftContext(contactRow, emailRow, draftRow.coversEmailIds);
	const resources = await describeResources(await listResources(contactRow.userId));
	const workerBackground = context.text + '\n\n' + resources;
	const templates = describeTemplates(await readyTemplates(contactRow.userId));
	const documents = await describeDocuments(contactRow.id);

	return {
		draftId: draftRow.id,
		emailRow,
		contactRow,
		background: workerBackground + '\n\n' + documents + '\n\n' + templates,
		workerBackground,
		files: [],
		force
	};
}

/** One run of the graph on this draft's thread: resumes what it remembers and adds `added`. */
async function runGraph(turn: TurnContext, added: ModelMessage[]): Promise<void> {
	await plannerGraph.invoke(
		{ messages: added, action: null, steps: 0 },
		{ configurable: { thread_id: turn.draftId, turn }, recursionLimit: RECURSION_LIMIT }
	);
}

/**
 * A draft that was made before the graph existed has chat but no saved state.
 * Its chat so far is what the planner remembers.
 */
async function earlierChat(draftId: string): Promise<ModelMessage[]> {
	const saved = await plannerGraph.getState({ configurable: { thread_id: draftId } });
	const remembered = saved.values.messages as ModelMessage[] | undefined;

	if (remembered !== undefined && remembered.length > 0) {
		return [];
	}

	const chat: ModelMessage[] = [];

	for (const said of await listDraftMessages(draftId)) {
		chat.push({ role: said.role, content: said.content });
	}

	return chat;
}

/** The first run on a new draft: the planner reads the email and writes, asks, or skips. */
export async function startPlanner(
	draftRow: DraftRow,
	emailRow: EmailRow,
	contactRow: ContactRow,
	force: boolean,
	/** Drafts this one replaces (a merge): the planner starts from their text. */
	seed = ''
): Promise<void> {
	let note = 'A new email needs a reply. Write the first draft, or ask me for what you are missing.';

	if (force) {
		note = note + ' I asked for this draft, so do not skip it.';
	}

	if (seed.length > 0) {
		note = note + '\n\n' + seed;
	}

	const turn = await buildTurn(draftRow, emailRow, contactRow, force);

	await runGraph(turn, [{ role: 'user', content: note }]);
}

/** The user's chat message: stored, then the same planner that made the draft takes its turn. */
export async function chatWithPlanner(
	userId: string,
	draftId: string,
	message: string
): Promise<void> {
	const draftRow = await getOwnedDraft(userId, draftId);

	if (draftRow === null || draftRow.status !== 'pending') {
		throw new Error('Draft not found');
	}

	const emails = await db.select().from(email).where(eq(email.id, draftRow.emailId)).limit(1);
	const contacts = await db.select().from(contact).where(eq(contact.id, draftRow.contactId)).limit(1);

	if (emails.length === 0 || contacts.length === 0) {
		throw new Error('Draft not found');
	}

	const added = await earlierChat(draftId);
	added.push({ role: 'user', content: message });

	await addDraftMessage(draftId, 'user', message);

	const turn = await buildTurn(draftRow, emails[0], contacts[0], true);

	await runGraph(turn, added);
}
