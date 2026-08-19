ALTER TABLE `projects` ADD `preview_command` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `preview_working_directory` text DEFAULT '.' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `preview_health_path` text DEFAULT '/' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `playwright_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `playwright_test_command` text;