ALTER TABLE `environments` ADD `properties` text;
--> statement-breakpoint
ALTER TABLE `environments` DROP COLUMN `requested_runtime_kind`;
