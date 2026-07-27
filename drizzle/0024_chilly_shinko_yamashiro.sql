CREATE TABLE `runner_engine_reports` (
	`organization_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`report_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`declaration_hash` text NOT NULL,
	`schema_version` integer NOT NULL,
	`collected_at` text NOT NULL,
	`received_at` text NOT NULL,
	`truncated` integer NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text,
	`replay_count` integer DEFAULT 0 NOT NULL,
	`compacted_at` text,
	PRIMARY KEY(`runner_id`, `report_id`),
	FOREIGN KEY (`organization_id`,`runner_id`)
		REFERENCES `runners`(`organization_id`,`id`)
		ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runner_engine_reports_schema_check"
		CHECK(`schema_version` = 1),
	CONSTRAINT "runner_engine_reports_truncated_check"
		CHECK(`truncated` IN (0, 1)),
	CONSTRAINT "runner_engine_reports_response_check"
		CHECK(`response_status` BETWEEN 100 AND 599
			AND (`response_body` IS NULL
				OR length(CAST(`response_body` AS BLOB)) <= 65536)),
	CONSTRAINT "runner_engine_reports_replay_check"
		CHECK(`replay_count` >= 0)
);--> statement-breakpoint
CREATE INDEX `runner_engine_reports_org_runner_history_idx`
ON `runner_engine_reports`
	(`organization_id`,`runner_id`,`received_at`,`report_id`);--> statement-breakpoint
CREATE INDEX `runner_engine_reports_compaction_idx`
ON `runner_engine_reports`
	(`organization_id`,`compacted_at`,`received_at`);--> statement-breakpoint
CREATE TABLE `runner_engine_evidence` (
	`runner_id` text NOT NULL,
	`report_id` text NOT NULL,
	`position` integer NOT NULL,
	`engine` text NOT NULL,
	`status` text NOT NULL,
	`readiness` text NOT NULL,
	`reason` text NOT NULL,
	`version` text,
	PRIMARY KEY(`runner_id`, `report_id`, `position`),
	FOREIGN KEY (`runner_id`,`report_id`)
		REFERENCES `runner_engine_reports`(`runner_id`,`report_id`)
		ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runner_engine_evidence_position_check"
		CHECK(`position` BETWEEN 0 AND 1),
	CONSTRAINT "runner_engine_evidence_engine_check"
		CHECK(`engine` IN ('claude_code_cli', 'codex_cli')),
	CONSTRAINT "runner_engine_evidence_status_check"
		CHECK(`status` IN ('available', 'unavailable', 'unknown')),
	CONSTRAINT "runner_engine_evidence_readiness_check"
		CHECK(`readiness` IN ('ready', 'attention_required', 'unknown')),
	CONSTRAINT "runner_engine_evidence_reason_check"
		CHECK(`reason` IN (
			'none', 'engine_not_configured', 'engine_binary_invalid',
			'engine_auth_attention_required', 'engine_incompatible',
			'engine_probe_failed'
		)),
	CONSTRAINT "runner_engine_evidence_version_check"
		CHECK(`version` IS NULL OR (
			length(CAST(`version` AS BLOB)) BETWEEN 1 AND 64
			AND `version` NOT GLOB '*[^0-9A-Za-z ._+()-]*'
			AND substr(`version`, 1, 1) GLOB '[0-9A-Za-z]'
		))
);--> statement-breakpoint
CREATE UNIQUE INDEX `runner_engine_evidence_engine_uidx`
ON `runner_engine_evidence`
	(`runner_id`,`report_id`,`engine`);--> statement-breakpoint
ALTER TABLE `runner_admission_policies`
ADD `engine_freshness_seconds` integer NOT NULL DEFAULT 86400
	CHECK(`engine_freshness_seconds` BETWEEN 3600 AND 2592000);--> statement-breakpoint
ALTER TABLE `runner_admission_policy_versions`
ADD `engine_freshness_seconds` integer NOT NULL DEFAULT 86400
	CHECK(`engine_freshness_seconds` BETWEEN 3600 AND 2592000);--> statement-breakpoint
CREATE TRIGGER `runner_engine_reports_prevent_replace`
BEFORE INSERT ON `runner_engine_reports`
WHEN EXISTS (
	SELECT 1 FROM `runner_engine_reports`
	WHERE `runner_id` = NEW.`runner_id`
		AND `report_id` = NEW.`report_id`
)
BEGIN
	SELECT RAISE(ABORT, 'engine_report_already_exists');
