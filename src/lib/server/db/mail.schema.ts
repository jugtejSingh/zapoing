import { relations, sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { user } from './auth.schema';
import type { EmailAttachment, EmailDirection } from '$lib/types';

/** One IMAP mailbox a user has connected. A user may have many. */
export const mailAccount = sqliteTable(
	'mail_account',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		label: text('label'),
		host: text('host').notNull(),
		port: integer('port').notNull().default(993),
		secure: integer('secure', { mode: 'boolean' }).notNull().default(true),
		username: text('username').notNull(),
		/** AES-256-GCM ciphertext. Always go through encryptSecret/decryptSecret. */
		password: text('password').notNull(),
		/** Null means derive it from the IMAP host (imap.x becomes smtp.x). */
		smtpHost: text('smtp_host'),
		/** Null means 465. 465 is implicit TLS, anything else upgrades with STARTTLS. */
		smtpPort: integer('smtp_port'),
		/** Last time we asked IMAP for new mail. Null means never synced. */
		lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [
		index('mail_account_userId_idx').on(table.userId),
		unique('mail_account_unique').on(table.userId, table.host, table.username)
	]
);

/**
 * Cached messages. Ownership comes via the account, so there is no userId here.
 * ponytail: attachments are metadata only, no blobs. Split into its own table
 * when you start storing the actual file bytes.
 */
export const email = sqliteTable(
	'email',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		accountId: text('account_id')
			.notNull()
			.references(() => mailAccount.id, { onDelete: 'cascade' }),
		mailbox: text('mailbox').notNull().default('INBOX'),
		uid: integer('uid').notNull(),
		/** IMAP uids are only unique per mailbox per uidvalidity. */
		uidValidity: integer('uid_validity').notNull(),
		from: text('from').notNull(),
		to: text('to').notNull(),
		/** Cc as display text, empty when there is none. */
		cc: text('cc').notNull().default(''),
		replyTo: text('reply_to'),
		/** Headers kept so a reply can thread without refetching the original over IMAP. */
		messageId: text('message_id'),
		references: text('references', { mode: 'json' }).$type<string[]>().notNull().default([]),
		subject: text('subject').notNull(),
		date: integer('date', { mode: 'timestamp_ms' }),
		text: text('text').notNull(),
		html: text('html'),
		snippet: text('snippet').notNull(),
		/** Server thread id when the server has one, else derived from References. */
		threadId: text('thread_id'),
		/** Gmail's tab category (X-GM-LABELS). Null means the primary inbox. */
		category: text('category'),
		/** 'in' for mail synced from INBOX, 'out' for mail synced from the Sent folder. */
		direction: text('direction').$type<EmailDirection>().notNull().default('in'),
		attachments: text('attachments', { mode: 'json' })
			.$type<EmailAttachment[]>()
			.notNull()
			.default([]),
		fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(table) => [
		index('email_accountId_idx').on(table.accountId),
		index('email_threadId_idx').on(table.accountId, table.mailbox, table.threadId),
		/** getCachedThread filters on account + thread across mailboxes, so it can't use the one above. */
		index('email_account_thread_idx').on(table.accountId, table.threadId),
		/** Serves the inbox list: filter by direction/category, newest first, without touching the body blobs. */
		index('email_list_idx').on(table.direction, table.category, table.date, table.uid),
		/** Lets the inbox list read newest-first by date and uid, and stop after one page. */
		index('email_dir_date_uid_idx').on(table.direction, table.date, table.uid),
		/** Covers the "is there a newer message in this thread" check without reading the wide rows. */
		index('email_thread_dir_date_uid_idx').on(
			table.accountId,
			table.threadId,
			table.direction,
			table.date,
			table.uid
		),
		unique('email_unique').on(table.accountId, table.mailbox, table.uidValidity, table.uid)
	]
);

/**
 * Where sync stands for one folder of one account. The sync position lives here,
 * not in the email rows, so a UIDVALIDITY change can never resume from the wrong
 * generation of uids.
 */
export const mailboxState = sqliteTable(
	'mailbox_state',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		accountId: text('account_id')
			.notNull()
			.references(() => mailAccount.id, { onDelete: 'cascade' }),
		mailbox: text('mailbox').notNull(),
		uidValidity: integer('uid_validity').notNull(),
		/** Highest uid stored so far. The next sync fetches lastUid + 1 onwards. */
		lastUid: integer('last_uid').notNull().default(0),
		/** CONDSTORE HIGHESTMODSEQ as text (it is a 64-bit number). Null until a sync completes. */
		highestModseq: text('highest_modseq'),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => new Date())
			.notNull()
	},
	(table) => [unique('mailbox_state_unique').on(table.accountId, table.mailbox)]
);

export const mailAccountRelations = relations(mailAccount, ({ one, many }) => ({
	user: one(user, {
		fields: [mailAccount.userId],
		references: [user.id]
	}),
	emails: many(email)
}));

export const emailRelations = relations(email, ({ one }) => ({
	account: one(mailAccount, {
		fields: [email.accountId],
		references: [mailAccount.id]
	})
}));
