import { Marked } from 'marked';
import { chromium } from 'playwright';
import { hasFooter, hasHeader, type Branding } from '$lib/server/branding';

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

/** The user's font and colour on top of the print styles. The branding values are validated when read. */
function brandingCss(branding: Branding | null): string {
	let css = '';

	if (branding === null) {
		return css;
	}

	if (branding.font.length > 0) {
		css += "body { font-family: '" + branding.font + "', Georgia, serif; }\n";
	}

	if (branding.primaryColor.length > 0) {
		css += 'h1, h2, h3, h4, h5, h6 { color: ' + branding.primaryColor + '; }\n';
		css += 'th { border-color: ' + branding.primaryColor + '; }\n';
	}

	return css;
}

export function markdownToHtml(source: string, branding: Branding | null = null): string {
	const body = markdown.parse(source, { async: false });

	return (
		'<!doctype html><html><head><meta charset="utf-8"><style>' +
		PRINT_CSS +
		brandingCss(branding) +
		'</style></head><body>' +
		body +
		'</body></html>'
	);
}

function headerHtml(branding: Branding): string {
	let html = '<div style="width:100%;padding:0 20mm;font-size:9px;display:flex;align-items:center;justify-content:space-between;">';

	if (branding.logo !== null) {
		const type = branding.logo.type === 'png' ? 'png' : 'jpeg';
		html +=
			'<img style="height:28px;" src="data:image/' +
			type +
			';base64,' +
			branding.logo.data.toString('base64') +
			'" />';
	} else {
		html += '<span></span>';
	}

	html += '<span>' + escapeHtml(branding.headerText) + '</span></div>';

	return html;
}

function footerHtml(branding: Branding): string {
	return (
		'<div style="width:100%;padding:0 20mm;font-size:9px;display:flex;justify-content:space-between;">' +
		'<span>' +
		escapeHtml(branding.footerText) +
		'</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
	);
}

/**
 * Markdown → HTML → PDF with headless Chromium, with the user's font, colour, logo,
 * header and footer when they are set.
 * ponytail: one browser per render. Keep one open if documents get frequent.
 */
export async function renderPdf(source: string, branding: Branding | null = null): Promise<Buffer> {
	// Docker's default seccomp profile blocks Chromium's sandbox; the image sets this. Pages run with
	// JavaScript off and every request aborted (below), which is what keeps this safe.
	const args: string[] = [];

	if (process.env.CHROMIUM_NO_SANDBOX === '1') {
		args.push('--no-sandbox');
	}

	const browser = await chromium.launch({ args });

	try {
		const context = await browser.newContext({ javaScriptEnabled: false });
		/** Belt and braces: the page may never fetch anything. */
		await context.route('**/*', (route) => route.abort());
		const page = await context.newPage();
		await page.setContent(markdownToHtml(source, branding));

		let top = '22mm';
		let bottom = '22mm';
		let headerTemplate = '<span></span>';
		let footerTemplate = '<span></span>';
		let displayHeaderFooter = false;

		if (branding !== null && hasHeader(branding)) {
			top = '32mm';
			headerTemplate = headerHtml(branding);
			displayHeaderFooter = true;
		}

		if (branding !== null && hasFooter(branding)) {
			bottom = '26mm';
			footerTemplate = footerHtml(branding);
			displayHeaderFooter = true;
		}

		return await page.pdf({
			format: 'A4',
			printBackground: true,
			displayHeaderFooter,
			headerTemplate,
			footerTemplate,
			margin: { top, bottom, left: '20mm', right: '20mm' }
		});
	} finally {
		await browser.close();
	}
}
