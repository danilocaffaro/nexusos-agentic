CREATE TABLE `artifact_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`artifact_version_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`content_hash` text NOT NULL,
	`byte_size` integer NOT NULL,
	`verdict` text NOT NULL,
	`reason_code` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`self_review_policy` text,
	`status` text DEFAULT 'active' NOT NULL,
	`supersedes_review_id` text,
	`superseded_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`superseded_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_version_id`) REFERENCES `artifact_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supersedes_review_id`) REFERENCES `artifact_reviews`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_reviews_active_reviewer_uidx` ON `artifact_reviews` (`artifact_version_id`,`reviewer_id`) WHERE "artifact_reviews"."status" = 'active';--> statement-breakpoint
CREATE INDEX `artifact_reviews_org_version_idx` ON `artifact_reviews` (`organization_id`,`artifact_version_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_reviews_supersedes_uidx` ON `artifact_reviews` (`supersedes_review_id`) WHERE "artifact_reviews"."supersedes_review_id" IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER `artifact_reviews_validate_before_insert`
BEFORE INSERT ON `artifact_reviews`
BEGIN
	SELECT CASE WHEN
		NEW.`verdict` NOT IN ('approved', 'changes_requested')
		OR NEW.`reason_code` NOT IN (
			'accurate', 'complete', 'needs_correction',
			'needs_evidence', 'outdated'
		)
		OR (
			NEW.`verdict` = 'approved'
			AND NEW.`reason_code` NOT IN ('accurate', 'complete')
		)
		OR (
			NEW.`verdict` = 'changes_requested'
			AND NEW.`reason_code` NOT IN (
				'needs_correction', 'needs_evidence', 'outdated'
			)
		)
		OR NEW.`status` != 'active'
		OR NEW.`superseded_by` IS NOT NULL
		OR NEW.`superseded_at` IS NOT NULL
		OR length(NEW.`content_hash`) != 64
		OR NEW.`content_hash` GLOB '*[^0-9a-f]*'
		OR typeof(NEW.`version_number`) != 'integer'
		OR NEW.`version_number` < 1
		OR typeof(NEW.`byte_size`) != 'integer'
		OR NEW.`byte_size` < 1
		OR NEW.`byte_size` > 262144
	THEN RAISE(ABORT, 'invalid_artifact_review') END;

	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM `artifact_versions` version
		INNER JOIN `artifacts` artifact
		  ON artifact.`id` = version.`artifact_id`
		 AND artifact.`organization_id` = version.`organization_id`
		INNER JOIN `artifact_payloads` payload
		  ON payload.`id` = version.`content_ref`
		 AND payload.`organization_id` = version.`organization_id`
		 AND payload.`body_text` IS NOT NULL
		 AND payload.`erased_at` IS NULL
		WHERE version.`id` = NEW.`artifact_version_id`
		  AND version.`organization_id` = NEW.`organization_id`
		  AND version.`artifact_id` = NEW.`artifact_id`
		  AND version.`version_number` = NEW.`version_number`
		  AND version.`content_hash` = NEW.`content_hash`
		  AND version.`byte_size` = NEW.`byte_size`
	)
	THEN RAISE(ABORT, 'invalid_artifact_review_reference') END;

	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM `principals` principal
		INNER JOIN `memberships` membership
		  ON membership.`principal_id` = principal.`id`
		 AND membership.`organization_id` = principal.`organization_id`
		 AND membership.`status` = 'active'
		 AND membership.`role` IN ('owner', 'admin', 'member')
		WHERE principal.`id` = NEW.`reviewer_id`
		  AND principal.`organization_id` = NEW.`organization_id`
		  AND principal.`kind` = 'human'
		  AND principal.`status` = 'active'
	)
	THEN RAISE(ABORT, 'artifact_reviewer_ineligible') END;

	SELECT CASE WHEN NOT (
		(
			NEW.`verdict` = 'approved'
			AND NEW.`reviewer_id` = (
				SELECT version.`created_by`
				FROM `artifact_versions` version
				WHERE version.`id` = NEW.`artifact_version_id`
				  AND version.`organization_id` = NEW.`organization_id`
			)
			AND NEW.`self_review_policy` = 'solo_owner_ack'
			AND EXISTS (
				SELECT 1 FROM `memberships` membership
				WHERE membership.`organization_id` = NEW.`organization_id`
				  AND membership.`principal_id` = NEW.`reviewer_id`
				  AND membership.`status` = 'active'
				  AND membership.`role` = 'owner'
			)
			AND NOT EXISTS (
				SELECT 1
				FROM `memberships` membership
				INNER JOIN `principals` principal
				  ON principal.`id` = membership.`principal_id`
				 AND principal.`organization_id` =
					membership.`organization_id`
				WHERE membership.`organization_id` = NEW.`organization_id`
				  AND membership.`principal_id` != NEW.`reviewer_id`
				  AND membership.`status` = 'active'
				  AND membership.`role` IN ('owner', 'admin', 'member')
				  AND principal.`kind` = 'human'
				  AND principal.`status` = 'active'
			)
		)
		OR
		(
			NOT (
				NEW.`verdict` = 'approved'
				AND NEW.`reviewer_id` = (
					SELECT version.`created_by`
					FROM `artifact_versions` version
					WHERE version.`id` = NEW.`artifact_version_id`
					  AND version.`organization_id` =
						NEW.`organization_id`
				)
			)
			AND NEW.`self_review_policy` IS NULL
		)
	)
	THEN RAISE(ABORT, 'artifact_self_review_forbidden') END;

	SELECT CASE WHEN NOT (
		(
			NEW.`supersedes_review_id` IS NULL
			AND NOT EXISTS (
				SELECT 1 FROM `artifact_reviews` review
				WHERE review.`organization_id` = NEW.`organization_id`
				  AND review.`artifact_version_id` =
					NEW.`artifact_version_id`
				  AND review.`reviewer_id` = NEW.`reviewer_id`
				  AND review.`status` = 'active'
			)
		)
		OR
		(
			NEW.`supersedes_review_id` IS NOT NULL
			AND EXISTS (
				SELECT 1 FROM `artifact_reviews` review
				WHERE review.`id` = NEW.`supersedes_review_id`
				  AND review.`organization_id` = NEW.`organization_id`
				  AND review.`artifact_id` = NEW.`artifact_id`
				  AND review.`artifact_version_id` =
					NEW.`artifact_version_id`
				  AND review.`reviewer_id` = NEW.`reviewer_id`
				  AND review.`status` = 'superseded'
				  AND review.`superseded_by` = NEW.`reviewer_id`
				  AND review.`superseded_at` = NEW.`created_at`
			)
		)
	)
	THEN RAISE(ABORT, 'invalid_review_supersession') END;
