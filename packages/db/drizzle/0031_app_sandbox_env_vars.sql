CREATE TABLE `app_sandbox_env_vars` (
  `name` text PRIMARY KEY NOT NULL,
  `encrypted_value` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_sandbox_env_vars_updated_at_idx`
ON `app_sandbox_env_vars` (`updated_at`);
