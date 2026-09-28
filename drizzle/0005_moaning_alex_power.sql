CREATE TABLE `mailbox_state` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`mailbox` text NOT NULL,
	`uid_validity` integer NOT NULL,
	`last_uid` integer DEFAULT 0 NOT NULL,
	`highest_modseq` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `mail_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_state_unique` ON `mailbox_state` (`account_id`,`mailbox`);--> statement-breakpoint
ALTER TABLE `email` ADD `direction` text DEFAULT 'in' NOT NULL;