END;--> statement-breakpoint
CREATE TRIGGER `runner_engine_reports_validate_before_insert`
BEFORE INSERT ON `runner_engine_reports`
BEGIN
	SELECT CASE WHEN
		length(NEW.`report_id`) <> 36
		OR substr(NEW.`report_id`, 1, 4) <> 'egr_'
		OR substr(NEW.`report_id`, 5) GLOB '*[^0-9a-f]*'
		OR length(NEW.`request_hash`) <> 64
		OR NEW.`request_hash` GLOB '*[^0-9a-f]*'
		OR length(NEW.`declaration_hash`) <> 64
		OR NEW.`declaration_hash` GLOB '*[^0-9a-f]*'
		OR NEW.`schema_version` <> 1
		OR length(NEW.`collected_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`collected_at`)
			IS NOT NEW.`collected_at`
		OR length(NEW.`received_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`received_at`)
			IS NOT NEW.`received_at`
		OR NEW.`received_at` < COALESCE((
			SELECT report.`received_at`
			FROM `runner_engine_reports` report
			WHERE report.`organization_id` = NEW.`organization_id`
				AND report.`runner_id` = NEW.`runner_id`
			ORDER BY report.`received_at` DESC, report.`report_id` DESC
			LIMIT 1
		), NEW.`received_at`)
		OR NEW.`truncated` NOT IN (0, 1)
		OR NEW.`response_status` <> 201
		OR NEW.`response_body` IS NULL
		OR NEW.`replay_count` <> 0
		OR NEW.`compacted_at` IS NOT NULL
		OR NOT EXISTS (
			SELECT 1
			FROM `runners` runner
			INNER JOIN `principals` principal
				ON principal.`id` = runner.`principal_id`
				AND principal.`organization_id` = runner.`organization_id`
			WHERE runner.`id` = NEW.`runner_id`
				AND runner.`organization_id` = NEW.`organization_id`
				AND runner.`status` = 'active'
				AND principal.`kind` = 'runner'
				AND principal.`status` = 'active'
		)
	THEN RAISE(ABORT, 'invalid_engine_report') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_engine_reports_validate_before_update`
BEFORE UPDATE ON `runner_engine_reports`
WHEN NOT (
	NEW.`organization_id` = OLD.`organization_id`
	AND NEW.`runner_id` = OLD.`runner_id`
	AND NEW.`report_id` = OLD.`report_id`
	AND NEW.`request_hash` = OLD.`request_hash`
	AND NEW.`declaration_hash` = OLD.`declaration_hash`
	AND NEW.`schema_version` = OLD.`schema_version`
	AND NEW.`collected_at` = OLD.`collected_at`
	AND NEW.`received_at` = OLD.`received_at`
	AND NEW.`truncated` = OLD.`truncated`
	AND NEW.`response_status` = OLD.`response_status`
	AND (
		(
			NEW.`replay_count` = OLD.`replay_count` + 1
			AND NEW.`response_body` IS OLD.`response_body`
			AND NEW.`compacted_at` IS OLD.`compacted_at`
		)
		OR
		(
			NEW.`replay_count` = OLD.`replay_count`
			AND OLD.`response_body` IS NOT NULL
			AND NEW.`response_body` IS NULL
			AND OLD.`compacted_at` IS NULL
			AND NEW.`compacted_at` IS NOT NULL
			AND length(NEW.`compacted_at`) = 24
			AND strftime(
				'%Y-%m-%dT%H:%M:%fZ',
				NEW.`compacted_at`
			) IS NEW.`compacted_at`
			AND NEW.`compacted_at` >= OLD.`received_at`
		)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'invalid_engine_report_transition');
END;--> statement-breakpoint
CREATE TRIGGER `runner_engine_reports_prevent_delete`
BEFORE DELETE ON `runner_engine_reports`
BEGIN
	SELECT RAISE(ABORT, 'engine_report_is_append_only');
END;--> statement-breakpoint
CREATE TRIGGER `runner_engine_evidence_prevent_replace`
BEFORE INSERT ON `runner_engine_evidence`
WHEN EXISTS (
	SELECT 1 FROM `runner_engine_evidence`
	WHERE `runner_id` = NEW.`runner_id`
		AND `report_id` = NEW.`report_id`
		AND (
			`position` = NEW.`position`
			OR `engine` = NEW.`engine`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'engine_evidence_already_exists');
END;--> statement-breakpoint
CREATE TRIGGER `runner_engine_evidence_validate_before_insert`
BEFORE INSERT ON `runner_engine_evidence`
BEGIN
	SELECT CASE WHEN
		NOT EXISTS (
			SELECT 1 FROM `runner_engine_reports` report
			WHERE report.`runner_id` = NEW.`runner_id`
				AND report.`report_id` = NEW.`report_id`
		)
		OR NOT (
			(NEW.`position` = 0 AND NEW.`engine` = 'claude_code_cli')
			OR (NEW.`position` = 1 AND NEW.`engine` = 'codex_cli')
		)
		OR (
			NEW.`position` > 0
			AND NOT EXISTS (
				SELECT 1 FROM `runner_engine_evidence` previous
				WHERE previous.`runner_id` = NEW.`runner_id`
					AND previous.`report_id` = NEW.`report_id`
					AND previous.`position` = NEW.`position` - 1
			)
		)
		OR NOT (
			(
				NEW.`readiness` = 'ready'
				AND NEW.`status` = 'available'
				AND NEW.`reason` = 'none'
				AND NEW.`version` IS NOT NULL
			)
			OR (
				NEW.`readiness` = 'unknown'
				AND NEW.`status` = 'unknown'
				AND NEW.`reason` = 'engine_probe_failed'
				AND NEW.`version` IS NULL
			)
			OR (
				NEW.`readiness` = 'attention_required'
				AND NEW.`status` = 'unavailable'
				AND NEW.`reason` IN (
					'engine_not_configured',
					'engine_binary_invalid'
				)
				AND NEW.`version` IS NULL
			)
			OR (
				NEW.`readiness` = 'attention_required'
				AND NEW.`status` = 'available'
				AND NEW.`reason` IN (
					'engine_auth_attention_required',
					'engine_incompatible'
				)
				AND NEW.`version` IS NOT NULL
			)
		)
	THEN RAISE(ABORT, 'invalid_engine_evidence') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_engine_evidence_prevent_update`
