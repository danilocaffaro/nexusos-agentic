CREATE TABLE `intent_artifact_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`intent_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`artifact_version_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`byte_size` integer NOT NULL,
	`relation` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`added_by` text NOT NULL,
	`superseded_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`superseded_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intent_id`) REFERENCES `action_intents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_version_id`) REFERENCES `artifact_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`added_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intent_artifact_evidence_active_uidx` ON `intent_artifact_evidence` (`intent_id`,`artifact_version_id`,`relation`) WHERE "intent_artifact_evidence"."status" = 'active';--> statement-breakpoint
CREATE INDEX `intent_artifact_evidence_org_intent_idx` ON `intent_artifact_evidence` (`organization_id`,`intent_id`);--> statement-breakpoint
CREATE INDEX `intent_artifact_evidence_version_idx` ON `intent_artifact_evidence` (`artifact_version_id`);--> statement-breakpoint
CREATE TRIGGER `intent_artifact_evidence_validate_before_insert`
BEFORE INSERT ON `intent_artifact_evidence`
BEGIN
	SELECT CASE WHEN
		NEW.`relation` NOT IN ('basis', 'outcome')
		OR NEW.`status` != 'active'
		OR NEW.`superseded_by` IS NOT NULL
		OR NEW.`superseded_at` IS NOT NULL
		OR length(NEW.`content_hash`) != 64
		OR NEW.`content_hash` GLOB '*[^0-9a-f]*'
		OR typeof(NEW.`byte_size`) != 'integer'
		OR NEW.`byte_size` < 1
		OR NEW.`byte_size` > 262144
	THEN RAISE(ABORT, 'invalid_evidence_metadata') END;

	SELECT CASE WHEN NOT EXISTS (
			SELECT 1
			FROM `action_intents` intent
			INNER JOIN `artifacts` artifact
			  ON artifact.`id` = NEW.`artifact_id`
			 AND artifact.`organization_id` = intent.`organization_id`
			 AND artifact.`project_id` = intent.`project_id`
			INNER JOIN `artifact_versions` version
			  ON version.`id` = NEW.`artifact_version_id`
			 AND version.`organization_id` = intent.`organization_id`
			 AND version.`artifact_id` = artifact.`id`
			 AND version.`content_hash` = NEW.`content_hash`
			 AND version.`byte_size` = NEW.`byte_size`
			INNER JOIN `artifact_payloads` payload
			  ON payload.`id` = version.`content_ref`
			 AND payload.`organization_id` = version.`organization_id`
			 AND payload.`body_text` IS NOT NULL
			 AND payload.`erased_at` IS NULL
			WHERE intent.`id` = NEW.`intent_id`
			  AND intent.`organization_id` = NEW.`organization_id`
		)
	THEN RAISE(ABORT, 'invalid_evidence_reference') END;

	SELECT CASE WHEN NOT EXISTS (
			SELECT 1
			FROM `action_intents` intent
			WHERE intent.`id` = NEW.`intent_id`
			  AND intent.`organization_id` = NEW.`organization_id`
			  AND (
				(NEW.`relation` = 'basis'
				 AND intent.`status` IN ('draft', 'proposed'))
				OR
				(NEW.`relation` = 'outcome'
				 AND intent.`status` = 'executing')
			  )
		)
	THEN RAISE(ABORT, 'evidence_phase_invalid') END;

	SELECT CASE WHEN NOT EXISTS (
			SELECT 1
			FROM `principals` principal
			LEFT JOIN `memberships` membership
			  ON membership.`principal_id` = principal.`id`
			 AND membership.`organization_id` = principal.`organization_id`
			 AND membership.`status` = 'active'
			WHERE principal.`id` = NEW.`added_by`
			  AND principal.`organization_id` = NEW.`organization_id`
			  AND principal.`status` = 'active'
			  AND (
				(NEW.`relation` = 'basis'
				 AND principal.`kind` = 'human'
				 AND membership.`role` IN ('owner', 'admin', 'member'))
				OR
				(NEW.`relation` = 'outcome'
				 AND principal.`kind` IN ('agent', 'automation', 'runner'))
			  )
		)
	THEN RAISE(ABORT, 'evidence_principal_inactive') END;
END;--> statement-breakpoint
CREATE TRIGGER `intent_artifact_evidence_restrict_update`
BEFORE UPDATE ON `intent_artifact_evidence`
BEGIN
	SELECT CASE WHEN NOT (
		NEW.`id` = OLD.`id`
		AND NEW.`organization_id` = OLD.`organization_id`
		AND NEW.`intent_id` = OLD.`intent_id`
		AND NEW.`artifact_id` = OLD.`artifact_id`
		AND NEW.`artifact_version_id` = OLD.`artifact_version_id`
		AND NEW.`content_hash` = OLD.`content_hash`
		AND NEW.`byte_size` = OLD.`byte_size`
		AND NEW.`relation` = OLD.`relation`
		AND NEW.`added_by` = OLD.`added_by`
		AND NEW.`created_at` = OLD.`created_at`
		AND OLD.`status` = 'active'
		AND NEW.`status` = 'superseded'
		AND OLD.`superseded_by` IS NULL
		AND NEW.`superseded_by` IS NOT NULL
		AND OLD.`superseded_at` IS NULL
		AND NEW.`superseded_at` IS NOT NULL
		AND EXISTS (
			SELECT 1
			FROM `action_intents` intent
			WHERE intent.`id` = OLD.`intent_id`
			  AND intent.`organization_id` = OLD.`organization_id`
			  AND intent.`status` IN ('draft', 'proposed')
		)
		AND EXISTS (
			SELECT 1
			FROM `principals` principal
			INNER JOIN `memberships` membership
			  ON membership.`principal_id` = principal.`id`
			 AND membership.`organization_id` = principal.`organization_id`
			 AND membership.`status` = 'active'
			WHERE principal.`id` = NEW.`superseded_by`
			  AND principal.`organization_id` = OLD.`organization_id`
			  AND principal.`kind` = 'human'
			  AND principal.`status` = 'active'
			  AND (
				NEW.`superseded_by` = OLD.`added_by`
				OR membership.`role` IN ('owner', 'admin')
			  )
		)
	) THEN RAISE(ABORT, 'evidence_is_immutable') END;
END;--> statement-breakpoint
CREATE TRIGGER `intent_artifact_evidence_prevent_delete`
BEFORE DELETE ON `intent_artifact_evidence`
BEGIN
	SELECT RAISE(ABORT, 'evidence_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ledger_entries_validate_evidence_event`
