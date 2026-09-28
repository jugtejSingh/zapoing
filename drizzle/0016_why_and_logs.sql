ALTER TABLE `agent_run` ADD `output` text;--> statement-breakpoint
ALTER TABLE `draft` ADD `intents` text DEFAULT '[]' NOT NULL;