END;--> statement-breakpoint
CREATE TRIGGER `artifact_reviews_restrict_update`
BEFORE UPDATE ON `artifact_reviews`
BEGIN
	SELECT CASE WHEN NOT (
		NEW.`id` = OLD.`id`
		AND NEW.`organization_id` = OLD.`organization_id`
		AND NEW.`artifact_id` = OLD.`artifact_id`
		AND NEW.`artifact_version_id` = OLD.`artifact_version_id`
		AND NEW.`version_number` = OLD.`version_number`
		AND NEW.`content_hash` = OLD.`content_hash`
		AND NEW.`byte_size` = OLD.`byte_size`
		AND NEW.`verdict` = OLD.`verdict`
		AND NEW.`reason_code` = OLD.`reason_code`
		AND NEW.`reviewer_id` = OLD.`reviewer_id`
		AND (
			NEW.`self_review_policy` = OLD.`self_review_policy`
			OR (
				NEW.`self_review_policy` IS NULL
				AND OLD.`self_review_policy` IS NULL
			)
		)
		AND (
			NEW.`supersedes_review_id` =
				OLD.`supersedes_review_id`
			OR (
				NEW.`supersedes_review_id` IS NULL
				AND OLD.`supersedes_review_id` IS NULL
			)
		)
		AND NEW.`created_at` = OLD.`created_at`
		AND OLD.`status` = 'active'
		AND NEW.`status` = 'superseded'
		AND OLD.`superseded_by` IS NULL
		AND NEW.`superseded_by` = OLD.`reviewer_id`
		AND OLD.`superseded_at` IS NULL
		AND NEW.`superseded_at` IS NOT NULL
	)
	THEN RAISE(ABORT, 'artifact_review_is_immutable') END;
END;--> statement-breakpoint
CREATE TRIGGER `artifact_reviews_prevent_delete`
BEFORE DELETE ON `artifact_reviews`
BEGIN
	SELECT RAISE(ABORT, 'artifact_review_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ledger_entries_validate_review_event`
BEFORE INSERT ON `ledger_entries`
WHEN NEW.`kind` IN ('review.recorded', 'review.superseded')
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM `artifact_reviews` review
		WHERE review.`organization_id` = NEW.`organization_id`
		  AND NEW.`payload_ref` =
			'nexus://artifact-review/' || review.`id`
		  AND NEW.`intent_id` IS NULL
		  AND length(NEW.`payload_hash`) = 64
		  AND NEW.`payload_hash` NOT GLOB '*[^0-9a-f]*'
		  AND (
			(NEW.`kind` = 'review.recorded'
			 AND review.`status` = 'active'
			 AND review.`reviewer_id` = NEW.`actor_id`
			 AND review.`created_at` = NEW.`occurred_at`)
			OR
			(NEW.`kind` = 'review.superseded'
			 AND review.`status` = 'superseded'
			 AND review.`superseded_by` = NEW.`actor_id`
			 AND review.`superseded_at` = NEW.`occurred_at`)
		  )
	)
	THEN RAISE(ABORT, 'invalid_review_ledger_event') END;

	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM `ledger_entries` existing
		WHERE existing.`organization_id` = NEW.`organization_id`
		  AND existing.`payload_ref` = NEW.`payload_ref`
		  AND existing.`kind` = NEW.`kind`
	)
	THEN RAISE(ABORT, 'duplicate_review_ledger_event') END;
END;
