/**
 * Markers that start the quoted copy of earlier mail. Everything from the first
 * marker down is dropped, because the earlier messages are in the thread already.
 * ponytail: English-language markers only. Add localized ones ("Am … schrieb:") when they show up.
 */
/** Gmail and Apple Mail: "On Tue, 3 Mar 2026 at 10:00, Ann <ann@x.com> wrote:" */
const GMAIL_HEADER = /^On .+wrote:\s*$/;
/** Outlook plain text. */
const ORIGINAL_MESSAGE = /^-{2,}\s*Original Message\s*-{2,}\s*$/i;
/** Outlook header block. Only counts when a "Sent:" line follows, see isOutlookHeader. */
const OUTLOOK_FROM = /^From: .+/;

function isOutlookHeader(lines: string[], index: number): boolean {
	for (let offset = 1; offset <= 3; offset++) {
		const next = lines[index + offset];

		if (next === undefined) {
			return false;
		}

		if (/^(Sent|Date): /.test(next.trim())) {
			return true;
		}
	}

	return false;
}

/** Joins a Gmail "On … wrote:" line that the client wrapped across two lines. */
function isWrappedGmailHeader(lines: string[], index: number): boolean {
	const line = lines[index].trim();
	const next = lines[index + 1];

	if (!line.startsWith('On ') || next === undefined) {
		return false;
	}

	return /wrote:\s*$/.test(next.trim());
}

/** Removes quoted replies from a plain-text email body and returns only the new content. */
export function stripQuotes(text: string): string {
	const lines = text.split(/\r?\n/);
	const kept: string[] = [];

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const trimmed = line.trim();

		if (GMAIL_HEADER.test(trimmed) || isWrappedGmailHeader(lines, index)) {
			break;
		}

		if (ORIGINAL_MESSAGE.test(trimmed)) {
			break;
		}

		if (OUTLOOK_FROM.test(trimmed) && isOutlookHeader(lines, index)) {
			break;
		}

		if (trimmed.startsWith('>')) {
			continue;
		}

		kept.push(line);
	}

	return kept.join('\n').trim();
}
