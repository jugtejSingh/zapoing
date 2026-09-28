import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { toEmail } from './mail';

const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const RAW = [
	'From: Sender <sender@example.com>',
	'To: Reader <reader@example.com>',
	'Subject: Hello',
	'Content-Type: multipart/related; boundary="b1"',
	'',
	'--b1',
	'Content-Type: text/html; charset=utf-8',
	'',
	'<p>Hi</p><img src="cid:logo123">',
	'',
	'--b1',
	'Content-Type: image/png',
	'Content-Transfer-Encoding: base64',
	'Content-ID: <logo123>',
	'Content-Disposition: inline; filename="logo.png"',
	'',
	PNG_BASE64,
	'',
	'--b1',
	'Content-Type: text/plain',
	'Content-Transfer-Encoding: base64',
	'Content-Disposition: attachment; filename="notes.txt"',
	'',
	Buffer.from('real attachment').toString('base64'),
	'',
	'--b1--',
	''
].join('\r\n');

describe('toEmail', () => {
	it('inlines cid images and keeps real attachments', async () => {
		const parsed = await simpleParser(RAW);
		const email = toEmail(7, parsed);

		expect(email.html).toContain('src="data:image/png;base64,');
		expect(email.html).not.toContain('cid:logo123');

		const filenames: string[] = [];

		for (const attachment of email.attachments) {
			filenames.push(attachment.filename);
		}

		expect(filenames).toEqual(['notes.txt']);
	});
});

describe('thread ids', () => {
	async function threadIdFor(headers: string[], serverThreadId?: string): Promise<string> {
		const raw = headers.concat(['', 'body']).join('\r\n');
		const parsed = await simpleParser(raw);

		return toEmail(7, parsed, serverThreadId).threadId;
	}

	it('prefers what the server says', async () => {
		const id = await threadIdFor(['Message-ID: <a@example.com>'], 'thrid-1');

		expect(id).toBe('thrid-1');
	});

	it('uses the root of the reply chain when the server is quiet', async () => {
		const id = await threadIdFor([
			'Message-ID: <c@example.com>',
			'In-Reply-To: <b@example.com>',
			'References: <a@example.com> <b@example.com>'
		]);

		expect(id).toBe('<a@example.com>');
	});

	it('groups a reply with the message it answers', async () => {
		const root = await threadIdFor(['Message-ID: <a@example.com>']);
		const reply = await threadIdFor([
			'Message-ID: <b@example.com>',
			'In-Reply-To: <a@example.com>'
		]);

		expect(reply).toBe(root);
	});
});
