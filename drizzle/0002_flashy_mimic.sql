CREATE TABLE `objectives` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`ref` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'p1' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `objectives_org_ref_uidx` ON `objectives` (`organization_id`,`ref`);--> statement-breakpoint
CREATE INDEX `objectives_org_status_idx` ON `objectives` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `objectives_project_status_idx` ON `objectives` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`objective_id` text,
	`ref` text NOT NULL,
	`kind` text DEFAULT 'task' NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'backlog' NOT NULL,
	`priority` text DEFAULT 'p1' NOT NULL,
	`assignee_id` text,
	`external_ref` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`objective_id`) REFERENCES `objectives`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_items_org_ref_uidx` ON `work_items` (`organization_id`,`ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_items_org_external_ref_uidx` ON `work_items` (`organization_id`,`external_ref`);--> statement-breakpoint
CREATE INDEX `work_items_project_status_idx` ON `work_items` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `work_items_objective_status_idx` ON `work_items` (`objective_id`,`status`);--> statement-breakpoint
CREATE INDEX `work_items_assignee_idx` ON `work_items` (`assignee_id`);--> statement-breakpoint
CREATE TRIGGER `objectives_validate_before_insert`
BEFORE INSERT ON `objectives`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `projects`
		WHERE `id` = NEW.`project_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` != 'archived'
	) THEN RAISE(ABORT, 'invalid_workspace_reference') END;
END;--> statement-breakpoint
CREATE TRIGGER `objectives_validate_before_update`
BEFORE UPDATE OF project_id ON `objectives`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `projects`
		WHERE `id` = NEW.`project_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` != 'archived'
	) THEN RAISE(ABORT, 'invalid_workspace_reference') END;
END;--> statement-breakpoint
CREATE TRIGGER `work_items_validate_before_insert`
BEFORE INSERT ON `work_items`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `projects`
		WHERE `id` = NEW.`project_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` != 'archived'
	) OR (
		NEW.`objective_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `objectives`
			WHERE `id` = NEW.`objective_id`
			  AND `organization_id` = NEW.`organization_id`
			  AND `project_id` = NEW.`project_id`
			  AND `status` IN ('open', 'active')
		)
	) OR (
		NEW.`assignee_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `principals`
			WHERE `id` = NEW.`assignee_id`
			  AND `organization_id` = NEW.`organization_id`
			  AND `status` = 'active'
		)
	) THEN RAISE(ABORT, 'invalid_workspace_reference') END;
END;--> statement-breakpoint
CREATE TRIGGER `work_items_validate_before_update`
BEFORE UPDATE OF project_id, objective_id, assignee_id ON `work_items`
BEGIN
	SELECT CASE WHEN (
		NEW.`project_id` IS NOT OLD.`project_id` AND NOT EXISTS (
		SELECT 1 FROM `projects`
		WHERE `id` = NEW.`project_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` != 'archived'
		)
	) OR (
		NEW.`objective_id` IS NOT OLD.`objective_id`
		AND NEW.`objective_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `objectives`
			WHERE `id` = NEW.`objective_id`
			  AND `organization_id` = NEW.`organization_id`
			  AND `project_id` = NEW.`project_id`
			  AND `status` IN ('open', 'active')
		)
	) OR (
		NEW.`assignee_id` IS NOT OLD.`assignee_id`
		AND NEW.`assignee_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `principals`
			WHERE `id` = NEW.`assignee_id`
			  AND `organization_id` = NEW.`organization_id`
			  AND `status` = 'active'
		)
	) THEN RAISE(ABORT, 'invalid_workspace_reference') END;
END;
