CREATE TABLE `artifact_payloads` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`byte_size` integer NOT NULL,
	`body_text` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`erased_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifact_payloads_org_hash_idx` ON `artifact_payloads` (`organization_id`,`content_hash`);--> statement-breakpoint
CREATE TABLE `artifact_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`content_ref` text NOT NULL,
	`content_hash` text NOT NULL,
	`byte_size` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_ref`) REFERENCES `artifact_payloads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_versions_artifact_number_uidx` ON `artifact_versions` (`artifact_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `artifact_versions_org_artifact_idx` ON `artifact_versions` (`organization_id`,`artifact_id`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`title` text NOT NULL,
	`media_type` text DEFAULT 'text/markdown' NOT NULL,
	`current_version` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifacts_org_updated_idx` ON `artifacts` (`organization_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `artifacts_work_item_updated_idx` ON `artifacts` (`work_item_id`,`updated_at`);--> statement-breakpoint
CREATE TRIGGER `artifact_payloads_validate_before_insert`
BEFORE INSERT ON `artifact_payloads`
BEGIN
	SELECT CASE WHEN
		length(NEW.`content_hash`) != 64
		OR NEW.`content_hash` GLOB '*[^0-9a-f]*'
		OR typeof(NEW.`byte_size`) != 'integer'
		OR NEW.`byte_size` < 1
		OR NEW.`byte_size` > 262144
		OR NEW.`body_text` IS NULL
		OR length(CAST(NEW.`body_text` AS BLOB)) != NEW.`byte_size`
		OR NEW.`erased_at` IS NOT NULL
	THEN RAISE(ABORT, 'invalid_artifact_payload') END;
END;--> statement-breakpoint
CREATE TRIGGER `artifact_payloads_restrict_update`
BEFORE UPDATE ON `artifact_payloads`
BEGIN
	SELECT CASE WHEN NOT (
		NEW.`id` = OLD.`id`
		AND NEW.`organization_id` = OLD.`organization_id`
		AND NEW.`content_hash` = OLD.`content_hash`
		AND NEW.`byte_size` = OLD.`byte_size`
		AND NEW.`created_at` = OLD.`created_at`
		AND OLD.`body_text` IS NOT NULL
		AND NEW.`body_text` IS NULL
		AND OLD.`erased_at` IS NULL
		AND NEW.`erased_at` IS NOT NULL
	) THEN RAISE(ABORT, 'artifact_payload_is_immutable') END;
END;--> statement-breakpoint
CREATE TRIGGER `artifact_payloads_prevent_delete`
BEFORE DELETE ON `artifact_payloads`
BEGIN
	SELECT RAISE(ABORT, 'artifact_payload_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `artifacts_validate_before_insert`
BEFORE INSERT ON `artifacts`
BEGIN
	SELECT CASE WHEN
		NEW.`media_type` != 'text/markdown'
		OR NEW.`current_version` != 0
		OR length(trim(NEW.`title`)) < 1
		OR length(NEW.`title`) > 160
	THEN RAISE(ABORT, 'invalid_artifact_metadata') END;

	SELECT CASE WHEN NOT EXISTS (
			SELECT 1
			FROM `work_items` work_item
			INNER JOIN `projects` project
			  ON project.`id` = work_item.`project_id`
			 AND project.`organization_id` = work_item.`organization_id`
			WHERE work_item.`id` = NEW.`work_item_id`
			  AND work_item.`organization_id` = NEW.`organization_id`
			  AND work_item.`project_id` = NEW.`project_id`
		)
	THEN RAISE(ABORT, 'invalid_artifact_reference') END;

	SELECT CASE WHEN NOT EXISTS (
			SELECT 1
			FROM `principals` principal
			WHERE principal.`id` = NEW.`created_by`
			  AND principal.`organization_id` = NEW.`organization_id`
			  AND principal.`status` = 'active'
		)
	THEN RAISE(ABORT, 'artifact_principal_inactive') END;
END;--> statement-breakpoint
CREATE TRIGGER `artifact_versions_validate_before_insert`
BEFORE INSERT ON `artifact_versions`
BEGIN
	SELECT CASE WHEN
		typeof(NEW.`version_number`) != 'integer'
		OR NEW.`version_number` < 1
	THEN RAISE(ABORT, 'artifact_version_conflict') END;

	SELECT CASE WHEN
		length(NEW.`note`) > 500
		OR length(NEW.`content_hash`) != 64
		OR NEW.`content_hash` GLOB '*[^0-9a-f]*'
		OR typeof(NEW.`byte_size`) != 'integer'
		OR NEW.`byte_size` < 1
		OR NEW.`byte_size` > 262144
	THEN RAISE(ABORT, 'invalid_artifact_version_metadata') END;

	SELECT CASE WHEN NOT EXISTS (
			SELECT 1
			FROM `artifacts` artifact
			WHERE artifact.`id` = NEW.`artifact_id`
			  AND artifact.`organization_id` = NEW.`organization_id`
			  AND NEW.`version_number` = artifact.`current_version` + 1
		)
	THEN RAISE(ABORT, 'artifact_version_conflict') END;

	SELECT CASE WHEN NOT EXISTS (
			SELECT 1
			FROM `artifact_payloads` payload
			WHERE payload.`id` = NEW.`content_ref`
			  AND payload.`organization_id` = NEW.`organization_id`
			  AND payload.`content_hash` = NEW.`content_hash`
			  AND payload.`byte_size` = NEW.`byte_size`
			  AND payload.`body_text` IS NOT NULL
			  AND payload.`erased_at` IS NULL
		)
	THEN RAISE(ABORT, 'invalid_artifact_payload_ref') END;

	SELECT CASE WHEN NOT EXISTS (
			SELECT 1
			FROM `principals` principal
			WHERE principal.`id` = NEW.`created_by`
			  AND principal.`organization_id` = NEW.`organization_id`
			  AND principal.`status` = 'active'
		)
	THEN RAISE(ABORT, 'artifact_principal_inactive') END;
END;--> statement-breakpoint
CREATE TRIGGER `artifacts_validate_version_advance`
BEFORE UPDATE ON `artifacts`
BEGIN
	SELECT CASE WHEN
		NEW.`id` != OLD.`id`
		OR NEW.`organization_id` != OLD.`organization_id`
		OR NEW.`project_id` != OLD.`project_id`
		OR NEW.`work_item_id` != OLD.`work_item_id`
		OR NEW.`title` != OLD.`title`
		OR NEW.`media_type` != OLD.`media_type`
		OR NEW.`created_by` != OLD.`created_by`
		OR NEW.`created_at` != OLD.`created_at`
		OR NEW.`current_version` != OLD.`current_version` + 1
		OR NOT EXISTS (
			SELECT 1
			FROM `artifact_versions` version
			WHERE version.`artifact_id` = NEW.`id`
			  AND version.`organization_id` = NEW.`organization_id`
			  AND version.`version_number` = NEW.`current_version`
		)
	THEN RAISE(ABORT, 'artifact_version_conflict') END;
END;--> statement-breakpoint
CREATE TRIGGER `artifact_versions_prevent_update`
BEFORE UPDATE ON `artifact_versions`
BEGIN
	SELECT RAISE(ABORT, 'artifact_version_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `artifact_versions_prevent_delete`
BEFORE DELETE ON `artifact_versions`
BEGIN
	SELECT RAISE(ABORT, 'artifact_version_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `artifacts_prevent_delete`
BEFORE DELETE ON `artifacts`
BEGIN
	SELECT RAISE(ABORT, 'artifact_is_immutable');
END;