BEFORE UPDATE ON `runner_engine_evidence`
BEGIN
	SELECT RAISE(ABORT, 'engine_evidence_is_append_only');
END;--> statement-breakpoint
CREATE TRIGGER `runner_engine_evidence_prevent_delete`
BEFORE DELETE ON `runner_engine_evidence`
BEGIN
	SELECT RAISE(ABORT, 'engine_evidence_is_append_only');
END;--> statement-breakpoint
DROP TRIGGER `runner_admission_policies_validate_before_insert`;--> statement-breakpoint
CREATE TRIGGER `runner_admission_policies_validate_before_insert`
BEFORE INSERT ON `runner_admission_policies`
BEGIN
	SELECT CASE WHEN
		NEW.`version` <> 1
		OR NEW.`capability_freshness_seconds` NOT BETWEEN 3600 AND 2592000
		OR NEW.`engine_freshness_seconds` NOT BETWEEN 3600 AND 2592000
		OR length(NEW.`created_at`) <> 24
		OR COALESCE(
			strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`created_at`),
			''
		) <> NEW.`created_at`
		OR NEW.`updated_at` <> NEW.`created_at`
	THEN RAISE(ABORT, 'invalid_runner_admission_policy') END;

	SELECT CASE WHEN NOT EXISTS (
			SELECT 1
			FROM `principals` principal
			INNER JOIN `memberships` membership
				ON membership.`organization_id` = principal.`organization_id`
				AND membership.`principal_id` = principal.`id`
			WHERE principal.`id` = NEW.`updated_by`
				AND principal.`organization_id` = NEW.`organization_id`
				AND principal.`kind` = 'human'
				AND principal.`status` = 'active'
				AND membership.`status` = 'active'
				AND membership.`role` IN ('owner', 'admin')
		)
	THEN RAISE(ABORT, 'invalid_runner_admission_policy_actor') END;
