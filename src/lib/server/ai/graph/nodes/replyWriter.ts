import type { RunnableConfig } from '@langchain/core/runnables';
import { writeReply } from '$lib/server/ai/agents/replyWriter';
import { loadDraft, updateDraft } from '$lib/server/ai/graph/draftRow';
import { turnOf, type PlannerStateValue, type PlannerUpdate } from '$lib/server/ai/graph/state';

/** The message writer: writes or edits the reply text, and stores it on the draft. */
export async function replyWriterNode(
	state: PlannerStateValue,
	config: RunnableConfig
): Promise<PlannerUpdate> {
	const turn = turnOf(config);
	const action = state.action;

	if (action === null || action.action !== 'draft_reply') {
		return {};
	}

	const current = await loadDraft(turn.draftId);
	const reply = await writeReply({
		emailId: turn.emailRow.id,
		background: turn.workerBackground,
		brief: action.brief,
		currentBody: current.body,
		files: turn.files
	});

	if (reply.body.length === 0) {
		return {
			action: null,
			messages: [{ role: 'user', content: 'Result: the message writer returned an empty reply.' }]
		};
	}

	await updateDraft(turn.draftId, {
		body: reply.body,
		reason: reply.reason,
		conflicts: reply.conflicts
	});

	return {
		action: null,
		messages: [{ role: 'user', content: 'Result: the draft is now:\n' + reply.body }]
	};
}
