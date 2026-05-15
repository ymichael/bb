ALTER TABLE `hosts` ADD `command_cursor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `hosts`
SET `command_cursor` = COALESCE((
  SELECT MAX(`cursor`)
  FROM `host_daemon_commands`
  WHERE `host_daemon_commands`.`host_id` = `hosts`.`id`
), 0);
--> statement-breakpoint
CREATE INDEX `events_completed_item_truncation_idx` ON `events` (`item_kind`,`created_at`) WHERE `type` = 'item/completed';
--> statement-breakpoint
DROP INDEX IF EXISTS `events_thread_turn_sequence_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `events_thread_item_id_sequence_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `events_thread_turn_type_item_kind_item_idx`;
--> statement-breakpoint
CREATE INDEX `host_daemon_commands_completed_prune_idx` ON `host_daemon_commands` (`completed_at`) WHERE `completed_at` IS NOT NULL AND `state` IN ('success', 'error');
