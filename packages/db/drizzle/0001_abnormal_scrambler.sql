ALTER TABLE `task_revisions` ADD `target_branch` text DEFAULT 'HEAD' NOT NULL;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `target_branch` text DEFAULT 'HEAD' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `target_branch` text DEFAULT 'HEAD' NOT NULL;--> statement-breakpoint
UPDATE `tasks`
SET `target_branch` = (
	SELECT `projects`.`default_base_ref`
	FROM `projects`
	WHERE `projects`.`id` = `tasks`.`project_id`
);--> statement-breakpoint
UPDATE `task_revisions`
SET `target_branch` = `base_ref`;--> statement-breakpoint
UPDATE `task_runs`
SET `target_branch` = (
	SELECT `task_revisions`.`target_branch`
	FROM `task_revisions`
	WHERE `task_revisions`.`id` = `task_runs`.`task_revision_id`
);
