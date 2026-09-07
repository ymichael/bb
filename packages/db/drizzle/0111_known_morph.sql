CREATE TABLE IF NOT EXISTS `deferred_thread_messages_legacy` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
INSERT OR IGNORE INTO `deferred_thread_messages_legacy` SELECT `id`, `thread_id`, `kind`, `payload`, `created_at` FROM `deferred_thread_messages`;--> statement-breakpoint
DROP TABLE `deferred_thread_messages`;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `system_notice` text;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `send_at` integer;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `waiting_on` text;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `wait_holder` text;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `failure_reason` text;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `payload_kind` text DEFAULT 'inline' NOT NULL;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `retry_of_turn_request_id` text;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `retry_attempt` integer;--> statement-breakpoint
ALTER TABLE `queued_thread_messages` ADD `retry_reason` text;--> statement-breakpoint
CREATE INDEX `queued_thread_messages_due_idx` ON `queued_thread_messages` (`send_at`,`id`) WHERE "queued_thread_messages"."send_at" IS NOT NULL AND "queued_thread_messages"."claimed_at" IS NULL AND "queued_thread_messages"."claim_token" IS NULL;--> statement-breakpoint
CREATE INDEX `queued_thread_messages_wait_holder_idx` ON `queued_thread_messages` (`wait_holder`,`id`) WHERE "queued_thread_messages"."wait_holder" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `pending_start_context` text;