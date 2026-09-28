ALTER TABLE `email` ADD `cc` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `email` ADD `reply_to` text;--> statement-breakpoint
ALTER TABLE `email` ADD `message_id` text;--> statement-breakpoint
ALTER TABLE `email` ADD `references` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `mail_account` ADD `smtp_host` text;--> statement-breakpoint
ALTER TABLE `mail_account` ADD `smtp_port` integer;--> statement-breakpoint
/* Existing rows lack the new headers: clear the cache so the next sync backfills everything. */
DELETE FROM `email`;--> statement-breakpoint
DELETE FROM `mailbox_state`;
