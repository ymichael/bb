CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`host_id` text NOT NULL,
	`path` text,
	`managed` integer DEFAULT false NOT NULL,
	`is_git_repo` integer DEFAULT false NOT NULL,
	`branch_name` text,
	`provisioner_id` text,
	`provisioner_state` text,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_host_path_idx` ON `environments` (`host_id`,`path`);--> statement-breakpoint
CREATE INDEX `environments_project_idx` ON `environments` (`project_id`);--> statement-breakpoint
CREATE INDEX `environments_status_idx` ON `environments` (`status`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`environment_id` text,
	`turn_id` text,
	`provider_thread_id` text,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_thread_sequence_idx` ON `events` (`thread_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `events_environment_idx` ON `events` (`environment_id`);--> statement-breakpoint
CREATE TABLE `host_daemon_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`cursor` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`state` text NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`result_payload` text,
	`created_at` integer NOT NULL,
	`fetched_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `host_daemon_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_daemon_commands_session_cursor_idx` ON `host_daemon_commands` (`session_id`,`cursor`);--> statement-breakpoint
CREATE INDEX `host_daemon_commands_session_state_idx` ON `host_daemon_commands` (`session_id`,`state`);--> statement-breakpoint
CREATE TABLE `host_daemon_cursors` (
	`host_id` text PRIMARY KEY NOT NULL,
	`cursor` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `host_daemon_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`host_name` text NOT NULL,
	`host_type` text NOT NULL,
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
CREATE TABLE `hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`provider` text,
	`external_id` text,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hosts_last_seen_idx` ON `hosts` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `project_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`host_id` text NOT NULL,
	`path` text,
	`repo_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_sources_project_idx` ON `project_sources` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_sources_host_idx` ON `project_sources` (`host_id`);--> statement-breakpoint
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
	`mode` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`sandbox_mode` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `queued_thread_messages_thread_updated_idx` ON `queued_thread_messages` (`thread_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text,
	`provider_id` text NOT NULL,
	`type` text DEFAULT 'standard' NOT NULL,
	`title` text,
	`status` text DEFAULT 'created' NOT NULL,
	`merge_base_branch` text,
	`parent_thread_id` text,
	`archived_at` integer,
	`last_read_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `threads_project_updated_idx` ON `threads` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `threads_environment_idx` ON `threads` (`environment_id`);--> statement-breakpoint
CREATE INDEX `threads_parent_idx` ON `threads` (`parent_thread_id`);--> statement-breakpoint
CREATE INDEX `threads_archived_status_idx` ON `threads` (`archived_at`,`status`);