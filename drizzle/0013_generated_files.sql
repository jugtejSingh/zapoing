CREATE TABLE `generated_file` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`document_id` text,
	`change` text NOT NULL,
	`filename` text NOT NULL,
	`format` text NOT NULL,
	`path` text,
	`source_path` text,
	`change_note` text DEFAULT '' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `draft`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `generated_file_draftId_idx` ON `generated_file` (`draft_id`);--> statement-breakpoint
CREATE INDEX `generated_file_documentId_idx` ON `generated_file` (`document_id`);