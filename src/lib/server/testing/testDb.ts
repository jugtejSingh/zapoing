/**
 * Helpers for specs that run against the real schema. The spec must mock
 * `$env/dynamic/private` with DATABASE_URL ':memory:' before this is imported,
 * so every spec file gets its own throwaway database.
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '$lib/server/db';
import {
	document,
	generatedFile,
	template,
	resource,
	documentVersion,
	agentRun,
	contact,
	draft,
	email,
	job,
	mailAccount,
	mailboxState,
	summaryVersion,
	thread,
	user
} from '$lib/server/db/schema';
import {
	createMailAccount,
	listAllMailAccountCredentials,
	type MailAccountCredentials
} from '$lib/server/mailAccount';

/** Applies the real migrations, so the tests also prove they run cleanly on an empty database. */
export function migrateTestDb(): void {
	migrate(db, { migrationsFolder: 'drizzle' });
}

export async function resetTestDb(): Promise<void> {
	await db.delete(generatedFile);
	await db.delete(template);
	await db.delete(resource);
	await db.delete(documentVersion);
	await db.delete(document);
	await db.delete(agentRun);
	await db.delete(draft);
	await db.delete(job);
	await db.delete(summaryVersion);
	await db.delete(thread);
	await db.delete(contact);
	await db.delete(email);
	await db.delete(mailboxState);
	await db.delete(mailAccount);
	await db.delete(user);
}

export async function createTestUser(id: string): Promise<void> {
	await db.insert(user).values({ id, name: id, email: id + '@example.com' });
}

/** Connects a mailbox the way the settings form does, and returns it as the worker sees it. */
export async function createTestAccount(
	userId: string,
	username: string,
	label: string | null = null
): Promise<MailAccountCredentials> {
	await createMailAccount(userId, {
		label,
		host: 'imap.example.com',
		port: 993,
		secure: true,
		username,
		password: 'secret'
	});

	for (const account of await listAllMailAccountCredentials()) {
		if (account.username === username) {
			return account;
		}
	}

	throw new Error('Account was not stored');
}
