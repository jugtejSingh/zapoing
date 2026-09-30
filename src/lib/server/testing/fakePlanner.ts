type Message = { role?: string; content: unknown };

export const PLANNER_PREFIX = 'You are the planner';

/**
 * A fake planner for specs. It replays a reply written for the old single-call
 * drafting agent ({reply_needed, body, documents}) as planner steps: write the
 * reply, then one worker per document entry, then say it is done.
 */
export function fakePlannerReply(oldReply: string, messages: Message[]): string {
	let parsed: {
		reply_needed?: unknown;
		reason?: unknown;
		documents?: {
			document_id?: unknown;
			template_id?: unknown;
			missing_template?: unknown;
			deliver_as?: unknown;
			resource_id?: unknown;
			spreadsheet?: unknown;
			change?: unknown;
		}[];
	};

	try {
		parsed = JSON.parse(oldReply);
	} catch {
		parsed = {};
	}

	if (parsed.reply_needed === false) {
		return JSON.stringify({ action: 'skip', reason: parsed.reason });
	}

	const steps: object[] = [{ action: 'draft_reply', brief: 'Write the reply' }];

	for (const entry of parsed.documents ?? []) {
		if (entry.template_id || entry.missing_template) {
			/** The template agent spec mock reads the id back out of this sentence. */
			steps.push({
				action: 'template',
				request: 'Use template ' + String(entry.template_id ?? 'none') + ': ' + String(entry.change)
			});
		} else if (entry.spreadsheet === true) {
			steps.push({
				action: 'financial',
				document_id: entry.document_id ?? null,
				resource_id: entry.resource_id ?? null,
				change: entry.change
			});
		} else {
			steps.push({
				action: 'document',
				document_id: entry.document_id ?? null,
				resource_id: entry.resource_id ?? null,
				deliver_as: entry.deliver_as ?? null,
				change: entry.change
			});
		}
	}

	steps.push({ action: 'say', message: 'Done' });

	let taken = 0;

	for (const message of messages) {
		if (message.role === 'assistant') {
			taken = taken + 1;
		}
	}

	return JSON.stringify(steps[Math.min(taken, steps.length - 1)]);
}
