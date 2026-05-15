CREATE TABLE `maintenance_scan_cursors` (
	`id` text PRIMARY KEY NOT NULL,
	`policy` text NOT NULL,
	`version` integer NOT NULL,
	`item_kind` text NOT NULL,
	`output_path` text NOT NULL,
	`last_created_at` integer DEFAULT 0 NOT NULL,
	`last_event_id` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_scan_cursors_path_idx` ON `maintenance_scan_cursors` (`policy`,`version`,`item_kind`,`output_path`);
--> statement-breakpoint
DROP INDEX IF EXISTS `events_completed_item_truncation_idx`;
--> statement-breakpoint
CREATE INDEX `events_completed_item_truncation_idx` ON `events` (`item_kind`,`created_at`,`id`) WHERE `type` = 'item/completed';
--> statement-breakpoint
CREATE INDEX `threads_active_maintenance_idx` ON `threads` (`status`) WHERE `deleted_at` IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `host_daemon_commands_completed_prune_idx`;
--> statement-breakpoint
CREATE INDEX `host_daemon_commands_completed_prune_idx` ON `host_daemon_commands` (`completed_at`) WHERE `completed_at` IS NOT NULL;
