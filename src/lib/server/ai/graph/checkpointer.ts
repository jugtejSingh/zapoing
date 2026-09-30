import path from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { env } from '$env/dynamic/private';

/**
 * The graph's saved state lives in its own file next to the main database, so
 * drizzle migrations never see it. Specs run on ':memory:' and get the same.
 */
function checkpointPath(): string {
	const databaseUrl = env.DATABASE_URL ?? '';

	if (databaseUrl === ':memory:' || databaseUrl.length === 0) {
		return ':memory:';
	}

	return path.join(path.dirname(databaseUrl), 'checkpoints.db');
}

export const checkpointer = SqliteSaver.fromConnString(checkpointPath());

/** Forgets a draft's graph state, once the draft is sent or discarded and its chat is over. */
export async function forgetDraftState(draftId: string): Promise<void> {
	await checkpointer.deleteThread(draftId);
}
