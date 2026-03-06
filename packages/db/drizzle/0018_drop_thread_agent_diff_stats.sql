ALTER TABLE `threads` DROP COLUMN `agent_diff_source`;
--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `agent_changed_files`;
--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `agent_insertions`;
--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `agent_deletions`;
--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `agent_diff_captured_at`;
