CREATE TABLE `agent_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`connection_id` text,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`model` text NOT NULL,
	`memory_scope` text DEFAULT 'project' NOT NULL,
	`autonomy_level` text DEFAULT 'A1' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `model_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_definitions_principal_uidx` ON `agent_definitions` (`principal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_definitions_org_slug_uidx` ON `agent_definitions` (`organization_id`,`slug`);--> statement-breakpoint
CREATE INDEX `agent_definitions_org_status_idx` ON `agent_definitions` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_definitions_connection_idx` ON `agent_definitions` (`connection_id`);--> statement-breakpoint
CREATE TABLE `model_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`auth_method` text NOT NULL,
	`label` text NOT NULL,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`last_verified_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_connections_org_provider_label_uidx` ON `model_connections` (`organization_id`,`provider`,`label`);--> statement-breakpoint
CREATE INDEX `model_connections_org_status_idx` ON `model_connections` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`team_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`assignment_role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_members_team_principal_uidx` ON `team_members` (`team_id`,`principal_id`);--> statement-breakpoint
CREATE INDEX `team_members_org_status_idx` ON `team_members` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `team_members_principal_idx` ON `team_members` (`principal_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`mission` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_project_slug_uidx` ON `teams` (`project_id`,`slug`);--> statement-breakpoint
CREATE INDEX `teams_org_status_idx` ON `teams` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `teams_project_status_idx` ON `teams` (`project_id`,`status`);--> statement-breakpoint
ALTER TABLE `projects` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE TRIGGER `agent_definitions_sync_principal_after_update`
AFTER UPDATE OF name, status ON `agent_definitions`
BEGIN
	UPDATE `principals`
	SET
		`display_name` = NEW.`name`,
		`status` = CASE
			WHEN NEW.`status` = 'archived' THEN 'archived'
			WHEN OLD.`status` = 'archived' THEN 'active'
			ELSE `status`
		END,
		`updated_at` = NEW.`updated_at`
	WHERE `id` = NEW.`principal_id`
	  AND `organization_id` = NEW.`organization_id`;
END;--> statement-breakpoint
CREATE TRIGGER `agent_definitions_sync_members_after_update`
AFTER UPDATE OF role, status ON `agent_definitions`
BEGIN
	UPDATE `team_members`
	SET
		`assignment_role` = NEW.`role`,
		`version` = `version` + 1,
		`updated_at` = NEW.`updated_at`
	WHERE `principal_id` = NEW.`principal_id`
	  AND `organization_id` = NEW.`organization_id`;
END;--> statement-breakpoint
CREATE TRIGGER `teams_validate_project_before_insert`
BEFORE INSERT ON `teams`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `projects`
		WHERE `id` = NEW.`project_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` != 'archived'
	) THEN RAISE(ABORT, 'invalid_workspace_reference') END;
END;--> statement-breakpoint
CREATE TRIGGER `agent_definitions_validate_before_insert`
BEFORE INSERT ON `agent_definitions`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `principals`
		WHERE `id` = NEW.`principal_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `kind` = 'agent'
		  AND `status` = 'active'
	) OR (
		NEW.`connection_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `model_connections`
			WHERE `id` = NEW.`connection_id`
			  AND `organization_id` = NEW.`organization_id`
			  AND `status` != 'archived'
		)
	) THEN RAISE(ABORT, 'invalid_workspace_reference') END;
END;--> statement-breakpoint
CREATE TRIGGER `agent_definitions_validate_before_update`
BEFORE UPDATE OF connection_id, status ON `agent_definitions`
WHEN NEW.`status` != 'archived'
BEGIN
	SELECT CASE WHEN NEW.`connection_id` IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM `model_connections`
		WHERE `id` = NEW.`connection_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` != 'archived'
	) THEN RAISE(ABORT, 'invalid_workspace_reference') END;
END;--> statement-breakpoint
CREATE TRIGGER `team_members_validate_before_insert`
BEFORE INSERT ON `team_members`
WHEN NEW.`status` = 'active'
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `teams`
		WHERE `id` = NEW.`team_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` != 'archived'
	) OR NOT EXISTS (
		SELECT 1 FROM `principals`
		WHERE `id` = NEW.`principal_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` = 'active'
	) THEN RAISE(ABORT, 'invalid_workspace_reference') END;
END;
