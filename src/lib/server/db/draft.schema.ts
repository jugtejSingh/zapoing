import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { contact } from './contact.schema';
import { email } from './mail.schema';

/**
 * An AI reply to one incoming email, or to several when merged.
 * - pending: waiting for the user
 * - skipped: the model decided no reply is needed (`reason` says why)
 * - merged: folded into a merged draft, kept for the record
 * - sent / discarded: done with
 */
export const draft = sqliteTable(
	'draft',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		/** The email the draft replies to. For a merge, the latest one it covers. */
		emailId: text('email_id')
			.notNull()
			.references(() => email.id, { onDelete: 'cascade' }),
		contactId: text('contact_id')
			.notNull()
			.references(() => contact.id, { onDelete: 'cascade' }),
		status: text('status', { enum: ['pending', 'skipped', 'merged', 'sent', 'discarded'] })
			.default('pending')
			.notNull(),
		body: text('body').notNull().default(''),
		placeholders: text('placeholders', { mode: 'json' }).$type<string[]>().notNull().default([]),
		/** The model's one-line reason: why a reply was or was not needed. */
		reason: text('reason'),
		/** What the email(s) asked for, one short line each, as the model read them. */
		intents: text('intents', { mode: 'json' }).$type<string[]>().notNull().default([]),
		/** Every email this draft answers: just emailId, or all the merged ones. */
		coversEmailIds: text('covers_email_ids', { mode: 'json' })
			.$type<string[]>()
			.notNull()
			.default([]),
		/** Whether the thread was cut to fit the budget when this was written. */
		threadCut: integer('thread_cut', { mode: 'boolean' }).notNull().default(false),
		/** The user's regenerate instruction, e.g. "make it shorter". */
		instruction: text('instruction'),
		/** The resources sent with the draft, named as they were then so a later delete keeps the record. */
		resources: text('resources', { mode: 'json' })
			.$type<{ id: string; name: string }[]>()
			.notNull()
			.default([]),
		/** Where the resources disagreed, as the model reported it. The newest one was used. */
		conflicts: text('conflicts', { mode: 'json' }).$type<string[]>().notNull().default([]),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [
		index('draft_emailId_idx').on(table.emailId),
		index('draft_status_idx').on(table.status)
	]
);

/** One row per model call an agent makes, so failures and slow calls are easy to find. */
export const agentRun = sqliteTable('agent_run', {
	id: text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	agent: text('agent').notNull(),
	emailId: text('email_id').references(() => email.id, { onDelete: 'set null' }),
	ok: integer('ok', { mode: 'boolean' }).notNull(),
	durationMs: integer('duration_ms').notNull(),
	error: text('error'),
	/** The model's raw reply, capped at 20k characters, for the log viewer. */
	output: text('output'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull()
});
