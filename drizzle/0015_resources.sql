CREATE TABLE `resource` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`keywords` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `resource_userId_idx` ON `resource` (`user_id`);--> statement-breakpoint
ALTER TABLE `draft` ADD `resources` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `draft` ADD `conflicts` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
-- Hand-written: keyword search over resources. drizzle does not model FTS5, so the table and triggers live only here.
CREATE VIRTUAL TABLE `resource_fts` USING fts5(resource_id UNINDEXED, name, keywords, tags);--> statement-breakpoint
CREATE TRIGGER `resource_fts_insert` AFTER INSERT ON `resource` BEGIN
	INSERT INTO `resource_fts` (resource_id, name, keywords, tags) VALUES (new.id, new.name, new.keywords, new.tags);
END;--> statement-breakpoint
CREATE TRIGGER `resource_fts_update` AFTER UPDATE ON `resource` BEGIN
	DELETE FROM `resource_fts` WHERE resource_id = old.id;
	INSERT INTO `resource_fts` (resource_id, name, keywords, tags) VALUES (new.id, new.name, new.keywords, new.tags);
END;--> statement-breakpoint
CREATE TRIGGER `resource_fts_delete` AFTER DELETE ON `resource` BEGIN
	DELETE FROM `resource_fts` WHERE resource_id = old.id;
END;
