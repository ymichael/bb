ALTER TABLE `environment_agent_sessions` RENAME TO `environment_daemon_sessions`;
--> statement-breakpoint
ALTER TABLE `environment_agent_cursors` RENAME TO `environment_daemon_cursors`;
--> statement-breakpoint
ALTER TABLE `environment_agent_commands` RENAME TO `environment_daemon_commands`;
--> statement-breakpoint
DROP INDEX IF EXISTS `environment_agent_sessions_environment_status_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `environment_agent_sessions_agent_status_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `environment_agent_sessions_lease_expires_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `environment_agent_sessions_status_lease_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `environment_agent_commands_thread_cursor_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `environment_agent_commands_thread_state_updated_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `environment_agent_commands_session_state_idx`;
--> statement-breakpoint
CREATE INDEX `environment_daemon_sessions_environment_status_idx` ON `environment_daemon_sessions` (`environment_id`, `status`);
--> statement-breakpoint
CREATE INDEX `environment_daemon_sessions_agent_status_idx` ON `environment_daemon_sessions` (`agent_id`, `status`);
--> statement-breakpoint
CREATE INDEX `environment_daemon_sessions_lease_expires_idx` ON `environment_daemon_sessions` (`lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `environment_daemon_sessions_status_lease_idx` ON `environment_daemon_sessions` (`status`, `lease_expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_daemon_commands_thread_cursor_idx` ON `environment_daemon_commands` (`thread_id`, `command_cursor`);
--> statement-breakpoint
CREATE INDEX `environment_daemon_commands_thread_state_updated_idx` ON `environment_daemon_commands` (`thread_id`, `state`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `environment_daemon_commands_session_state_idx` ON `environment_daemon_commands` (`session_id`, `state`);
