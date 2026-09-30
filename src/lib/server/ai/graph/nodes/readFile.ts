import type { RunnableConfig } from '@langchain/core/runnables';
import { readFileText } from '$lib/server/ai/graph/readFile';
import { turnOf, type PlannerStateValue, type PlannerUpdate } from '$lib/server/ai/graph/state';

/** Gives the planner the read text of a resource or an earlier attachment, then hands back to it. */
export async function readFileNode(
	state: PlannerStateValue,
	config: RunnableConfig
): Promise<PlannerUpdate> {
	const turn = turnOf(config);
	const action = state.action;

	if (action === null || action.action !== 'read_file') {
		return {};
	}

	const text = await readFileText(turn.contactRow.userId, turn.contactRow.id, action.id);

	return { action: null, messages: [{ role: 'user', content: text }] };
}
