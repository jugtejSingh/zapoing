ALTER TABLE `resource` ADD `content` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `resource` ADD `index_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `resource` ADD `index_error` text;--> statement-breakpoint
-- Hand-written: rebuild the FTS5 index with the file's text. drizzle does not model FTS5.
DROP TRIGGER `resource_fts_insert`;--> statement-breakpoint
DROP TRIGGER `resource_fts_update`;--> statement-breakpoint
DROP TRIGGER `resource_fts_delete`;--> statement-breakpoint
DROP TABLE `resource_fts`;--> statement-breakpoint
CREATE VIRTUAL TABLE `resource_fts` USING fts5(resource_id UNINDEXED, name, keywords, tags, content);--> statement-breakpoint
INSERT INTO `resource_fts` (resource_id, name, keywords, tags, content) SELECT id, name, keywords, tags, content FROM `resource`;--> statement-breakpoint
CREATE TRIGGER `resource_fts_insert` AFTER INSERT ON `resource` BEGIN
	INSERT INTO `resource_fts` (resource_id, name, keywords, tags, content) VALUES (new.id, new.name, new.keywords, new.tags, new.content);
END;--> statement-breakpoint
CREATE TRIGGER `resource_fts_update` AFTER UPDATE ON `resource` BEGIN
	DELETE FROM `resource_fts` WHERE resource_id = old.id;
	INSERT INTO `resource_fts` (resource_id, name, keywords, tags, content) VALUES (new.id, new.name, new.keywords, new.tags, new.content);
END;--> statement-breakpoint
CREATE TRIGGER `resource_fts_delete` AFTER DELETE ON `resource` BEGIN
	DELETE FROM `resource_fts` WHERE resource_id = old.id;
END;
