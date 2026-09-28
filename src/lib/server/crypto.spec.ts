import { describe, it, expect, vi, beforeAll } from 'vitest';

const KEY = 'a'.repeat(64);

vi.mock('$env/dynamic/private', () => ({ env: { CREDENTIALS_KEY: KEY } }));

let encryptSecret: typeof import('./crypto').encryptSecret;
let decryptSecret: typeof import('./crypto').decryptSecret;

beforeAll(async () => {
	const mod = await import('./crypto');
	encryptSecret = mod.encryptSecret;
	decryptSecret = mod.decryptSecret;
});

describe('secret encryption', () => {
	it('round-trips a password', () => {
		const secret = 'hunter2-with-üñïçødé';

		expect(decryptSecret(encryptSecret(secret))).toBe(secret);
	});

	it('produces different ciphertext each time', () => {
		expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
	});

	it('rejects tampered payloads', () => {
		const raw = Buffer.from(encryptSecret('secret'), 'base64');
		raw[raw.length - 1] = raw[raw.length - 1] ^ 0xff;

		expect(() => decryptSecret(raw.toString('base64'))).toThrow();
	});
});
