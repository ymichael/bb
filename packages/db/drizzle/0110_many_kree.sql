CREATE TABLE `thread_conversation_outlines` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`projection_key` text NOT NULL,
	`items_json` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
