import { END, START, StateGraph } from '@langchain/langgraph';
import { checkpointer } from '$lib/server/ai/graph/checkpointer';
import { documentNode } from '$lib/server/ai/graph/nodes/document';
import { financialNode } from '$lib/server/ai/graph/nodes/financial';
import { plannerNode } from '$lib/server/ai/graph/nodes/planner';
import { readFileNode } from '$lib/server/ai/graph/nodes/readFile';
import { replyWriterNode } from '$lib/server/ai/graph/nodes/replyWriter';
import { templateNode } from '$lib/server/ai/graph/nodes/template';
import { PlannerState, type PlannerStateValue } from '$lib/server/ai/graph/state';

/** Where the planner's decision sends the run: to a worker, back to itself, or out. */
function routeAfterPlanner(state: PlannerStateValue): string {
	const action = state.action;

	if (action === null) {
		return 'planner';
	}

	if (action.action === 'draft_reply') {
		return 'replyWriter';
	}

	if (action.action === 'document') {
		return 'document';
	}

	if (action.action === 'template') {
		return 'template';
	}

	if (action.action === 'financial') {
		return 'financial';
	}

	if (action.action === 'read_file') {
		return 'readFile';
	}

	/** "say" is the chat answer and "skip" leaves no draft: both end the run. */
	return END;
}

/** After the template or financial agent: a leftover action is the document maker's fallback. */
function routeAfterSpecialist(state: PlannerStateValue): string {
	if (state.action === null) {
		return 'planner';
	}

	return 'document';
}

/**
 * One graph for every draft. A draft is one thread of it: the first email starts the
 * thread, and every chat message resumes it, so the planner that wrote the draft is
 * the one that edits it. Workers always report back to the planner.
 */
export const plannerGraph = new StateGraph(PlannerState)
	.addNode('planner', plannerNode)
	.addNode('replyWriter', replyWriterNode)
	.addNode('document', documentNode)
	.addNode('template', templateNode)
	.addNode('financial', financialNode)
	.addNode('readFile', readFileNode)
	.addEdge(START, 'planner')
	.addConditionalEdges('planner', routeAfterPlanner, {
		planner: 'planner',
		replyWriter: 'replyWriter',
		document: 'document',
		template: 'template',
		financial: 'financial',
		readFile: 'readFile',
		[END]: END
	})
	.addConditionalEdges('template', routeAfterSpecialist, {
		planner: 'planner',
		document: 'document'
	})
	.addConditionalEdges('financial', routeAfterSpecialist, {
		planner: 'planner',
		document: 'document'
	})
	.addEdge('replyWriter', 'planner')
	.addEdge('document', 'planner')
	.addEdge('readFile', 'planner')
	.compile({ checkpointer });
