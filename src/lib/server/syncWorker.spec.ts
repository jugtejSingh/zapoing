import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailAccountCredentials } from './mailAccount';
import type { SyncProgress } from './mailSync';

const accounts: MailAccountCredentials[] = [];
const syncAccount =
	vi.fn<(account: MailAccountCredentials, onProgress?: SyncProgress) => Promise<void>>();

vi.mock('./mailAccount', () => ({
	listAllMailAccountCredentials: async () => accounts
}));

vi.mock('./mailSync', () => ({
	syncAccount: (account: MailAccountCredentials, onProgress?: SyncProgress) =>
		syncAccount(account, onProgress)
}));

import { getSyncStatuses, requestSync } from './syncWorker';

function makeAccount(id: string): MailAccountCredentials {
	return {
		id,
		host: 'imap.example.com',
		port: 993,
		secure: true,
		username: id,
		password: 'x',
		smtpHost: null,
		smtpPort: null
	};
}

beforeEach(() => {
	delete (globalThis as { __zapoingSyncWorker?: unknown }).__zapoingSyncWorker;
	accounts.length = 0;
	syncAccount.mockReset();
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('requestSync', () => {
	it('never runs two syncs at once, and runs once more if asked mid-sync', async () => {
		accounts.push(makeAccount('a'));

		let active = 0;
		let maxActive = 0;
		let releaseFirst: () => void = () => {};

		syncAccount.mockImplementation(async () => {
			active = active + 1;
			maxActive = Math.max(maxActive, active);

			if (syncAccount.mock.calls.length === 1) {
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
			}

			active = active - 1;
		});

		const first = requestSync();

		await vi.waitFor(() => {
			expect(syncAccount).toHaveBeenCalledTimes(1);
		});

		const second = requestSync();
		const third = requestSync();

		expect(second).toBe(first);
		expect(third).toBe(first);

		releaseFirst();
		await first;

		expect(maxActive).toBe(1);
		/** The first run, plus one catch-up run for however many asks came in during it. */
		expect(syncAccount).toHaveBeenCalledTimes(2);
	});

	it('keeps syncing the other accounts when one fails, and reports the failure', async () => {
		accounts.push(makeAccount('broken'));
		accounts.push(makeAccount('fine'));

		syncAccount.mockImplementation(async (account) => {
			if (account.id === 'broken') {
				throw new Error('auth failed');
			}
		});

		await requestSync();

		expect(syncAccount).toHaveBeenCalledTimes(2);

		const errors: Record<string, string | null> = {};

		for (const status of getSyncStatuses()) {
			expect(status.syncing).toBe(false);
			errors[status.accountId] = status.error;
		}

		expect(errors.broken).toContain('Could not reach this mailbox');
		expect(errors.fine).toBe(null);
	});

	it('exposes progress while an account is syncing', async () => {
		accounts.push(makeAccount('a'));

		let seenMidSync: ReturnType<typeof getSyncStatuses> = [];

		syncAccount.mockImplementation(async (_account, onProgress) => {
			if (onProgress) {
				onProgress(100, 250);
			}

			seenMidSync = getSyncStatuses();
		});

		await requestSync();

		expect(seenMidSync).toEqual([
			{ accountId: 'a', syncing: true, done: 100, total: 250, error: null }
		]);
	});
});
