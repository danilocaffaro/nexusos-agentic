ALTER TABLE `run_leases` ADD `admission_basis` text;--> statement-breakpoint
ALTER TABLE `run_leases` ADD `admission_policy_source` text;--> statement-breakpoint
ALTER TABLE `run_leases` ADD `admission_policy_version` integer;--> statement-breakpoint
ALTER TABLE `run_leases` ADD `admission_freshness_seconds` integer;--> statement-breakpoint
ALTER TABLE `run_leases` ADD `admission_required_capability` text;--> statement-breakpoint
ALTER TABLE `run_leases` ADD `admission_report_id` text;--> statement-breakpoint
ALTER TABLE `run_leases` ADD `admission_report_received_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `assigned_runner_id` text REFERENCES runners(id);--> statement-breakpoint
ALTER TABLE `runs` ADD `required_capability` text;--> statement-breakpoint

DROP TRIGGER `runs_validate_before_insert`;--> statement-breakpoint
CREATE TRIGGER `runs_validate_before_insert`
BEFORE INSERT ON `runs`
BEGIN
	SELECT CASE WHEN
		NEW.`id` NOT GLOB 'run_[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
		OR length(NEW.`id`) <> 36
		OR substr(NEW.`id`, 5) GLOB '*[^0-9a-f]*'
		OR NEW.`kind` <> 'diagnostic'
		OR NEW.`status` <> 'queued'
		OR NEW.`version` <> 1
		OR NEW.`lease_generation` <> 0
		OR NEW.`current_lease_id` IS NOT NULL
		OR NEW.`claim_count` <> 0
		OR NEW.`max_claims` <> 5
		OR NEW.`deadline_at` <= NEW.`created_at`
		OR NEW.`cancel_requested_at` IS NOT NULL
		OR NEW.`cancel_requested_by` IS NOT NULL
		OR NEW.`outcome_status` IS NOT NULL
		OR NEW.`outcome_summary` IS NOT NULL
		OR NEW.`completed_operation_id` IS NOT NULL
		OR NEW.`recorded_at` IS NOT NULL
		OR (
			NEW.`required_capability` IS NOT NULL
			AND (
				NEW.`assigned_runner_id` IS NULL
				OR NEW.`required_capability` NOT IN (
					'node_permission_model', 'bubblewrap', 'landlock', 'seccomp',
					'user_namespace', 'docker', 'podman'
				)
			)
		)
		OR (
			NEW.`assigned_runner_id` IS NOT NULL
			AND NOT EXISTS (
				SELECT 1
				FROM `runners` runner
				INNER JOIN `principals` principal
					ON principal.`id` = runner.`principal_id`
					AND principal.`organization_id` = runner.`organization_id`
				WHERE runner.`id` = NEW.`assigned_runner_id`
					AND runner.`organization_id` = NEW.`organization_id`
					AND runner.`status` = 'active'
					AND principal.`kind` = 'runner'
					AND principal.`status` = 'active'
			)
		)
		OR NOT EXISTS (
			SELECT 1 FROM `principals` principal
			WHERE principal.`id` = NEW.`requested_by`
				AND principal.`organization_id` = NEW.`organization_id`
				AND principal.`kind` = 'human'
				AND principal.`status` = 'active'
		)
	THEN RAISE(ABORT, 'invalid_run') END;
END;--> statement-breakpoint

DROP TRIGGER `runs_validate_before_update`;--> statement-breakpoint
CREATE TRIGGER `runs_validate_before_update`
BEFORE UPDATE ON `runs`
BEGIN
	SELECT CASE WHEN
		NEW.`id` <> OLD.`id`
		OR NEW.`organization_id` <> OLD.`organization_id`
		OR NEW.`requested_by` <> OLD.`requested_by`
		OR NEW.`kind` <> OLD.`kind`
		OR NEW.`created_at` <> OLD.`created_at`
		OR NEW.`deadline_at` <> OLD.`deadline_at`
		OR NEW.`max_claims` <> OLD.`max_claims`
		OR NEW.`assigned_runner_id` IS NOT OLD.`assigned_runner_id`
		OR NEW.`required_capability` IS NOT OLD.`required_capability`
		OR NEW.`lease_generation` < OLD.`lease_generation`
		OR NEW.`lease_generation` > OLD.`lease_generation` + 1
		OR NEW.`claim_count` < OLD.`claim_count`
		OR NEW.`claim_count` > OLD.`claim_count` + 1
		OR NEW.`claim_count` > NEW.`max_claims`
		OR NEW.`version` NOT IN (OLD.`version`, OLD.`version` + 1)
		OR (
			OLD.`status` = 'queued'
			AND NEW.`status` NOT IN ('queued', 'leased', 'canceled')
		)
		OR (
			OLD.`status` = 'leased'
			AND NEW.`status` NOT IN ('leased', 'queued', 'completed')
		)
		OR (
			OLD.`status` IN ('completed', 'canceled')
			AND (
				NEW.`status` <> OLD.`status`
				OR NEW.`version` <> OLD.`version`
				OR NEW.`updated_at` <> OLD.`updated_at`
			)
		)
		OR (
			(NEW.`cancel_requested_at` IS NULL) <>
			(NEW.`cancel_requested_by` IS NULL)
		)
		OR (
			NEW.`cancel_requested_by` IS NOT NULL
			AND NOT EXISTS (
				SELECT 1 FROM `principals` principal
				WHERE principal.`id` = NEW.`cancel_requested_by`
					AND principal.`organization_id` = NEW.`organization_id`
					AND principal.`kind` = 'human'
			)
		)
		OR (
			NEW.`status` = 'queued'
			AND (
				NEW.`current_lease_id` IS NOT NULL
				OR NEW.`outcome_status` IS NOT NULL
				OR NEW.`outcome_summary` IS NOT NULL
				OR NEW.`completed_operation_id` IS NOT NULL
				OR NEW.`recorded_at` IS NOT NULL
			)
		)
		OR (
			NEW.`status` = 'leased'
			AND (
				NEW.`current_lease_id` IS NULL
				OR NEW.`lease_generation` < 1
				OR NEW.`claim_count` < 1
				OR NEW.`outcome_status` IS NOT NULL
				OR NEW.`outcome_summary` IS NOT NULL
				OR NEW.`completed_operation_id` IS NOT NULL
				OR NEW.`recorded_at` IS NOT NULL
				OR NOT EXISTS (
					SELECT 1 FROM `run_leases` lease
					WHERE lease.`id` = NEW.`current_lease_id`
						AND lease.`run_id` = NEW.`id`
						AND lease.`organization_id` = NEW.`organization_id`
						AND lease.`fence` = NEW.`lease_generation`
						AND lease.`status` = 'active'
				)
			)
		)
		OR (
			NEW.`status` = 'completed'
			AND (
				NEW.`current_lease_id` IS NULL
				OR NEW.`outcome_status` NOT IN ('succeeded', 'failed', 'canceled')
				OR NEW.`outcome_summary` IS NULL
				OR length(CAST(NEW.`outcome_summary` AS BLOB)) > 1024
				OR NEW.`completed_operation_id` IS NULL
				OR NEW.`recorded_at` IS NULL
				OR NOT EXISTS (
					SELECT 1
					FROM `runner_operations` operation
					INNER JOIN `run_leases` lease
						ON lease.`run_id` = operation.`run_id`
						AND lease.`fence` = operation.`fence`
					WHERE operation.`run_id` = NEW.`id`
						AND operation.`operation_id` = NEW.`completed_operation_id`
						AND operation.`fence` = NEW.`lease_generation`
						AND lease.`id` = NEW.`current_lease_id`
						AND lease.`status` = 'active'
				)
			)
		)
		OR (
			NEW.`status` = 'canceled'
			AND (
				OLD.`status` <> 'queued'
				OR NEW.`current_lease_id` IS NOT NULL
				OR NEW.`cancel_requested_at` IS NULL
				OR NEW.`outcome_status` IS NOT NULL
				OR NEW.`outcome_summary` IS NOT NULL
				OR NEW.`completed_operation_id` IS NOT NULL
				OR NEW.`recorded_at` IS NULL
			)
		)
	THEN RAISE(ABORT, 'invalid_run_transition') END;
END;--> statement-breakpoint

DROP TRIGGER `run_leases_validate_before_insert`;--> statement-breakpoint
CREATE TRIGGER `run_leases_validate_before_insert`
BEFORE INSERT ON `run_leases`
BEGIN
	SELECT CASE WHEN
		NEW.`id` NOT GLOB 'lse_[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
		OR length(NEW.`id`) <> 36
		OR substr(NEW.`id`, 5) GLOB '*[^0-9a-f]*'
		OR NEW.`status` <> 'active'
		OR NEW.`fence` < 1
		OR NEW.`issued_at` >= NEW.`expires_at`
		OR NEW.`renewed_at` IS NOT NULL
		OR NEW.`renew_count` <> 0
		OR NEW.`ended_at` IS NOT NULL
		OR NEW.`ended_reason` IS NOT NULL
		OR NOT EXISTS (
			SELECT 1 FROM `runs` run
			WHERE run.`id` = NEW.`run_id`
				AND run.`organization_id` = NEW.`organization_id`
				AND run.`status` IN ('queued', 'leased')
				AND run.`lease_generation` + 1 = NEW.`fence`
				AND run.`claim_count` < run.`max_claims`
				AND run.`deadline_at` > NEW.`issued_at`
				AND (
					run.`status` = 'queued'
					OR NOT EXISTS (
						SELECT 1 FROM `run_leases` current
						WHERE current.`id` = run.`current_lease_id`
							AND current.`status` = 'active'
					)
				)
		)
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
	THEN RAISE(ABORT, 'invalid_run_lease') END;

	SELECT CASE WHEN EXISTS (
		SELECT 1
		FROM `runs` run
		WHERE run.`id` = NEW.`run_id`
			AND run.`organization_id` = NEW.`organization_id`
			AND run.`assigned_runner_id` IS NOT NULL
			AND run.`assigned_runner_id` <> NEW.`runner_id`
	) THEN RAISE(ABORT, 'invalid_run_lease_assignment') END;

	SELECT CASE WHEN
		length(NEW.`issued_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`issued_at`)
			IS NOT NEW.`issued_at`
	THEN RAISE(ABORT, 'invalid_run_lease_admission') END;

	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM `runs` run
		WHERE run.`id` = NEW.`run_id`
			AND run.`organization_id` = NEW.`organization_id`
			AND (
				(
					run.`assigned_runner_id` IS NULL
					AND run.`required_capability` IS NULL
					AND NEW.`admission_basis` IS NULL
					AND NEW.`admission_policy_source` IS NULL
					AND NEW.`admission_policy_version` IS NULL
					AND NEW.`admission_freshness_seconds` IS NULL
					AND NEW.`admission_required_capability` IS NULL
					AND NEW.`admission_report_id` IS NULL
					AND NEW.`admission_report_received_at` IS NULL
				)
				OR (
					run.`assigned_runner_id` = NEW.`runner_id`
					AND run.`required_capability` IS NULL
					AND NEW.`admission_basis` = 'assignment_only'
					AND NEW.`admission_policy_source` IS NULL
					AND NEW.`admission_policy_version` IS NULL
					AND NEW.`admission_freshness_seconds` IS NULL
					AND NEW.`admission_required_capability` IS NULL
					AND NEW.`admission_report_id` IS NULL
					AND NEW.`admission_report_received_at` IS NULL
				)
				OR (
					run.`assigned_runner_id` = NEW.`runner_id`
					AND run.`required_capability` IS NOT NULL
					AND NEW.`admission_basis` = 'capability_declaration'
					AND NEW.`admission_policy_source` IN ('default', 'configured')
					AND typeof(NEW.`admission_policy_version`) = 'integer'
					AND typeof(NEW.`admission_freshness_seconds`) = 'integer'
					AND NEW.`admission_required_capability`
						= run.`required_capability`
					AND NEW.`admission_report_id` IS NOT NULL
					AND NEW.`admission_report_received_at` IS NOT NULL
				)
			)
	) THEN RAISE(ABORT, 'invalid_run_lease_admission') END;

	SELECT CASE WHEN
		NEW.`admission_basis` = 'capability_declaration'
		AND NOT EXISTS (
			SELECT 1
			FROM `runs` run
			INNER JOIN `runner_capability_reports` report
				ON report.`organization_id` = run.`organization_id`
				AND report.`runner_id` = run.`assigned_runner_id`
				AND report.`report_id` = NEW.`admission_report_id`
				AND report.`received_at`
					= NEW.`admission_report_received_at`
			INNER JOIN `runner_capability_evidence` evidence
				ON evidence.`runner_id` = report.`runner_id`
				AND evidence.`report_id` = report.`report_id`
				AND evidence.`capability` = run.`required_capability`
				AND evidence.`status` = 'available'
			WHERE run.`id` = NEW.`run_id`
				AND run.`organization_id` = NEW.`organization_id`
				AND run.`assigned_runner_id` = NEW.`runner_id`
				AND run.`required_capability`
					= NEW.`admission_required_capability`
				AND report.`received_at` <= NEW.`issued_at`
				AND NOT EXISTS (
					SELECT 1
					FROM `runner_capability_reports` newer
					WHERE newer.`organization_id` = NEW.`organization_id`
						AND newer.`runner_id` = NEW.`runner_id`
						AND (
							newer.`received_at` > report.`received_at`
							OR (
								newer.`received_at` = report.`received_at`
								AND newer.`report_id` > report.`report_id`
							)
						)
				)
				AND (
					(
						CAST(strftime('%s', NEW.`issued_at`) AS INTEGER) * 1000
						+ CAST(substr(NEW.`issued_at`, 21, 3) AS INTEGER)
					) - (
						CAST(strftime('%s', report.`received_at`) AS INTEGER) * 1000
						+ CAST(substr(report.`received_at`, 21, 3) AS INTEGER)
					)
				) BETWEEN 0 AND NEW.`admission_freshness_seconds` * 1000
				AND (
					(
						NEW.`admission_policy_source` = 'default'
						AND NEW.`admission_policy_version` = 0
						AND NEW.`admission_freshness_seconds` = 86400
						AND NOT EXISTS (
							SELECT 1
							FROM `runner_admission_policies` policy
							WHERE policy.`organization_id` = NEW.`organization_id`
						)
					)
					OR (
						NEW.`admission_policy_source` = 'configured'
						AND EXISTS (
							SELECT 1
							FROM `runner_admission_policies` policy
							INNER JOIN `runner_admission_policy_versions` version
								ON version.`organization_id`
									= policy.`organization_id`
								AND version.`version` = policy.`version`
							INNER JOIN `runner_admission_policy_capabilities` allowed
								ON allowed.`organization_id`
									= version.`organization_id`
								AND allowed.`version` = version.`version`
								AND allowed.`capability`
									= NEW.`admission_required_capability`
							WHERE policy.`organization_id`
									= NEW.`organization_id`
								AND policy.`version`
									= NEW.`admission_policy_version`
								AND policy.`capability_freshness_seconds`
									= NEW.`admission_freshness_seconds`
								AND version.`capability_freshness_seconds`
									= NEW.`admission_freshness_seconds`
						)
					)
				)
		)
	THEN RAISE(ABORT, 'invalid_run_lease_admission') END;
