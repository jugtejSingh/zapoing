CREATE INDEX `email_account_thread_idx` ON `email` (`account_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `email_list_idx` ON `email` (`direction`,`category`,`date`,`uid`);