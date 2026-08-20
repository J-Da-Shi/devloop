CREATE TABLE `context_scratchpad` (
	`key` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`content_type` text NOT NULL,
	`content_text` text NOT NULL,
	`original_tokens` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_context_scratchpad_run` ON `context_scratchpad` (`run_id`);