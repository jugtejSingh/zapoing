import { error, fail } from '@sveltejs/kit';
import { runsForEmails } from '$lib/server/ai/agentRun';
import { mergeDrafts, redraftEmail, senderContact } from '$lib/server/ai/agents/drafting';
import {
	closeThreadDrafts,
	getOwnedDraft,
	getOwnedEmail,
	openDraftsFor,
	setDraftStatus,
	unansweredEmails
} from '$lib/server/drafts';
import {
	draftAttachments,
	fillGenerated,
	listDraftFiles,
	recordSentFiles,
	removeGenerated,
	unfilledDraftFiles
} from '$lib/server/files/generated';
import { getCachedThread } from '$lib/server/mailCache';
import { listMailAccounts } from '$lib/server/mailAccount';
import { replyRecipients } from '$lib/server/replyAddresses';
import { MAX_ATTACHMENT_BYTES, sendReply, type ReplyAttachment } from '$lib/server/smtp';
import type { ThreadDrafts } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

async function loadThreadDrafts(
	userId: string,
	messages: { id: string; direction: string }[]
): Promise<ThreadDrafts> {
	const start = Date.now();
	const result: ThreadDrafts = {
		active: null,
		skippedReason: null,
		pendingCount: 0,
		latestWaitingId: null,
		canDraft: false
	};

	/** Only emails after the user's last reply count; a reply sent from anywhere else hides old drafts. */
	const waiting = unansweredEmails(messages);

	if (waiting.length === 0) {
		console.log('[home/[id]] loadThreadDrafts: nothing unanswered, ' + (Date.now() - start) + 'ms');
		return result;
	}

	const waitingIds: string[] = [];

	for (const row of waiting) {
		waitingIds.push(row.id);
	}

	const latestId = waitingIds[waitingIds.length - 1];
	result.latestWaitingId = latestId;

	const openDraftsStart = Date.now();
	const openDrafts = await openDraftsFor(waitingIds);
	console.log(
		'[home/[id]] loadThreadDrafts: openDraftsFor(' +
			waitingIds.length +
			' ids) took ' +
			(Date.now() - openDraftsStart) +
			'ms'
	);

	for (const open of openDrafts) {
		if (open.status === 'pending') {
			result.pendingCount = result.pendingCount + 1;

			if (result.active === null) {
				const filesStart = Date.now();
				const files = await listDraftFiles(open.id);
				console.log('[home/[id]] loadThreadDrafts: listDraftFiles took ' + (Date.now() - filesStart) + 'ms');

				const runsStart = Date.now();
				const runs = await runsForEmails(open.coversEmailIds);
				console.log('[home/[id]] loadThreadDrafts: runsForEmails took ' + (Date.now() - runsStart) + 'ms');

				result.active = {
					id: open.id,
					body: open.body ?? '',
					files,
					resources: open.resources,
					conflicts: open.conflicts,
					reason: open.reason,
					intents: open.intents,
					threadCut: open.threadCut,
					runs
				};
			}
		} else if (open.emailId === latestId && result.skippedReason === null) {
			result.skippedReason = open.reason ?? 'No reply needed';
		}
	}

	if (result.active !== null) {
		result.skippedReason = null;
	}

	const ownedStart = Date.now();
	const latest = await getOwnedEmail(userId, latestId);
	console.log('[home/[id]] loadThreadDrafts: getOwnedEmail took ' + (Date.now() - ownedStart) + 'ms');

	if (latest !== null) {
		const contactStart = Date.now();
		const tracked = await senderContact(userId, latest);
		console.log('[home/[id]] loadThreadDrafts: senderContact took ' + (Date.now() - contactStart) + 'ms');
		result.canDraft = tracked !== null;
	}

	console.log('[home/[id]] loadThreadDrafts: total ' + (Date.now() - start) + 'ms');

	return result;
}

function failMessage(caught: unknown, fallback: string) {
	let message = fallback;

	if (caught instanceof Error) {
		message = caught.message;
	}

	return fail(500, { message });
}

export const load: PageServerLoad = async ({ params, locals }) => {
	const loadStart = Date.now();
	console.log('[home/[id]] load: started for ' + params.id);

	if (!locals.user) {
		error(401, 'Not signed in');
	}

	/** The whole thread, received and sent, oldest first. The id in the url is just the way in. */
	const threadStart = Date.now();
	const messages = await getCachedThread(locals.user.id, params.id);
	console.log('[home/[id]] load: getCachedThread took ' + (Date.now() - threadStart) + 'ms');

	if (messages.length === 0) {
		error(404, 'Email not found');
	}

	/** The reply always answers the newest message, whichever way it went. */
	const last = messages[messages.length - 1];
	let ownAddress = '';

	const accountsStart = Date.now();
	for (const account of await listMailAccounts(locals.user.id)) {
		if (account.id === last.accountId) {
			ownAddress = account.username;
		}
	}
	console.log('[home/[id]] load: listMailAccounts took ' + (Date.now() - accountsStart) + 'ms');

	const recipients = replyRecipients(last, ownAddress);

	const draftsStart = Date.now();
	const drafts = await loadThreadDrafts(locals.user.id, messages);
	console.log('[home/[id]] load: loadThreadDrafts took ' + (Date.now() - draftsStart) + 'ms');

	console.log('[home/[id]] load: total ' + (Date.now() - loadStart) + 'ms');

	return {
		messages,
		reply: {
			emailId: last.id,
			to: recipients.to,
			cc: recipients.cc
		},
		drafts
	};
};

