import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './auth.schema';

/**
 * What the AI knows about a stored file: its text and a short description of
 * what it is and when to use it. One row per template, resource or received
 * attachment (`kind` + `refId`). The file itself stays on disk; agents pick a
 * file by its description and then read its text from here.
 */
export const fileIndex = sqliteTable(
	'file_index',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: ['template', 'resource', 'attachment'] }).notNull(),
		/** The template, resource or document_version id. Not a foreign key: it points at three tables. */
		refId: text('ref_id').notNull(),
		description: text('description').notNull().default(''),
		/** The file's text, for agents to read. Never shown to the user. */
		text: text('text').notNull().default(''),
		status: text('status', { enum: ['pending', 'ready', 'failed'] })
			.notNull()
			.default('pending'),
		/** Why the file could not be read. */
		error: text('error'),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [
		uniqueIndex('file_index_kind_refId_idx').on(table.kind, table.refId),
		index('file_index_userId_idx').on(table.userId)
	]
);
