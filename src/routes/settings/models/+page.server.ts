import { error, fail, redirect } from '@sveltejs/kit';
import {
	AGENTS,
	clearApiKey,
	DEFAULT_MODEL,
	MAX_THREAD_BUDGET_TOKENS,
	MIN_THREAD_BUDGET_TOKENS,
	modelSettingsView,
	ModelSettingsInputError,
	saveModelSettings,
	type Agent
} from '$lib/server/ai/modelSettings';
import type { Actions, PageServerLoad } from './$types';

function field(formData: FormData, name: string): string {
	const value = formData.get(name);

	if (typeof value !== 'string') {
		return '';
	}

	return value;
}

/** ponytail: settings are app-wide (single-user install); any signed-in user may change them. */
export const load: PageServerLoad = async (event) => {
	if (!event.locals.user) {
		redirect(302, '/');
	}

	return {
		settings: modelSettingsView(),
		agents: [...AGENTS],
		defaultModel: DEFAULT_MODEL,
		minBudget: MIN_THREAD_BUDGET_TOKENS,
		maxBudget: MAX_THREAD_BUDGET_TOKENS
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		const formData = await request.formData();
		const models: Partial<Record<Agent, string>> = {};

		for (const agent of AGENTS) {
			models[agent] = field(formData, 'model-' + agent);
		}

		try {
			await saveModelSettings({
				apiKey: field(formData, 'apiKey'),
				models,
				threadBudgetTokens: field(formData, 'threadBudgetTokens')
			});
		} catch (caught) {
			if (caught instanceof ModelSettingsInputError) {
				return fail(400, { message: caught.message });
			}

			throw caught;
		}

		return { message: 'Settings saved' };
	},

	clearKey: async ({ locals }) => {
		if (!locals.user) {
			error(401, 'Not signed in');
		}

		await clearApiKey();

		return { message: 'API key removed' };
	}
};
