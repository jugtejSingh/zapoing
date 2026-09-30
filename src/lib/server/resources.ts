import { readFile, rm, writeFile } from 'node:fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { resource } from '$lib/server/db/schema';
import type { ModelFile } from '$lib/server/ai/model';
import { isReadableByAI } from '$lib/server/files/allowlist';
import { forgetIndex, indexRows, queueIngest } from '$lib/server/fileIndex';
import { MAX_ATTACHMENT_BYTES } from '$lib/server/smtp';
import { resourceDir, resourceFilePath } from '$lib/server/storage/paths';

export type ResourceRow = typeof resource.$inferSelect;

/** Thrown for anything the user can fix: wrong file type, too big, empty name. */
export class ResourceInputError extends Error {}

function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf('.');

	if (dot === -1) {
		return '';
	}

	return filename.slice(dot + 1).toLowerCase();
}

/** Only files the AI can read (decision F), up to the attachment limit. */
function checkFile(file: File): void {
	if (!isReadableByAI(file.name, file.type)) {
		throw new ResourceInputError(
			'Resources must be a file the AI can read: PDF, Word, Excel, CSV, text, Markdown or an image'
		);
	}

	if (file.size === 0) {
		throw new ResourceInputError('The file is empty');
	}

	if (file.size > MAX_ATTACHMENT_BYTES) {
		throw new ResourceInputError('The file is larger than 25 MB');
	}
}

function cleanText(value: string, max: number): string {
	return value.trim().slice(0, max);
}

async function saveFile(resourceId: string, file: File): Promise<string> {
	const filePath = await resourceFilePath(resourceId, extensionOf(file.name));
	await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
	return filePath;
}

export async function createResource(
	userId: string,
	input: { name: string; file: File }
): Promise<ResourceRow> {
	const name = cleanText(input.name, 120);

	if (name.length === 0) {
		throw new ResourceInputError('Give the resource a name');
	}

	checkFile(input.file);
	const id = crypto.randomUUID();
	const filePath = await saveFile(id, input.file);

	const inserted = await db
		.insert(resource)
		.values({
			id,
			userId,
			name,
			filename: input.file.name,
			contentType: input.file.type,
			path: filePath
		})
		.returning();

	await queueIngest('resource', id);

	return inserted[0];
}

/** Newest first, so the one that wins a conflict is on top. */
export async function listResources(userId: string): Promise<ResourceRow[]> {
	return db
		.select()
		.from(resource)
		.where(eq(resource.userId, userId))
		.orderBy(desc(resource.updatedAt));
}

export async function getOwnedResource(userId: string, id: string): Promise<ResourceRow | null> {
	const rows = await db
		.select()
		.from(resource)
		.where(and(eq(resource.id, id), eq(resource.userId, userId)))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	return rows[0];
}

export async function updateResource(
	userId: string,
	id: string,
	input: { name: string }
): Promise<boolean> {
	const name = cleanText(input.name, 120);

	if (name.length === 0) {
		throw new ResourceInputError('Give the resource a name');
	}

	const updated = await db
		.update(resource)
		.set({ name })
		.where(and(eq(resource.id, id), eq(resource.userId, userId)))
		.returning({ id: resource.id });

	return updated.length > 0;
}

/** A newer file for the same resource. updatedAt moves, so it now wins conflicts. */
export async function replaceResourceFile(
	userId: string,
	id: string,
	file: File
): Promise<boolean> {
	const row = await getOwnedResource(userId, id);

	if (row === null) {
		return false;
	}

	checkFile(file);
	await rm(resourceDir(row.id), { recursive: true, force: true });
	const filePath = await saveFile(row.id, file);

	await db
		.update(resource)
		.set({ filename: file.name, contentType: file.type, path: filePath, updatedAt: new Date() })
		.where(eq(resource.id, row.id));
	await queueIngest('resource', row.id);

	return true;
}

/** Removes the row, its index row and its folder. */
export async function deleteResource(userId: string, id: string): Promise<boolean> {
	const row = await getOwnedResource(userId, id);

	if (row === null) {
		return false;
	}

	await db.delete(resource).where(eq(resource.id, row.id));
	await forgetIndex('resource', row.id);
	await rm(resourceDir(row.id), { recursive: true, force: true });

	return true;
}

function newestFirst(rows: ResourceRow[]): ResourceRow[] {
	const sorted = [...rows];
	sorted.sort((a, b) => {
		return b.updatedAt.getTime() - a.updatedAt.getTime();
	});
	return sorted;
}

/**
 * The [RESOURCES] section the planner sees: every resource by id, name and
 * description, newest first. The planner reads one with read_file, or hands it to
 * a worker to change. Files that are not indexed yet are listed without a description.
 */
export async function describeResources(rows: ResourceRow[]): Promise<string> {
	const lines: string[] = ['[RESOURCES]'];

	if (rows.length === 0) {
		lines.push('None.');
		return lines.join('\n');
	}

	lines.push(
		"The user's reference files. Read one with read_file before you rely on it. When two disagree, use the newest."
	);

	const ids: string[] = [];

	for (const row of rows) {
		ids.push(row.id);
	}

	const index = await indexRows('resource', ids);

	for (const row of newestFirst(rows)) {
		let description = 'not read yet';
		const indexed = index.get(row.id);

		if (indexed !== undefined && indexed.status === 'ready') {
			description = indexed.description;
		} else if (indexed !== undefined && indexed.status === 'failed') {
			description = 'could not be read';
		}

		lines.push(
			'- id: ' +
				row.id +
				' | ' +
				row.name +
				' | ' +
				row.filename +
				' | updated ' +
				row.updatedAt.toISOString().slice(0, 10) +
				' | ' +
				description
		);
	}

	return lines.join('\n');
}

/** The resource files as the model gets them. A file missing from disk is skipped. */
export async function resourceFiles(rows: ResourceRow[]): Promise<ModelFile[]> {
	const files: ModelFile[] = [];

	for (const row of newestFirst(rows)) {
		try {
			files.push({
				filename: row.filename,
				mime: row.contentType,
				content: await readFile(row.path)
			});
		} catch {
			continue;
		}
	}

	return files;
}
