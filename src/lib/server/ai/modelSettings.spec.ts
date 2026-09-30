import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
	return 'model-settings-spec-' + String(Date.now());
});

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const nodePath = await import('node:path');
	const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), dataDir));

	return {
		env: {
			MODEL_API_KEY: 'env-key',
			MODEL_BASE_URL: 'https://env.test/v1/',
			CREDENTIALS_KEY: 'a'.repeat(64),
			DATA_DIR: dir
		}
	};
});

import { cutThread } from '$lib/server/ai/context/cutThread';
import { callModel } from '$lib/server/ai/model';
import { modelSettingsPath } from '$lib/server/storage/paths';
import { load } from '../../../routes/settings/models/+page.server';
import {
	clearApiKey,
	modelConfig,
	ModelSettingsInputError,
	saveModelSettings,
	threadBudgetTokens
} from './modelSettings';

type LoadEvent = Parameters<typeof load>[0];

const fetchMock = vi.fn();

function blankInput() {
	return { apiKey: '', models: {}, threadBudgetTokens: '' };
}

beforeEach(async () => {
	await rm(modelSettingsPath(), { force: true });
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockImplementation(async () => {
		return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
			status: 200
		});
	});
});

describe('model settings', () => {
	it('falls back to the env, then the defaults', () => {
		expect(modelConfig('planner')).toEqual({
			apiKey: 'env-key',
			baseUrl: 'https://env.test/v1',
			model: 'z-ai/glm-5.3-flash'
		});
		expect(threadBudgetTokens()).toBe(8000);
	});

	it('encrypts the key on disk and never puts it in the page data', async () => {
		await saveModelSettings({ ...blankInput(), apiKey: 'sk-very-secret-9876' });

		expect(readFileSync(modelSettingsPath(), 'utf8')).not.toContain('sk-very-secret');
		expect(modelConfig('memory').apiKey).toBe('sk-very-secret-9876');

		const data = await load({ locals: { user: { id: 'u1' } } } as unknown as LoadEvent);

		expect(JSON.stringify(data)).not.toContain('sk-very-secret');
		expect(data).toMatchObject({ settings: { keySource: 'settings', keyEnding: '9876' } });

		// A blank key keeps the saved one.
		await saveModelSettings(blankInput());
		expect(modelConfig('memory').apiKey).toBe('sk-very-secret-9876');

		await clearApiKey();
		expect(modelConfig('memory').apiKey).toBe('env-key');
	});

	it('sends calls to the per-agent model', async () => {
		await saveModelSettings({
			apiKey: 'sk-other',
			models: { planner: 'big-model' },
			threadBudgetTokens: ''
		});

		await callModel('planner', [{ role: 'user', content: 'hello' }]);
		await callModel('memory', [{ role: 'user', content: 'hello' }]);

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://env.test/v1/chat/completions');
		expect(init.headers.Authorization).toBe('Bearer sk-other');
		expect(JSON.parse(init.body).model).toBe('big-model');
		expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe('z-ai/glm-5.3-flash');
	});

	it('changes where the thread is cut', async () => {
		const thread = [];

		for (let index = 0; index < 5; index++) {
			thread.push({ id: 'm' + String(index), from: '', date: null, text: 'x'.repeat(4000) });
		}

		expect(cutThread(thread, 'm4', threadBudgetTokens()).droppedIds).toEqual([]);

		await saveModelSettings({ ...blankInput(), threadBudgetTokens: '2000' });

		expect(threadBudgetTokens()).toBe(2000);
		expect(cutThread(thread, 'm4', threadBudgetTokens()).droppedIds).toEqual(['m1', 'm2', 'm3']);
	});

	it('rejects budgets out of range and keys with spaces, saving nothing', async () => {
		const bad = [
				{ ...blankInput(), threadBudgetTokens: '500' },
			{ ...blankInput(), apiKey: 'has a space' }
		];

		for (const input of bad) {
			await expect(saveModelSettings(input)).rejects.toBeInstanceOf(ModelSettingsInputError);
		}

	});
});
