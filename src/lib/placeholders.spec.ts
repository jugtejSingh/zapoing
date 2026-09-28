import { describe, expect, it } from 'vitest';
import { fillPlaceholder, hasPlaceholders, listPlaceholders, nextPlaceholderRange } from './placeholders';

const DRAFT = 'Free from [[start-time]] to [[end-time]] on [[date]]. See you at [[start-time]].';

describe('placeholders', () => {
	it('lists each name once, in order', () => {
		expect(listPlaceholders(DRAFT)).toEqual(['start-time', 'end-time', 'date']);
	});

	it('ignores single brackets and empty text', () => {
		expect(listPlaceholders('see [link] and [[ ]]x')).toEqual([]);
		expect(hasPlaceholders('no gaps here')).toBe(false);
		expect(hasPlaceholders(DRAFT)).toBe(true);
	});

	it('fills every use of a name at once', () => {
		const filled = fillPlaceholder(DRAFT, 'start-time', '10:00');
		expect(filled).toBe('Free from 10:00 to [[end-time]] on [[date]]. See you at 10:00.');
		expect(listPlaceholders(filled)).toEqual(['end-time', 'date']);
	});

	it('finds the next placeholder and wraps around', () => {
		const first = nextPlaceholderRange(DRAFT, 0);
		expect(first).not.toBeNull();
		expect(DRAFT.slice(first!.start, first!.end)).toBe('[[start-time]]');

		const second = nextPlaceholderRange(DRAFT, first!.end);
		expect(DRAFT.slice(second!.start, second!.end)).toBe('[[end-time]]');

		const wrapped = nextPlaceholderRange(DRAFT, DRAFT.length);
		expect(wrapped).toEqual(first);
		expect(nextPlaceholderRange('nothing', 0)).toBeNull();
	});
});
