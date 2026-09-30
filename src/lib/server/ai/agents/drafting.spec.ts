import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
	return 'drafting-spec-' + String(Date.now());
});

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const nodePath = await import('node:path');
	const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), dataDir));

	return {
		env: {
			MODEL_API_KEY: 'test-key',
			MODEL_BASE_URL: 'https://model.test/v1/',
			DATABASE_URL: ':memory:',
			CREDENTIALS_KEY: 'a'.repeat(64),
			DATA_DIR: dir
		}
	};
});

import { eq } from 'drizzle-orm';
import { fakePlannerReply, PLANNER_PREFIX } from '$lib/server/testing/fakePlanner';
import { db } from '$lib/server/db';
import { draft, email } from '$lib/server/db/schema';
import { listDraftMessages } from '$lib/server/draftChat';
import { closeThreadDrafts, getOwnedEmail } from '$lib/server/drafts';
import { enqueueJob, requestJobRun } from '$lib/server/jobs/worker';
import { addTrackedPerson, findContactByEmail } from '$lib/server/trackedPerson';
import {
	createTestAccount,
	createTestUser,
	migrateTestDb,
	resetTestDb
} from '$lib/server/testing/testDb';
import { registerMemoryAgent } from './memory';
import { chatWithPlanner, parsePlannerAction } from './planner';
import { parseModelReply } from './replyWriter';
import {
	createDraftForEmail,
	mergeDrafts,
	redraftEmail,
	registerDraftingAgent
} from './drafting';

const fetchMock = vi.fn();

/** What the fake model returns to drafting calls; memory calls always get a summary. */
let draftReply = '';

function okReply(text: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
		status: 200
	});
}

function draftJson(replyNeeded: boolean, reason: string, body: string): string {
	return JSON.stringify({ reply_needed: replyNeeded, reason, body });
}

let contactId: string;
let accountId: string;

async function insertEmail(
	uid: number,
	text: string,
	direction: 'in' | 'out' = 'in'
): Promise<string> {
	let from = 'Anna <anna@acme.test>';
	let to = 'me@example.com';

	if (direction === 'out') {
		from = 'me@example.com';
		to = 'Anna <anna@acme.test>';
	}

	const rows = await db
		.insert(email)
		.values({
			accountId,
			uid,
			uidValidity: 1,
			from,
			to,
			subject: 'Order',
			date: new Date(Date.UTC(2026, 0, uid)),
			text,
			snippet: text,
			threadId: 't1',
			direction
		})
		.returning();

	return rows[0].id;
}

async function draftsOf(emailId: string) {
	return db.select().from(draft).where(eq(draft.emailId, emailId));
}

async function allDrafts() {
	return db.select().from(draft);
}

beforeAll(() => {
	migrateTestDb();
});

beforeEach(async () => {
	delete (globalThis as { __zapoingJobWorker?: unknown }).__zapoingJobWorker;
	draftReply = draftJson(true, 'asks for a quote', 'The quote is [[price]].');
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
		const request = JSON.parse(init.body) as { messages: { content: string }[] };

		if (request.messages[0].content.startsWith(PLANNER_PREFIX)) {
			return okReply(fakePlannerReply(draftReply, request.messages));
		}

		if (request.messages[0].content.startsWith('You write email replies')) {
			return okReply(draftReply);
		}

		return okReply('## Who they are\nAnna, buyer at Acme.');
	});

	await resetTestDb();
	await createTestUser('u1');
	accountId = (await createTestAccount('u1', 'me@example.com')).id;
	await addTrackedPerson('u1', 'anna@acme.test');

	const found = await findContactByEmail('u1', 'anna@acme.test');

	if (found === null) {
		throw new Error('contact missing');
	}

	contactId = found.id;
});

describe('parseModelReply', () => {
	it('reads fenced JSON and falls back to plain text', () => {
		const fenced = parseModelReply('```json\n{"reason": "asks for a quote", "body": "Sure."}\n```');
		expect(fenced).toEqual({
			reason: 'asks for a quote',
			body: 'Sure.',
			conflicts: []
		});

		const plain = parseModelReply('Sure, see you then.');
		expect(plain).toEqual({
			reason: null,
			body: 'Sure, see you then.',
			conflicts: []
		});
	});
});

