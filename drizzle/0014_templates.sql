CREATE TABLE `template` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`filename` text NOT NULL,
	`format` text NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `template_userId_idx` ON `template` (`user_id`);--> statement-breakpoint
ALTER TABLE `generated_file` ADD `template_id` text REFERENCES template(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `generated_file` ADD `placeholders` text DEFAULT '[]' NOT NULL;