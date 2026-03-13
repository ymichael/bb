CREATE TABLE `thread_environment_attachments` (
  `thread_id` text PRIMARY KEY NOT NULL REFERENCES `threads`(`id`) ON DELETE cascade,
  `environment_id` text NOT NULL REFERENCES `environments`(`id`) ON DELETE cascade,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `thread_environment_attachments_environment_idx`
  ON `thread_environment_attachments` (`environment_id`);
