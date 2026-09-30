import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { document } from './document.schema';
import { draft } from './draft.schema';
import { template } from './template.schema';

/**
 * A file the document agent made for a draft. A failed model call or render is
 * kept as a row with `error` set, so the draft shows it instead of losing it.
 */
export const generatedFile = sqliteTable(
	'generated_file',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		draftId: text('draft_id')
			.notNull()
			.references(() => draft.id, { onDelete: 'cascade' }),
		/** The document this is a new version of; null for a brand-new document. */
		documentId: text('document_id').references(() => document.id, { onDelete: 'set null' }),
		/** The template it was filled from, if any. */
		templateId: text('template_id').references(() => template.id, { onDelete: 'set null' }),
		/** What was asked for, e.g. "payment terms to 45 days". */
		change: text('change').notNull(),
		filename: text('filename').notNull(),
		format: text('format', { enum: ['pdf', 'docx', 'xlsx'] }).notNull(),
		/** The rendered file; null when it failed. */
		path: text('path'),
		/** The model's Markdown or JSON sheets the file was rendered from. */
		sourcePath: text('source_path'),
		changeNote: text('change_note').notNull().default(''),
		/** [[fields]] still in the file. The reply can't be sent until they are filled. */
		placeholders: text('placeholders', { mode: 'json' }).$type<string[]>().notNull().default([]),
		/** A Word file that goes out as a PDF (converted by LibreOffice); the stored docx stays editable. */
		sendAsPdf: integer('send_as_pdf', { mode: 'boolean' }).notNull().default(false),
		error: text('error'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(table) => [
		index('generated_file_draftId_idx').on(table.draftId),
		index('generated_file_documentId_idx').on(table.documentId)
	]
);
