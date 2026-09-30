import { describe, expect, it } from 'vitest';
import { cleanColor, cleanFont, readLogo, type Branding } from '$lib/server/branding';
import { renderDocx } from '$lib/server/files/render/docx';
import { markdownToHtml } from '$lib/server/files/render/pdf';

/** A 2x1 PNG header is enough: only the signature and the size are read. */
function tinyPng(): Buffer {
	const data = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
	data.writeUInt32BE(2, 16);
	data.writeUInt32BE(1, 20);

	return data;
}

const branding: Branding = {
	font: 'Calibri',
	primaryColor: '#1a4d8f',
	headerText: 'Acme Ltd',
	footerText: 'Acme Ltd, London',
	logo: null
};

describe('branding', () => {
	it('keeps a hex colour and a plain font, drops anything else', () => {
		expect(cleanColor('#1a4d8f')).toBe('#1a4d8f');
		expect(cleanColor('red; } body { display:none')).toBe('');
		expect(cleanFont('Open Sans')).toBe('Open Sans');
		expect(cleanFont("x'; } body {")).toBe('');
	});

	it('reads a PNG logo and refuses other files', () => {
		expect(readLogo(tinyPng())).toMatchObject({ type: 'png', width: 2, height: 1 });
		expect(readLogo(Buffer.from('not an image'))).toBeNull();
	});

	it('puts the font and colour into the PDF page and leaves them out when unset', () => {
		expect(markdownToHtml('# Hi', branding)).toContain("font-family: 'Calibri'");
		expect(markdownToHtml('# Hi', branding)).toContain('#1a4d8f');
		expect(markdownToHtml('# Hi')).not.toContain('Calibri');
	});

	it('makes a Word file with a header and footer', async () => {
		const withLogo: Branding = { ...branding, logo: { ...readLogo(tinyPng())!, data: tinyPng() } };
		const docx = await renderDocx('# Hi', withLogo);

		expect(docx.subarray(0, 2).toString()).toBe('PK');
	});
});
