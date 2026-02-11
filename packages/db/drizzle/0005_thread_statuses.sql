PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'created' NOT NULL CHECK(`status` IN ('created', 'provisioning', 'provisioning_failed', 'idle', 'active')),
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_threads`(`id`, `project_id`, `title`, `status`, `archived_at`, `created_at`, `updated_at`)
SELECT
	`id`,
	`project_id`,
	`title`,
	CASE
		WHEN `status` = 'running' THEN 'active'
		WHEN `status` IN ('created', 'provisioning', 'provisioning_failed', 'idle', 'active') THEN `status`
		ELSE 'created'
	END,
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
PRAGMA foreign_keys=ON;
