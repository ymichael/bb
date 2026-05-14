PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`provider` text,
	`external_id` text,
	`last_activity_at` integer,
	`suspended_at` integer,
	`destroyed_at` integer,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_hosts`("id", "name", "type", "provider", "external_id", "last_activity_at", "suspended_at", "destroyed_at", "last_seen_at", "created_at", "updated_at") SELECT "id", "name", "type", "provider", "external_id", "last_activity_at", "suspended_at", "destroyed_at", "last_seen_at", "created_at", "updated_at" FROM `hosts`;--> statement-breakpoint
DROP TABLE `hosts`;--> statement-breakpoint
ALTER TABLE `__new_hosts` RENAME TO `hosts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `hosts_last_activity_idx` ON `hosts` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `hosts_last_seen_idx` ON `hosts` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `hosts_suspended_idx` ON `hosts` (`suspended_at`);
