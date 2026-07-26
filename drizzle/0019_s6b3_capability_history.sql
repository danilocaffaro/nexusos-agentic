CREATE UNIQUE INDEX `runners_org_id_uidx`
ON `runners` (`organization_id`,`id`);--> statement-breakpoint
CREATE TABLE `runner_capability_reports` (
	`organization_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`report_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`declaration_hash` text NOT NULL,
	`schema_version` integer NOT NULL,
	`platform_os` text NOT NULL,
	`platform_arch` text NOT NULL,
	`node_version` text NOT NULL,
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
		ON UPDATE no action ON DELETE RESTRICT,
	CONSTRAINT "runner_capability_reports_schema_check"
		CHECK(`schema_version` = 1),
	CONSTRAINT "runner_capability_reports_truncated_check"
		CHECK(`truncated` IN (0, 1)),
	CONSTRAINT "runner_capability_reports_response_check"
		CHECK(`response_status` BETWEEN 100 AND 599
			AND (`response_body` IS NULL
				OR length(CAST(`response_body` AS BLOB)) <= 65536)),
	CONSTRAINT "runner_capability_reports_replay_check"
		CHECK(`replay_count` >= 0)
);--> statement-breakpoint
CREATE INDEX `runner_capability_reports_org_runner_history_idx`
ON `runner_capability_reports`
	(`organization_id`,`runner_id`,`received_at`,`report_id`);--> statement-breakpoint
CREATE INDEX `runner_capability_reports_compaction_idx`
ON `runner_capability_reports`
	(`organization_id`,`compacted_at`,`received_at`);--> statement-breakpoint
CREATE TABLE `runner_capability_evidence` (
	`runner_id` text NOT NULL,
	`report_id` text NOT NULL,
	`position` integer NOT NULL,
	`capability` text NOT NULL,
	`status` text NOT NULL,
	`detection` text NOT NULL,
	`reason_code` text NOT NULL,
	`version` text,
	PRIMARY KEY(`runner_id`, `report_id`, `position`),
	FOREIGN KEY (`runner_id`,`report_id`)
		REFERENCES `runner_capability_reports`(`runner_id`,`report_id`)
		ON UPDATE no action ON DELETE RESTRICT,
	CONSTRAINT "runner_capability_evidence_position_check"
		CHECK(`position` >= 0 AND `position` < 16),
	CONSTRAINT "runner_capability_evidence_capability_check"
		CHECK(`capability` IN (
			'node_permission_model', 'bubblewrap', 'landlock', 'seccomp',
			'user_namespace', 'docker', 'podman'
		)),
	CONSTRAINT "runner_capability_evidence_status_check"
		CHECK(`status` IN ('available', 'unavailable', 'unknown')),
	CONSTRAINT "runner_capability_evidence_detection_check"
		CHECK(`detection` IN (
			'node_flag', 'binary_version', 'proc_read', 'syscall', 'none'
		)),
	CONSTRAINT "runner_capability_evidence_reason_check"
		CHECK(`reason_code` IN (
			'none', 'not_found', 'not_supported', 'permission_denied',
			'probe_disabled', 'unknown'
		)),
	CONSTRAINT "runner_capability_evidence_version_check"
		CHECK(`version` IS NULL OR (
			length(CAST(`version` AS BLOB)) BETWEEN 1 AND 64
			AND `version` NOT GLOB '*[^0-9A-Za-z._+-]*'
			AND substr(`version`, 1, 1) GLOB '[0-9A-Za-z]'
		))
);--> statement-breakpoint
CREATE UNIQUE INDEX `runner_capability_evidence_capability_uidx`
ON `runner_capability_evidence`
	(`runner_id`,`report_id`,`capability`);--> statement-breakpoint
