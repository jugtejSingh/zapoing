CREATE TABLE `draft_attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_reply_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`content` blob NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`draft_reply_id`) REFERENCES `draft_reply`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `draft_attachment_draftReplyId_idx` ON `draft_attachment` (`draft_reply_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `draft_attachment_unique` ON `draft_attachment` (`draft_reply_id`,`filename`);