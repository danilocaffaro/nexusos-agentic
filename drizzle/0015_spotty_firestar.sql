CREATE TABLE `artifact_supersessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`source_artifact_id` text NOT NULL,
	`source_version_id` text NOT NULL,
	`source_version_number` integer NOT NULL,
	`source_content_hash` text NOT NULL,
	`source_byte_size` integer NOT NULL,
	`target_artifact_id` text NOT NULL,
	`target_version_id` text NOT NULL,
	`target_version_number` integer NOT NULL,
	`target_content_hash` text NOT NULL,
	`target_byte_size` integer NOT NULL,
	`relation_type` text DEFAULT 'supersedes' NOT NULL,
	`reason_code` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`declared_by` text NOT NULL,
	`declared_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`retraction_reason_code` text,
	`retracted_by` text,
	`retracted_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_version_id`) REFERENCES `artifact_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_version_id`) REFERENCES `artifact_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`declared_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`retracted_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_supersessions_active_source_uidx` ON `artifact_supersessions` (`organization_id`,`source_artifact_id`) WHERE "artifact_supersessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX `artifact_supersessions_org_target_active_idx` ON `artifact_supersessions` (`organization_id`,`target_artifact_id`) WHERE "artifact_supersessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX `artifact_supersessions_org_source_history_idx` ON `artifact_supersessions` (`organization_id`,`source_artifact_id`,`declared_at`);--> statement-breakpoint
CREATE TRIGGER `artifact_supersessions_validate_before_insert`
BEFORE INSERT ON `artifact_supersessions`
BEGIN
	SELECT CASE WHEN
		NEW.`relation_type` != 'supersedes'
		OR NEW.`reason_code` NOT IN (
			'replaced_by_revision', 'duplicate_output', 'scope_moved'
		)
		OR NEW.`status` != 'active'
		OR NEW.`retraction_reason_code` IS NOT NULL
		OR NEW.`retracted_by` IS NOT NULL
		OR NEW.`retracted_at` IS NOT NULL
		OR NEW.`source_artifact_id` = NEW.`target_artifact_id`
		OR NEW.`source_content_hash` = NEW.`target_content_hash`
		OR length(NEW.`source_content_hash`) != 64
		OR NEW.`source_content_hash` GLOB '*[^0-9a-f]*'
		OR length(NEW.`target_content_hash`) != 64
		OR NEW.`target_content_hash` GLOB '*[^0-9a-f]*'
		OR typeof(NEW.`source_version_number`) != 'integer'
		OR NEW.`source_version_number` < 1
		OR typeof(NEW.`target_version_number`) != 'integer'
		OR NEW.`target_version_number` < 1
		OR typeof(NEW.`source_byte_size`) != 'integer'
		OR NEW.`source_byte_size` < 1
		OR NEW.`source_byte_size` > 262144
		OR typeof(NEW.`target_byte_size`) != 'integer'
		OR NEW.`target_byte_size` < 1
		OR NEW.`target_byte_size` > 262144
	THEN RAISE(ABORT, 'invalid_artifact_supersession') END;

	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM `artifact_versions` version
		INNER JOIN `artifacts` artifact
		  ON artifact.`id` = version.`artifact_id`
		 AND artifact.`organization_id` = version.`organization_id`
		WHERE version.`id` = NEW.`source_version_id`
		  AND version.`organization_id` = NEW.`organization_id`
		  AND version.`artifact_id` = NEW.`source_artifact_id`
		  AND version.`version_number` = NEW.`source_version_number`
		  AND version.`content_hash` = NEW.`source_content_hash`
		  AND version.`byte_size` = NEW.`source_byte_size`
		  AND artifact.`current_version` = NEW.`source_version_number`
		  AND artifact.`current_version` >= 1
	)
	THEN RAISE(ABORT, 'artifact_supersession_head_moved') END;

	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM `artifact_versions` version
		INNER JOIN `artifacts` artifact
		  ON artifact.`id` = version.`artifact_id`
		 AND artifact.`organization_id` = version.`organization_id`
		WHERE version.`id` = NEW.`target_version_id`
		  AND version.`organization_id` = NEW.`organization_id`
		  AND version.`artifact_id` = NEW.`target_artifact_id`
		  AND version.`version_number` = NEW.`target_version_number`
		  AND version.`content_hash` = NEW.`target_content_hash`
		  AND version.`byte_size` = NEW.`target_byte_size`
		  AND artifact.`current_version` = NEW.`target_version_number`
		  AND artifact.`current_version` >= 1
	)
	THEN RAISE(ABORT, 'artifact_supersession_head_moved') END;

	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM `artifact_versions` version
		INNER JOIN `artifact_payloads` payload
		  ON payload.`id` = version.`content_ref`
		 AND payload.`organization_id` = version.`organization_id`
		 AND payload.`body_text` IS NOT NULL
		 AND payload.`erased_at` IS NULL
		WHERE version.`id` = NEW.`target_version_id`
		  AND version.`organization_id` = NEW.`organization_id`
	)
	THEN RAISE(ABORT, 'artifact_supersession_target_unreadable') END;

	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM `principals` principal
		INNER JOIN `memberships` membership
		  ON membership.`principal_id` = principal.`id`
		 AND membership.`organization_id` = principal.`organization_id`
		 AND membership.`status` = 'active'
		 AND membership.`role` IN ('owner', 'admin')
		WHERE principal.`id` = NEW.`declared_by`
		  AND principal.`organization_id` = NEW.`organization_id`
		  AND principal.`kind` = 'human'
		  AND principal.`status` = 'active'
	)
	THEN RAISE(ABORT, 'artifact_supersession_actor_ineligible') END;

	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM `artifact_supersessions` existing
		WHERE existing.`organization_id` = NEW.`organization_id`
		  AND existing.`source_artifact_id` = NEW.`source_artifact_id`
		  AND existing.`status` = 'active'
	)
	THEN RAISE(ABORT, 'artifact_supersession_exists') END;

	WITH RECURSIVE chain(`artifact_id`, `depth`) AS (
		SELECT NEW.`target_artifact_id`, 0
		UNION ALL
		SELECT relation.`target_artifact_id`, chain.`depth` + 1
		FROM `artifact_supersessions` relation
		INNER JOIN chain
		  ON relation.`source_artifact_id` = chain.`artifact_id`
		WHERE relation.`organization_id` = NEW.`organization_id`
		  AND relation.`status` = 'active'
		  AND chain.`depth` < 100
	)
	SELECT CASE
		WHEN EXISTS (
			SELECT 1 FROM chain
			WHERE chain.`artifact_id` = NEW.`source_artifact_id`
		)
		THEN RAISE(ABORT, 'artifact_supersession_cycle')
		WHEN EXISTS (
			SELECT 1
			FROM chain
			INNER JOIN `artifact_supersessions` relation
			  ON relation.`source_artifact_id` = chain.`artifact_id`
			 AND relation.`organization_id` = NEW.`organization_id`
			 AND relation.`status` = 'active'
			WHERE chain.`depth` = 100
		)
		THEN RAISE(ABORT, 'artifact_supersession_chain_too_long')
	END;
