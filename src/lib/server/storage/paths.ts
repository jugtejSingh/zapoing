import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from '$env/dynamic/private';

/** Everything the app keeps on disk lives under DATA_DIR (default ./data). */
export function dataDir(): string {
	if (env.DATA_DIR) {
		return path.resolve(env.DATA_DIR);
	}

	return path.resolve('data');
}

/** Creates the parent directory of `file` if needed and returns `file`. */
async function ensureParent(file: string): Promise<string> {
	await mkdir(path.dirname(file), { recursive: true });
	return file;
}

export function userProfilePath(): Promise<string> {
	return ensureParent(path.join(dataDir(), 'profile', 'user.json'));
}

export function contactProfilePath(contactId: string): Promise<string> {
	return ensureParent(path.join(dataDir(), 'contacts', contactId, 'profile.json'));
}

export function summaryPath(contactId: string): Promise<string> {
	return ensureParent(path.join(dataDir(), 'contacts', contactId, 'summary.md'));
}

/** Where a replaced summary.md is archived, named by the time it was replaced. */
export function summaryHistoryPath(contactId: string, at: Date): Promise<string> {
	const stamp = at.toISOString().replace(/[:.]/g, '-');
	return ensureParent(
		path.join(dataDir(), 'contacts', contactId, 'summary_history', stamp + '.md')
	);
}

export function threadCutLogPath(): Promise<string> {
	return ensureParent(path.join(dataDir(), 'logs', 'agents', 'thread-cuts.jsonl'));
}

export function documentDir(documentId: string): string {
	return path.join(dataDir(), 'attachments', documentId);
}

/**
 * Where a received file is kept: `attachments/<person's email>/<YYYY-MM-DD>/<filename>`,
 * so a file can be found by who sent it and when. A second file with the same name
 * on the same day gets " (2)", " (3)"… instead of replacing the first.
 */
export async function attachmentFilePath(
	personEmail: string,
	receivedAt: Date,
	filename: string
): Promise<string> {
	const day = receivedAt.toISOString().slice(0, 10);
	const folder = path.join(dataDir(), 'attachments', safeSegment(personEmail), day);
	const clean = path.basename(filename).replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').slice(0, 150);
	const dot = clean.lastIndexOf('.');
	let base = clean;
	let extension = '';

	if (dot > 0) {
		base = clean.slice(0, dot);
		extension = clean.slice(dot);
	}

	let candidate = path.join(folder, base + extension);
	let number = 2;

	while (existsSync(candidate)) {
		candidate = path.join(folder, base + ' (' + String(number) + ')' + extension);
		number = number + 1;
	}

	return ensureParent(candidate);
}

export function documentMetaPath(documentId: string): Promise<string> {
	return ensureParent(path.join(documentDir(documentId), 'meta.json'));
}

/** The working copy the document agent edits instead of the original: `working.md` or `working.sheets.json`. */
export function documentWorkingPath(
	documentId: string,
	kind: 'markdown' | 'sheets'
): Promise<string> {
	let name = 'working.md';

	if (kind === 'sheets') {
		name = 'working.sheets.json';
	}

	return ensureParent(path.join(documentDir(documentId), name));
}

/** Which version the working copy was made from, so a newer received version replaces it. */
export function documentWorkingInfoPath(documentId: string): Promise<string> {
	return ensureParent(path.join(documentDir(documentId), 'working.json'));
}

/** Only letters, digits, dash and underscore; thread ids can hold `<`, `>` and `@`. */
function safeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
}

/** `generated/<thread-id>/<generated-file-id>/`: the file, its `.changes.md` and the model's source. */
export function generatedDir(threadKey: string, generatedId: string): string {
	return path.join(dataDir(), 'generated', safeSegment(threadKey), safeSegment(generatedId));
}

export function generatedFilePath(
	threadKey: string,
	generatedId: string,
	filename: string
): Promise<string> {
	return ensureParent(path.join(generatedDir(threadKey, generatedId), path.basename(filename)));
}

/** `templates/<id>/`: `original.<ext>`, the marked copy and `template.json`. */
export function templateDir(templateId: string): string {
	return path.join(dataDir(), 'templates', safeSegment(templateId));
}

export function templateOriginalPath(templateId: string, format: string): Promise<string> {
	return ensureParent(path.join(templateDir(templateId), 'original.' + format));
}

/** The copy with `[[field]]` markers: `template.docx`, `template.xlsx`, or `template.md` for a PDF. */
export function templateMarkedPath(templateId: string, format: string): Promise<string> {
	let extension = format;

	if (format === 'pdf') {
		extension = 'md';
	}

	return ensureParent(path.join(templateDir(templateId), 'template.' + extension));
}

export function templateInfoPath(templateId: string): Promise<string> {
	return ensureParent(path.join(templateDir(templateId), 'template.json'));
}

/** `resources/<id>/`: holds `original.<ext>`. */
export function resourceDir(resourceId: string): string {
	return path.join(dataDir(), 'resources', safeSegment(resourceId));
}

export function resourceFilePath(resourceId: string, extension: string): Promise<string> {
	return ensureParent(path.join(resourceDir(resourceId), 'original.' + safeSegment(extension)));
}

/** \`settings/models.json\`: the model settings page. The API key in it is encrypted. */
export function modelSettingsPath(): string {
	return path.join(dataDir(), 'settings', 'models.json');
}

/** The logo for generated documents. One file, named by its type, so a new upload replaces the old one. */
export function brandingLogoPath(type: 'png' | 'jpg'): Promise<string> {
	return ensureParent(path.join(dataDir(), 'profile', 'logo.' + type));
}
