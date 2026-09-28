CREATE TABLE `agent_run` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`email_id` text,
	`ok` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `email`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `draft` (
	`id` text PRIMARY KEY NOT NULL,
	`email_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`placeholders` text DEFAULT '[]' NOT NULL,
	`reason` text,
	`covers_email_ids` text DEFAULT '[]' NOT NULL,
	`thread_cut` integer DEFAULT false NOT NULL,
	`instruction` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `email`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contact`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `draft_emailId_idx` ON `draft` (`email_id`);--> statement-breakpoint
CREATE INDEX `draft_status_idx` ON `draft` (`status`);