END;--> statement-breakpoint
DROP TRIGGER `runner_admission_policies_validate_before_update`;--> statement-breakpoint
CREATE TRIGGER `runner_admission_policies_validate_before_update`
BEFORE UPDATE ON `runner_admission_policies`
BEGIN
	SELECT CASE WHEN
		NEW.`organization_id` <> OLD.`organization_id`
		OR NEW.`created_at` <> OLD.`created_at`
		OR NEW.`version` <> OLD.`version` + 1
		OR NEW.`capability_freshness_seconds` NOT BETWEEN 3600 AND 2592000
		OR NEW.`engine_freshness_seconds` NOT BETWEEN 3600 AND 2592000
		OR length(NEW.`updated_at`) <> 24
		OR COALESCE(
			strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`updated_at`),
			''
		) <> NEW.`updated_at`
		OR NEW.`updated_at` <= OLD.`updated_at`
	THEN RAISE(ABORT, 'invalid_runner_admission_policy_transition') END;

	SELECT CASE WHEN NOT EXISTS (
			SELECT 1
			FROM `principals` principal
			INNER JOIN `memberships` membership
				ON membership.`organization_id` = principal.`organization_id`
				AND membership.`principal_id` = principal.`id`
			WHERE principal.`id` = NEW.`updated_by`
				AND principal.`organization_id` = NEW.`organization_id`
				AND principal.`kind` = 'human'
				AND principal.`status` = 'active'
				AND membership.`status` = 'active'
				AND membership.`role` IN ('owner', 'admin')
		)
	THEN RAISE(ABORT, 'invalid_runner_admission_policy_actor') END;
END;--> statement-breakpoint
DROP TRIGGER `runner_admission_policy_versions_validate_before_insert`;--> statement-breakpoint
CREATE TRIGGER `runner_admission_policy_versions_validate_before_insert`
BEFORE INSERT ON `runner_admission_policy_versions`
BEGIN
	SELECT CASE WHEN
		NEW.`version` < 1
		OR NEW.`capability_freshness_seconds` NOT BETWEEN 3600 AND 2592000
		OR NEW.`engine_freshness_seconds` NOT BETWEEN 3600 AND 2592000
		OR length(NEW.`recorded_at`) <> 24
		OR COALESCE(
			strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`recorded_at`),
			''
		) <> NEW.`recorded_at`
		OR NOT EXISTS (
			SELECT 1 FROM `runner_admission_policies` policy
			WHERE policy.`organization_id` = NEW.`organization_id`
				AND policy.`version` = NEW.`version`
				AND policy.`capability_freshness_seconds` =
					NEW.`capability_freshness_seconds`
				AND policy.`engine_freshness_seconds` =
					NEW.`engine_freshness_seconds`
				AND policy.`updated_by` = NEW.`updated_by`
				AND policy.`updated_at` = NEW.`recorded_at`
		)
	THEN RAISE(ABORT, 'invalid_runner_admission_policy_version') END;
END;--> statement-breakpoint
DROP TRIGGER `ledger_entries_validate_policy_event`;--> statement-breakpoint
CREATE TRIGGER `ledger_entries_validate_policy_event`
BEFORE INSERT ON `ledger_entries`
WHEN NEW.`kind` = 'runner_policy.updated'
BEGIN
	SELECT CASE WHEN
		NEW.`intent_id` IS NOT NULL
		OR NEW.`run_id` IS NOT NULL
		OR length(NEW.`payload_hash`) <> 64
		OR NEW.`payload_hash` GLOB '*[^0-9a-f]*'
		OR NOT EXISTS (
			SELECT 1
			FROM `runner_admission_policies` policy
			INNER JOIN `runner_admission_policy_versions` version
				ON version.`organization_id` = policy.`organization_id`
				AND version.`version` = policy.`version`
				AND version.`capability_freshness_seconds` =
					policy.`capability_freshness_seconds`
				AND version.`engine_freshness_seconds` =
					policy.`engine_freshness_seconds`
				AND version.`updated_by` = policy.`updated_by`
				AND version.`recorded_at` = policy.`updated_at`
			WHERE policy.`organization_id` = NEW.`organization_id`
				AND policy.`updated_by` = NEW.`actor_id`
				AND policy.`updated_at` = NEW.`occurred_at`
				AND NEW.`payload_ref` =
					'nexus://runner-admission-policies/' ||
					policy.`organization_id` || '#v' || policy.`version`
		)
	THEN RAISE(ABORT, 'invalid_policy_ledger_event') END;

	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM `ledger_entries` existing
		WHERE existing.`organization_id` = NEW.`organization_id`
			AND existing.`payload_ref` = NEW.`payload_ref`
			AND existing.`kind` = NEW.`kind`
	)
	THEN RAISE(ABORT, 'duplicate_policy_ledger_event') END;
END;