export const actions: Actions = {
	reply: async (event) => {
		if (!event.locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await event.request.formData();
		const emailId = formData.get('emailId')?.toString() ?? '';
		const body = formData.get('body')?.toString() ?? '';
		const cc = formData.get('cc')?.toString() ?? '';
		const draftIdText = formData.get('draftId')?.toString() ?? '';
		let draftId: string | null = null;

		if (draftIdText.length > 0) {
			draftId = draftIdText;
		}

		if (emailId.length === 0) {
			return fail(400, { message: 'Missing email id' });
		}

		if (body.trim().length === 0) {
			return fail(400, { message: 'Write something before sending' });
		}

		/** The draft's rendered documents go out with the reply; removed ones are gone from the table. */
		const attachments: ReplyAttachment[] = [];

		if (draftId !== null) {
			const sentDraft = await getOwnedDraft(event.locals.user.id, draftId);

			if (sentDraft === null) {
				return fail(404, { message: 'Draft not found' });
			}

			const unfilled = await unfilledDraftFiles(sentDraft.id);

			if (unfilled.length > 0) {
				return fail(400, {
					message: 'Fill the fields in ' + unfilled.join(', ') + ' before sending'
				});
			}

			for (const attachment of await draftAttachments(sentDraft.id)) {
				attachments.push(attachment);
			}
		}

		/** An empty file input still posts one nameless, empty file. */
		const files: File[] = [];
		let totalBytes = 0;

		for (const entry of formData.getAll('attachments')) {
			if (entry instanceof File && entry.size > 0) {
				files.push(entry);
				totalBytes += entry.size;
			}
		}

		if (totalBytes > MAX_ATTACHMENT_BYTES) {
			return fail(400, { message: 'Attachments are over the 25 MB limit' });
		}

		for (const file of files) {
			let contentType = 'application/octet-stream';

			if (file.type.length > 0) {
				contentType = file.type;
			}

			attachments.push({
				filename: file.name,
				contentType,
				content: Buffer.from(await file.arrayBuffer())
			});
		}

		try {
			await sendReply(event.locals.user.id, emailId, { body, cc, attachments });
		} catch (sendError) {
			return failMessage(sendError, 'Could not send the reply');
		}

		/** The mail is out; a failure here only leaves stale drafts, so it must not report a failed send. */
		try {
			const anchor = await getOwnedEmail(event.locals.user.id, emailId);

			if (anchor !== null) {
				await closeThreadDrafts(anchor, draftId);
			}
		} catch (closeError) {
			console.error('Reply sent but drafts not closed:', closeError);
		}

		/** Same here: the files went out, a failure only means they are not stored as new versions. */
		if (draftId !== null) {
			try {
				await recordSentFiles(draftId);
			} catch (recordError) {
				console.error('Reply sent but its documents were not stored:', recordError);
			}
		}

		return { message: 'Reply sent' };
	},

	/** ponytail: model calls run inline in the request; move them to jobs if they get slow. */
	regenerate: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();
		const draftId = formData.get('draftId')?.toString() ?? '';
		const instruction = formData.get('instruction')?.toString().trim() ?? '';
		const found = await getOwnedDraft(locals.user.id, draftId);

		if (found === null) {
			return fail(404, { message: 'Draft not found' });
		}

		let instructionText: string | null = null;

		if (instruction.length > 0) {
			instructionText = instruction;
		}

		try {
			await redraftEmail(locals.user.id, found.emailId, instructionText);
		} catch (caught) {
			return failMessage(caught, 'Could not regenerate the draft');
		}

		return { message: 'Draft regenerated' };
	},

	discard: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();
		const draftId = formData.get('draftId')?.toString() ?? '';
		const found = await getOwnedDraft(locals.user.id, draftId);

		if (found === null) {
			return fail(404, { message: 'Draft not found' });
		}

		await setDraftStatus(found.id, 'discarded');

		return { message: 'Draft discarded' };
	},

	merge: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();
		const emailId = formData.get('emailId')?.toString() ?? '';

		try {
			await mergeDrafts(locals.user.id, emailId);
		} catch (caught) {
			return failMessage(caught, 'Could not merge the drafts');
		}

		return { message: 'Drafts merged' };
	},

	/** The user's values for a generated file's [[fields]], posted as value:<name>. */
	fillGenerated: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();
		const id = formData.get('generatedId')?.toString() ?? '';
		const values = new Map<string, string>();

		for (const [key, value] of formData.entries()) {
			if (key.startsWith('value:') && typeof value === 'string') {
				values.set(key.slice('value:'.length), value);
			}
		}

		try {
			if (!(await fillGenerated(locals.user.id, id, values))) {
				return fail(404, { message: 'File not found' });
			}
		} catch (caught) {
			console.error('Filling a generated file failed:', caught);
			return fail(500, { message: 'The file could not be updated' });
		}

		return { message: 'File updated' };
	},

	removeGenerated: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();
		const id = formData.get('generatedId')?.toString() ?? '';

		if (!(await removeGenerated(locals.user.id, id))) {
			return fail(404, { message: 'File not found' });
		}

		return { message: 'File removed' };
	},

	draftAnyway: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();
		const emailId = formData.get('emailId')?.toString() ?? '';

		try {
			await redraftEmail(locals.user.id, emailId, null);
		} catch (caught) {
			return failMessage(caught, 'Could not write a draft');
		}

		return { message: 'Draft written' };
	}
};
