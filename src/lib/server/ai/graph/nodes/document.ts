import type { RunnableConfig } from '@langchain/core/runnables';
import { generateDocument } from '$lib/server/ai/agents/document';
import { describeNewFiles, fileIds, loadDraft } from '$lib/server/ai/graph/draftRow';
import { turnOf, type PlannerStateValue, type PlannerUpdate } from '$lib/server/ai/graph/state';
import { keepLatestVersions } from '$lib/server/files/generated';

/** The document maker: changes or writes a document and attaches it to the draft. */
export async function documentNode(
	state: PlannerStateValue,
	config: RunnableConfig
): Promise<PlannerUpdate> {
	const turn = turnOf(config);
	const action = state.action;

	if (action === null || action.action !== 'document') {
		return {};
	}

	const before = await fileIds(turn.draftId);
	const current = await loadDraft(turn.draftId);

	await generateDocument(current, turn.emailRow, action.request, turn.workerBackground, turn.files, {
		userId: turn.contactRow.userId
	});
	await keepLatestVersions(turn.draftId);

	return {
		action: null,
		messages: [
			{ role: 'user', content: 'Result: ' + (await describeNewFiles(turn.draftId, before)) }
		]
	};
}