BEFORE INSERT ON `ledger_entries`
WHEN NEW.`kind` IN ('evidence.linked', 'evidence.superseded')
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM `intent_artifact_evidence` evidence
		WHERE evidence.`organization_id` = NEW.`organization_id`
		  AND evidence.`intent_id` = NEW.`intent_id`
		  AND NEW.`payload_ref` =
			'nexus://intent-evidence/' || evidence.`id`
		  AND length(NEW.`payload_hash`) = 64
		  AND NEW.`payload_hash` NOT GLOB '*[^0-9a-f]*'
		  AND (
			(NEW.`kind` = 'evidence.linked'
			 AND evidence.`status` = 'active'
			 AND evidence.`added_by` = NEW.`actor_id`
			 AND evidence.`created_at` = NEW.`occurred_at`)
			OR
			(NEW.`kind` = 'evidence.superseded'
			 AND evidence.`status` = 'superseded'
			 AND evidence.`superseded_by` = NEW.`actor_id`
			 AND evidence.`superseded_at` = NEW.`occurred_at`)
		  )
	)
	THEN RAISE(ABORT, 'invalid_evidence_ledger_event') END;

	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM `ledger_entries` existing
		WHERE existing.`organization_id` = NEW.`organization_id`
		  AND existing.`payload_ref` = NEW.`payload_ref`
		  AND existing.`kind` = NEW.`kind`
	)
	THEN RAISE(ABORT, 'duplicate_evidence_ledger_event') END;
END;
