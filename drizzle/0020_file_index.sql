-- Hand-written: search is replaced by descriptions in file_index, so the FTS5 table and its triggers go before the columns they read.
DROP TRIGGER `resource_fts_insert`;--> statement-breakpoint
DROP TRIGGER `resource_fts_update`;--> statement-breakpoint
DROP TRIGGER `resource_fts_delete`;--> statement-breakpoint
DROP TABLE `resource_fts`;--> statement-breakpoint
CREATE TABLE `file_index` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_index_kind_refId_idx` ON `file_index` (`kind`,`ref_id`);--> statement-breakpoint
CREATE INDEX `file_index_userId_idx` ON `file_index` (`user_id`);--> statement-breakpoint
ALTER TABLE `resource` DROP COLUMN `keywords`;--> statement-breakpoint
ALTER TABLE `resource` DROP COLUMN `tags`;--> statement-breakpoint
ALTER TABLE `resource` DROP COLUMN `content`;--> statement-breakpoint
ALTER TABLE `resource` DROP COLUMN `index_status`;--> statement-breakpoint
ALTER TABLE `resource` DROP COLUMN `index_error`;