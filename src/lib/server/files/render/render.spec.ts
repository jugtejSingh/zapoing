import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { renderDocx } from './docx';
import { markdownToHtml, renderPdf } from './pdf';
import { renderXlsx } from './xlsx';

const SAMPLE = `# Supply agreement

Payment within **45 days**.

| Item | Price |
| --- | --- |
| Widgets | 120 |
`;

describe('renderPdf', () => {
	it('renders Markdown to a PDF', async () => {
		const pdf = await renderPdf(SAMPLE);

		expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
	}, 60_000);

	it('shows raw HTML and images as text, never as markup', () => {
		const html = markdownToHtml('<script>alert(1)</script>\n\n![logo](https://evil.test/x.png)');

		expect(html).not.toContain('<script>alert');
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;script&gt;');
	});
});

describe('renderDocx', () => {
	it('renders the heading and the table', async () => {
		const docx = await renderDocx(SAMPLE);
		const zip = await JSZip.loadAsync(docx);
		const xml = await zip.file('word/document.xml')?.async('string');

		expect(xml).toContain('Supply agreement');
		expect(xml).toContain('<w:tbl>');
		expect(xml).toContain('Widgets');
		expect(xml).toContain('45 days');
	});
});

describe('renderXlsx', () => {
	it('writes the cells of every sheet', async () => {
		const xlsx = await renderXlsx([
			{
				name: 'Prices',
				rows: [
					['Item', 'Price'],
					['Widgets', 120]
				]
			},
			{ name: 'Prices', rows: [['duplicate name', true]] }
		]);
		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(xlsx as unknown as ArrayBuffer);

		const names: string[] = [];

		for (const sheet of workbook.worksheets) {
			names.push(sheet.name);
		}

		expect(names).toEqual(['Prices', 'Prices 2']);
		expect(workbook.worksheets[0].getCell('A2').value).toBe('Widgets');
		expect(workbook.worksheets[0].getCell('B2').value).toBe(120);
		expect(workbook.worksheets[1].getCell('B1').value).toBe(true);
	});
});
