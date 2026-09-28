import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * 32-byte key, provided as 64 hex characters in CREDENTIALS_KEY.
 * Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
function getKey(): Buffer {
	const value = env.CREDENTIALS_KEY;

	if (!value) {
		throw new Error('CREDENTIALS_KEY is not set');
	}

	const key = Buffer.from(value, 'hex');

	if (key.length !== 32) {
		throw new Error('CREDENTIALS_KEY must be 64 hex characters (32 bytes)');
	}

	return key;
}

/** Encrypts a secret for storage. Output is base64 of iv + tag + ciphertext. */
export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, getKey(), iv);

	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();

	return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Reverses `encryptSecret`. Throws if the payload was tampered with or the key is wrong. */
export function decryptSecret(payload: string): string {
	const raw = Buffer.from(payload, 'base64');

	if (raw.length < IV_LENGTH + TAG_LENGTH) {
		throw new Error('Encrypted payload is too short');
	}

	const iv = raw.subarray(0, IV_LENGTH);
	const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
	const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);

	const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
	decipher.setAuthTag(tag);

	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
