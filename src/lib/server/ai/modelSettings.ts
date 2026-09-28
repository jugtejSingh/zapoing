import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { decryptSecret, encryptSecret } from '$lib/server/crypto';
import { modelSettingsPath } from '$lib/server/storage/paths';

/** Decision L: GLM 5.3 Flash by default. */
export const DEFAULT_MODEL = 'glm-5.3-flash';
export const DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4';
export const DEFAULT_THREAD_BUDGET_TOKENS = 8000;
export const MIN_THREAD_BUDGET_TOKENS = 1000;
export const MAX_THREAD_BUDGET_TOKENS = 200000;

export const AGENTS = [
	'triage',
	'context',
	'drafting',
	'memory',
	'ingestion',
	'document',
	'template'
] as const;

export type Agent = (typeof AGENTS)[number];

/** What is on disk. The API key is only ever stored encrypted. */
type StoredSettings = {
	apiKeyEncrypted: string | null;
	baseUrl: string | null;
	models: Partial<Record<Agent, string>>;
	threadBudgetTokens: number | null;
};

/** Thrown for anything the user can fix on the settings page. */
export class ModelSettingsInputError extends Error {}

function emptySettings(): StoredSettings {
	return { apiKeyEncrypted: null, baseUrl: null, models: {}, threadBudgetTokens: null };
}

/**
 * ponytail: read from disk on every model call; the file is tiny. Cache it if
 * that ever shows up in a profile. App-wide, like the user profile: one user.
 */
function readStored(): StoredSettings {
	let text: string;

	try {
		text = readFileSync(modelSettingsPath(), 'utf8');
	} catch {
		return emptySettings();
	}

	const settings = emptySettings();
	Object.assign(settings, JSON.parse(text) as Partial<StoredSettings>);

	return settings;
}

async function writeStored(settings: StoredSettings): Promise<void> {
	const file = modelSettingsPath();
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(settings, null, '\t'), 'utf8');
}

function storedApiKey(settings: StoredSettings): string | null {
	if (settings.apiKeyEncrypted === null) {
		return null;
	}

	return decryptSecret(settings.apiKeyEncrypted);
}

/** Where one model call goes: saved settings first, then the env, then the defaults. */
export function modelConfig(agent: Agent): {
	apiKey: string | null;
	baseUrl: string;
	model: string;
} {
	const settings = readStored();
	let apiKey = storedApiKey(settings);

	if (apiKey === null && env.MODEL_API_KEY) {
		apiKey = env.MODEL_API_KEY;
	}

	let baseUrl = DEFAULT_BASE_URL;

	if (settings.baseUrl !== null) {
		baseUrl = settings.baseUrl;
	} else if (env.MODEL_BASE_URL) {
		baseUrl = env.MODEL_BASE_URL;
	}

	return {
		apiKey,
		baseUrl: baseUrl.replace(/\/+$/, ''),
		model: settings.models[agent] ?? DEFAULT_MODEL
	};
}

export function threadBudgetTokens(): number {
	const stored = readStored().threadBudgetTokens;

	if (stored !== null) {
		return stored;
	}

	const parsed = Number(env.THREAD_BUDGET_TOKENS);

	if (Number.isFinite(parsed) && parsed > 0) {
		return parsed;
	}

	return DEFAULT_THREAD_BUDGET_TOKENS;
}

/** What the settings page may show. Never the key itself. */
export type ModelSettingsView = {
	keySource: 'settings' | 'env' | 'none';
	/** The last 4 characters of a saved key, so the user can tell which one it is. */
	keyEnding: string | null;
	baseUrl: string;
	models: Record<Agent, string>;
	threadBudgetTokens: number | null;
};

export function modelSettingsView(): ModelSettingsView {
	const settings = readStored();
	let keySource: ModelSettingsView['keySource'] = 'none';
	let keyEnding: string | null = null;

	if (settings.apiKeyEncrypted !== null) {
		keySource = 'settings';
		keyEnding = (storedApiKey(settings) ?? '').slice(-4);
	} else if (env.MODEL_API_KEY) {
		keySource = 'env';
	}

	const models = {} as Record<Agent, string>;

	for (const agent of AGENTS) {
		models[agent] = settings.models[agent] ?? '';
	}

	return {
		keySource,
		keyEnding,
		baseUrl: settings.baseUrl ?? '',
		models,
		threadBudgetTokens: settings.threadBudgetTokens
	};
}

/** https only, so the key and the email content are never sent in the clear. Local servers may use http. */
function checkBaseUrl(value: string): string {
	let url: URL;

	try {
		url = new URL(value);
	} catch {
		throw new ModelSettingsInputError('The base URL is not a valid URL');
	}

	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
		throw new ModelSettingsInputError('The base URL must use https (http only for localhost)');
	}

	if (url.username !== '' || url.password !== '') {
		throw new ModelSettingsInputError('Put the API key in its own field, not in the URL');
	}

	return url.toString().replace(/\/+$/, '');
}

function checkBudget(value: string): number | null {
	if (value.trim().length === 0) {
		return null;
	}

	const parsed = Number(value);

	if (
		!Number.isInteger(parsed) ||
		parsed < MIN_THREAD_BUDGET_TOKENS ||
		parsed > MAX_THREAD_BUDGET_TOKENS
	) {
		throw new ModelSettingsInputError(
			'The thread budget must be a whole number from ' +
				String(MIN_THREAD_BUDGET_TOKENS) +
				' to ' +
				String(MAX_THREAD_BUDGET_TOKENS)
		);
	}

	return parsed;
}

/**
 * Saves the page. A blank API key keeps the saved one; blank fields fall back
 * to the env and the defaults. Everything is checked before anything is written.
 */
export async function saveModelSettings(input: {
	apiKey: string;
	baseUrl: string;
	models: Partial<Record<Agent, string>>;
	threadBudgetTokens: string;
}): Promise<void> {
	const settings = readStored();
	const apiKey = input.apiKey.trim();

	if (/\s/.test(apiKey)) {
		throw new ModelSettingsInputError('The API key cannot contain spaces');
	}

	let baseUrl: string | null = null;

	if (input.baseUrl.trim().length > 0) {
		baseUrl = checkBaseUrl(input.baseUrl.trim());
	}

	const threadBudget = checkBudget(input.threadBudgetTokens);
	const models: Partial<Record<Agent, string>> = {};

	for (const agent of AGENTS) {
		const model = (input.models[agent] ?? '').trim().slice(0, 200);

		if (model.length > 0) {
			models[agent] = model;
		}
	}

	if (apiKey.length > 0) {
		settings.apiKeyEncrypted = encryptSecret(apiKey);
	}

	settings.baseUrl = baseUrl;
	settings.models = models;
	settings.threadBudgetTokens = threadBudget;
	await writeStored(settings);
}

/** Removes the saved key; calls fall back to MODEL_API_KEY from the env, if set. */
export async function clearApiKey(): Promise<void> {
	const settings = readStored();
	settings.apiKeyEncrypted = null;
	await writeStored(settings);
}
