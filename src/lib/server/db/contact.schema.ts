import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { user } from './auth.schema';
import { mailAccount } from './mail.schema';

/**
 * A person the user emails. `tracked` opts them into AI work (memory summaries,
 * drafts). The running summary itself lives on disk under data/contacts/<id>/.
 */
export const contact = sqliteTable(
	'contact',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		name: text('name'),
		company: text('company'),
		/** Lowercased addresses. The first one is the primary address. */
		emails: text('emails', { mode: 'json' }).$type<string[]>().notNull().default([]),
		tracked: integer('tracked', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(table) => [index('contact_userId_idx').on(table.userId)]
);

/** One conversation per account, kept in step with the email table by sync. */
export const thread = sqliteTable(
	'thread',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		accountId: text('account_id')
			.notNull()
			.references(() => mailAccount.id, { onDelete: 'cascade' }),
		threadId: text('thread_id').notNull(),
		subject: text('subject').notNull().default(''),
		firstAt: integer('first_at', { mode: 'timestamp_ms' }),
		lastAt: integer('last_at', { mode: 'timestamp_ms' }),
		contactId: text('contact_id').references(() => contact.id, { onDelete: 'set null' })
	},
	(table) => [unique('thread_unique').on(table.accountId, table.threadId)]
);

/** Every summary.md that was replaced, with the file it was archived to. */
export const summaryVersion = sqliteTable(
	'summary_version',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		contactId: text('contact_id')
			.notNull()
			.references(() => contact.id, { onDelete: 'cascade' }),
		path: text('path').notNull(),
		reason: text('reason', { enum: ['update', 'rebuild', 'user_edit'] }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(table) => [index('summary_version_contactId_idx').on(table.contactId)]
);
