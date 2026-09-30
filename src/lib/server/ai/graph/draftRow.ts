import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { draft } from '$lib/server/db/schema';
import { listDraftFiles } from '$lib/server/files/generated';

export type DraftRow = typeof draft.$inferSelect;

/** The draft as it is in the database right now: workers change it while the graph runs. */
export async function loadDraft(id: string): Promise<DraftRow> {
	const rows = await db.select().from(draft).where(eq(draft.id, id)).limit(1);

	if (rows.length === 0) {
		throw new Error('Draft not found');
	}

	return rows[0];
}

export async function updateDraft(
	id: string,
	fields: Partial<typeof draft.$inferInsert>
): Promise<DraftRow> {
	const rows = await db.update(draft).set(fields).where(eq(draft.id, id)).returning();

	return rows[0];
}

/** The body and the files as they are now, so the planner starts each step from the truth. */
export async function describeState(draftRow: DraftRow): Promise<string> {
	const lines: string[] = ['[CURRENT DRAFT]'];

	if (draftRow.body.trim().length > 0) {
		lines.push(draftRow.body);
	} else {
		lines.push('(nothing written yet)');
	}

	lines.push('', '[FILES ON THIS DRAFT]');
	const files = await listDraftFiles(draftRow.id);

	if (files.length === 0) {
		lines.push('(none)');
	}

	for (const file of files) {
		let line = '- ' + file.filename + ', asked: ' + file.change;

		if (file.error !== null) {
			line = line + ', FAILED: ' + file.error;
		}

		if (file.placeholders.length > 0) {
			line = line + ', still to fill: ' + file.placeholders.join(', ');
		}

		lines.push(line);
	}

	return lines.join('\n');
}

export async function fileIds(draftId: string): Promise<Set<string>> {
	const ids = new Set<string>();

	for (const file of await listDraftFiles(draftId)) {
		ids.add(file.id);
	}

	return ids;
}

/** What the workers made since `before`, so the planner can check it. */
export async function describeNewFiles(draftId: string, before: Set<string>): Promise<string> {
	const lines: string[] = [];

	for (const file of await listDraftFiles(draftId)) {
		if (before.has(file.id)) {
			continue;
		}

		if (file.error !== null) {
			lines.push(file.filename + ' FAILED: ' + file.error);
		} else {
			lines.push(file.filename + ' was made. Changes: ' + file.changeNote);
		}
	}

	if (lines.length === 0) {
		return 'No file was made.';
	}

	return lines.join('\n');
}
