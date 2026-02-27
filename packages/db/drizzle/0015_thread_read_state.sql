ALTER TABLE `threads` ADD COLUMN `last_read_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `threads`
SET `last_read_at` = `updated_at`
WHERE `last_read_at` = 0;
