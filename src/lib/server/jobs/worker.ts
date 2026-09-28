import { and, asc, eq, lte } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { job } from '$lib/server/db/schema';

const POLL_INTERVAL_MS = 5 * 1000;
export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30 * 1000;

export type JobHandler = (payload: unknown) => Promise<void>;

type WorkerState = {
	timer: ReturnType<typeof setInterval> | null;
	running: Promise<void> | null;
	/** Work was asked for while a run was going, so run again when it ends. */
	rerun: boolean;
	handlers: Map<string, JobHandler>;
};

/** Kept on globalThis so Vite's hot reload in dev reuses the one worker. */
const globalWithWorker = globalThis as typeof globalThis & { __zapoingJobWorker?: WorkerState };

function workerState(): WorkerState {
	if (!globalWithWorker.__zapoingJobWorker) {
		globalWithWorker.__zapoingJobWorker = {
			timer: null,
			running: null,
			rerun: false,
			handlers: new Map()
		};
	}

	return globalWithWorker.__zapoingJobWorker;
}

export function registerJobHandler(type: string, handler: JobHandler): void {
	workerState().handlers.set(type, handler);
}

/** Stores the job, then nudges the runner if it is started so the job does not wait for the next poll. */
export async function enqueueJob(type: string, payload: unknown): Promise<string> {
	/** runAt comes from the JS clock, the same one claimNextJob compares against; SQLite's clock can be a few ms ahead. */
	const inserted = await db
		.insert(job)
		.values({ type, payload, runAt: new Date() })
		.returning({ id: job.id });

	if (workerState().timer) {
		void requestJobRun();
	}

	return inserted[0].id;
}

/** Delay before retry number `attempts`: 30s, 60s, 120s, ... */
function backoffMs(attempts: number): number {
	return BASE_BACKOFF_MS * Math.pow(2, attempts - 1);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

/** Takes the oldest due pending job and marks it running, or returns null when none is due. */
async function claimNextJob(): Promise<typeof job.$inferSelect | null> {
	const due = await db
		.select()
		.from(job)
		.where(and(eq(job.status, 'pending'), lte(job.runAt, new Date())))
		.orderBy(asc(job.runAt))
		.limit(1);

	if (due.length === 0) {
		return null;
	}

	/** ponytail: one process, one runner, so select-then-update cannot race. Needs a single UPDATE ... RETURNING if a second runner ever exists. */
	await db.update(job).set({ status: 'running' }).where(eq(job.id, due[0].id));

	return due[0];
}

async function runOneJob(state: WorkerState, claimed: typeof job.$inferSelect): Promise<void> {
	const attempts = claimed.attempts + 1;
	const handler = state.handlers.get(claimed.type);

	if (!handler) {
		await db
			.update(job)
			.set({ status: 'failed', attempts, lastError: 'No handler for job type ' + claimed.type })
			.where(eq(job.id, claimed.id));
		return;
	}

	try {
		await handler(claimed.payload);
		await db.update(job).set({ status: 'done', attempts, lastError: null }).where(eq(job.id, claimed.id));
	} catch (error) {
		console.error('Job ' + claimed.id + ' (' + claimed.type + ') failed', error);

		if (attempts >= MAX_ATTEMPTS) {
			await db
				.update(job)
				.set({ status: 'failed', attempts, lastError: errorMessage(error) })
				.where(eq(job.id, claimed.id));
		} else {
			await db
				.update(job)
				.set({
					status: 'pending',
					attempts,
					lastError: errorMessage(error),
					runAt: new Date(Date.now() + backoffMs(attempts))
				})
				.where(eq(job.id, claimed.id));
		}
	}
}

/** ponytail: one job at a time. Run several in parallel if AI calls pile up. */
async function runDueJobs(state: WorkerState): Promise<void> {
	let claimed = await claimNextJob();

	while (claimed) {
		await runOneJob(state, claimed);
		claimed = await claimNextJob();
	}
}

async function runUntilSettled(state: WorkerState): Promise<void> {
	try {
		do {
			state.rerun = false;
			await runDueJobs(state);
		} while (state.rerun);
	} finally {
		state.running = null;
	}
}

/** Runs every due job now, unless a run is going — then it queues one more pass. */
export function requestJobRun(): Promise<void> {
	const state = workerState();

	if (state.running) {
		state.rerun = true;
		return state.running;
	}

	state.running = runUntilSettled(state);
	return state.running;
}

/**
 * Puts back jobs a previous process was running when it stopped, then polls
 * every 5 seconds. Only runs while the Node server is up.
 */
export async function startJobWorker(): Promise<void> {
	const state = workerState();

	if (state.timer) {
		return;
	}

	state.timer = setInterval(() => {
		void requestJobRun();
	}, POLL_INTERVAL_MS);

	await db.update(job).set({ status: 'pending' }).where(eq(job.status, 'running'));
	void requestJobRun();
}
