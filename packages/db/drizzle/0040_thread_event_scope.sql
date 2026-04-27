UPDATE `events` SET `type` = 'provider/error' WHERE `type` = 'error';
--> statement-breakpoint
UPDATE `events` SET `type` = 'provider/warning' WHERE `type` = 'warning';
--> statement-breakpoint
ALTER TABLE `events` ADD `scope_kind` text;
--> statement-breakpoint
UPDATE `events` SET `scope_kind` = 'turn' WHERE `turn_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `events`
SET `scope_kind` = 'thread'
WHERE `turn_id` IS NULL
  AND `type` IN (
    'thread/started',
    'thread/identity',
    'thread/name/updated',
    'client/thread/start',
    'client/turn/requested',
    'client/turn/start',
    'system/thread/interrupted',
    'system/operation',
    'system/thread-provisioning',
    'provider/error',
    'provider/warning',
    'provider/unhandled',
    'system/error',
    'system/manager/user_message'
  );
--> statement-breakpoint
CREATE TABLE `__new_events` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL,
  `environment_id` text,
  `scope_kind` text NOT NULL,
  `turn_id` text,
  `provider_thread_id` text,
  `sequence` integer NOT NULL,
  `type` text NOT NULL,
  `item_id` text,
  `item_kind` text,
  `data` text DEFAULT '{}' NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null,
  CONSTRAINT `events_scope_shape_check` CHECK (
    (`scope_kind` = 'turn' AND `turn_id` IS NOT NULL)
    OR
    (`scope_kind` = 'thread' AND `turn_id` IS NULL)
  )
);
--> statement-breakpoint
INSERT INTO `__new_events` (
  `id`,
  `thread_id`,
  `environment_id`,
  `scope_kind`,
  `turn_id`,
  `provider_thread_id`,
  `sequence`,
  `type`,
  `item_id`,
  `item_kind`,
  `data`,
  `created_at`
)
SELECT
  `id`,
  `thread_id`,
  `environment_id`,
  `scope_kind`,
  `turn_id`,
  `provider_thread_id`,
  `sequence`,
  `type`,
  `item_id`,
  `item_kind`,
  `data`,
  `created_at`
FROM `events`;
--> statement-breakpoint
DROP TABLE `events`;
--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;
--> statement-breakpoint
CREATE UNIQUE INDEX `events_thread_sequence_idx` ON `events` (`thread_id`, `sequence`);
--> statement-breakpoint
CREATE INDEX `events_thread_type_item_kind_sequence_idx` ON `events` (`thread_id`, `type`, `item_kind`, `sequence`);
--> statement-breakpoint
CREATE INDEX `events_thread_item_id_sequence_idx` ON `events` (`thread_id`, `item_id`, `sequence`);
--> statement-breakpoint
CREATE INDEX `events_environment_idx` ON `events` (`environment_id`);
