import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import DraftPane from '$lib/components/draft/DraftPane.svelte';
import type { ThreadDrafts } from '$lib/types';

describe('DraftPane', () => {
	it('shows the chat with the planner', async () => {
		const drafts: ThreadDrafts = {
			active: {
				id: 'd1',
				body: 'Hello',
				messages: [
					{ id: 'm1', role: 'user', content: 'Make it shorter' },
					{ id: 'm2', role: 'assistant', content: 'Shortened the reply.' }
				],
				files: [],
				conflicts: []
			},
			skippedReason: null,
			pendingCount: 1,
			latestWaitingId: 'e1',
			canDraft: true
		};
		render(DraftPane, { drafts });

		await expect.element(page.getByText('Make it shorter')).toBeInTheDocument();
		await expect.element(page.getByText('Shortened the reply.')).toBeInTheDocument();
	});
});
