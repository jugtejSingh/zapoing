import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { contact } from './contact.schema';
import { email } from './mail.schema';

/** One logical file exchanged with a tracked person, e.g. "the service agreement". */
export const document = sqliteTable(
	'document',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		contactId: text('contact_id')
			.notNull()
			.references(() => contact.id, { onDelete: 'cascade' }),
		/** The first version's filename. */
		name: text('name').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(table) => [index('document_contactId_idx').on(table.contactId)]
);

/** One stored file of a document. The bytes live on disk at `path`, never in the database. */
export const documentVersion = sqliteTable(
	'document_version',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		documentId: text('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' }),
		/** 1, 2, 3… in the order the versions were received. */
		version: integer('version').notNull(),
		/** The email it came with; the file stays if that email leaves the cache. */
		emailId: text('email_id').references(() => email.id, { onDelete: 'set null' }),
		sender: text('sender').notNull(),
		receivedAt: integer('received_at', { mode: 'timestamp_ms' }),
		sha256: text('sha256').notNull(),
		filename: text('filename').notNull(),
		contentType: text('content_type').notNull(),
		size: integer('size').notNull(),
		path: text('path').notNull(),
		/** On the allowlist, so it may be sent to the model. Other files are stored but never sent. */
		readable: integer('readable', { mode: 'boolean' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(table) => [
		index('document_version_documentId_idx').on(table.documentId),
		index('document_version_sha256_idx').on(table.sha256)
	]
);
