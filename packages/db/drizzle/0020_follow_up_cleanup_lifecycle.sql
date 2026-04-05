ALTER TABLE `environments` ADD `cleanup_requested_at` integer;
--> statement-breakpoint
ALTER TABLE `environments` ADD `cleanup_mode` text;
--> statement-breakpoint
CREATE INDEX `environments_cleanup_requested_idx` ON `environments` (`cleanup_requested_at`);
--> statement-breakpoint
UPDATE `environments`
SET
	`cleanup_requested_at` = COALESCE(`cleanup_requested_at`, `updated_at`),
	`cleanup_mode` = COALESCE(`cleanup_mode`, 'force')
WHERE `status` = 'destroying';
--> statement-breakpoint
UPDATE `environments`
SET `status` = CASE
	WHEN `path` IS NULL THEN 'provisioning'
	ELSE 'ready'
END
WHERE `status` = 'destroying'
	AND NOT EXISTS (
		SELECT 1
		FROM `host_daemon_commands`
		WHERE `host_daemon_commands`.`type` = 'environment.destroy'
			AND `host_daemon_commands`.`state` IN ('pending', 'fetched')
			AND json_extract(`host_daemon_commands`.`payload`, '$.environmentId') = `environments`.`id`
	);
