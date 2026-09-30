import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { document } from '$lib/server/db/schema';
import { indexedText } from '$lib/server/fileIndex';
import { latestVersion } from '$lib/server/files/documents';
import { getOwnedResource } from '$lib/server/resources';

/** Longest file text the planner gets in one read. */
const MAX_CHARS = 20000;

function cut(text: string): string {
	if (text.length > MAX_CHARS) {
		return text.slice(0, MAX_CHARS) + '\n[cut]';
	}

	return text;
}

/** The read text of a resource or of this contact's attachment, for the planner's read_file action. */
export async function readFileText(userId: string, contactId: string, id: string): Promise<string> {
	const resourceRow = await getOwnedResource(userId, id);

	if (resourceRow !== null) {
		const text = await indexedText('resource', resourceRow.id);

		if (text === null) {
			return 'Result: "' + resourceRow.name + '" has not been read yet.';
		}

		return 'Result: "' + resourceRow.name + '"\n' + cut(text);
	}

	const documents = await db
		.select()
		.from(document)
		.where(and(eq(document.id, id), eq(document.contactId, contactId)))
		.limit(1);

	if (documents.length > 0) {
		const latest = await latestVersion(documents[0].id);
		let text: string | null = null;

		if (latest !== null) {
			text = await indexedText('attachment', latest.id);
		}

		if (text === null) {
			return 'Result: "' + documents[0].name + '" has not been read yet.';
		}

		return 'Result: "' + documents[0].name + '"\n' + cut(text);
	}

	return 'Result: there is no file with that id.';
}
