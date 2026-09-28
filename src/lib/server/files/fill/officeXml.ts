import JSZip from 'jszip';
import { fillPlaceholder, listPlaceholders } from '$lib/placeholders';

/**
 * Marks and fills fields inside a DOCX or XLSX without rebuilding it: only the
 * text nodes change, so the letterhead, fonts, numbering and everything else
 * stay exactly as the user made them.
 */
export type OfficeFormat = 'docx' | 'xlsx';

export type FieldText = {
	name: string;
	/** The exact text in the file this field replaces, e.g. "Acme Ltd". */
	texts: string[];
};

/** Word body, headers, footers and notes; Excel shared and inline strings. */
function isTextPart(path: string, format: OfficeFormat): boolean {
	if (format === 'docx') {
		return /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(path);
	}

	return /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(path);
}

function textNodePattern(format: OfficeFormat): RegExp {
	if (format === 'docx') {
		return /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
	}

	return /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
}

/** Text never matches across a paragraph (Word) or a string (Excel). */
const BOUNDARY = /<\/(?:w:p|si|is)>/;

function decodeXml(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
		const lower = entity.toLowerCase();

		if (lower === 'amp') {
			return '&';
		} else if (lower === 'lt') {
			return '<';
		} else if (lower === 'gt') {
			return '>';
		} else if (lower === 'quot') {
			return '"';
		} else if (lower === 'apos') {
			return "'";
		} else if (lower.startsWith('#x')) {
			return String.fromCodePoint(parseInt(lower.slice(2), 16));
		} else if (lower.startsWith('#')) {
			return String.fromCodePoint(parseInt(lower.slice(1), 10));
		}

		return whole;
	});
}

export function escapeXml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type TextNode = {
	start: number;
	end: number;
	text: string;
	changed: boolean;
};

/** Text nodes grouped by paragraph (or string), in document order. */
function paragraphsOf(
	xml: string,
	format: OfficeFormat
): { nodes: TextNode[]; groups: TextNode[][] } {
	const nodes: TextNode[] = [];
	const groups: TextNode[][] = [];
	let current: TextNode[] = [];
	let previousEnd = 0;

	for (const match of xml.matchAll(textNodePattern(format))) {
		const node: TextNode = {
			start: match.index,
			end: match.index + match[0].length,
			text: decodeXml(match[1]),
			changed: false
		};

		if (BOUNDARY.test(xml.slice(previousEnd, node.start)) && current.length > 0) {
			groups.push(current);
			current = [];
		}

		current.push(node);
		nodes.push(node);
		previousEnd = node.end;
	}

	if (current.length > 0) {
		groups.push(current);
	}

	return { nodes, groups };
}

/**
 * Replaces the characters [start, end) of the paragraph with the marker. Word
 * often splits a phrase over several runs; the marker goes into the first one,
 * keeping its formatting, and the rest of the phrase is removed from the others.
 */
function replaceRange(group: TextNode[], start: number, end: number, marker: string): void {
	const lengths: number[] = [];

	for (const node of group) {
		lengths.push(node.text.length);
	}

	let offset = 0;
	let placed = false;

	for (let index = 0; index < group.length; index++) {
		const node = group[index];
		const nodeStart = offset;
		const nodeEnd = offset + lengths[index];
		offset = nodeEnd;

		if (nodeEnd <= start || nodeStart >= end) {
			continue;
		}

		const localStart = Math.max(start, nodeStart) - nodeStart;
		const localEnd = Math.min(end, nodeEnd) - nodeStart;

		if (!placed) {
			node.text = node.text.slice(0, localStart) + marker + node.text.slice(localEnd);
			placed = true;
		} else {
			node.text = node.text.slice(0, localStart) + node.text.slice(localEnd);
		}

		node.changed = true;
	}
}

function groupText(group: TextNode[]): string {
	let text = '';

	for (const node of group) {
		text = text + node.text;
	}

	return text;
}

