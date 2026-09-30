import { asc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { draftMessage } from '$lib/server/db/schema';
import type { DraftChatMessage } from '$lib/types';

export async function addDraftMessage(
	draftId: string,
	role: DraftChatMessage['role'],
	content: string
): Promise<void> {
	await db.insert(draftMessage).values({ draftId, role, content });
}

/** The chat about one draft, oldest first. */
export async function listDraftMessages(draftId: string): Promise<DraftChatMessage[]> {
	const rows = await db
		.select()
		.from(draftMessage)
		.where(eq(draftMessage.draftId, draftId))
		.orderBy(asc(draftMessage.createdAt), asc(draftMessage.id));
	const messages: DraftChatMessage[] = [];

	for (const row of rows) {
		messages.push({ id: row.id, role: row.role, content: row.content });
	}

	return messages;
}
