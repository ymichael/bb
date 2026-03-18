CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`project_instructions` text,
	`default_provider_id` text,
	`primary_checkout_thread_id` text REFERENCES `threads`(`id`) ON DELETE SET NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_projects`(
	`id`,
	`name`,
	`root_path`,
	`project_instructions`,
	`default_provider_id`,
	`primary_checkout_thread_id`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`name`,
	`root_path`,
	`project_instructions`,
	`default_provider_id`,
	`primary_checkout_thread_id`,
	`created_at`,
	`updated_at`
FROM `projects`;
--> statement-breakpoint
DROP TABLE `projects`;
--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;
--> statement-breakpoint
CREATE INDEX `projects_primary_checkout_thread_idx` ON `projects` (`primary_checkout_thread_id`);
