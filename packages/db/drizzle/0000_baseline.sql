CREATE TABLE `app_sandbox_env_vars` (
	`name` text PRIMARY KEY NOT NULL,
	`encrypted_value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_sandbox_env_vars_updated_at_idx` ON `app_sandbox_env_vars` (`updated_at`);--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`start` text,
	`prefix` text,
	`key` text NOT NULL,
	`referenceId` text NOT NULL,
	`refillInterval` integer,
	`refillAmount` integer,
	`lastRefillAt` integer,
	`enabled` integer NOT NULL,
	`rateLimitEnabled` integer NOT NULL,
	`rateLimitTimeWindow` integer NOT NULL,
	`rateLimitMax` integer NOT NULL,
	`requestCount` integer NOT NULL,
	`remaining` integer,
	`lastRequest` integer,
	`expiresAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`permissions` text,
	`metadata` text,
	`configId` text NOT NULL,
	FOREIGN KEY (`referenceId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apikey_key_unique` ON `apikey` (`key`);--> statement-breakpoint
CREATE INDEX `apikey_reference_id_idx` ON `apikey` (`referenceId`);--> statement-breakpoint
CREATE INDEX `apikey_config_id_idx` ON `apikey` (`configId`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL,
	`image` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`trigger_type` text NOT NULL,
	`trigger_config` text NOT NULL,
	`action` text NOT NULL,
	`auto_archive` integer DEFAULT false NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`run_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automations_project_idx` ON `automations` (`project_id`);--> statement-breakpoint
CREATE INDEX `automations_due_idx` ON `automations` (`enabled`,`trigger_type`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `environment_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`payload` text NOT NULL,
	`command_id` text,
	`requested_at` integer NOT NULL,
	`queued_at` integer,
	`completed_at` integer,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_id`) REFERENCES `host_daemon_commands`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_operations_environment_kind_idx` ON `environment_operations` (`environment_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `environment_operations_command_idx` ON `environment_operations` (`command_id`);--> statement-breakpoint
CREATE INDEX `environment_operations_state_idx` ON `environment_operations` (`state`);--> statement-breakpoint
CREATE INDEX `environment_operations_environment_idx` ON `environment_operations` (`environment_id`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`host_id` text NOT NULL,
	`path` text,
	`managed` integer DEFAULT false NOT NULL,
	`is_git_repo` integer DEFAULT false NOT NULL,
	`is_worktree` integer DEFAULT false NOT NULL,
	`branch_name` text,
	`default_branch` text,
	`merge_base_branch` text,
	`cleanup_requested_at` integer,
	`cleanup_mode` text,
	`workspace_provision_type` text NOT NULL,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_host_path_idx` ON `environments` (`host_id`,`path`);--> statement-breakpoint
CREATE INDEX `environments_project_idx` ON `environments` (`project_id`);--> statement-breakpoint
CREATE INDEX `environments_cleanup_requested_idx` ON `environments` (`cleanup_requested_at`);--> statement-breakpoint
CREATE INDEX `environments_status_idx` ON `environments` (`status`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`environment_id` text,
	`scope_kind` text NOT NULL,
	`turn_id` text,
	`provider_thread_id` text,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`item_id` text,
	`item_kind` text,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "events_scope_shape_check" CHECK((
        ("events"."scope_kind" = 'turn' AND "events"."turn_id" IS NOT NULL)
        OR
        ("events"."scope_kind" = 'thread' AND "events"."turn_id" IS NULL)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_thread_sequence_idx` ON `events` (`thread_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `events_thread_type_item_kind_sequence_idx` ON `events` (`thread_id`,`type`,`item_kind`,`sequence`);--> statement-breakpoint
CREATE INDEX `events_thread_item_id_sequence_idx` ON `events` (`thread_id`,`item_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `events_environment_idx` ON `events` (`environment_id`);--> statement-breakpoint
CREATE TABLE `host_daemon_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`session_id` text,
	`cursor` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`state` text NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`result_payload` text,
	`created_at` integer NOT NULL,
	`fetched_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `host_daemon_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_daemon_commands_host_cursor_idx` ON `host_daemon_commands` (`host_id`,`cursor`);--> statement-breakpoint
CREATE INDEX `host_daemon_commands_host_state_idx` ON `host_daemon_commands` (`host_id`,`state`);--> statement-breakpoint
CREATE TABLE `host_daemon_sessions` (
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
CREATE INDEX `host_daemon_sessions_host_status_idx` ON `host_daemon_sessions` (`host_id`,`status`);--> statement-breakpoint
CREATE TABLE `host_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`payload` text NOT NULL,
	`command_id` text,
	`requested_at` integer NOT NULL,
	`queued_at` integer,
	`completed_at` integer,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_id`) REFERENCES `host_daemon_commands`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_operations_host_kind_idx` ON `host_operations` (`host_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `host_operations_command_idx` ON `host_operations` (`command_id`);--> statement-breakpoint
CREATE INDEX `host_operations_state_idx` ON `host_operations` (`state`);--> statement-breakpoint
CREATE TABLE `hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`provider` text,
	`external_id` text,
	`last_activity_at` integer,
	`suspended_at` integer,
	`destroyed_at` integer,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hosts_last_activity_idx` ON `hosts` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `hosts_last_seen_idx` ON `hosts` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `hosts_suspended_idx` ON `hosts` (`suspended_at`);--> statement-breakpoint
CREATE TABLE `manager_thread_nudges` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`name` text NOT NULL,
	`cron` text NOT NULL,
	`timezone` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_fire_at` integer NOT NULL,
	`last_fired_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `manager_thread_nudges_due_idx` ON `manager_thread_nudges` (`enabled`,`next_fire_at`);--> statement-breakpoint
CREATE INDEX `manager_thread_nudges_project_idx` ON `manager_thread_nudges` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `manager_thread_nudges_sync_key_idx` ON `manager_thread_nudges` (`project_id`,`thread_id`,`name`);--> statement-breakpoint
CREATE TABLE `pending_interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_thread_id` text NOT NULL,
	`provider_request_id` text NOT NULL,
	`session_id` text NOT NULL,
	`resolving_command_id` text,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`resolution` text,
	`status_reason` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolving_command_id`) REFERENCES `host_daemon_commands`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_interactions_provider_request_idx` ON `pending_interactions` (`session_id`,`provider_id`,`provider_thread_id`,`provider_request_id`);--> statement-breakpoint
CREATE INDEX `pending_interactions_thread_created_idx` ON `pending_interactions` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `pending_interactions_thread_status_created_idx` ON `pending_interactions` (`thread_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `pending_interactions_status_created_idx` ON `pending_interactions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `pending_interactions_resolving_command_idx` ON `pending_interactions` (`resolving_command_id`);--> statement-breakpoint
CREATE TABLE `project_execution_defaults` (
	`project_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`thread_type` text NOT NULL,
	`model` text NOT NULL,
	`service_tier` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`permission_mode` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_execution_defaults_project_thread_type_idx` ON `project_execution_defaults` (`project_id`,`thread_type`);--> statement-breakpoint
CREATE INDEX `project_execution_defaults_project_idx` ON `project_execution_defaults` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`payload` text NOT NULL,
	`command_id` text,
	`requested_at` integer NOT NULL,
	`queued_at` integer,
	`completed_at` integer,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_id`) REFERENCES `host_daemon_commands`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_operations_project_kind_idx` ON `project_operations` (`project_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_operations_command_idx` ON `project_operations` (`command_id`);--> statement-breakpoint
CREATE INDEX `project_operations_state_idx` ON `project_operations` (`state`);--> statement-breakpoint
CREATE INDEX `project_operations_project_idx` ON `project_operations` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`host_id` text,
	`path` text,
	`repo_url` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "project_sources_shape_check" CHECK((
        ("project_sources"."type" = 'local_path' AND "project_sources"."host_id" IS NOT NULL AND "project_sources"."path" IS NOT NULL AND "project_sources"."repo_url" IS NULL)
        OR
        ("project_sources"."type" = 'github_repo' AND "project_sources"."host_id" IS NULL AND "project_sources"."path" IS NULL AND "project_sources"."repo_url" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE INDEX `project_sources_project_idx` ON `project_sources` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_sources_host_idx` ON `project_sources` (`host_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_sources_project_host_idx` ON `project_sources` (`project_id`,`host_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_sources_default_project_idx`
ON `project_sources` (`project_id`)
WHERE `is_default` = 1;--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_updated_idx` ON `projects` (`updated_at`);--> statement-breakpoint
CREATE TABLE `queued_thread_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`content` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`permission_mode` text NOT NULL,
	`service_tier` text NOT NULL,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `queued_thread_messages_thread_created_idx` ON `queued_thread_messages` (`thread_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `sandbox_provider_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`encrypted_access_token` text NOT NULL,
	`encrypted_refresh_token` text NOT NULL,
	`encrypted_id_token` text,
	`encrypted_metadata` text NOT NULL,
	`label` text,
	`expires_at` integer NOT NULL,
	`last_refreshed_at` integer,
	`last_error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sandbox_provider_credentials_provider_id_idx` ON `sandbox_provider_credentials` (`provider_id`);--> statement-breakpoint
CREATE INDEX `sandbox_provider_credentials_expires_at_idx` ON `sandbox_provider_credentials` (`expires_at`);--> statement-breakpoint
CREATE TABLE `thread_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`payload` text NOT NULL,
	`provisioning_id` text,
	`provisioning_stage` text,
	`provisioning_environment_id` text,
	`provision_event_sequence` integer,
	`workspace_ready_event_sequence` integer,
	`command_id` text,
	`requested_at` integer NOT NULL,
	`queued_at` integer,
	`completed_at` integer,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provisioning_environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`command_id`) REFERENCES `host_daemon_commands`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_operations_thread_kind_idx` ON `thread_operations` (`thread_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_operations_command_idx` ON `thread_operations` (`command_id`);--> statement-breakpoint
CREATE INDEX `thread_operations_state_idx` ON `thread_operations` (`state`);--> statement-breakpoint
CREATE INDEX `thread_operations_thread_idx` ON `thread_operations` (`thread_id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text,
	`automation_id` text,
	`provider_id` text NOT NULL,
	`type` text DEFAULT 'standard' NOT NULL,
	`title` text,
	`title_fallback` text,
	`status` text DEFAULT 'created' NOT NULL,
	`parent_thread_id` text,
	`archived_at` integer,
	`stop_requested_at` integer,
	`deleted_at` integer,
	`last_read_at` integer,
	`latest_attention_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `threads_project_updated_idx` ON `threads` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `threads_environment_idx` ON `threads` (`environment_id`);--> statement-breakpoint
CREATE INDEX `threads_automation_runtime_idx` ON `threads` (`automation_id`,`archived_at`,`deleted_at`,`status`);--> statement-breakpoint
CREATE INDEX `threads_parent_idx` ON `threads` (`parent_thread_id`);--> statement-breakpoint
CREATE INDEX `threads_archived_status_idx` ON `threads` (`archived_at`,`status`);--> statement-breakpoint
CREATE INDEX `threads_environment_archived_deleted_idx` ON `threads` (`environment_id`,`archived_at`,`deleted_at`);
