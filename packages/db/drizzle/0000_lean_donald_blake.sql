CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`checksum` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifacts_run_idx` ON `artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_aggregate_idx` ON `audit_events` (`aggregate_type`,`aggregate_id`);--> statement-breakpoint
CREATE TABLE `domain_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `domain_events_aggregate_idx` ON `domain_events` (`aggregate_type`,`aggregate_id`);--> statement-breakpoint
CREATE TABLE `paired_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`credential_hash` text NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pairing_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`external_base_url` text,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_sessions_code_hash_unique` ON `pairing_sessions` (`code_hash`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`default_base_ref` text NOT NULL,
	`integration_ref` text NOT NULL,
	`integration_commit` text,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);--> statement-breakpoint
CREATE TABLE `remote_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`command_type` text NOT NULL,
	`expected_version` integer NOT NULL,
	`status` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_commands_idempotency_unique` ON `remote_commands` (`device_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `review_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`decision` text NOT NULL,
	`feedback` text,
	`device_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_decisions_run_idx` ON `review_decisions` (`run_id`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_sequence_unique` ON `run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `task_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`revision` integer NOT NULL,
	`spec_json` text NOT NULL,
	`spec_hash` text NOT NULL,
	`base_ref` text NOT NULL,
	`base_strategy` text NOT NULL,
	`confirmed_base_commit` text,
	`created_from` text NOT NULL,
	`created_by_device_id` text,
	`confirmed_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_revisions_number_unique` ON `task_revisions` (`task_id`,`revision`);--> statement-breakpoint
CREATE TABLE `task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`task_revision_id` text NOT NULL,
	`runner` text NOT NULL,
	`status` text NOT NULL,
	`base_commit` text,
	`result_commit` text,
	`worktree_path` text,
	`branch_name` text,
	`execution_token` text NOT NULL,
	`process_group_id` integer,
	`runner_version` text,
	`run_input_hash` text NOT NULL,
	`summary` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_revision_id`) REFERENCES `task_revisions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `task_runs_task_idx` ON `task_runs` (`task_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`goal` text NOT NULL,
	`acceptance_criteria_json` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 50 NOT NULL,
	`active_revision_id` text,
	`latest_run_id` text,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_project_status_idx` ON `tasks` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_queue_idx` ON `tasks` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE TABLE `worker_state` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	`active_run_id` text,
	`version` integer DEFAULT 0 NOT NULL
);
