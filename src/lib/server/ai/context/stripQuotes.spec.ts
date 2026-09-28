import { describe, expect, it } from 'vitest';
import { stripQuotes } from './stripQuotes';

describe('stripQuotes', () => {
	it('drops a Gmail quote and everything under it', () => {
		const body = [
			'Sounds good, Thursday works.',
			'',
			'On Tue, 3 Mar 2026 at 10:00, Ann <ann@x.com> wrote:',
			'> Can we meet Thursday?',
			'> Ann'
		].join('\n');

		expect(stripQuotes(body)).toBe('Sounds good, Thursday works.');
	});

	it('handles a Gmail header wrapped over two lines', () => {
		const body = ['Yes.', 'On Tue, 3 Mar 2026 at 10:00, Ann Long-Name', '<ann@x.com> wrote:', '> Question?'].join(
			'\n'
		);

		expect(stripQuotes(body)).toBe('Yes.');
	});

	it('drops an Outlook From/Sent block', () => {
		const body = [
			'Attached is the contract.',
			'',
			'From: Bob Smith <bob@y.com>',
			'Sent: Monday, March 2, 2026 9:00 AM',
			'To: Me',
			'Subject: Contract',
			'',
			'Please send the contract.'
		].join('\n');

		expect(stripQuotes(body)).toBe('Attached is the contract.');
	});

	it('drops an Original Message separator', () => {
		const body = ['Done.', '-----Original Message-----', 'From: bob@y.com', 'Old text'].join('\n');

		expect(stripQuotes(body)).toBe('Done.');
	});

	it('keeps a From: line that is not an Outlook header', () => {
		const body = 'From: the team, thanks for everything.\nSee you soon.';

		expect(stripQuotes(body)).toBe(body);
	});

	it('drops stray > lines inline', () => {
		expect(stripQuotes('> quoted\nreply')).toBe('reply');
	});
});
