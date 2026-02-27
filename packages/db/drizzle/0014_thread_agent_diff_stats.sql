ALTER TABLE `threads` ADD COLUMN `agent_diff_source` text;
--> statement-breakpoint
ALTER TABLE `threads` ADD COLUMN `agent_changed_files` integer;
--> statement-breakpoint
ALTER TABLE `threads` ADD COLUMN `agent_insertions` integer;
--> statement-breakpoint
ALTER TABLE `threads` ADD COLUMN `agent_deletions` integer;
--> statement-breakpoint
ALTER TABLE `threads` ADD COLUMN `agent_diff_captured_at` integer;
