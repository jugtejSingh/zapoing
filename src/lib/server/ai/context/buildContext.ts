import { email, contact } from '$lib/server/db/schema';
import { readSummary } from '$lib/server/ai/agents/memory';
import { readProfile, type UserProfile } from '$lib/server/profile';
import { threadEmails } from '$lib/server/threads';
import {
	cutThread,
	formatThread,
	logThreadCut,
	threadBudgetTokens,
	type ThreadMessage
} from './cutThread';

type EmailRow = typeof email.$inferSelect;
type ContactRow = typeof contact.$inferSelect;

export type DraftContext = {
	/** Everything the model needs, as one block of prompt text. */
	text: string;
	threadCut: boolean;
};

function addLine(lines: string[], label: string, value: string): void {
	if (value.trim().length > 0) {
		lines.push(label + ': ' + value.trim());
	}
}

/** The profile as short labelled lines, leaving out anything the user has not filled in. */
export function describeProfile(profile: UserProfile): string {
	const lines: string[] = [];

	addLine(lines, 'Name', profile.name);
	addLine(lines, 'Role', profile.role);
	addLine(lines, 'Company', profile.company);
	addLine(lines, 'What the company does', profile.companyDescription);
	addLine(lines, 'Tone', profile.writingStyle.tone);
	addLine(lines, 'Length', profile.writingStyle.length);
	addLine(lines, 'Phrases I use', profile.writingStyle.phrasesUse.join('; '));
	addLine(lines, 'Phrases I avoid', profile.writingStyle.phrasesAvoid.join('; '));
	addLine(lines, 'Sign-off', profile.signOff);
	addLine(lines, 'Signature', profile.signature);
	addLine(lines, 'Timezone', profile.timezone);
	addLine(lines, 'Working hours', profile.workingHours);
	addLine(lines, 'Standing rules', profile.standingRules.join('; '));

	if (lines.length === 0) {
		return '(no profile yet)';
	}

	return lines.join('\n');
}

/**
 * The context bundle for a draft: the user's profile, the person's summary and
 * the thread cut to budget. `newIds` are the emails being answered; the last
 * one is pinned by the cut.
 */
export async function buildDraftContext(
	contactRow: ContactRow,
	replyTo: EmailRow,
	newIds: string[]
): Promise<DraftContext> {
	const messages: ThreadMessage[] = [];

	for (const row of await threadEmails(replyTo)) {
		messages.push({ id: row.id, from: row.from, date: row.date, text: row.text });
	}

	const cut = cutThread(messages, replyTo.id, threadBudgetTokens());
	await logThreadCut('drafting', contactRow.id, cut);

	let summary = (await readSummary(contactRow.id)).trim();

	if (summary.length === 0) {
		summary = '(nothing known yet)';
	}

	const text =
		'About me (the user):\n' +
		describeProfile(await readProfile()) +
		'\n\nAbout the person (' +
		contactRow.emails.join(', ') +
		'):\n' +
		summary +
		'\n\nThread (oldest first):\n\n' +
		formatThread(cut.kept, newIds);

	return { text, threadCut: cut.droppedIds.length > 0 };
}
