import { redirect, type Handle, type ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { registerDraftingAgent } from '$lib/server/ai/agents/drafting';
import { registerMemoryAgent } from '$lib/server/ai/agents/memory';
import { registerTemplateAgent } from '$lib/server/ai/agents/template';
import { registerIngestion } from '$lib/server/files/ingest';
import { ingestMissingFiles, registerFileIngest } from '$lib/server/fileIndex';
import { relocateAttachments } from '$lib/server/files/documents';
import { auth } from '$lib/server/auth';
import { startJobWorker } from '$lib/server/jobs/worker';
import { startSyncWorker } from '$lib/server/syncWorker';
import { svelteKitHandler } from 'better-auth/svelte-kit';

/** Mail sync and the job runner start with the Node server and stop when it stops. */
export const init: ServerInit = async () => {
	if (building) {
		return;
	}

	registerMemoryAgent();
	registerDraftingAgent();
	registerIngestion();
	registerTemplateAgent();
	registerFileIngest();
	startSyncWorker();
	await startJobWorker();

	relocateAttachments()
		.then(() => ingestMissingFiles())
		.catch((caught: unknown) => {
			console.error('Indexing files failed', caught);
		});
};

/** Routes reachable without a session. Everything else redirects to the login page. */
const PUBLIC_PATHS = ['/', '/register'];

function isPublic(pathname: string): boolean {
	if (pathname.startsWith('/api/auth')) {
		return true;
	}

	for (const path of PUBLIC_PATHS) {
		if (pathname === path) {
			return true;
		}
	}

	return false;
}

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const requestStart = Date.now();
	console.log('[request] ' + event.request.method + ' ' + event.url.pathname + ': started');

	const sessionStart = Date.now();
	const session = await auth.api.getSession({ headers: event.request.headers });
	console.log(
		'[request] ' +
			event.request.method +
			' ' +
			event.url.pathname +
			': getSession took ' +
			(Date.now() - sessionStart) +
			'ms'
	);

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}

	if (!session && !isPublic(event.url.pathname)) {
		redirect(302, '/');
	}

	const resolveStart = Date.now();
	const response = await svelteKitHandler({ event, resolve, auth, building });

	console.log(
		'[request] ' +
			event.request.method +
			' ' +
			event.url.pathname +
			': load/actions + render took ' +
			(Date.now() - resolveStart) +
			'ms, total ' +
			(Date.now() - requestStart) +
			'ms, status ' +
			response.status
	);

	return response;
};

export const handle: Handle = handleBetterAuth;
