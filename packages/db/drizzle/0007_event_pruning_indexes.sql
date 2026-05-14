CREATE INDEX `events_thread_turn_type_item_sequence_idx` ON `events` (`thread_id`,`turn_id`,`type`,`item_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `events_thread_turn_type_item_kind_item_idx` ON `events` (`thread_id`,`turn_id`,`type`,`item_kind`,`item_id`);
