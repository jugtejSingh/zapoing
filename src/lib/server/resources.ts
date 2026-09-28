import { readFile, rm, writeFile } from 'node:fs/promises';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { resource } from '$lib/server/db/schema';
import type { ModelFile } from '$lib/server/ai/model';
import { isReadableByAI } from '$lib/server/files/allowlist';
import { indexResource } from '$lib/server/resourceIndex';
import { MAX_ATTACHMENT_BYTES } from '$lib/server/smtp';
import { resourceDir, resourceFilePath } from '$lib/server/storage/paths';

export type ResourceRow = typeof resource.$inferSelect;

/** At most this many resources go with one draft. */
export const RESOURCE_LIMIT = 3;

/** ponytail: caps the FTS query; a long email only adds noise past this. */
const MAX_TERMS = 30;

const STOPWORDS = new Set([
	'about',
	'above',
	'after',
	'again',
	'all',
	'also',
	'and',
	'any',
	'are',
	'because',
	'been',
	'before',
	'being',
	'below',
	'best',
	'between',
	'both',
	'but',
	'can',
	'could',
	'dear',
	'did',
	'does',
	'doing',
	'down',
	'during',
	'each',
	'few',
	'for',
	'from',
	'further',
	'get',
	'had',
	'has',
	'have',
	'having',
	'hello',
	'her',
	'here',
	'hers',
	'him',
	'his',
	'how',
	'into',
	'its',
	'just',
	'kind',
	'know',
	'let',
	'like',
	'look',
	'looking',
	'many',
	'may',
	'more',
	'most',
	'much',
	'must',
	'need',
	'not',
	'now',
	'off',
	'once',
	'only',
	'other',
	'our',
	'ours',
	'out',
	'over',
	'own',
	'please',
	'regards',
	'same',
	'send',
	'sent',
	'she',
	'should',
	'some',
	'such',
	'thank',
	'thanks',
	'than',
	'that',
	'the',
	'their',
	'them',
	'then',
	'there',
	'these',
	'they',
	'this',
	'those',
	'through',
	'too',
	'under',
	'until',
	'very',
	'want',
	'was',
	'way',
	'were',
	'what',
	'when',
	'where',
	'which',
	'while',
	'who',
	'whom',
	'why',
	'will',
	'with',
	'would',
	'you',
	'your',
	'yours'
]);

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

/** "finance, pricing 2026" → ["finance", "pricing", "2026"], lower case, no repeats. */
export function parseTags(value: string): string[] {
	const tags: string[] = [];

	for (const part of value.toLowerCase().split(/[\s,]+/)) {
		const tag = part.trim().slice(0, 40);

		if (tag.length > 0 && !tags.includes(tag)) {
			tags.push(tag);
		}
	}

	return tags.slice(0, 20);
}

async function saveFile(resourceId: string, file: File): Promise<string> {
	const filePath = await resourceFilePath(resourceId, extensionOf(file.name));
	await writeFile(filePath, Buffer.from(await file.arrayBuffer()));
	return filePath;
}

export async function createResource(
	userId: string,
	input: { name: string; keywords: string; tags: string; file: File }
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
			keywords: cleanText(input.keywords, 1000),
			tags: parseTags(input.tags),
			filename: input.file.name,
			contentType: input.file.type,
			path: filePath
		})
		.returning();

	await indexResource(id);

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
	input: { name: string; keywords: string; tags: string }
): Promise<boolean> {
	const name = cleanText(input.name, 120);

	if (name.length === 0) {
		throw new ResourceInputError('Give the resource a name');
	}

	const updated = await db
		.update(resource)
		.set({ name, keywords: cleanText(input.keywords, 1000), tags: parseTags(input.tags) })
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
	await indexResource(row.id);

	return true;
}

/** Removes the row (a trigger drops it from the search index) and its folder. */
export async function deleteResource(userId: string, id: string): Promise<boolean> {
	const row = await getOwnedResource(userId, id);

	if (row === null) {
		return false;
	}

	await db.delete(resource).where(eq(resource.id, row.id));
	await rm(resourceDir(row.id), { recursive: true, force: true });

	return true;
}

/** Words worth searching for: lower case, 3+ letters, no common words, no repeats. */
export function searchTerms(text: string): string[] {
	const terms: string[] = [];

	for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (word.length < 3 || STOPWORDS.has(word) || terms.includes(word)) {
			continue;
		}

		terms.push(word);

		if (terms.length >= MAX_TERMS) {
			break;
		}
	}

	return terms;
}

/**
 * An FTS5 query that matches any term, each as a quoted prefix ("price"*), so
 * no character in the email can be read as FTS syntax. Null when nothing is left.
 */
export function ftsQuery(terms: string[]): string | null {
	const parts: string[] = [];

	for (const term of terms) {
		parts.push('"' + term.replaceAll('"', '""') + '"*');
	}

	if (parts.length === 0) {
		return null;
	}

	return parts.join(' OR ');
}

/**
 * The user's resources that best match the text, best first. Local only: FTS5
 * over name, keywords, tags and the file's text, ranked by bm25 with the name
 * weighted highest and the file's text lowest.
 */
export async function searchResources(
	userId: string,
	text: string,
	limit: number = RESOURCE_LIMIT
): Promise<ResourceRow[]> {
	const query = ftsQuery(searchTerms(text));

	if (query === null) {
		return [];
	}

	/** bm25 weights follow the column order: resource_id (unindexed), name, keywords, tags, content. */
	const matches = db.all<{ id: string }>(sql`
		SELECT resource.id AS id
		FROM resource_fts
		JOIN resource ON resource.id = resource_fts.resource_id
		WHERE resource_fts MATCH ${query} AND resource.user_id = ${userId}
		ORDER BY bm25(resource_fts, 0.0, 10.0, 5.0, 2.0, 1.0)
		LIMIT ${limit}
	`);

	const rows: ResourceRow[] = [];

	for (const match of matches) {
		const row = await getOwnedResource(userId, match.id);

		if (row !== null) {
			rows.push(row);
		}
	}

	return rows;
}

function newestFirst(rows: ResourceRow[]): ResourceRow[] {
	const sorted = [...rows];
	sorted.sort((a, b) => {
		return b.updatedAt.getTime() - a.updatedAt.getTime();
	});
	return sorted;
}

/** The [RESOURCES] section of the drafting context. */
export function describeResources(rows: ResourceRow[]): string {
	const lines: string[] = ['[RESOURCES]'];

	if (rows.length === 0) {
		lines.push('None.');
		return lines.join('\n');
	}

	lines.push(
		'The user\'s reference files, attached to this message, newest first. Use them for facts like prices and terms. When they disagree, use the newest and add the disagreement to "conflicts".'
	);

	for (const row of newestFirst(rows)) {
		let line = '- ' + row.name + ' (file ' + row.filename;

		if (row.tags.length > 0) {
			line = line + ', tags: ' + row.tags.join(', ');
		}

		line = line + ', updated ' + row.updatedAt.toISOString().slice(0, 10) + ')';
		lines.push(line);
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

/** What the draft keeps: names as they were, so deleting a resource later keeps the record. */
export function usedResources(rows: ResourceRow[]): { id: string; name: string }[] {
	const used: { id: string; name: string }[] = [];

	for (const row of newestFirst(rows)) {
		used.push({ id: row.id, name: row.name });
	}

	return used;
}
