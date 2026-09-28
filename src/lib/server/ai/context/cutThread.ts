import { appendFile } from 'node:fs/promises';
import { threadCutLogPath } from '$lib/server/storage/paths';
import { stripQuotes } from './stripQuotes';

export type ThreadMessage = {
	id: string;
	from: string;
	date: Date | null;
	/** Plain-text body. Quotes are stripped by cutThread. */
	text: string;
};

export type ThreadCut = {
	kept: ThreadMessage[];
	droppedIds: string[];
	tokens: number;
};

/** The settings page, then THREAD_BUDGET_TOKENS, then 8000. */
export { threadBudgetTokens } from '$lib/server/ai/modelSettings';

/** ponytail: about 4 characters per token. Swap in a real tokenizer if the budget keeps overflowing. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function messageTokens(message: ThreadMessage): number {
	return estimateTokens(message.from) + estimateTokens(message.text);
}

/**
 * Fits a thread (oldest first) into the token budget. Quotes are stripped first.
 * The first message and the one being replied to always stay; the oldest of the
 * rest are dropped until the thread fits. The two pinned messages can still go
 * over the budget on their own, which is better than losing either.
 */
export function cutThread(
	messages: ThreadMessage[],
	replyToId: string,
	budgetTokens: number
): ThreadCut {
	const stripped: ThreadMessage[] = [];

	for (const message of messages) {
		stripped.push({ ...message, text: stripQuotes(message.text) });
	}

	let tokens = 0;

	for (const message of stripped) {
		tokens = tokens + messageTokens(message);
	}

	const droppedIds = new Set<string>();

	for (let index = 1; index < stripped.length; index++) {
		if (tokens <= budgetTokens) {
			break;
		}

		const message = stripped[index];

		if (message.id === replyToId) {
			continue;
		}

		droppedIds.add(message.id);
		tokens = tokens - messageTokens(message);
	}

	const kept: ThreadMessage[] = [];

	for (const message of stripped) {
		if (!droppedIds.has(message.id)) {
			kept.push(message);
		}
	}

	return { kept, droppedIds: Array.from(droppedIds), tokens };
}

/** Appends one JSON line per cut that dropped something, so over-long threads are easy to spot. */
export async function logThreadCut(
	agent: string,
	contactId: string,
	cut: ThreadCut
): Promise<void> {
	if (cut.droppedIds.length === 0) {
		return;
	}

	const keptIds: string[] = [];

	for (const message of cut.kept) {
		keptIds.push(message.id);
	}

	const entry = {
		at: new Date().toISOString(),
		agent,
		contactId,
		keptIds,
		droppedIds: cut.droppedIds,
		tokens: cut.tokens
	};

	await appendFile(await threadCutLogPath(), JSON.stringify(entry) + '\n', 'utf8');
}

/** A thread as prompt text, oldest first. Messages in `newIds` are marked [NEW MESSAGE]. */
export function formatThread(messages: ThreadMessage[], newIds: string[]): string {
	const parts: string[] = [];

	for (const message of messages) {
		let header = 'From: ' + message.from;

		if (message.date !== null) {
			header = header + '\nDate: ' + message.date.toISOString();
		}

		if (newIds.includes(message.id)) {
			header = '[NEW MESSAGE]\n' + header;
		}

		parts.push(header + '\n\n' + message.text);
	}

	return parts.join('\n\n---\n\n');
}
