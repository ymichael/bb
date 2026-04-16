ALTER TABLE `threads` ADD `latest_attention_at` integer;
--> statement-breakpoint
UPDATE `threads` SET `latest_attention_at` = `updated_at` WHERE `latest_attention_at` IS NULL;
--> statement-breakpoint
CREATE TABLE `__new_threads` (
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
  FOREIGN KEY (`parent_thread_id`) REFERENCES `__new_threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_threads`(
  `id`, `project_id`, `environment_id`, `automation_id`, `provider_id`, `type`, `title`,
  `title_fallback`, `status`, `parent_thread_id`, `archived_at`, `stop_requested_at`,
  `deleted_at`, `last_read_at`, `latest_attention_at`, `created_at`, `updated_at`
)
SELECT
  `id`, `project_id`, `environment_id`, `automation_id`, `provider_id`, `type`, `title`,
  `title_fallback`, `status`, `parent_thread_id`, `archived_at`, `stop_requested_at`,
  `deleted_at`, `last_read_at`, `latest_attention_at`, `created_at`, `updated_at`
FROM `threads`;
--> statement-breakpoint
DROP TABLE `threads`;
--> statement-breakpoint
ALTER TABLE `__new_threads` RENAME TO `threads`;
--> statement-breakpoint
CREATE INDEX `threads_project_updated_idx` ON `threads` (`project_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `threads_environment_idx` ON `threads` (`environment_id`);
--> statement-breakpoint
CREATE INDEX `threads_automation_runtime_idx` ON `threads` (`automation_id`,`archived_at`,`deleted_at`,`status`);
--> statement-breakpoint
CREATE INDEX `threads_parent_idx` ON `threads` (`parent_thread_id`);
--> statement-breakpoint
CREATE INDEX `threads_archived_status_idx` ON `threads` (`archived_at`,`status`);
--> statement-breakpoint
CREATE INDEX `threads_environment_archived_deleted_idx` ON `threads` (`environment_id`,`archived_at`,`deleted_at`);
