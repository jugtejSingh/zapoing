CREATE TABLE `contact` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text,
	`company` text,
	`emails` text DEFAULT '[]' NOT NULL,
	`tracked` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_userId_idx` ON `contact` (`user_id`);--> statement-breakpoint
CREATE TABLE `summary_version` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`path` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `summary_version_contactId_idx` ON `summary_version` (`contact_id`);--> statement-breakpoint
CREATE TABLE `thread` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`first_at` integer,
	`last_at` integer,
	`contact_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `mail_account`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_unique` ON `thread` (`account_id`,`thread_id`);--> statement-breakpoint
INSERT INTO `thread` (`id`, `account_id`, `thread_id`, `subject`, `first_at`, `last_at`)
SELECT lower(hex(randomblob(16))), `account_id`, `thread_id`, max(`subject`), min(`date`), max(`date`)
FROM `email` WHERE `thread_id` IS NOT NULL GROUP BY `account_id`, `thread_id`;
