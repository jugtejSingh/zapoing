import type { RunnableConfig } from '@langchain/core/runnables';
import { generateDocument } from '$lib/server/ai/agents/document';
import { describeNewFiles, fileIds, loadDraft } from '$lib/server/ai/graph/draftRow';
import { turnOf, type PlannerStateValue, type PlannerUpdate } from '$lib/server/ai/graph/state';
import { keepLatestVersions, removeErroredSince } from '$lib/server/files/generated';

/**
 * The financial agent: new or changed spreadsheets, with its own model. If it fails,
 * its failed attempt is removed and the document maker gets the same request.
 */
export async function financialNode(
	state: PlannerStateValue,
	config: RunnableConfig
): Promise<PlannerUpdate> {
	const turn = turnOf(config);
	const action = state.action;

	if (action === null || action.action !== 'financial') {
		return {};
	}

	const before = await fileIds(turn.draftId);
	const current = await loadDraft(turn.draftId);
	const request = { ...action.request, spreadsheet: true };

	await generateDocument(current, turn.emailRow, request, turn.workerBackground, turn.files, {
		agent: 'financial',
		userId: turn.contactRow.userId
	});

	const result = await describeNewFiles(turn.draftId, before);

	if (result.includes(' FAILED: ') || result === 'No file was made.') {
		await removeErroredSince(turn.draftId, before);

		return { action: { action: 'document', request } };
	}

	await keepLatestVersions(turn.draftId);

	return { action: null, messages: [{ role: 'user', content: 'Result: ' + result }] };
}
