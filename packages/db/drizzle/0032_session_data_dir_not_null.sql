DELETE FROM `host_daemon_sessions` WHERE `data_dir` IS NULL;
--> statement-breakpoint
CREATE TABLE `__new_host_daemon_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `host_id` text NOT NULL,
  `instance_id` text NOT NULL,
  `host_name` text NOT NULL,
  `host_type` text NOT NULL,
  `data_dir` text NOT NULL,
  `protocol_version` integer NOT NULL,
  `heartbeat_interval_ms` integer NOT NULL,
  `lease_timeout_ms` integer NOT NULL,
  `status` text NOT NULL,
  `lease_expires_at` integer NOT NULL,
  `last_heartbeat_at` integer,
  `closed_at` integer,
  `close_reason` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_host_daemon_sessions` (
  `id`,
  `host_id`,
  `instance_id`,
  `host_name`,
  `host_type`,
  `data_dir`,
  `protocol_version`,
  `heartbeat_interval_ms`,
  `lease_timeout_ms`,
  `status`,
  `lease_expires_at`,
  `last_heartbeat_at`,
  `closed_at`,
  `close_reason`,
  `created_at`,
  `updated_at`
)
SELECT
  `id`,
  `host_id`,
  `instance_id`,
  `host_name`,
  `host_type`,
  `data_dir`,
  `protocol_version`,
  `heartbeat_interval_ms`,
  `lease_timeout_ms`,
  `status`,
  `lease_expires_at`,
  `last_heartbeat_at`,
  `closed_at`,
  `close_reason`,
  `created_at`,
  `updated_at`
FROM `host_daemon_sessions`;
--> statement-breakpoint
DROP TABLE `host_daemon_sessions`;
--> statement-breakpoint
ALTER TABLE `__new_host_daemon_sessions` RENAME TO `host_daemon_sessions`;
--> statement-breakpoint
CREATE INDEX `host_daemon_sessions_host_status_idx` ON `host_daemon_sessions` (`host_id`,`status`);
