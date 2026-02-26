CREATE TABLE `__new_threads` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `title` text,
  `status` text DEFAULT 'created' NOT NULL,
  `agent_role_id` text,
  `parent_thread_id` text,
  `archived_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_threads`(
  `id`,
  `project_id`,
  `title`,
  `status`,
  `agent_role_id`,
  `parent_thread_id`,
  `archived_at`,
  `created_at`,
  `updated_at`
)
SELECT
  `id`,
  `project_id`,
  `title`,
  `status`,
  `agent_role_id`,
  `parent_thread_id`,
  `archived_at`,
  `created_at`,
  `updated_at`
FROM `threads`;
--> statement-breakpoint
DROP TABLE `threads`;
--> statement-breakpoint
ALTER TABLE `__new_threads` RENAME TO `threads`;
--> statement-breakpoint
CREATE INDEX `threads_project_updated_idx` ON `threads` (`project_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `threads_project_agent_role_updated_idx` ON `threads` (`project_id`,`agent_role_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `threads_parent_thread_idx` ON `threads` (`parent_thread_id`);
--> statement-breakpoint
DROP TABLE IF EXISTS `task_events`;
--> statement-breakpoint
DROP TABLE IF EXISTS `task_dependencies`;
--> statement-breakpoint
DROP TABLE IF EXISTS `tasks`;
