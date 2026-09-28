import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { agentRun, email, mailAccount } from '$lib/server/db/schema';
import type { AgentRunSummary } from '$lib/types';

const MAX_OUTPUT_CHARS = 20000;

/** A step that returns the model's text keeps it for the log viewer. */
function outputOf(result: unknown): string | null {
	if (typeof result === 'string') {
		return result.slice(0, MAX_OUTPUT_CHARS);
	}

	return null;
}

/** Runs one agent step and records how long it took and whether it failed. Errors still propagate. */
export async function recordAgentRun<T>(
	agent: string,
	emailId: string | null,
	step: () => Promise<T>
): Promise<T> {
	const started = Date.now();

	try {
		const result = await step();
		await db.insert(agentRun).values({
			agent,
			emailId,
			ok: true,
			durationMs: Date.now() - started,
			output: outputOf(result)
		});
		return result;
	} catch (stepError) {
		let message = String(stepError);

		if (stepError instanceof Error) {
			message = stepError.message;
		}

		await db
			.insert(agentRun)
			.values({ agent, emailId, ok: false, durationMs: Date.now() - started, error: message });
		throw stepError;
	}
}

/** ponytail: the newest 30 runs are plenty for one draft; page it if people need older ones. */
const RUNS_SHOWN = 30;

/** The runs for a draft's emails, newest first, without their output (fetched when opened). */
export async function runsForEmails(emailIds: string[]): Promise<AgentRunSummary[]> {
	if (emailIds.length === 0) {
		return [];
	}

	const rows = await db
		.select()
		.from(agentRun)
		.where(inArray(agentRun.emailId, emailIds))
		.orderBy(desc(agentRun.createdAt))
		.limit(RUNS_SHOWN);
	const runs: AgentRunSummary[] = [];

	for (const row of rows) {
		runs.push({
			id: row.id,
			agent: row.agent,
			ok: row.ok,
			durationMs: row.durationMs,
			error: row.error,
			hasOutput: row.output !== null,
			createdAt: row.createdAt
		});
	}

	return runs;
}

/** A run's model output, only if its email belongs to one of the user's accounts. */
export async function getOwnedRunOutput(userId: string, runId: string): Promise<string | null> {
	const rows = await db
		.select({ output: agentRun.output })
		.from(agentRun)
		.innerJoin(email, eq(agentRun.emailId, email.id))
		.innerJoin(mailAccount, eq(email.accountId, mailAccount.id))
		.where(and(eq(agentRun.id, runId), eq(mailAccount.userId, userId)))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0].output;
}
