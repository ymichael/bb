CREATE TABLE `thread_dynamic_context_file_states` (
	`thread_id` text NOT NULL,
	`file_key` text NOT NULL,
	`content_status` text NOT NULL,
	`content_hash` text NOT NULL,
	`shown_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_dynamic_context_file_states_thread_file_idx` ON `thread_dynamic_context_file_states` (`thread_id`,`file_key`);