describe('createDraftForEmail', () => {
	it('stores a pending draft', async () => {
		const emailId = await insertEmail(1, 'Can you send a quote?');

		await createDraftForEmail({ contactId, emailId });

		const rows = await draftsOf(emailId);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('pending');
		expect(rows[0].body).toBe('The quote is [[price]].');
	});

	it('stores a skipped draft with the reason when no reply is needed', async () => {
		draftReply = draftJson(false, 'just a thank-you', '');
		const emailId = await insertEmail(1, 'Thanks!');

		await createDraftForEmail({ contactId, emailId });

		const rows = await draftsOf(emailId);
		expect(rows[0].status).toBe('skipped');
		expect(rows[0].reason).toBe('just a thank-you');
		expect(rows[0].body).toBe('');
	});

	it('does not write a second draft when the job is retried', async () => {
		const emailId = await insertEmail(1, 'Can you send a quote?');

		await createDraftForEmail({ contactId, emailId });
		await createDraftForEmail({ contactId, emailId });

		expect(await draftsOf(emailId)).toHaveLength(1);
		/** The planner asks for the reply, the writer writes it, the planner says it is done. */
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('writes nothing for an email the user sent', async () => {
		const emailId = await insertEmail(1, 'Here is the quote.', 'out');

		await createDraftForEmail({ contactId, emailId });

		expect(await draftsOf(emailId)).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('redraftEmail', () => {
	it('"Draft anyway" forces a draft and retires the skipped one', async () => {
		draftReply = draftJson(false, 'just a thank-you', '');
		const emailId = await insertEmail(1, 'Thanks!');
		await createDraftForEmail({ contactId, emailId });

		draftReply = draftJson(true, '', 'You are welcome.');
		await redraftEmail('u1', emailId);

		const statuses: string[] = [];

		for (const row of await draftsOf(emailId)) {
			statuses.push(row.status);
		}

		expect(statuses.sort()).toEqual(['discarded', 'pending']);

		let plannerWasTold = false;

		for (const call of fetchMock.mock.calls) {
			const body = call[1].body as string;

			if (body.includes('do not skip it')) {
				plannerWasTold = true;
			}
		}

		expect(plannerWasTold).toBe(true);
	});

	it("refuses another user's email", async () => {
		await createTestUser('u2');
		const emailId = await insertEmail(1, 'Can you send a quote?');

		await expect(redraftEmail('u2', emailId)).rejects.toThrow('Email not found');
	});
});

describe('mergeDrafts', () => {
	it('merges only the drafts after the last reply, into the latest email', async () => {
		const answered = await insertEmail(1, 'First question?');
		await createDraftForEmail({ contactId, emailId: answered });
		await insertEmail(2, 'Answer.', 'out');
		const second = await insertEmail(3, 'Second question?');
		const third = await insertEmail(4, 'Third question?');
		await createDraftForEmail({ contactId, emailId: second });
		await createDraftForEmail({ contactId, emailId: third });

		draftReply = draftJson(true, '', 'Both answers: [[price]] and [[date]].');
		await mergeDrafts('u1', second);

		expect((await draftsOf(answered))[0].status).toBe('pending');
		expect((await draftsOf(second))[0].status).toBe('merged');

		const onThird = await draftsOf(third);
		let merged = null;
		let source = null;

		for (const row of onThird) {
			if (row.status === 'pending') {
				merged = row;
			}

			if (row.status === 'merged') {
				source = row;
			}
		}

		expect(source).not.toBeNull();
		expect(merged?.body).toBe('Both answers: [[price]] and [[date]].');
		expect(merged?.coversEmailIds).toEqual([second, third]);

		/** The planner of the merged draft starts from the source drafts. */
		let seeded = false;

		for (const call of fetchMock.mock.calls) {
			const body = call[1].body as string;

			if (body.includes('--- Draft 2 ---')) {
				seeded = true;
				expect(body).not.toContain('First question?\\n\\n[NEW MESSAGE]');
			}
		}

		expect(seeded).toBe(true);
	});

	it('refuses when fewer than two drafts are waiting', async () => {
		const emailId = await insertEmail(1, 'Can you send a quote?');
		await createDraftForEmail({ contactId, emailId });

		await expect(mergeDrafts('u1', emailId)).rejects.toThrow('nothing to merge');
	});
});

describe('closeThreadDrafts', () => {
	it('marks the sent draft sent and discards the rest of the thread', async () => {
		const first = await insertEmail(1, 'One?');
		const second = await insertEmail(2, 'Two?');
		await createDraftForEmail({ contactId, emailId: first });
		await createDraftForEmail({ contactId, emailId: second });
		const sentDraft = (await draftsOf(second))[0];

		const anchor = await getOwnedEmail('u1', second);

		if (anchor === null) {
			throw new Error('email missing');
		}

		await closeThreadDrafts(anchor, sentDraft.id);

		expect((await draftsOf(first))[0].status).toBe('discarded');
		expect((await draftsOf(second))[0].status).toBe('sent');
	});
});

describe('parsePlannerAction', () => {
	it('reads each action', () => {
		expect(parsePlannerAction('{"action":"draft_reply","brief":"add the price"}')).toEqual({
			action: 'draft_reply',
			brief: 'add the price'
		});
		expect(
			parsePlannerAction('```json\n{"action":"skip","reason":"thanks only"}\n```')
		).toEqual({
			action: 'skip',
			reason: 'thanks only'
		});
		expect(
			parsePlannerAction('{"action":"template","request":"fill the NDA"}')
		).toEqual({ action: 'template', request: 'fill the NDA' });
	});

	it('reads how a document goes out: Word, PDF, or the old rule when not said', () => {
		const pdf = parsePlannerAction(
			'{"action":"document","document_id":"d1","deliver_as":"pdf","change":"term to 2 years"}'
		);
		const word = parsePlannerAction(
			'{"action":"document","deliver_as":"docx","change":"write an agreement"}'
		);
		const unsaid = parsePlannerAction('{"action":"document","change":"write an agreement"}');
		const odd = parsePlannerAction(
			'{"action":"document","deliver_as":"rtf","change":"write an agreement"}'
		);

		expect(pdf).toMatchObject({
			action: 'document',
			request: { documentId: 'd1', deliverAs: 'pdf', spreadsheet: false }
		});
		expect(word).toMatchObject({ request: { documentId: null, deliverAs: 'docx' } });
		expect(unsaid).toMatchObject({ request: { deliverAs: null } });
		expect(odd).toMatchObject({ request: { deliverAs: null } });
	});

	it('reads the financial action as a spreadsheet request that is never delivered as Word', () => {
		expect(
			parsePlannerAction(
				'{"action":"financial","document_id":"d1","deliver_as":"pdf","change":"widgets to 130"}'
			)
		).toEqual({
			action: 'financial',
			request: {
				documentId: 'd1',
				sourceResourceId: null,
				templateId: null,
				missingTemplate: null,
				spreadsheet: true,
				deliverAs: null,
				change: 'widgets to 130'
			}
		});
		expect(parsePlannerAction('{"action":"financial"}').action).toBe('say');
	});

	it('reads read_file, and asks again when it has no id', () => {
		expect(parsePlannerAction('{"action":"read_file","id":"r1"}')).toEqual({
			action: 'read_file',
			id: 'r1'
		});
		expect(parsePlannerAction('{"action":"read_file"}').action).toBe('say');
	});

	it('takes plain text as something to say, and asks again on a broken action', () => {
		expect(parsePlannerAction('What are the terms?')).toEqual({
			action: 'say',
			message: 'What are the terms?'
		});
		expect(parsePlannerAction('{"action":"document"}').action).toBe('say');
	});
});

describe('chatWithPlanner', () => {
	it('asks, takes the answer, rewrites the draft and keeps the chat', async () => {
		const emailId = await insertEmail(1, 'Can you send a quote?');
		await createDraftForEmail({ contactId, emailId });
		const written = (await draftsOf(emailId))[0];

		/** The planner: run the writer, then tell the user. */
		const plannerSteps = [
			JSON.stringify({ action: 'draft_reply', brief: 'the price is 40 EUR' }),
			JSON.stringify({ action: 'say', message: 'Updated the price to 40 EUR.' })
		];
		fetchMock.mockReset();
		fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
			const request = JSON.parse(init.body) as { messages: { content: string }[] };

			if (request.messages[0].content.startsWith(PLANNER_PREFIX)) {
				return okReply(plannerSteps.shift() ?? '{"action":"say","message":"?"}');
			}

			return okReply(draftJson(true, '', 'The quote is 40 EUR.'));
		});

		await chatWithPlanner('u1', written.id, 'the price is 40 EUR');

		const after = (await draftsOf(emailId))[0];
		expect(after.body).toBe('The quote is 40 EUR.');

		const chat = await listDraftMessages(written.id);
		expect(chat.map((message) => message.role)).toEqual(['assistant', 'user', 'assistant']);
		expect(chat[1].content).toBe('the price is 40 EUR');
		expect(chat[2].content).toBe('Updated the price to 40 EUR.');

		/** The second planner call has seen the writer's result. */
		const secondPlanner = JSON.parse(fetchMock.mock.calls[2][1].body as string);
		expect(JSON.stringify(secondPlanner.messages)).toContain('The quote is 40 EUR.');

		/** The chat resumes the planner that wrote the draft: its first run is still in its memory. */
		const chatPlanner = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		expect(JSON.stringify(chatPlanner.messages)).toContain('A new email needs a reply');
	});

	it("refuses another user's draft", async () => {
		await createTestUser('u2');
		const emailId = await insertEmail(1, 'Can you send a quote?');
		await createDraftForEmail({ contactId, emailId });
		const written = (await draftsOf(emailId))[0];

		await expect(chatWithPlanner('u2', written.id, 'hello')).rejects.toThrow('Draft not found');
	});
});

describe('pipeline', () => {
	it('a memory update queues the draft, which is written with the new summary', async () => {
		registerMemoryAgent();
		registerDraftingAgent();
		const emailId = await insertEmail(1, 'Can you send a quote?');

		await enqueueJob('memory.update', { contactId, emailId });
		await requestJobRun();

		const rows = await allDrafts();
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('pending');

		/** Memory first, then drafting, and the draft prompt carries the fresh summary. */
		const draftRequest = JSON.parse(fetchMock.mock.calls[1][1].body as string);
		expect(draftRequest.messages[1].content).toContain('Anna, buyer at Acme.');
	});
});
