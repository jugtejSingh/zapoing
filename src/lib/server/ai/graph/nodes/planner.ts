import type { RunnableConfig } from '@langchain/core/runnables';
import { recordAgentRun } from '$lib/server/ai/agentRun';
import {
	MAX_STEPS,
	PLANNER_PROMPT,
	parsePlannerAction
} from '$lib/server/ai/agents/plannerActions';
import { describeState, loadDraft, updateDraft } from '$lib/server/ai/graph/draftRow';
import { turnOf, type PlannerStateValue, type PlannerUpdate } from '$lib/server/ai/graph/state';
import { callModel, type ModelMessage } from '$lib/server/ai/model';
import { addDraftMessage } from '$lib/server/draftChat';

/**
 * The planner: reads the draft and everything it remembers, and picks the next action.
 * "say" is the chat answer and ends the run; a worker action is how the draft changes.
 */
export async function plannerNode(
	state: PlannerStateValue,
	config: RunnableConfig
): Promise<PlannerUpdate> {
	const turn = turnOf(config);

	if (state.steps >= MAX_STEPS) {
		const message =
			'I stopped after ' + String(MAX_STEPS) + ' steps. The draft is as it stands. Tell me what to change.';
		await addDraftMessage(turn.draftId, 'assistant', message);

		return { action: { action: 'say', message } };
	}

	const draftRow = await loadDraft(turn.draftId);
	const known = turn.background + '\n\n' + (await describeState(draftRow));

	const messages: ModelMessage[] = [
		{ role: 'system', content: PLANNER_PROMPT },
		{ role: 'user', content: known }
	];

	for (const message of state.messages) {
		messages.push(message);
	}

	const raw = await recordAgentRun('planner', turn.emailRow.id, () => {
		return callModel('planner', messages, turn.files);
	});
	const next = parsePlannerAction(raw);
	const remembered: ModelMessage[] = [{ role: 'assistant', content: raw }];

	if (next.action === 'say') {
		await addDraftMessage(turn.draftId, 'assistant', next.message);

		return { messages: remembered, action: next, steps: state.steps + 1 };
	}

	if (next.action === 'skip' && turn.force) {
		remembered.push({
			role: 'user',
			content: 'Result: the user asked for a draft, so do not skip.'
		});

		return { messages: remembered, action: null, steps: state.steps + 1 };
	}

	if (next.action === 'skip') {
		await updateDraft(turn.draftId, { status: 'skipped', reason: next.reason });
	}

	return { messages: remembered, action: next, steps: state.steps + 1 };
}
