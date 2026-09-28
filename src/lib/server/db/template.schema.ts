import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth.schema';

/** A field the model found in a template. `found` is how many places it was marked in the file. */
export type TemplateField = {
	name: string;
	description: string;
	found: number;
};

/**
 * A document the user fills per deal, e.g. their NDA. The files live under
 * data/templates/<id>/: the upload as `original.<ext>`, and the marked copy
 * (`template.docx`, `template.xlsx` or `template.md` for a PDF) that is filled.
 */
export const template = sqliteTable(
	'template',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		/** When to use it, e.g. "mutual NDA before any deal talks". */
		description: text('description').notNull().default(''),
		filename: text('filename').notNull(),
		format: text('format', { enum: ['docx', 'xlsx', 'pdf'] }).notNull(),
		fields: text('fields', { mode: 'json' }).$type<TemplateField[]>().notNull().default([]),
		/** processing until the model has found the fields. */
		status: text('status', { enum: ['processing', 'ready', 'failed'] })
			.notNull()
			.default('processing'),
		error: text('error'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [index('template_userId_idx').on(table.userId)]
);
