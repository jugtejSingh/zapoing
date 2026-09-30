import { recordAgentRun } from '$lib/server/ai/agentRun';
import { generateFromTemplate } from '$lib/server/ai/agents/template';
import { describeNewFiles, fileIds, loadDraft } from '$lib/server/ai/graph/draftRow';
import type { TurnContext } from '$lib/server/ai/graph/state';
import { callModel, type ModelMessage } from '$lib/server/ai/model';
import { indexedText, indexRows } from '$lib/server/fileIndex';
import { readyTemplates, type TemplateRow } from '$lib/server/templates';

/** Reads and looks before it fills: this many model calls per request, then it gives up. */
const MAX_TURNS = 5;

/** Longest template text shown to the agent in one read. */
const MAX_READ_CHARS = 20000;

export const TEMPLATE_AGENT_PROMPT = `You are the template agent. The planner asks you for a standard document (an NDA, contract, agreement, order form...) and you produce it from the user's templates.
You see every template: id, name, what the user says it is for, what the AI found when it read the file, its format and its fields.

Each step, return exactly one JSON object with no code fence:
{"action": "read", "template_id": "id from [TEMPLATES]"}  (shows you the template's text and fields, so you can check it is the right one)
{"action": "fill", "template_id": "id from [TEMPLATES]", "deliver_as": "docx" or "pdf", "change": "what to fill in or change, with every value you know"}  (fills the template into a new file and ends your turn. A Word template is filled as Word; "pdf" (the default) converts it to a PDF when the reply is sent, "docx" sends the Word file)
{"action": "none", "reason": "one short line"}  (no template fits; the document maker writes a stand-in instead)

- Choose by the descriptions, then read the likely one before you fill it. Never fill a template meant for something else.
- Facts you do not have are left for the planner to ask about: do not invent values.
- After a fill you get the result. If the planner asks for changes later, fill again with the corrected request.`;

export type TemplateAgentAction =
	| { action: 'read'; templateId: string }
	| { action: 'fill'; templateId: string; change: string; deliverAs: 'docx' | 'pdf' }
	| { action: 'none'; reason: string };

function textOf(value: unknown): string | null {
	if (typeof value === 'string' && value.trim().length > 0) {
		return value.trim();
	}

	return null;
}

/** Reads the agent's JSON. Anything else counts as "none": the document maker takes over. */
export function parseTemplateAgentAction(raw: string): TemplateAgentAction {
	let text = raw.trim();
	text = text.replace(/^```(?:json)?\s*/i, '');
	text = text.replace(/\s*```$/, '');

	let parsed: Record<string, unknown>;

	try {
		parsed = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { action: 'none', reason: 'The template agent did not answer in JSON' };
	}

	const templateId = textOf(parsed.template_id);
	const change = textOf(parsed.change);

	if (parsed.action === 'read' && templateId !== null) {
		return { action: 'read', templateId };
	}

	if (parsed.action === 'fill' && templateId !== null && change !== null) {
		let deliverAs: 'docx' | 'pdf' = 'pdf';

		if (parsed.deliver_as === 'docx') {
			deliverAs = 'docx';
		}

		return { action: 'fill', templateId, change, deliverAs };
	}

	return { action: 'none', reason: textOf(parsed.reason) ?? 'No template fits' };
}

/** Every ready template, with what the user and the AI each say about it. */
async function describeCatalogue(userId: string): Promise<{ text: string; rows: TemplateRow[] }> {
	const rows = await readyTemplates(userId);
	const ids: string[] = [];

	for (const row of rows) {
		ids.push(row.id);
	}

	const index = await indexRows('template', ids);
	const lines: string[] = ['[TEMPLATES]'];

	for (const row of rows) {
		const names: string[] = [];

		for (const field of row.fields) {
			names.push(field.name);
		}

		let found = 'not read';
		const indexed = index.get(row.id);

		if (indexed !== undefined && indexed.status === 'ready') {
			found = indexed.description;
		}

		lines.push(
			'- id: ' +
				row.id +
				' | ' +
				row.name +
				' | user says: ' +
				row.description +
				' | file says: ' +
				found +
				' | ' +
				row.format +
				' | fields: ' +
				names.join(', ')
		);
	}

	if (rows.length === 0) {
		lines.push('None.');
	}

	return { text: lines.join('\n'), rows };
}

async function readTemplate(rows: TemplateRow[], templateId: string): Promise<string> {
	let found: TemplateRow | null = null;

	for (const row of rows) {
		if (row.id === templateId) {
			found = row;
		}
	}

	if (found === null) {
		return 'Result: there is no template with that id.';
	}

	let text = await indexedText('template', found.id);

	if (text === null) {
		return 'Result: "' + found.name + '" has not been read yet.';
	}

	if (text.length > MAX_READ_CHARS) {
		text = text.slice(0, MAX_READ_CHARS) + '\n[cut]';
	}

	const names: string[] = [];

	for (const field of found.fields) {
		names.push(field.name + ' (' + field.description + ')');
	}

	return 'Result: "' + found.name + '"\nFields: ' + names.join('; ') + '\nText:\n' + text;
}

export type TemplateAgentResult = {
	/** A template was filled and the file is on the draft. */
	filled: boolean;
	/** What the planner is told: the new file, or why there is none. */
	note: string;
	/** This run's part of the template agent's own history. */
	messages: ModelMessage[];
};

/**
 * One request from the planner: the agent looks through the templates, reads the
 * likely one and fills it. It keeps its own history apart from the planner's, so a
 * later revision request resumes with what it already read.
 */
export async function runTemplateAgent(
	turn: TurnContext,
	request: string,
	history: ModelMessage[]
): Promise<TemplateAgentResult> {
	const catalogue = await describeCatalogue(turn.contactRow.userId);
	const added: ModelMessage[] = [{ role: 'user', content: 'Request from the planner: ' + request }];

	for (let attempt = 0; attempt < MAX_TURNS; attempt++) {
		const draftRow = await loadDraft(turn.draftId);
		const known = turn.workerBackground + '\n\n' + catalogue.text + '\n\n[CURRENT DRAFT]\n' + draftRow.body;
		const messages: ModelMessage[] = [
			{ role: 'system', content: TEMPLATE_AGENT_PROMPT },
			{ role: 'user', content: known }
		];

		for (const earlier of history) {
			messages.push(earlier);
		}

		for (const now of added) {
			messages.push(now);
		}

		const raw = await recordAgentRun('template.agent', turn.emailRow.id, () => {
			return callModel('template', messages);
		});
		const next = parseTemplateAgentAction(raw);
		added.push({ role: 'assistant', content: raw });

		if (next.action === 'none') {
			return { filled: false, note: next.reason, messages: added };
		}

		if (next.action === 'read') {
			added.push({ role: 'user', content: await readTemplate(catalogue.rows, next.templateId) });
			continue;
		}

		const before = await fileIds(turn.draftId);

		await generateFromTemplate(
			draftRow,
			turn.emailRow,
			{
				documentId: null,
				sourceResourceId: null,
				templateId: next.templateId,
				missingTemplate: null,
				spreadsheet: false,
				deliverAs: next.deliverAs,
				change: next.change
			},
			{ userId: turn.contactRow.userId, contactName: turn.contactRow.name },
			turn.workerBackground
		);

		const result = await describeNewFiles(turn.draftId, before);

		added.push({ role: 'user', content: 'Result: ' + result });

		if (result.includes(' FAILED: ')) {
			return { filled: false, note: result, messages: added };
		}

		return { filled: true, note: result, messages: added };
	}

	return { filled: false, note: 'The template agent did not decide in time', messages: added };
}
