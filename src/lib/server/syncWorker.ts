import { listAllMailAccountCredentials } from '$lib/server/mailAccount';
import { syncAccount } from '$lib/server/mailSync';
import type { SyncStatus } from '$lib/types';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** Gives the dev server a moment to finish booting before the backfill hogs the event loop. */
const FIRST_RUN_DELAY_MS = 5 * 1000;

type WorkerState = {
	timer: ReturnType<typeof setInterval> | null;
	running: Promise<void> | null;
	/** A sync was asked for while one was running, so run again when it ends. */
	rerun: boolean;
	statuses: Map<string, SyncStatus>;
};

/**
 * Kept on globalThis so Vite's hot reload in dev reuses the one worker instead
 * of starting a second one that syncs the same mailboxes at the same time.
 */
const globalWithWorker = globalThis as typeof globalThis & { __zapoingSyncWorker?: WorkerState };

function workerState(): WorkerState {
	if (!globalWithWorker.__zapoingSyncWorker) {
		globalWithWorker.__zapoingSyncWorker = {
			timer: null,
			running: null,
			rerun: false,
			statuses: new Map()
		};
	}

	return globalWithWorker.__zapoingSyncWorker;
}

/** Syncs accounts one at a time. One failing account does not stop the rest. */
async function syncAllAccounts(state: WorkerState): Promise<void> {
	const accounts = await listAllMailAccountCredentials();

	for (const account of accounts) {
		const status: SyncStatus = {
			accountId: account.id,
			syncing: true,
			done: 0,
			total: 0,
			error: null
		};

		const previous = state.statuses.get(account.id);

		if (previous) {
			status.done = previous.done;
			status.total = previous.total;
		}

		state.statuses.set(account.id, status);

		try {
			await syncAccount(account, (done, total) => {
				status.done = done;
				status.total = total;
			});
		} catch (error) {
			console.error('Mail sync failed for account ' + account.id, error);
			status.error = 'Could not reach this mailbox. Showing the last messages we have.';
		} finally {
			status.syncing = false;
		}
	}
}

async function runUntilSettled(state: WorkerState): Promise<void> {
	try {
		do {
			state.rerun = false;
			await syncAllAccounts(state);
		} while (state.rerun);
	} finally {
		state.running = null;
	}
}

/**
 * Starts a sync of every account now, unless one is already running — then it
 * queues one more pass for when that finishes. Never runs two at once.
 */
export function requestSync(): Promise<void> {
	const state = workerState();

	if (state.running) {
		state.rerun = true;
		return state.running;
	}

	state.running = runUntilSettled(state);
	return state.running;
}

/** Syncs once shortly after boot (the first run backfills everything), then every 5 minutes. */
export function startSyncWorker(): void {
	const state = workerState();

	if (state.timer) {
		return;
	}

	setTimeout(() => {
		void requestSync();
	}, FIRST_RUN_DELAY_MS);

	state.timer = setInterval(() => {
		void requestSync();
	}, SYNC_INTERVAL_MS);
}

/** Latest sync status per account, for the sidebar. */
export function getSyncStatuses(): SyncStatus[] {
	const statuses: SyncStatus[] = [];

	for (const status of workerState().statuses.values()) {
		statuses.push({ ...status });
	}

	return statuses;
}