CREATE TABLE `runner_capability_nonces` (
	`organization_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`nonce` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text NOT NULL,
	`occurred_at` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`runner_id`, `nonce`),
	FOREIGN KEY (`organization_id`,`runner_id`)
		REFERENCES `runners`(`organization_id`,`id`)
		ON UPDATE no action ON DELETE RESTRICT,
	CONSTRAINT "runner_capability_nonces_response_check"
		CHECK(`response_status` BETWEEN 100 AND 599
			AND length(CAST(`response_body` AS BLOB)) <= 65536)
);--> statement-breakpoint
CREATE INDEX `runner_capability_nonces_expiry_idx`
ON `runner_capability_nonces`
	(`organization_id`,`expires_at`,`runner_id`,`nonce`);--> statement-breakpoint
CREATE TRIGGER `runner_capability_reports_prevent_replace`
BEFORE INSERT ON `runner_capability_reports`
WHEN EXISTS (
	SELECT 1 FROM `runner_capability_reports`
	WHERE `runner_id` = NEW.`runner_id`
		AND `report_id` = NEW.`report_id`
)
BEGIN
	SELECT RAISE(ABORT, 'capability_report_already_exists');
END;--> statement-breakpoint
CREATE TRIGGER `runner_capability_reports_validate_before_insert`
BEFORE INSERT ON `runner_capability_reports`
BEGIN
	SELECT CASE WHEN
		length(NEW.`report_id`) <> 36
		OR substr(NEW.`report_id`, 1, 4) <> 'cap_'
		OR substr(NEW.`report_id`, 5) GLOB '*[^0-9a-f]*'
		OR length(NEW.`request_hash`) <> 64
		OR NEW.`request_hash` GLOB '*[^0-9a-f]*'
		OR length(NEW.`declaration_hash`) <> 64
		OR NEW.`declaration_hash` GLOB '*[^0-9a-f]*'
		OR NEW.`schema_version` <> 1
		OR NEW.`platform_os` NOT IN (
			'aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32'
		)
		OR NEW.`platform_arch` NOT IN (
			'arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc',
			'ppc64', 'riscv64', 's390', 's390x', 'x64'
		)
		OR length(CAST(NEW.`node_version` AS BLOB)) NOT BETWEEN 1 AND 64
		OR substr(NEW.`node_version`, 1, 1) <> 'v'
		OR NEW.`node_version` GLOB '*[^0-9A-Za-z.-]*'
		OR length(NEW.`collected_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`collected_at`)
			IS NOT NEW.`collected_at`
		OR length(NEW.`received_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`received_at`)
			IS NOT NEW.`received_at`
		OR NEW.`received_at` < COALESCE((
			SELECT MAX(report.`received_at`)
			FROM `runner_capability_reports` report
			WHERE report.`runner_id` = NEW.`runner_id`
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
	THEN RAISE(ABORT, 'invalid_capability_report') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_capability_reports_validate_before_update`
BEFORE UPDATE ON `runner_capability_reports`
WHEN NOT (
	NEW.`organization_id` = OLD.`organization_id`
	AND NEW.`runner_id` = OLD.`runner_id`
	AND NEW.`report_id` = OLD.`report_id`
	AND NEW.`request_hash` = OLD.`request_hash`
	AND NEW.`declaration_hash` = OLD.`declaration_hash`
	AND NEW.`schema_version` = OLD.`schema_version`
	AND NEW.`platform_os` = OLD.`platform_os`
	AND NEW.`platform_arch` = OLD.`platform_arch`
	AND NEW.`node_version` = OLD.`node_version`
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
	SELECT RAISE(ABORT, 'invalid_capability_report_transition');
END;--> statement-breakpoint
CREATE TRIGGER `runner_capability_reports_prevent_delete`
BEFORE DELETE ON `runner_capability_reports`
BEGIN
	SELECT RAISE(ABORT, 'capability_report_is_append_only');
END;--> statement-breakpoint
CREATE TRIGGER `runner_capability_evidence_prevent_replace`
BEFORE INSERT ON `runner_capability_evidence`
WHEN EXISTS (
	SELECT 1 FROM `runner_capability_evidence`
	WHERE `runner_id` = NEW.`runner_id`
		AND `report_id` = NEW.`report_id`
		AND (
			`position` = NEW.`position`
			OR `capability` = NEW.`capability`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'capability_evidence_already_exists');
END;--> statement-breakpoint
CREATE TRIGGER `runner_capability_evidence_validate_before_insert`
BEFORE INSERT ON `runner_capability_evidence`
BEGIN
	SELECT CASE WHEN
		NOT EXISTS (
			SELECT 1 FROM `runner_capability_reports` report
			WHERE report.`runner_id` = NEW.`runner_id`
				AND report.`report_id` = NEW.`report_id`
		)
		OR (
			NEW.`position` > 0
			AND NOT EXISTS (
				SELECT 1 FROM `runner_capability_evidence` previous
				WHERE previous.`runner_id` = NEW.`runner_id`
					AND previous.`report_id` = NEW.`report_id`
					AND previous.`position` = NEW.`position` - 1
			)
		)
	THEN RAISE(ABORT, 'invalid_capability_evidence') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_capability_evidence_prevent_update`
BEFORE UPDATE ON `runner_capability_evidence`
BEGIN
	SELECT RAISE(ABORT, 'capability_evidence_is_append_only');
END;--> statement-breakpoint
CREATE TRIGGER `runner_capability_evidence_prevent_delete`
BEFORE DELETE ON `runner_capability_evidence`
BEGIN
	SELECT RAISE(ABORT, 'capability_evidence_is_append_only');
END;--> statement-breakpoint
CREATE TRIGGER `runner_capability_nonces_prevent_replace`
BEFORE INSERT ON `runner_capability_nonces`
WHEN EXISTS (
	SELECT 1 FROM `runner_capability_nonces`
	WHERE `runner_id` = NEW.`runner_id`
		AND `nonce` = NEW.`nonce`
)
BEGIN
	SELECT RAISE(ABORT, 'capability_nonce_already_exists');
END;--> statement-breakpoint
CREATE TRIGGER `runner_capability_nonces_validate_before_insert`
BEFORE INSERT ON `runner_capability_nonces`
BEGIN
	SELECT CASE WHEN
		length(NEW.`nonce`) <> 22
		OR NEW.`nonce` GLOB '*[^0-9A-Za-z_-]*'
		OR length(NEW.`request_hash`) <> 64
		OR NEW.`request_hash` GLOB '*[^0-9a-f]*'
		OR NEW.`response_status` <> 201
		OR length(NEW.`occurred_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`occurred_at`)
			IS NOT NEW.`occurred_at`
		OR length(NEW.`expires_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`expires_at`)
			IS NOT NEW.`expires_at`
		OR NEW.`expires_at` <= NEW.`occurred_at`
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
	THEN RAISE(ABORT, 'invalid_capability_nonce') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_capability_nonces_prevent_update`
BEFORE UPDATE ON `runner_capability_nonces`
BEGIN
	SELECT RAISE(ABORT, 'capability_nonce_is_immutable');
END;
