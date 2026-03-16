CREATE TABLE `environment_agent_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`session_id` text,
	`command_cursor` integer NOT NULL,
	`command_type` text NOT NULL,
	`payload` text NOT NULL,
	`state` text NOT NULL,
	`result` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `environment_agent_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_agent_commands_thread_cursor_idx` ON `environment_agent_commands` (`thread_id`,`command_cursor`);--> statement-breakpoint
CREATE INDEX `environment_agent_commands_thread_state_updated_idx` ON `environment_agent_commands` (`thread_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `environment_agent_commands_session_state_idx` ON `environment_agent_commands` (`session_id`,`state`);--> statement-breakpoint
CREATE TABLE `environment_agent_cursors` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`sequence` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `environment_agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`environment_id` text,
	`agent_id` text NOT NULL,
	`agent_instance_id` text NOT NULL,
	`protocol_version` integer NOT NULL,
	`control_base_url` text,
	`control_auth_token` text,
	`status` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`last_heartbeat_at` integer,
	`closed_at` integer,
	`close_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `environment_agent_sessions_thread_status_idx` ON `environment_agent_sessions` (`thread_id`,`status`);--> statement-breakpoint
CREATE INDEX `environment_agent_sessions_environment_status_idx` ON `environment_agent_sessions` (`environment_id`,`status`);--> statement-breakpoint
CREATE INDEX `environment_agent_sessions_agent_status_idx` ON `environment_agent_sessions` (`agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `environment_agent_sessions_lease_expires_idx` ON `environment_agent_sessions` (`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `environment_agent_sessions_status_lease_idx` ON `environment_agent_sessions` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`descriptor` text NOT NULL,
	`managed` integer DEFAULT false NOT NULL,
	`requested_runtime_kind` text,
	`runtime_state` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `environments_project_updated_idx` ON `environments` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`norm_type` text DEFAULT '' NOT NULL,
	`turn_id` text,
	`provider_thread_id` text,
	`is_turn_lifecycle` integer DEFAULT false NOT NULL,
	`is_thread_identity` integer DEFAULT false NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_thread_seq_idx` ON `events` (`thread_id`,`seq`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`project_instructions` text,
	`default_provider_id` text,
	`primary_checkout_thread_id` text,
	`primary_manager_thread_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`primary_checkout_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`primary_manager_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `projects_primary_checkout_thread_idx` ON `projects` (`primary_checkout_thread_id`);--> statement-breakpoint
CREATE INDEX `projects_primary_manager_thread_idx` ON `projects` (`primary_manager_thread_id`);--> statement-breakpoint
CREATE TABLE `queued_thread_messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`thread_id` text NOT NULL,
	`input` text DEFAULT '[]' NOT NULL,
	`model` text,
	`service_tier` text,
	`reasoning_level` text NOT NULL,
	`sandbox_mode` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `queued_thread_messages_id_unique` ON `queued_thread_messages` (`id`);--> statement-breakpoint
CREATE INDEX `queued_thread_messages_thread_seq_idx` ON `queued_thread_messages` (`thread_id`,`seq`);--> statement-breakpoint
CREATE INDEX `queued_thread_messages_thread_created_idx` ON `queued_thread_messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `thread_environment_attachments` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_environment_attachments_environment_idx` ON `thread_environment_attachments` (`environment_id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider_id` text DEFAULT 'codex' NOT NULL,
	`type` text DEFAULT 'standard' NOT NULL,
	`title` text,
	`status` text DEFAULT 'created' NOT NULL,
	`environment_id` text,
	`merge_base_branch` text,
	`parent_thread_id` text,
	`archived_at` integer,
	`last_read_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `threads_project_updated_idx` ON `threads` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `threads_environment_idx` ON `threads` (`environment_id`);--> statement-breakpoint
CREATE INDEX `threads_parent_thread_idx` ON `threads` (`parent_thread_id`);--> statement-breakpoint
CREATE INDEX `threads_archived_status_idx` ON `threads` (`archived_at`,`status`);--> statement-breakpoint
CREATE INDEX `threads_archived_environment_idx` ON `threads` (`archived_at`,`environment_id`);