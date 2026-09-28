import { isReadableByAI } from '$lib/server/files/allowlist';
import { modelConfig, type Agent } from '$lib/server/ai/modelSettings';

export type { Agent };

export type ModelMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

export type ModelFile = {
	filename: string;
	mime: string;
	content: Uint8Array;
};

type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } }
	| { type: 'file'; file: { filename: string; file_data: string } };

function dataUrl(file: ModelFile): string {
	return 'data:' + file.mime + ';base64,' + Buffer.from(file.content).toString('base64');
}

function filePart(file: ModelFile): ContentPart {
	if (file.mime.startsWith('image/')) {
		return { type: 'image_url', image_url: { url: dataUrl(file) } };
	}

	return { type: 'file', file: { filename: file.filename, file_data: dataUrl(file) } };
}

/**
 * Builds the OpenAI-style message list. Allowed files are attached to the
 * last user message; every other file is dropped here and never leaves the machine.
 */
function buildMessages(messages: ModelMessage[], files: ModelFile[]): unknown[] {
	const parts: ContentPart[] = [];

	for (const file of files) {
		if (isReadableByAI(file.filename, file.mime)) {
			parts.push(filePart(file));
		}
	}

	let lastUserIndex = -1;

	for (let index = 0; index < messages.length; index++) {
		if (messages[index].role === 'user') {
			lastUserIndex = index;
		}
	}

	const built: unknown[] = [];

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];

		if (index === lastUserIndex && parts.length > 0) {
			const content: ContentPart[] = [{ type: 'text', text: message.content }];

			for (const part of parts) {
				content.push(part);
			}

			built.push({ role: message.role, content });
		} else {
			built.push({ role: message.role, content: message.content });
		}
	}

	return built;
}

/** The one way anything talks to the model. Returns the reply text. */
export async function callModel(
	agent: Agent,
	messages: ModelMessage[],
	files: ModelFile[] = []
): Promise<string> {
	const config = modelConfig(agent);

	if (config.apiKey === null) {
		throw new Error('No model API key: add one in Settings → Models or set MODEL_API_KEY');
	}

	const response = await fetch(config.baseUrl + '/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: 'Bearer ' + config.apiKey
		},
		body: JSON.stringify({
			model: config.model,
			messages: buildMessages(messages, files)
		})
	});

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 500);
		throw new Error('Model call failed (' + response.status + '): ' + detail);
	}

	const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
	const content = data.choices?.[0]?.message?.content;

	if (typeof content !== 'string') {
		throw new Error('Model reply had no text');
	}

	return content;
}
