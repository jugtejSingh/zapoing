import { describe, expect, it, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
	return 'paths-spec-' + String(Date.now());
});

vi.mock('$env/dynamic/private', async () => {
	const fs = await import('node:fs');
	const os = await import('node:os');
	const nodePath = await import('node:path');
	const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), dataDir));

	return { env: { DATA_DIR: dir } };
});

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { attachmentFilePath, dataDir as root } from './paths';

const RECEIVED = new Date(Date.UTC(2026, 2, 5, 23, 30));

function relative(full: string): string {
	return path.relative(root(), full).split(path.sep).join('/');
}

describe('attachmentFilePath', () => {
	it('keeps a received file under the sender and the day it arrived', async () => {
		const target = await attachmentFilePath('anna@acme.test', RECEIVED, 'Contract.docx');

		expect(relative(target)).toBe('attachments/anna_acme_test/2026-03-05/Contract.docx');
	});

	it('keeps every letter of the file name, including p, c and C', async () => {
		const target = await attachmentFilePath('anna@acme.test', RECEIVED, 'Copy of Price {C}.pdf');

		expect(path.basename(target)).toBe('Copy of Price {C}.pdf');
	});

	it('replaces the characters a file system does not allow', async () => {
		const target = await attachmentFilePath('anna@acme.test', RECEIVED, 'ab:c*d?e"f<g>h|i.pdf');

		expect(path.basename(target)).toBe('ab_c_d_e_f_g_h_i.pdf');
	});

	it('cannot leave the day folder through the file name', async () => {
		const target = await attachmentFilePath('anna@acme.test', RECEIVED, '../../../etc/passwd.txt');

		expect(relative(target)).toBe('attachments/anna_acme_test/2026-03-05/passwd.txt');
	});

	it('cannot leave the folder through the sender either', async () => {
		const target = await attachmentFilePath('../../evil@acme.test', RECEIVED, 'Notes.docx');

		expect(relative(target).startsWith('attachments/')).toBe(true);
		expect(relative(target)).not.toContain('..');
	});

	it('numbers a second file with the same name on the same day instead of replacing it', async () => {
		const first = await attachmentFilePath('anna@acme.test', RECEIVED, 'Prices.xlsx');
		await writeFile(first, 'one');
		const second = await attachmentFilePath('anna@acme.test', RECEIVED, 'Prices.xlsx');
		await writeFile(second, 'two');
		const third = await attachmentFilePath('anna@acme.test', RECEIVED, 'Prices.xlsx');

		expect(path.basename(first)).toBe('Prices.xlsx');
		expect(path.basename(second)).toBe('Prices (2).xlsx');
		expect(path.basename(third)).toBe('Prices (3).xlsx');
	});

	it('uses another folder for another day or another person', async () => {
		const nextDay = await attachmentFilePath(
			'anna@acme.test',
			new Date(Date.UTC(2026, 2, 6)),
			'Prices.xlsx'
		);
		const other = await attachmentFilePath('bob@acme.test', RECEIVED, 'Prices.xlsx');

		expect(relative(nextDay)).toBe('attachments/anna_acme_test/2026-03-06/Prices.xlsx');
		expect(relative(other)).toBe('attachments/bob_acme_test/2026-03-05/Prices.xlsx');
	});
});
