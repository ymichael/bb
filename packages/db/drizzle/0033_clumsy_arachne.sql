CREATE TABLE `pending_interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`provider_thread_id` text NOT NULL,
	`provider_request_id` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`resolution` text,
	`status_reason` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_interactions_provider_request_idx` ON `pending_interactions` (`session_id`,`provider_id`,`provider_thread_id`,`provider_request_id`);--> statement-breakpoint
CREATE INDEX `pending_interactions_thread_created_idx` ON `pending_interactions` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `pending_interactions_thread_status_created_idx` ON `pending_interactions` (`thread_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `pending_interactions_status_created_idx` ON `pending_interactions` (`status`,`created_at`);
