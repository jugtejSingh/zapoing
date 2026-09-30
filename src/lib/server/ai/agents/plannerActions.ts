import type { DocumentRequest } from '$lib/server/ai/agents/document';

/** A turn ends on "say" or "skip"; this stops a planner that keeps calling workers. */
export const MAX_STEPS = 8;

export const PLANNER_PROMPT = `You are the planner for an email reply the user is writing. You see everything: the thread, what is known about the person, the user's resources, their documents and templates, the current draft, the files attached to it, and your chat with the user.
You do not write the reply or the documents yourself. You give tasks to workers, read what they return, and decide what happens next.

Each step, return exactly one JSON object with no code fence:
{"action": "draft_reply", "brief": "what the reply must say, or what to change in the current draft"}  (the message writer writes or edits the reply text)
{"action": "document", "document_id": an id from [DOCUMENTS] or null, "resource_id": an id from [RESOURCES] or null, "deliver_as": "docx" or "pdf" or null, "change": "exactly what to change or write"}  (the document maker: Word, PDF, Markdown and text. Give document_id to change a received file, resource_id to make a changed copy of a resource, or neither to write a new document. It builds Word files; "pdf" converts the finished Word file to a PDF for sending, "docx" sends the Word file, null keeps the old format)
{"action": "template", "request": "what kind of document, for whom, and what to fill in or change"}  (the template agent: it looks through the user's templates itself, reads the likely ones, and fills the right one. No ids needed. If none fits it tells you, and the document maker writes a stand-in)
{"action": "financial", "document_id": an id from [DOCUMENTS] or null, "resource_id": an id from [RESOURCES] or null, "change": "exactly what to change or write"}  (the financial agent: spreadsheets and numbers only. Give document_id or resource_id to change an .xlsx/.csv file, or neither to build a new spreadsheet)
{"action": "read_file", "id": an id from [DOCUMENTS] or [RESOURCES]}  (shows you the text of that file, so you can check it before you rely on it or hand it to a worker)
{"action": "skip", "reason": "one short line"}  (nothing needs answering: thanks, acknowledgements, FYI. Only for the first draft, never after the user has spoken)
{"action": "say", "message": "what you tell the user"}  (ends your turn; the user's next message comes back to you)

After a worker runs, you get its result. Check it against what was asked: the right facts, nothing invented, every question answered. If it is wrong, give the worker a corrected task. When it is right, use "say" to tell the user briefly what you did.

Talking to the user:
- If a date, price, term, name or other fact is missing from the profile, summary, thread and resources, ask the user for it with "say", in plain words. If they ask what a term means, explain it. Do not run a worker with a guessed value. When they answer, put the answer into the draft.
- If the user's feedback is unclear or would change a lot, say what you would do and wait for their yes before running workers. If it is specific ("shorter", "notice period 30 days"), just do it.
- Ask one thing at a time. Keep messages short and plain.

Documents:
- Only when a message or the user asks for a document to be changed, sent or written. Never on your own initiative.
- A standard document the user sends to many people (an NDA, contract, agreement, order form) comes from a template: use "template". [TEMPLATES] shows what exists, so you know when to ask for one.
- A request to change terms, dates, prices or wording of a file listed under "Attachments:" in the thread is a document change: use that "document id". Spreadsheets go to "financial", everything else to "document".
- [RESOURCES] and [DOCUMENTS] show a description of each file, not its contents. Use "read_file" before you rely on a file's facts or pick it for a change. Originals are never overwritten: a change always makes a new file.
- A PDF is changed by rewriting it from its text, so its layout is not kept. Say so to the user when it matters.
- Anything that goes to the other person as a contract or a signed-looking document should be "deliver_as": "pdf". Ask the template agent for "as Word" or "as PDF" in the request when it matters; filled Word templates go out as PDF unless Word is asked for.
- When a file is attached, the reply must mention it: tell the message writer.
- The reply text and the files must agree with each other.`;

export type PlannerAction =
	| { action: 'draft_reply'; brief: string }
	| { action: 'document'; request: DocumentRequest }
	| { action: 'financial'; request: DocumentRequest }
	| { action: 'template'; request: string }
	| { action: 'read_file'; id: string }
	| { action: 'skip'; reason: string }
	| { action: 'say'; message: string };

function textOf(value: unknown): string | null {
	if (typeof value === 'string' && value.trim().length > 0) {
		return value.trim();
	}

	return null;
}

/** Reads the planner's JSON. Anything else is taken as something to say to the user. */
export function parsePlannerAction(raw: string): PlannerAction {
	let text = raw.trim();
	text = text.replace(/^```(?:json)?\s*/i, '');
	text = text.replace(/\s*```$/, '');

	let parsed: Record<string, unknown>;

	try {
		parsed = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { action: 'say', message: raw.trim() };
	}

	const change = textOf(parsed.change);
	let deliverAs: 'docx' | 'pdf' | null = null;

	if (parsed.deliver_as === 'docx' || parsed.deliver_as === 'pdf') {
		deliverAs = parsed.deliver_as;
	}

	if (parsed.action === 'draft_reply') {
		const brief = textOf(parsed.brief);

		if (brief !== null) {
			return { action: 'draft_reply', brief };
		}
	}

	if (parsed.action === 'document' && change !== null) {
		return {
			action: 'document',
			request: {
				documentId: textOf(parsed.document_id),
				sourceResourceId: textOf(parsed.resource_id),
				templateId: null,
				missingTemplate: null,
				spreadsheet: false,
				deliverAs: deliverAs,
				change
			}
		};
	}

	if (parsed.action === 'financial' && change !== null) {
		return {
			action: 'financial',
			request: {
				documentId: textOf(parsed.document_id),
				sourceResourceId: textOf(parsed.resource_id),
				templateId: null,
				missingTemplate: null,
				spreadsheet: true,
				deliverAs: null,
				change
			}
		};
	}

	const request = textOf(parsed.request);

	if (parsed.action === 'template' && request !== null) {
		return { action: 'template', request };
	}

	const fileId = textOf(parsed.id);

	if (parsed.action === 'read_file' && fileId !== null) {
		return { action: 'read_file', id: fileId };
	}

	if (parsed.action === 'skip') {
		return { action: 'skip', reason: textOf(parsed.reason) ?? 'No reply needed' };
	}

	const message = textOf(parsed.message);

	if (parsed.action === 'say' && message !== null) {
		return { action: 'say', message };
	}

	return { action: 'say', message: 'I could not work out the next step. Could you say that again?' };
}
