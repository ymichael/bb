PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_host_daemon_commands` (
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
INSERT INTO `__new_host_daemon_commands`("id", "host_id", "session_id", "cursor", "type", "payload", "state", "retry_count", "result_payload", "created_at", "fetched_at", "completed_at") SELECT "id", "host_id", "session_id", "cursor", "type", "payload", "state", "retry_count", "result_payload", "created_at", "fetched_at", "completed_at" FROM `host_daemon_commands`;--> statement-breakpoint
DROP TABLE `host_daemon_commands`;--> statement-breakpoint
ALTER TABLE `__new_host_daemon_commands` RENAME TO `host_daemon_commands`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `host_daemon_commands_host_cursor_idx` ON `host_daemon_commands` (`host_id`,`cursor`);--> statement-breakpoint
CREATE INDEX `host_daemon_commands_host_state_idx` ON `host_daemon_commands` (`host_id`,`state`);