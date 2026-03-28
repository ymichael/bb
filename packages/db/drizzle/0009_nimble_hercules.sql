CREATE TABLE `__new_environments` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `host_id` text NOT NULL,
  `path` text,
  `managed` integer DEFAULT false NOT NULL,
  `is_git_repo` integer DEFAULT false NOT NULL,
  `is_worktree` integer DEFAULT false NOT NULL,
  `branch_name` text,
  `default_branch` text,
  `workspace_provision_type` text NOT NULL,
  `status` text DEFAULT 'provisioning' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_environments` (
  `id`,
  `project_id`,
  `host_id`,
  `path`,
  `managed`,
  `is_git_repo`,
  `is_worktree`,
  `branch_name`,
  `default_branch`,
  `workspace_provision_type`,
  `status`,
  `created_at`,
  `updated_at`
)
SELECT
  `id`,
  `project_id`,
  `host_id`,
  `path`,
  `managed`,
  `is_git_repo`,
  `is_worktree`,
  `branch_name`,
  `default_branch`,
  `workspace_provision_type`,
  `status`,
  `created_at`,
  `updated_at`
FROM `environments`;
--> statement-breakpoint
DROP TABLE `environments`;
--> statement-breakpoint
ALTER TABLE `__new_environments` RENAME TO `environments`;
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_host_path_idx` ON `environments` (`host_id`,`path`);
--> statement-breakpoint
CREATE INDEX `environments_project_idx` ON `environments` (`project_id`);
--> statement-breakpoint
CREATE INDEX `environments_status_idx` ON `environments` (`status`);
