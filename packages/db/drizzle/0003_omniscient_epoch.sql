ALTER TABLE `environments` RENAME COLUMN "provisioner_id" TO "workspace_provision_type";--> statement-breakpoint
ALTER TABLE `environments` DROP COLUMN `provisioner_state`;