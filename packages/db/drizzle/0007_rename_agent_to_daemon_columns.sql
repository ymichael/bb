ALTER TABLE `environment_daemon_sessions` RENAME COLUMN `agent_id` TO `environment_daemon_id`;
--> statement-breakpoint
ALTER TABLE `environment_daemon_sessions` RENAME COLUMN `agent_instance_id` TO `environment_daemon_instance_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `environment_daemon_sessions_agent_status_idx`;
--> statement-breakpoint
CREATE INDEX `environment_daemon_sessions_daemon_status_idx` ON `environment_daemon_sessions` (`environment_daemon_id`, `status`);
