import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth.schema';

/**
 * Reference material the user adds: pricing, company overview, standard terms.
 * The file lives at data/resources/<id>/original.<ext>. Its text and description live in `file_index`.
 */
export const resource = sqliteTable(
	'resource',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		filename: text('filename').notNull(),
		contentType: text('content_type').notNull(),
		path: text('path').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		/** Bumped by edits and by a replaced file; the newest wins a conflict. */
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [index('resource_userId_idx').on(table.userId)]
);
