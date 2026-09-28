import { Marked } from 'marked';
import { chromium } from 'playwright';

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * The model's Markdown is untrusted: raw HTML is shown as text and images as
 * their alt text, so nothing in it can load a URL or run a script.
 */
const markdown = new Marked({
	gfm: true,
	renderer: {
		html(token) {
			return escapeHtml(token.text);
		},
		image(token) {
			return escapeHtml(token.text);
		}
	}
});

const PRINT_CSS = `
@page { size: A4; margin: 22mm 20mm; }
body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; line-height: 1.45; color: #111; }
h1 { font-size: 18pt; margin: 0 0 12pt; }
h2 { font-size: 14pt; margin: 16pt 0 8pt; }
h3, h4, h5, h6 { font-size: 12pt; margin: 12pt 0 6pt; }
p { margin: 0 0 8pt; }
ul, ol { margin: 0 0 8pt; padding-left: 20pt; }
table { border-collapse: collapse; width: 100%; margin: 0 0 10pt; }
th, td { border: 1px solid #555; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #eee; }
`;

export function markdownToHtml(source: string): string {
	const body = markdown.parse(source, { async: false });

	return (
		'<!doctype html><html><head><meta charset="utf-8"><style>' +
		PRINT_CSS +
		'</style></head><body>' +
		body +
		'</body></html>'
	);
}

/**
 * Markdown → HTML → PDF with headless Chromium.
 * ponytail: one browser per render. Keep one open if documents get frequent.
 */
export async function renderPdf(source: string): Promise<Buffer> {
	const browser = await chromium.launch();

	try {
		const context = await browser.newContext({ javaScriptEnabled: false });
		/** Belt and braces: the page may never fetch anything. */
		await context.route('**/*', (route) => route.abort());
		const page = await context.newPage();
		await page.setContent(markdownToHtml(source));

		return await page.pdf({ format: 'A4', printBackground: true });
	} finally {
		await browser.close();
	}
}
