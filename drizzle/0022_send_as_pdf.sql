ALTER TABLE `generated_file` ADD `send_as_pdf` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `generated_file` SET `send_as_pdf` = 1 WHERE `format` = 'docx' AND `template_id` IS NOT NULL;
