import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { MODEL_API_KEY: 'test-key', MODEL_BASE_URL: 'https://model.test/v1/' }
}));

import { callModel } from './model';

const fetchMock = vi.fn();

function okReply(text: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
}

function sentBody(): { model: string; messages: { role: string; content: unknown }[] } {
	const init = fetchMock.mock.calls[0][1] as RequestInit;
	return JSON.parse(init.body as string);
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

describe('callModel', () => {
	it('posts to the configured endpoint with the key and returns the reply text', async () => {
		fetchMock.mockResolvedValue(okReply('hello'));

		const reply = await callModel('planner', [{ role: 'user', content: 'hi' }]);

		expect(reply).toBe('hello');
		expect(fetchMock.mock.calls[0][0]).toBe('https://model.test/v1/chat/completions');
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
		expect(sentBody().model).toBe('z-ai/glm-5.3-flash');
		expect(sentBody().messages).toEqual([{ role: 'user', content: 'hi' }]);
	});

	it('attaches allowed files and never sends disallowed ones', async () => {
		fetchMock.mockResolvedValue(okReply('ok'));
		const bytes = new Uint8Array([1, 2, 3]);

		await callModel(
			'document',
			[
				{ role: 'system', content: 'be brief' },
				{ role: 'user', content: 'read these' }
			],
			[
				{ filename: 'contract.pdf', mime: 'application/pdf', content: bytes },
				{ filename: 'photo.png', mime: 'image/png', content: bytes },
				{ filename: 'setup.exe', mime: 'application/x-msdownload', content: bytes }
			]
		);

		const raw = (fetchMock.mock.calls[0][1] as RequestInit).body as string;
		expect(raw).not.toContain('setup.exe');
		expect(sentBody().messages).toEqual([
			{ role: 'system', content: 'be brief' },
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'read these' },
					{ type: 'file', file: { filename: 'contract.pdf', file_data: 'data:application/pdf;base64,AQID' } },
					{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }
				]
			}
		]);
	});

	it('throws with the status when the model call fails', async () => {
		fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));

		await expect(callModel('memory', [{ role: 'user', content: 'hi' }])).rejects.toThrow(
			'Model call failed (429): rate limited'
		);
	});
});
