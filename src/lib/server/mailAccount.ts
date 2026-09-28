import { and, asc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { mailAccount } from '$lib/server/db/schema';
import { encryptSecret, decryptSecret } from '$lib/server/crypto';

/** An account as the browser may see it: no password, encrypted or otherwise. */
export type SafeMailAccount = {
	id: string;
	label: string | null;
	host: string;
	port: number;
	username: string;
	createdAt: Date;
};

export type NewMailAccount = {
	label: string | null;
	host: string;
	port: number;
	secure: boolean;
	username: string;
	password: string;
	/** Null or omitted means derive it from the IMAP host. */
	smtpHost?: string | null;
	/** Null or omitted means 465. */
	smtpPort?: number | null;
};

/** Credentials ready to hand to an IMAP client. */
export type MailAccountCredentials = {
	id: string;
	host: string;
	port: number;
	secure: boolean;
	username: string;
	password: string;
	smtpHost: string | null;
	smtpPort: number | null;
};

/** Every account belonging to a user, oldest first. Never includes the password. */
export async function listMailAccounts(userId: string): Promise<SafeMailAccount[]> {
	return db
		.select({
			id: mailAccount.id,
			label: mailAccount.label,
			host: mailAccount.host,
			port: mailAccount.port,
			username: mailAccount.username,
			createdAt: mailAccount.createdAt
		})
		.from(mailAccount)
		.where(eq(mailAccount.userId, userId))
		.orderBy(asc(mailAccount.createdAt));
}

/**
 * One account with its password decrypted, or null if it is not this user's.
 * Always look accounts up through this so an id from the URL cannot cross users.
 */
export async function getMailAccountCredentials(
	userId: string,
	accountId: string
): Promise<MailAccountCredentials | null> {
	const rows = await db
		.select()
		.from(mailAccount)
		.where(and(eq(mailAccount.id, accountId), eq(mailAccount.userId, userId)))
		.limit(1);

	if (rows.length === 0) {
		return null;
	}

	const row = rows[0];

	return {
		id: row.id,
		host: row.host,
		port: row.port,
		secure: row.secure,
		username: row.username,
		password: decryptSecret(row.password),
		smtpHost: row.smtpHost,
		smtpPort: row.smtpPort
	};
}

/**
 * Every connected account with its password decrypted, oldest first. For the
 * background sync only — it runs for the whole (single-user, local) app, so it
 * is not scoped to a user. Never hand this to the browser.
 */
export async function listAllMailAccountCredentials(): Promise<MailAccountCredentials[]> {
	const rows = await db.select().from(mailAccount).orderBy(asc(mailAccount.createdAt));
	const accounts: MailAccountCredentials[] = [];

	for (const row of rows) {
		accounts.push({
			id: row.id,
			host: row.host,
			port: row.port,
			secure: row.secure,
			username: row.username,
			password: decryptSecret(row.password),
			smtpHost: row.smtpHost,
			smtpPort: row.smtpPort
		});
	}

	return accounts;
}

/** Stores a new account, encrypting the password on the way in. */
export async function createMailAccount(userId: string, input: NewMailAccount): Promise<void> {
	await db.insert(mailAccount).values({
		userId,
		label: input.label,
		host: input.host,
		port: input.port,
		secure: input.secure,
		username: input.username,
		password: encryptSecret(input.password),
		smtpHost: input.smtpHost ?? null,
		smtpPort: input.smtpPort ?? null
	});
}
