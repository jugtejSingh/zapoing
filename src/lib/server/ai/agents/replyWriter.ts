import { recordAgentRun } from '$lib/server/ai/agentRun';
import { callModel, type ModelFile } from '$lib/server/ai/model';

export const REPLY_PROMPT = `You write email replies for the user, in their voice.
Return JSON only, with no code fence: {"reason": "one short line", "body": "the reply", "conflicts": []}

Rules for the reply:
- Answer every question and request in the [NEW MESSAGE] emails, in the order they were asked.
- Any date, time, price, number, commitment or fact that is not in the profile, summary or thread becomes a placeholder like [[start-time]], [[price]] or [[signing-date]]. Short, self-explanatory names. The same fact uses the same name. Never guess.
- Never agree to terms or make commitments on the user's behalf; use a placeholder instead.
- Follow the user's tone, length and sign-off, adjusted to how formal the person is.
- Plain text, no subject line. As short as a person would write it.

Resources:
- [RESOURCES] lists the user's own reference files (prices, terms, company facts) by description. Facts the brief quotes from them may be used without a placeholder.
- When two resources disagree, use the newest one and add a short line to "conflicts", e.g. "Pricing 2025 says 40 EUR/h, Pricing 2026 says 45 EUR/h; used Pricing 2026". Otherwise "conflicts" is [].`;

export type ModelReply = {
	reason: string | null;
	body: string;
	conflicts: string[];
};

function nonEmpty(value: unknown): string | null {
	if (typeof value === 'string' && value.trim().length > 0) {
		return value.trim();
	}

	return null;
}

/** A list of short lines from the model, e.g. conflicts. Anything else is dropped. */
function readLines(value: unknown): string[] {
	const lines: string[] = [];

	if (!Array.isArray(value)) {
		return lines;
	}

	for (const entry of value) {
		const text = nonEmpty(entry);

		if (text !== null) {
			lines.push(text.slice(0, 500));
		}
	}

	return lines;
}

/** Reads the model's JSON. Anything that is not valid JSON is taken as the reply text itself. */
export function parseModelReply(raw: string): ModelReply {
	let text = raw.trim();
	text = text.replace(/^```(?:json)?\s*/i, '');
	text = text.replace(/\s*```$/, '');

	try {
		const parsed = JSON.parse(text) as {
			reason?: unknown;
			body?: unknown;
			conflicts?: unknown;
		};
		let body = '';
		let reason: string | null = null;

		if (typeof parsed.body === 'string') {
			body = parsed.body.trim();
		}

		if (typeof parsed.reason === 'string') {
			reason = parsed.reason.trim();
		}

		return {
			reason,
			body,
			conflicts: readLines(parsed.conflicts)
		};
	} catch {
		return {
			reason: null,
			body: raw.trim(),
			conflicts: []
		};
	}
}

export type ReplyInput = {
	emailId: string;
	/** Thread, memory, resources, documents and templates, already built by the caller. */
	background: string;
	/** What the planner wants written or changed. */
	brief: string;
	/** The draft being changed, so the brief edits it instead of starting over. */
	currentBody: string;
	files: ModelFile[];
};

/** The message-drafter worker: one model call that writes or edits the reply text. */
export async function writeReply(input: ReplyInput): Promise<ModelReply> {
	let userContent = input.background;

	if (input.currentBody.length > 0) {
		userContent =
			userContent +
			'\n\nThe current draft:\n' +
			input.currentBody +
			'\n\nChange only what the brief asks for, keep the rest of the draft word for word.';
	}

	userContent =
		userContent +
		'\n\nBrief: ' +
		input.brief +
		'\n\nFiles are made by other workers: do not write any.';

	const raw = await recordAgentRun('drafting.reply', input.emailId, () => {
		return callModel(
			'reply',
			[
				{ role: 'system', content: REPLY_PROMPT },
				{ role: 'user', content: userContent }
			],
			input.files
		);
	});

	return parseModelReply(raw);
}
