CREATE INDEX `events_thread_type_sequence_idx` ON `events` (`thread_id`,`type`,`sequence`);
--> statement-breakpoint
CREATE INDEX `host_daemon_commands_host_state_cursor_idx` ON `host_daemon_commands` (`host_id`,`state`,`cursor`);
--> statement-breakpoint
DROP INDEX IF EXISTS `host_daemon_commands_host_state_idx`;
--> statement-breakpoint
CREATE INDEX `host_daemon_commands_state_fetched_at_idx` ON `host_daemon_commands` (`state`,`fetched_at`);
--> statement-breakpoint
CREATE INDEX `host_daemon_commands_payload_prune_idx` ON `host_daemon_commands` (`state`,`completed_at`) WHERE `completed_at` IS NOT NULL AND (`payload` <> '{}' OR `result_payload` IS NOT NULL);
