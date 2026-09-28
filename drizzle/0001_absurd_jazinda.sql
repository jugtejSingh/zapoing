CREATE TABLE `draft_reply` (
	`id` text PRIMARY KEY NOT NULL,
	`email_id` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `email`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_reply_email_id_unique` ON `draft_reply` (`email_id`);--> statement-breakpoint
CREATE TABLE `person_summary` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `person_summary_userId_idx` ON `person_summary` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `person_summary_unique` ON `person_summary` (`user_id`,`email`);--> statement-breakpoint
ALTER TABLE `email` ADD `ai_processed_at` integer;