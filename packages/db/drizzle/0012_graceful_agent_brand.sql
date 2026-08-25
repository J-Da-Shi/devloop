CREATE TABLE `managed_delivery_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`max_task_budget_cents` integer DEFAULT 10000 NOT NULL,
	`warning_percent` integer DEFAULT 80 NOT NULL,
	`budget_overrun_percent` integer DEFAULT 25 NOT NULL,
	`auto_retry_limit` integer DEFAULT 2 NOT NULL,
	`codex_hourly_rate_cents` integer DEFAULT 2000 NOT NULL,
	`claude_code_hourly_rate_cents` integer DEFAULT 2000 NOT NULL,
	`fake_hourly_rate_cents` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `task_runs` ADD `budget_estimated_cost_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `budget_elapsed_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `budget_hard_limit_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `budget_warning_at_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `budget_source` text DEFAULT 'ELAPSED_TIME_ESTIMATE' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `execution_mode` text DEFAULT 'MANAGED' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `budget_estimate_low_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `budget_estimate_high_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `budget_estimate_low_minutes` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `budget_estimate_high_minutes` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `budget_confidence` text DEFAULT 'LOW' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `budget_hard_limit_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `budget_consumed_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `budget_warning_percent` integer DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `budget_rationale_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `managed_retry_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `tasks` SET `execution_mode` = 'STANDARD' WHERE `budget_hard_limit_cents` = 0;
