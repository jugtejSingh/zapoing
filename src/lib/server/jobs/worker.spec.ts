import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { DATABASE_URL: ':memory:', CREDENTIALS_KEY: 'a'.repeat(64) }
}));

import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { job } from '$lib/server/db/schema';
import { migrateTestDb, resetTestDb } from '$lib/server/testing/testDb';
import { enqueueJob, MAX_ATTEMPTS, registerJobHandler, requestJobRun } from './worker';

async function jobRow(id: string): Promise<typeof job.$inferSelect> {
	const rows = await db.select().from(job).where(eq(job.id, id));
	return rows[0];
}

/** Skips the backoff wait so the next run picks the job up straight away. */
async function makeDueNow(id: string): Promise<void> {
	await db
		.update(job)
		.set({ runAt: new Date(Date.now() - 1000) })
		.where(eq(job.id, id));
}

beforeAll(() => {
	migrateTestDb();
});

beforeEach(async () => {
	delete (globalThis as { __zapoingJobWorker?: unknown }).__zapoingJobWorker;
	await resetTestDb();
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('job worker', () => {
	it('runs a pending job with its payload and marks it done', async () => {
		const seen: unknown[] = [];
		registerJobHandler('echo', async (payload) => {
			seen.push(payload);
		});

		const id = await enqueueJob('echo', { emailId: 'e1' });
		await requestJobRun();

		expect(seen).toEqual([{ emailId: 'e1' }]);
		const row = await jobRow(id);
		expect(row.status).toBe('done');
		expect(row.attempts).toBe(1);
	});

	it('puts a failed job back with a later runAt and the error', async () => {
		registerJobHandler('flaky', async () => {
			throw new Error('model timed out');
		});

		const id = await enqueueJob('flaky', {});
		const before = Date.now();
		await requestJobRun();

		const row = await jobRow(id);
		expect(row.status).toBe('pending');
		expect(row.attempts).toBe(1);
		expect(row.lastError).toBe('model timed out');
		expect(row.runAt.getTime()).toBeGreaterThan(before);
	});

	it('gives up after the last attempt', async () => {
		let calls = 0;
		registerJobHandler('broken', async () => {
			calls = calls + 1;
			throw new Error('nope');
		});

		const id = await enqueueJob('broken', {});

		for (let attempt = 0; attempt < MAX_ATTEMPTS + 2; attempt++) {
			await makeDueNow(id);
			await requestJobRun();
		}

		expect(calls).toBe(MAX_ATTEMPTS);
		const row = await jobRow(id);
		expect(row.status).toBe('failed');
		expect(row.attempts).toBe(MAX_ATTEMPTS);
		expect(row.lastError).toBe('nope');
	});

	it('fails a job nobody handles instead of retrying it', async () => {
		const id = await enqueueJob('unknown', {});
		await requestJobRun();

		const row = await jobRow(id);
		expect(row.status).toBe('failed');
		expect(row.lastError).toContain('unknown');
	});

	it('leaves jobs scheduled for later alone', async () => {
		let calls = 0;
		registerJobHandler('later', async () => {
			calls = calls + 1;
		});

		const id = await enqueueJob('later', {});
		await db
			.update(job)
			.set({ runAt: new Date(Date.now() + 60 * 1000) })
			.where(eq(job.id, id));
		await requestJobRun();

		expect(calls).toBe(0);
		expect((await jobRow(id)).status).toBe('pending');
	});
});
