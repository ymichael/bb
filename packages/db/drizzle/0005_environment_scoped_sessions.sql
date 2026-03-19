CREATE TABLE `__new_environment_agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL REFERENCES `environments`(`id`) ON DELETE CASCADE,
	`agent_id` text NOT NULL,
	`agent_instance_id` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`worker_name` text,
	`worker_version` text,
	`worker_build_id` text,
	`provider_metadata` text,
	`selected_capabilities` text,
	`control_base_url` text,
	`control_auth_token` text,
	`status` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`last_heartbeat_at` integer,
	`closed_at` integer,
	`close_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_environment_agent_sessions`(
	`id`,
	`environment_id`,
	`agent_id`,
	`agent_instance_id`,
	`protocol_version`,
	`worker_name`,
	`worker_version`,
	`worker_build_id`,
	`provider_metadata`,
	`selected_capabilities`,
	`control_base_url`,
	`control_auth_token`,
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
	`environment_id`,
	`agent_id`,
	`agent_instance_id`,
	`protocol_version`,
	`worker_name`,
	`worker_version`,
	`worker_build_id`,
	`provider_metadata`,
	`selected_capabilities`,
	`control_base_url`,
	`control_auth_token`,
	`status`,
	`lease_expires_at`,
	`last_heartbeat_at`,
	`closed_at`,
	`close_reason`,
	`created_at`,
	`updated_at`
FROM `environment_agent_sessions`
WHERE `environment_id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `environment_agent_sessions`;
--> statement-breakpoint
ALTER TABLE `__new_environment_agent_sessions` RENAME TO `environment_agent_sessions`;
--> statement-breakpoint
CREATE INDEX `environment_agent_sessions_environment_status_idx` ON `environment_agent_sessions` (`environment_id`, `status`);
--> statement-breakpoint
CREATE INDEX `environment_agent_sessions_agent_status_idx` ON `environment_agent_sessions` (`agent_id`, `status`);
--> statement-breakpoint
CREATE INDEX `environment_agent_sessions_lease_expires_idx` ON `environment_agent_sessions` (`lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `environment_agent_sessions_status_lease_idx` ON `environment_agent_sessions` (`status`, `lease_expires_at`);
