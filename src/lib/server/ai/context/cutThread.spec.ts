import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(path.join(tmpdir(), 'zapoing-cut-'));

vi.mock('$env/dynamic/private', () => ({ env: { DATA_DIR: dataDir } }));

const { cutThread, logThreadCut } = await import('./cutThread');

function message(id: string, chars: number) {
	return { id, from: '', date: null, text: 'x'.repeat(chars) };
}

describe('cutThread', () => {
	it('keeps everything when the thread fits', () => {
		const cut = cutThread([message('a', 40), message('b', 40)], 'b', 100);

		expect(cut.droppedIds).toEqual([]);
		expect(cut.kept.length).toBe(2);
	});

	it('keeps the first and reply-to messages and drops the oldest of the rest', () => {
		// 100 tokens each, budget fits three.
		const thread = [message('first', 400), message('m2', 400), message('m3', 400), message('m4', 400), message('reply', 400)];
		const cut = cutThread(thread, 'reply', 300);

		expect(cut.droppedIds).toEqual(['m2', 'm3']);
		const keptIds: string[] = [];
		for (const kept of cut.kept) {
			keptIds.push(kept.id);
		}
		expect(keptIds).toEqual(['first', 'm4', 'reply']);
	});

	it('never drops the reply-to message even when it sits in the middle', () => {
		const thread = [message('first', 400), message('reply', 400), message('m3', 400)];
		const cut = cutThread(thread, 'reply', 100);

		expect(cut.droppedIds).toEqual(['m3']);
	});

	it('strips quotes before counting', () => {
		const quoted = { id: 'q', from: '', date: null, text: 'Hi\nOn Mon, Ann wrote:\n' + '> old\n'.repeat(500) };
		const cut = cutThread([message('first', 4), quoted], 'q', 10);

		expect(cut.droppedIds).toEqual([]);
		expect(cut.kept[1].text).toBe('Hi');
	});

	it('logs a JSON line only when something was cut', async () => {
		const logFile = path.join(dataDir, 'logs', 'agents', 'thread-cuts.jsonl');
		const thread = [message('first', 400), message('m2', 400), message('reply', 400)];

		await logThreadCut('memory', 'c1', cutThread(thread, 'reply', 1000));
		await logThreadCut('memory', 'c1', cutThread(thread, 'reply', 200));

		const lines = readFileSync(logFile, 'utf8').trim().split('\n');
		expect(lines.length).toBe(1);
		expect(JSON.parse(lines[0])).toMatchObject({ agent: 'memory', contactId: 'c1', droppedIds: ['m2'] });
	});
});
