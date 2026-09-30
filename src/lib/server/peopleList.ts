import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { contact } from '$lib/server/db/schema';
import { readSummary } from '$lib/server/ai/agents/memory';

const PREVIEW_MAX_LINES = 4;
const PREVIEW_MAX_CHARS = 280;

export type PersonListItem = {
	id: string;
	name: string | null;
	company: string | null;
	emails: string[];
	preview: string;
};

/** The first few lines of text from the summary, without heading marks or blank lines. */
export function summaryPreview(summary: string): string {
	const lines = summary.split(/\r?\n/);
	const kept: string[] = [];

	for (const line of lines) {
		if (kept.length >= PREVIEW_MAX_LINES) {
			break;
		}

		const cleaned = line.replace(/^#+\s*/, '').trim();

		if (cleaned.length > 0) {
			kept.push(cleaned);
		}
	}

	const joined = kept.join('\n');

	if (joined.length > PREVIEW_MAX_CHARS) {
		return joined.slice(0, PREVIEW_MAX_CHARS).trimEnd() + '…';
	}

	return joined;
}

/** Each address once, in order, so a person never shows the same email twice. */
function uniqueEmails(emails: string[]): string[] {
	const seen: string[] = [];

	for (const address of emails) {
		if (!seen.includes(address)) {
			seen.push(address);
		}
	}

	return seen;
}

/** The user's tracked people, sorted by name (or first address), each with a short memory preview. */
export async function listPeopleWithMemory(userId: string): Promise<PersonListItem[]> {
	const rows = await db
		.select()
		.from(contact)
		.where(and(eq(contact.userId, userId), eq(contact.tracked, true)));

	const people: PersonListItem[] = [];

	for (const row of rows) {
		const summary = await readSummary(row.id);

		people.push({
			id: row.id,
			name: row.name,
			company: row.company,
			emails: uniqueEmails(row.emails),
			preview: summaryPreview(summary)
		});
	}

	people.sort((first, second) => {
		return sortKey(first).localeCompare(sortKey(second));
	});

	return people;
}

function sortKey(person: PersonListItem): string {
	if (person.name) {
		return person.name.toLowerCase();
	}

	if (person.emails.length > 0) {
		return person.emails[0];
	}

	return '';
}
