import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import DraftSummary from '$lib/components/draft/DraftSummary.svelte';
import type { DraftFile, ThreadDrafts } from '$lib/types';

function fileWith(overrides: Partial<DraftFile>): DraftFile {
	const base: DraftFile = {
		id: 'f1',
		filename: 'Supply agreement.docx',
		change: 'A supply agreement',
		changeNote: '- Term: 1 year',
		error: null,
		isNewDocument: true,
		placeholders: [],
		sendAsPdf: false
	};

	return { ...base, ...overrides };
}

function draftsWith(overrides: Partial<NonNullable<ThreadDrafts['active']>>): ThreadDrafts {
	return {
		active: {
			id: 'd1',
			body: 'Hello',
			messages: [],
			files: [],
			conflicts: [],
			...overrides
		},
		skippedReason: null,
		pendingCount: 1,
		latestWaitingId: 'e1',
		canDraft: true
	};
}

describe('DraftSummary', () => {
	it('shows the documents and the draft controls', async () => {
		render(DraftSummary, { drafts: draftsWith({ files: [fileWith({})] }) });

		await expect.element(page.getByText('Supply agreement.docx')).toBeInTheDocument();
		await expect.element(page.getByText('1 draft for this thread')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
	});

	it('shows a failed file with why it failed', async () => {
		render(DraftSummary, {
			drafts: draftsWith({ files: [fileWith({ error: 'LibreOffice is not installed' })] })
		});

		await expect.element(page.getByText(/LibreOffice is not installed/)).toBeInTheDocument();
	});

	it('shows where the resources disagreed', async () => {
		render(DraftSummary, {
			drafts: draftsWith({ conflicts: ['2025 says 40 EUR/h, 2026 says 45 EUR/h'] })
		});

		await expect.element(page.getByText(/Resources disagree/)).toBeInTheDocument();
	});

		it('offers Draft anyway when there is no draft', async () => {
		const drafts: ThreadDrafts = {
			active: null,
			skippedReason: 'Only a thank you',
			pendingCount: 0,
			latestWaitingId: 'e1',
			canDraft: true
		};
		render(DraftSummary, { drafts });

		await expect.element(page.getByText(/Only a thank you/)).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Draft anyway' })).toBeInTheDocument();
	});

	it('offers Merge when several drafts are waiting', async () => {
		const drafts = draftsWith({});
		drafts.pendingCount = 3;
		render(DraftSummary, { drafts });

		await expect.element(page.getByText('3 drafts, showing the newest')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Merge into one' })).toBeInTheDocument();
	});
});
