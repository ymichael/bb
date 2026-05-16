CREATE TABLE `__pending_interactions_rebuild` (
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
INSERT INTO `__pending_interactions_rebuild` (
	`id`,
	`thread_id`,
	`turn_id`,
	`provider_id`,
	`provider_thread_id`,
	`provider_request_id`,
	`session_id`,
	`resolving_command_id`,
	`status`,
	`payload`,
	`resolution`,
	`status_reason`,
	`created_at`,
	`resolved_at`,
	`updated_at`
)
SELECT
	`id`,
	`thread_id`,
	`turn_id`,
	`provider_id`,
	`provider_thread_id`,
	`provider_request_id`,
	`session_id`,
	`resolving_command_id`,
	`status`,
	`payload`,
	`resolution`,
	`status_reason`,
	`created_at`,
	`resolved_at`,
	`updated_at`
FROM `pending_interactions`;
--> statement-breakpoint
DROP TABLE `pending_interactions`;
--> statement-breakpoint
ALTER TABLE `__pending_interactions_rebuild` RENAME TO `pending_interactions`;
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_interactions_provider_request_idx` ON `pending_interactions` (`session_id`,`provider_id`,`provider_thread_id`,`provider_request_id`);
--> statement-breakpoint
CREATE INDEX `pending_interactions_thread_created_idx` ON `pending_interactions` (`thread_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `pending_interactions_thread_status_created_idx` ON `pending_interactions` (`thread_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `pending_interactions_status_created_idx` ON `pending_interactions` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `pending_interactions_resolving_command_idx` ON `pending_interactions` (`resolving_command_id`);
