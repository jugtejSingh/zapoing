import { rm, writeFile } from 'node:fs/promises';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { template } from '$lib/server/db/schema';
import { isReadableByAI } from '$lib/server/files/allowlist';
import { forgetIndex, queueIngest } from '$lib/server/fileIndex';
import { MAX_ATTACHMENT_BYTES } from '$lib/server/smtp';
import { templateDir, templateOriginalPath } from '$lib/server/storage/paths';

export type TemplateRow = typeof template.$inferSelect;
export type TemplateFormat = TemplateRow['format'];

const FORMATS: TemplateFormat[] = ['docx', 'xlsx', 'pdf'];

/** Thrown for anything the user can fix: wrong file type, too big, empty name. */
export class TemplateInputError extends Error {}

/** DOCX, XLSX or PDF, checked by both extension and MIME type, at most the attachment limit. */
export function templateFormatOf(file: File): TemplateFormat {
	const dot = file.name.lastIndexOf('.');
	let extension = '';

	if (dot !== -1) {
		extension = file.name.slice(dot + 1).toLowerCase();
	}

	let format: TemplateFormat | null = null;

	for (const candidate of FORMATS) {
		if (candidate === extension) {
			format = candidate;
		}
	}

	if (format === null || !isReadableByAI(file.name, file.type)) {
		throw new TemplateInputError('Templates must be a Word (.docx), Excel (.xlsx) or PDF file');
	}

	if (file.size === 0) {
		throw new TemplateInputError('The file is empty');
	}

	if (file.size > MAX_ATTACHMENT_BYTES) {
		throw new TemplateInputError('The file is larger than 25 MB');
	}

	return format;
}

function cleanText(value: string, max: number): string {
	return value.trim().slice(0, max);
}

async function saveOriginal(templateId: string, format: TemplateFormat, file: File): Promise<void> {
	const content = Buffer.from(await file.arrayBuffer());
	await writeFile(await templateOriginalPath(templateId, format), content);
}

/** Saves the upload and queues its ingestion; the field-finding job follows once its text is read. */
export async function createTemplate(
	userId: string,
	input: { name: string; description: string; file: File }
): Promise<TemplateRow> {
	const name = cleanText(input.name, 120);

	if (name.length === 0) {
		throw new TemplateInputError('Give the template a name');
	}

	const format = templateFormatOf(input.file);
	const id = crypto.randomUUID();
	await saveOriginal(id, format, input.file);

	const inserted = await db
		.insert(template)
		.values({
			id,
			userId,
			name,
			description: cleanText(input.description, 1000),
			filename: input.file.name,
			format
		})
		.returning();

	await queueIngest('template', id);

	return inserted[0];
}

export async function listTemplates(userId: string): Promise<TemplateRow[]> {
	return db.select().from(template).where(eq(template.userId, userId)).orderBy(asc(template.name));
}

/** Only ready templates: the ones drafting may use. */
export async function readyTemplates(userId: string): Promise<TemplateRow[]> {
	return db
		.select()
		.from(template)
		.where(and(eq(template.userId, userId), eq(template.status, 'ready')))
		.orderBy(asc(template.name));
}

export async function getOwnedTemplate(userId: string, id: string): Promise<TemplateRow | null> {
	const rows = await db
		.select()
		.from(template)
		.where(and(eq(template.id, id), eq(template.userId, userId)))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0];
}

export async function updateTemplate(
	userId: string,
	id: string,
	input: { name: string; description: string }
): Promise<boolean> {
	const name = cleanText(input.name, 120);

	if (name.length === 0) {
		throw new TemplateInputError('Give the template a name');
	}

	const updated = await db
		.update(template)
		.set({ name, description: cleanText(input.description, 1000) })
		.where(and(eq(template.id, id), eq(template.userId, userId)))
		.returning({ id: template.id });

	return updated.length > 0;
}

/** A new file for the same template: the old files go, and the fields are found again. */
export async function replaceTemplateFile(
	userId: string,
	id: string,
	file: File
): Promise<boolean> {
	const row = await getOwnedTemplate(userId, id);

	if (row === null) {
		return false;
	}

	const format = templateFormatOf(file);
	await rm(templateDir(row.id), { recursive: true, force: true });
	await saveOriginal(row.id, format, file);

	await db
		.update(template)
		.set({ filename: file.name, format, fields: [], status: 'processing', error: null })
		.where(eq(template.id, row.id));

	/** The ingest job reads the new file, then queues the field-finding job. */
	await queueIngest('template', row.id);

	return true;
}

/** Removes the row and its folder. Files already made from it keep working. */
export async function deleteTemplate(userId: string, id: string): Promise<boolean> {
	const row = await getOwnedTemplate(userId, id);

	if (row === null) {
		return false;
	}

	await db.delete(template).where(eq(template.id, row.id));
	await forgetIndex('template', row.id);
	await rm(templateDir(row.id), { recursive: true, force: true });

	return true;
}
