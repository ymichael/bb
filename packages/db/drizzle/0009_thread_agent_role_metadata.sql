ALTER TABLE `threads` ADD COLUMN `agent_role_id` text;
--> statement-breakpoint
CREATE INDEX `threads_project_agent_role_updated_idx`
  ON `threads` (`project_id`, `agent_role_id`, `updated_at`);
