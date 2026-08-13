ALTER TABLE `projects` ADD `repository_url` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `last_fetched_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repository_url_unique` ON `projects` (`repository_url`);--> statement-breakpoint
ALTER TABLE `task_runs` ADD `pushed_at` text;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `pushed_commit` text;