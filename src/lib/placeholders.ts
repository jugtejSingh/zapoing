/**
 * `[[name]]` placeholders in drafts. Shared by the server (Send guard, draft
 * storage) and the reply box (Tab to next, unfilled list).
 */

function pattern(): RegExp {
	/** At least one non-space character between the brackets, no brackets or newlines inside. */
	return /\[\[([^[\]\n]*[^[\]\s][^[\]\n]*)\]\]/g;
}

/** Each placeholder name once, in order of first appearance. */
export function listPlaceholders(text: string): string[] {
	const names: string[] = [];

	for (const match of text.matchAll(pattern())) {
		const name = match[1].trim();

		if (!names.includes(name)) {
			names.push(name);
		}
	}

	return names;
}

export function hasPlaceholders(text: string): boolean {
	return pattern().test(text);
}

/** Replaces every `[[name]]` with `value`, so a name used twice is filled once. */
export function fillPlaceholder(text: string, name: string, value: string): string {
	return text.replace(pattern(), (whole, found: string) => {
		if (found.trim() === name) {
			return value;
		}

		return whole;
	});
}

/** The next placeholder at or after `from`, wrapping to the start. Null when there are none. */
export function nextPlaceholderRange(text: string, from: number): { start: number; end: number } | null {
	let first: { start: number; end: number } | null = null;

	for (const match of text.matchAll(pattern())) {
		const start = match.index;
		const range = { start, end: start + match[0].length };

		if (first === null) {
			first = range;
		}

		if (start >= from) {
			return range;
		}
	}

	return first;
}
