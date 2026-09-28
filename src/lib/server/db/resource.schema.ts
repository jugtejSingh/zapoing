import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth.schema';

/**
 * Reference material the user adds: pricing, company overview, standard terms.
 * The file lives at data/resources/<id>/original.<ext>. Search runs on the
 * `resource_fts` FTS5 table (name, keywords, tags, content), which triggers in
 * migrations 0015 and 0017 keep in step with this one; drizzle does not model it.
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
		/** Free text, e.g. "prices discounts 2026". */
		keywords: text('keywords').notNull().default(''),
		/** e.g. ["finance", "pricing"]. FTS5 splits the JSON text into words on its own. */
		tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
		filename: text('filename').notNull(),
		contentType: text('content_type').notNull(),
		path: text('path').notNull(),
		/** The file's text, for search only; never shown or sent to the model. Read locally for text and Office files, by the AI for PDFs and images. */
		content: text('content').notNull().default(''),
		indexStatus: text('index_status', { enum: ['pending', 'ready', 'failed'] })
			.notNull()
			.default('pending'),
		/** Why the contents could not be read; the resource is still found by name, keywords and tags. */
		indexError: text('index_error'),
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
