CREATE TABLE `__new_environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`descriptor` text,
	`managed` integer DEFAULT false NOT NULL,
	`properties` text,
	`runtime_state` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_environments`(
	`id`,
	`project_id`,
	`descriptor`,
	`managed`,
	`properties`,
	`runtime_state`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`project_id`,
	`descriptor`,
	`managed`,
	`properties`,
	`runtime_state`,
	`created_at`,
	`updated_at`
FROM `environments`;
--> statement-breakpoint
DROP TABLE `environments`;
--> statement-breakpoint
ALTER TABLE `__new_environments` RENAME TO `environments`;
--> statement-breakpoint
CREATE INDEX `environments_project_updated_idx` ON `environments` (`project_id`,`updated_at`);
