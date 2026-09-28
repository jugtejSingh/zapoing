import { error } from '@sveltejs/kit';
import { getOwnedRunOutput } from '$lib/server/ai/agentRun';
import type { RequestHandler } from './$types';

/** The model's raw reply for one agent run, as plain text for the log viewer. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		error(401, 'Not signed in');
	}

	const output = await getOwnedRunOutput(locals.user.id, params.id);

	if (output === null) {
		error(404, 'No output for this run');
	}

	return new Response(output, {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'private, no-store'
		}
	});
};