/** Marks every occurrence of the texts in one XML part and counts them per field. */
export function markXml(
	xml: string,
	format: OfficeFormat,
	fields: FieldText[],
	found: Map<string, number>
): string {
	const { nodes, groups } = paragraphsOf(xml, format);

	/** Longest text first, so "Acme" never eats into "Acme Ltd". */
	const pairs: { text: string; name: string }[] = [];

	for (const field of fields) {
		for (const text of field.texts) {
			if (text.trim().length > 0) {
				pairs.push({ text, name: field.name });
			}
		}
	}

	pairs.sort((a, b) => b.text.length - a.text.length);

	for (const group of groups) {
		for (const pair of pairs) {
			const marker = '[[' + pair.name + ']]';
			let from = 0;

			while (true) {
				const text = groupText(group);
				const at = text.indexOf(pair.text, from);

				if (at === -1) {
					break;
				}

				/** Never inside a marker placed by a longer text. */
				if (text.lastIndexOf('[[', at) > text.lastIndexOf(']]', at)) {
					from = at + 1;
					continue;
				}

				replaceRange(group, at, at + pair.text.length, marker);
				found.set(pair.name, (found.get(pair.name) ?? 0) + 1);
				from = at + marker.length;
			}
		}
	}

	let result = xml;

	/** From the end, so earlier positions stay valid. */
	for (let index = nodes.length - 1; index >= 0; index--) {
		const node = nodes[index];

		if (!node.changed) {
			continue;
		}

		let tag = 't';

		if (format === 'docx') {
			tag = 'w:t';
		}

		const replacement =
			'<' + tag + ' xml:space="preserve">' + escapeXml(node.text) + '</' + tag + '>';
		result = result.slice(0, node.start) + replacement + result.slice(node.end);
	}

	return result;
}

async function eachTextPart(
	content: Buffer,
	format: OfficeFormat,
	change: (xml: string) => string
): Promise<Buffer> {
	const zip = await JSZip.loadAsync(content);

	for (const path of Object.keys(zip.files)) {
		if (!isTextPart(path, format)) {
			continue;
		}

		const file = zip.file(path);

		if (file === null) {
			continue;
		}

		const xml = await file.async('string');
		const changed = change(xml);

		if (changed !== xml) {
			zip.file(path, changed);
		}
	}

	return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Puts a `[[name]]` marker wherever a field's text appears. Returns the marked file and the counts. */
export async function markFields(
	content: Buffer,
	format: OfficeFormat,
	fields: FieldText[]
): Promise<{ content: Buffer; found: Map<string, number> }> {
	const found = new Map<string, number>();
	const marked = await eachTextPart(content, format, (xml) => {
		return markXml(xml, format, fields, found);
	});

	return { content: marked, found };
}

/** Swaps markers for values. A marker with no value stays as `[[name]]` for the user to fill. */
export async function fillFields(
	content: Buffer,
	format: OfficeFormat,
	values: Map<string, string>
): Promise<Buffer> {
	return eachTextPart(content, format, (xml) => {
		let result = xml;

		for (const [name, value] of values) {
			result = fillPlaceholder(result, name, escapeXml(value));
		}

		return result;
	});
}

/** The `[[names]]` still in the file. */
export async function markersIn(content: Buffer, format: OfficeFormat): Promise<string[]> {
	const zip = await JSZip.loadAsync(content);
	const names: string[] = [];

	for (const path of Object.keys(zip.files)) {
		const file = zip.file(path);

		if (!isTextPart(path, format) || file === null) {
			continue;
		}

		for (const name of listPlaceholders(await file.async('string'))) {
			if (!names.includes(name)) {
				names.push(name);
			}
		}
	}

	return names;
}

/**
 * The file's text, one paragraph (or cell) per line, exactly as markFields
 * searches it, so the texts the model copies from it are found.
 */
export async function documentText(content: Buffer, format: OfficeFormat): Promise<string> {
	const zip = await JSZip.loadAsync(content);
	const lines: string[] = [];

	for (const path of Object.keys(zip.files)) {
		const file = zip.file(path);

		if (!isTextPart(path, format) || file === null) {
			continue;
		}

		const { groups } = paragraphsOf(await file.async('string'), format);

		for (const group of groups) {
			const text = groupText(group);

			if (text.trim().length > 0) {
				lines.push(text);
			}
		}
	}

	return lines.join('\n');
}