END;--> statement-breakpoint

DROP TRIGGER `run_leases_validate_before_update`;--> statement-breakpoint
CREATE TRIGGER `run_leases_validate_before_update`
BEFORE UPDATE ON `run_leases`
BEGIN
	SELECT CASE WHEN
		NEW.`id` <> OLD.`id`
		OR NEW.`organization_id` <> OLD.`organization_id`
		OR NEW.`run_id` <> OLD.`run_id`
		OR NEW.`runner_id` <> OLD.`runner_id`
		OR NEW.`fence` <> OLD.`fence`
		OR NEW.`issued_at` <> OLD.`issued_at`
		OR NEW.`created_at` <> OLD.`created_at`
		OR NEW.`admission_basis` IS NOT OLD.`admission_basis`
		OR NEW.`admission_policy_source` IS NOT OLD.`admission_policy_source`
		OR NEW.`admission_policy_version` IS NOT OLD.`admission_policy_version`
		OR NEW.`admission_freshness_seconds`
			IS NOT OLD.`admission_freshness_seconds`
		OR NEW.`admission_required_capability`
			IS NOT OLD.`admission_required_capability`
		OR NEW.`admission_report_id` IS NOT OLD.`admission_report_id`
		OR NEW.`admission_report_received_at`
			IS NOT OLD.`admission_report_received_at`
		OR OLD.`status` <> 'active'
		OR NEW.`status` NOT IN ('active', 'superseded', 'released', 'revoked')
		OR NEW.`renew_count` NOT IN (OLD.`renew_count`, OLD.`renew_count` + 1)
		OR NEW.`expires_at` < OLD.`expires_at`
		OR (
			NEW.`status` = 'active'
			AND (
				NEW.`ended_at` IS NOT NULL
				OR NEW.`ended_reason` IS NOT NULL
				OR (
					NEW.`renew_count` = OLD.`renew_count` + 1
					AND NEW.`renewed_at` IS NULL
				)
			)
		)
		OR (
			NEW.`status` <> 'active'
			AND (
				NEW.`renew_count` <> OLD.`renew_count`
				OR NEW.`expires_at` <> OLD.`expires_at`
				OR NEW.`renewed_at` IS NOT OLD.`renewed_at`
				OR NEW.`ended_at` IS NULL
				OR NEW.`ended_reason` IS NULL
			)
		)
	THEN RAISE(ABORT, 'invalid_run_lease_transition') END;
