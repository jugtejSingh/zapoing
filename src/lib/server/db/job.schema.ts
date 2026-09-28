import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Background work (AI calls and the like) that must survive a restart.
 * The runner picks the oldest 'pending' row whose runAt has passed.
 */
export const job = sqliteTable(
	'job',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		type: text('type').notNull(),
		payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
		status: text('status', { enum: ['pending', 'running', 'done', 'failed'] })
			.default('pending')
			.notNull(),
		attempts: integer('attempts').default(0).notNull(),
		runAt: integer('run_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		lastError: text('last_error'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [index('job_status_run_at_idx').on(table.status, table.runAt)]
);
