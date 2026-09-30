import type { RunnableConfig } from '@langchain/core/runnables';
import { runTemplateAgent } from '$lib/server/ai/agents/templateAgent';
import { describeNewFiles, fileIds } from '$lib/server/ai/graph/draftRow';
import { turnOf, type PlannerStateValue, type PlannerUpdate } from '$lib/server/ai/graph/state';
import { keepLatestVersions, removeErroredSince } from '$lib/server/files/generated';

/**
 * The template agent: looks through the user's templates, reads the likely one and
 * fills it. When no template fits or the fill fails, the failed attempt is removed and
 * the document maker gets the request instead.
 */
export async function templateNode(
	state: PlannerStateValue,
	config: RunnableConfig
): Promise<PlannerUpdate> {
	const turn = turnOf(config);
	const action = state.action;

	if (action === null || action.action !== 'template') {
		return {};
	}

	const before = await fileIds(turn.draftId);
	const result = await runTemplateAgent(turn, action.request, state.templateMessages);

	if (result.filled) {
		await keepLatestVersions(turn.draftId);

		return {
			action: null,
			templateMessages: result.messages,
			messages: [{ role: 'user', content: 'Result: ' + (await describeNewFiles(turn.draftId, before)) }]
		};
	}

	await removeErroredSince(turn.draftId, before);

	return {
		templateMessages: result.messages,
		action: {
			action: 'document',
			request: {
				documentId: null,
				sourceResourceId: null,
				templateId: null,
				missingTemplate: action.request,
				spreadsheet: false,
				deliverAs: null,
				change: action.request
			}
		}
	};
}
