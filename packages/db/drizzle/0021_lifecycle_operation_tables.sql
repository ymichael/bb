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
CREATE UNIQUE INDEX `project_operations_project_kind_idx` ON `project_operations` (`project_id`,`kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_operations_command_idx` ON `project_operations` (`command_id`);
--> statement-breakpoint
CREATE INDEX `project_operations_state_idx` ON `project_operations` (`state`);
--> statement-breakpoint
CREATE INDEX `project_operations_project_idx` ON `project_operations` (`project_id`);
--> statement-breakpoint
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
CREATE UNIQUE INDEX `environment_operations_environment_kind_idx` ON `environment_operations` (`environment_id`,`kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_operations_command_idx` ON `environment_operations` (`command_id`);
--> statement-breakpoint
CREATE INDEX `environment_operations_state_idx` ON `environment_operations` (`state`);
--> statement-breakpoint
CREATE INDEX `environment_operations_environment_idx` ON `environment_operations` (`environment_id`);
--> statement-breakpoint
CREATE TABLE `thread_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
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
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_id`) REFERENCES `host_daemon_commands`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_operations_thread_kind_idx` ON `thread_operations` (`thread_id`,`kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_operations_command_idx` ON `thread_operations` (`command_id`);
--> statement-breakpoint
CREATE INDEX `thread_operations_state_idx` ON `thread_operations` (`state`);
--> statement-breakpoint
CREATE INDEX `thread_operations_thread_idx` ON `thread_operations` (`thread_id`);
