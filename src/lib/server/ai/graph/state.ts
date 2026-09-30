import { Annotation } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { contact, email } from '$lib/server/db/schema';
import type { PlannerAction } from '$lib/server/ai/agents/plannerActions';
import type { ModelFile, ModelMessage } from '$lib/server/ai/model';

/**
 * What the graph remembers for one draft (the checkpoint thread is the draft id).
 * Only plain data lives here: it is saved to disk after every step.
 */
export const PlannerState = Annotation.Root({
	/** The planner's working conversation: user turns, its own actions, and worker results. It only grows. */
	messages: Annotation<ModelMessage[]>({
		reducer: (existing, added) => existing.concat(added),
		default: () => []
	}),
	/** The template agent's own conversation, apart from the planner's, so a revision resumes what it read. */
	templateMessages: Annotation<ModelMessage[]>({
		reducer: (existing, added) => existing.concat(added),
		default: () => []
	}),
	/** The planner's latest decision, read by the router. null sends the planner around again. */
	action: Annotation<PlannerAction | null>({
		reducer: (_existing, added) => added,
		default: () => null
	}),
	/** Planner calls in the current run, so a planner that keeps calling workers is stopped. Reset by each run. */
	steps: Annotation<number>({
		reducer: (_existing, added) => added,
		default: () => 0
	})
});

export type PlannerStateValue = typeof PlannerState.State;
export type PlannerUpdate = typeof PlannerState.Update;

/**
 * Rebuilt for every run and passed as `configurable.turn`. Rows and file bytes do not
 * belong in the checkpoint: they are read fresh, so the planner always sees the truth.
 */
export type TurnContext = {
	draftId: string;
	emailRow: typeof email.$inferSelect;
	contactRow: typeof contact.$inferSelect;
	/** Thread, memory, resources, documents and templates as text. */
	background: string;
	/** Only the thread, memory and resources part of `background`, which the workers get. */
	workerBackground: string;
	files: ModelFile[];
	/** The user asked for a draft, so "skip" is not allowed. */
	force: boolean;
};

export function turnOf(config: RunnableConfig): TurnContext {
	const turn = config.configurable?.turn as TurnContext | undefined;

	if (turn === undefined) {
		throw new Error('The planner graph was run without a turn');
	}

	return turn;
}
