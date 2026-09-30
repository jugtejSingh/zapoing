import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const WINDOWS_INSTALL = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
const CONVERT_TIMEOUT_MS = 60_000;

/** On PATH on Linux; the Windows installer does not add it. */
function sofficeCommand(): string {
	if (process.platform === 'win32' && existsSync(WINDOWS_INSTALL)) {
		return WINDOWS_INSTALL;
	}

	return 'soffice';
}

/**
 * Word → PDF with headless LibreOffice, so headers, footers and layout stay.
 * Throws when LibreOffice is missing or fails: the caller must not send the docx instead.
 * ponytail: one process per file, own profile dir so parallel runs never lock each other.
 */
export async function docxToPdf(docx: Buffer): Promise<Buffer> {
	const dir = await mkdtemp(path.join(tmpdir(), 'zapoing-pdf-'));

	try {
		const input = path.join(dir, 'file.docx');
		const profile = 'file:///' + path.join(dir, 'profile').replace(/\\/g, '/');
		await writeFile(input, docx);

		try {
			await run(
				sofficeCommand(),
				[
					'-env:UserInstallation=' + profile,
					'--headless',
					'--convert-to',
					'pdf',
					'--outdir',
					dir,
					input
				],
				{ timeout: CONVERT_TIMEOUT_MS }
			);
		} catch (caught) {
			console.error('LibreOffice conversion failed:', caught);
			throw new Error('Could not convert the Word file to PDF. Is LibreOffice installed?', {
				cause: caught
			});
		}

		return await readFile(path.join(dir, 'file.pdf'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