END;--> statement-breakpoint
CREATE TRIGGER `artifact_supersessions_restrict_update`
BEFORE UPDATE ON `artifact_supersessions`
BEGIN
	SELECT CASE WHEN NOT (
		NEW.`id` = OLD.`id`
		AND NEW.`organization_id` = OLD.`organization_id`
		AND NEW.`source_artifact_id` = OLD.`source_artifact_id`
		AND NEW.`source_version_id` = OLD.`source_version_id`
		AND NEW.`source_version_number` = OLD.`source_version_number`
		AND NEW.`source_content_hash` = OLD.`source_content_hash`
		AND NEW.`source_byte_size` = OLD.`source_byte_size`
		AND NEW.`target_artifact_id` = OLD.`target_artifact_id`
		AND NEW.`target_version_id` = OLD.`target_version_id`
		AND NEW.`target_version_number` = OLD.`target_version_number`
		AND NEW.`target_content_hash` = OLD.`target_content_hash`
		AND NEW.`target_byte_size` = OLD.`target_byte_size`
		AND NEW.`relation_type` = OLD.`relation_type`
		AND NEW.`reason_code` = OLD.`reason_code`
		AND NEW.`declared_by` = OLD.`declared_by`
		AND NEW.`declared_at` = OLD.`declared_at`
		AND OLD.`status` = 'active'
		AND NEW.`status` = 'retracted'
		AND OLD.`retraction_reason_code` IS NULL
		AND NEW.`retraction_reason_code` IN (
			'declared_in_error', 'no_longer_accurate'
		)
		AND OLD.`retracted_by` IS NULL
		AND NEW.`retracted_by` IS NOT NULL
		AND OLD.`retracted_at` IS NULL
		AND NEW.`retracted_at` IS NOT NULL
		AND EXISTS (
			SELECT 1
			FROM `principals` principal
			INNER JOIN `memberships` membership
			  ON membership.`principal_id` = principal.`id`
			 AND membership.`organization_id` =
				principal.`organization_id`
			 AND membership.`status` = 'active'
			 AND membership.`role` IN ('owner', 'admin')
			WHERE principal.`id` = NEW.`retracted_by`
			  AND principal.`organization_id` = NEW.`organization_id`
			  AND principal.`kind` = 'human'
			  AND principal.`status` = 'active'
		)
	)
	THEN RAISE(ABORT, 'artifact_supersession_is_immutable') END;
END;--> statement-breakpoint
CREATE TRIGGER `artifact_supersessions_prevent_delete`
BEFORE DELETE ON `artifact_supersessions`
BEGIN
	SELECT RAISE(ABORT, 'artifact_supersession_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ledger_entries_validate_supersession_event`
BEFORE INSERT ON `ledger_entries`
WHEN NEW.`kind` IN (
	'supersession.declared', 'supersession.retracted'
)
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM `artifact_supersessions` relation
		WHERE relation.`organization_id` = NEW.`organization_id`
		  AND NEW.`payload_ref` =
			'nexus://artifact-supersession/' || relation.`id`
		  AND NEW.`intent_id` IS NULL
		  AND NEW.`run_id` IS NULL
		  AND length(NEW.`payload_hash`) = 64
		  AND NEW.`payload_hash` NOT GLOB '*[^0-9a-f]*'
		  AND (
			(NEW.`kind` = 'supersession.declared'
			 AND relation.`status` = 'active'
			 AND relation.`declared_by` = NEW.`actor_id`
			 AND relation.`declared_at` = NEW.`occurred_at`)
			OR
			(NEW.`kind` = 'supersession.retracted'
			 AND relation.`status` = 'retracted'
			 AND relation.`retracted_by` = NEW.`actor_id`
			 AND relation.`retracted_at` = NEW.`occurred_at`)
		  )
	)
	THEN RAISE(ABORT, 'invalid_supersession_ledger_event') END;

	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM `ledger_entries` existing
		WHERE existing.`organization_id` = NEW.`organization_id`
		  AND existing.`payload_ref` = NEW.`payload_ref`
		  AND existing.`kind` = NEW.`kind`
	)
	THEN RAISE(ABORT, 'duplicate_supersession_ledger_event') END;
END;
