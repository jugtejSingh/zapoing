import { describe, expect, it } from 'vitest';
import { isReadableByAI } from './allowlist';

describe('isReadableByAI', () => {
	it('accepts the document, sheet, text and image types', () => {
		const accepted: [string, string][] = [
			['report.pdf', 'application/pdf'],
			[
				'letter.docx',
				'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
			],
			['numbers.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
			['data.csv', 'text/csv; charset=utf-8'],
			['notes.txt', 'text/plain'],
			['README.MD', 'text/markdown'],
			['photo.JPG', 'image/jpeg'],
			['scan.png', 'image/png']
		];

		for (const [filename, mime] of accepted) {
			expect(isReadableByAI(filename, mime), filename).toBe(true);
		}
	});

	it('rejects executables, archives, scripts and unknown types', () => {
		const rejected: [string, string][] = [
			['setup.exe', 'application/x-msdownload'],
			['bundle.zip', 'application/zip'],
			['script.js', 'text/javascript'],
			['no-extension', 'text/plain'],
			['mystery.bin', 'application/octet-stream']
		];

		for (const [filename, mime] of rejected) {
			expect(isReadableByAI(filename, mime), filename).toBe(false);
		}
	});

	it('rejects a file whose extension and MIME type disagree', () => {
		expect(isReadableByAI('invoice.pdf', 'application/x-msdownload')).toBe(false);
	});
});
