/**
 * Decision F: only these file types are ever sent to the AI. Anything else
 * (executables, archives, scripts, unknown types) never leaves the machine.
 * Both the extension and the MIME type must agree, so a renamed .exe is still refused.
 */
const ALLOWED: Record<string, string[]> = {
	pdf: ['application/pdf'],
	docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
	xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
	csv: ['text/csv', 'application/csv', 'text/plain'],
	txt: ['text/plain'],
	md: ['text/markdown', 'text/x-markdown', 'text/plain'],
	png: ['image/png'],
	jpg: ['image/jpeg'],
	jpeg: ['image/jpeg'],
	gif: ['image/gif'],
	webp: ['image/webp']
};

export function isReadableByAI(filename: string, mime: string): boolean {
	const dot = filename.lastIndexOf('.');

	if (dot === -1) {
		return false;
	}

	const extension = filename.slice(dot + 1).toLowerCase();
	const allowedMimes = ALLOWED[extension];

	if (!allowedMimes) {
		return false;
	}

	/** Drop parameters like "; charset=utf-8" before comparing. */
	const bareMime = mime.split(';')[0].trim().toLowerCase();

	return allowedMimes.includes(bareMime);
}
