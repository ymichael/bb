CREATE TABLE `__new_project_sources` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `type` text NOT NULL,
  `host_id` text,
  `path` text,
  `repo_url` text,
  `is_default` integer DEFAULT false NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade,
  CHECK (
    (
      `type` = 'local_path' AND
      `host_id` IS NOT NULL AND
      `path` IS NOT NULL AND
      `repo_url` IS NULL
    ) OR (
      `type` = 'github_repo' AND
      `host_id` IS NULL AND
      `path` IS NULL AND
      `repo_url` IS NOT NULL
    )
  )
);
--> statement-breakpoint
INSERT INTO `__new_project_sources` (
  `id`,
  `project_id`,
  `type`,
  `host_id`,
  `path`,
  `repo_url`,
  `is_default`,
  `created_at`,
  `updated_at`
)
SELECT
  `id`,
  `project_id`,
  `type`,
  CASE WHEN `type` = 'local_path' THEN `host_id` ELSE NULL END,
  CASE WHEN `type` = 'local_path' THEN `path` ELSE NULL END,
  CASE WHEN `type` = 'github_repo' THEN `repo_url` ELSE NULL END,
  `is_default`,
  `created_at`,
  `updated_at`
FROM `project_sources`;
--> statement-breakpoint
DROP TABLE `project_sources`;
--> statement-breakpoint
ALTER TABLE `__new_project_sources` RENAME TO `project_sources`;
--> statement-breakpoint
CREATE INDEX `project_sources_project_idx` ON `project_sources` (`project_id`);
--> statement-breakpoint
CREATE INDEX `project_sources_host_idx` ON `project_sources` (`host_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_sources_project_host_idx` ON `project_sources` (`project_id`,`host_id`);
