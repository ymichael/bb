CREATE TABLE `terminal_sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL,
  `environment_id` text NOT NULL,
  `host_id` text NOT NULL,
  `daemon_session_id` text,
  `title` text NOT NULL,
  `initial_cwd` text NOT NULL,
  `current_cwd` text,
  `cols` integer NOT NULL,
  `rows` integer NOT NULL,
  `status` text NOT NULL,
  `exit_code` integer,
  `close_reason` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `last_connected_at` integer,
  `exited_at` integer,
  FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`daemon_session_id`) REFERENCES `host_daemon_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `terminal_sessions_thread_status_updated_idx` ON `terminal_sessions` (`thread_id`, `status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `terminal_sessions_environment_status_idx` ON `terminal_sessions` (`environment_id`, `status`);
--> statement-breakpoint
CREATE INDEX `terminal_sessions_host_status_idx` ON `terminal_sessions` (`host_id`, `status`);
--> statement-breakpoint
CREATE INDEX `terminal_sessions_daemon_session_idx` ON `terminal_sessions` (`daemon_session_id`);