END;--> statement-breakpoint

DROP TRIGGER `run_events_validate_before_insert`;--> statement-breakpoint
CREATE TRIGGER `run_events_validate_before_insert`
BEFORE INSERT ON `run_events`
BEGIN
	SELECT CASE WHEN
		NEW.`sequence` <> COALESCE((
			SELECT MAX(event.`sequence`) + 1
			FROM `run_events` event
			WHERE event.`run_id` = NEW.`run_id`
		), 1)
		OR NEW.`kind` NOT IN (
			'run.created', 'lease.claimed', 'lease.renewed',
			'lease.superseded', 'lease.released', 'lease.revoked',
			'run.cancel_requested', 'run.completed', 'run.canceled'
		)
		OR length(CAST(NEW.`metadata_json` AS BLOB)) > 4096
		OR NOT json_valid(NEW.`metadata_json`)
		OR NOT EXISTS (
			SELECT 1 FROM `runs` run
			WHERE run.`id` = NEW.`run_id`
				AND run.`organization_id` = NEW.`organization_id`
		)
		OR NOT EXISTS (
			SELECT 1 FROM `principals` principal
			WHERE principal.`id` = NEW.`actor_id`
				AND principal.`organization_id` = NEW.`organization_id`
		)
		OR (
			NEW.`kind` LIKE 'lease.%'
			AND (
				NEW.`fence` IS NULL
				OR NOT EXISTS (
					SELECT 1 FROM `run_leases` lease
					WHERE lease.`run_id` = NEW.`run_id`
						AND lease.`fence` = NEW.`fence`
				)
			)
		)
		OR (
			NEW.`kind` = 'lease.claimed'
			AND NOT EXISTS (
				SELECT 1
				FROM `run_leases` lease
				INNER JOIN `runs` run
					ON run.`id` = lease.`run_id`
					AND run.`organization_id` = lease.`organization_id`
				WHERE lease.`run_id` = NEW.`run_id`
					AND lease.`organization_id` = NEW.`organization_id`
					AND lease.`fence` = NEW.`fence`
					AND json_type(NEW.`metadata_json`, '$') = 'object'
					AND json_type(NEW.`metadata_json`, '$.leaseId') = 'text'
					AND json_extract(NEW.`metadata_json`, '$.leaseId')
						= lease.`id`
					AND json_type(NEW.`metadata_json`, '$.operationId') = 'text'
					AND length(json_extract(
						NEW.`metadata_json`, '$.operationId'
					)) = 35
					AND substr(json_extract(
						NEW.`metadata_json`, '$.operationId'
					), 1, 3) = 'op_'
					AND substr(json_extract(
						NEW.`metadata_json`, '$.operationId'
					), 4) NOT GLOB '*[^0-9a-f]*'
					AND json_extract(
						NEW.`metadata_json`, '$.assignedRunnerId'
					) IS run.`assigned_runner_id`
					AND json_extract(
						NEW.`metadata_json`, '$.admissionBasis'
					) IS lease.`admission_basis`
					AND json_extract(
						NEW.`metadata_json`, '$.admissionPolicySource'
					) IS lease.`admission_policy_source`
					AND json_extract(
						NEW.`metadata_json`, '$.admissionPolicyVersion'
					) IS lease.`admission_policy_version`
					AND json_extract(
						NEW.`metadata_json`, '$.admissionFreshnessSeconds'
					) IS lease.`admission_freshness_seconds`
					AND json_extract(
						NEW.`metadata_json`, '$.admissionRequiredCapability'
					) IS lease.`admission_required_capability`
					AND json_extract(
						NEW.`metadata_json`, '$.admissionReportId'
					) IS lease.`admission_report_id`
					AND json_extract(
						NEW.`metadata_json`, '$.admissionReportReceivedAt'
					) IS lease.`admission_report_received_at`
					AND (
						(
							lease.`admission_basis` IS NULL
							AND (
								SELECT COUNT(*)
								FROM json_each(NEW.`metadata_json`)
							) = 2
						)
						OR (
							lease.`admission_basis` = 'assignment_only'
							AND json_type(
								NEW.`metadata_json`, '$.assignedRunnerId'
							) = 'text'
							AND json_type(
								NEW.`metadata_json`, '$.admissionBasis'
							) = 'text'
							AND (
								SELECT COUNT(*)
								FROM json_each(NEW.`metadata_json`)
							) = 4
						)
						OR (
							lease.`admission_basis` = 'capability_declaration'
							AND json_type(
								NEW.`metadata_json`, '$.assignedRunnerId'
							) = 'text'
							AND json_type(
								NEW.`metadata_json`, '$.admissionBasis'
							) = 'text'
							AND json_type(
								NEW.`metadata_json`, '$.admissionPolicySource'
							) = 'text'
							AND json_type(
								NEW.`metadata_json`, '$.admissionPolicyVersion'
							) = 'integer'
							AND json_type(
								NEW.`metadata_json`, '$.admissionFreshnessSeconds'
							) = 'integer'
							AND json_type(
								NEW.`metadata_json`, '$.admissionRequiredCapability'
							) = 'text'
							AND json_type(
								NEW.`metadata_json`, '$.admissionReportId'
							) = 'text'
							AND json_type(
								NEW.`metadata_json`, '$.admissionReportReceivedAt'
							) = 'text'
							AND (
								SELECT COUNT(*)
								FROM json_each(NEW.`metadata_json`)
							) = 10
						)
					)
					AND NOT EXISTS (
						SELECT 1
						FROM json_each(NEW.`metadata_json`) field
						WHERE field.`key` NOT IN (
							'leaseId', 'operationId', 'assignedRunnerId',
							'admissionBasis', 'admissionPolicySource',
							'admissionPolicyVersion', 'admissionFreshnessSeconds',
							'admissionRequiredCapability', 'admissionReportId',
							'admissionReportReceivedAt'
						)
					)
			)
		)
		OR (
			NEW.`kind` NOT LIKE 'lease.%'
			AND NEW.`kind` <> 'run.completed'
			AND NEW.`fence` IS NOT NULL
		)
	THEN RAISE(ABORT, 'invalid_run_event') END;
END;
