ALTER TABLE `threads` ADD `title_fallback` text;--> statement-breakpoint
CREATE UNIQUE INDEX `project_sources_project_host_idx` ON `project_sources` (`project_id`,`host_id`);