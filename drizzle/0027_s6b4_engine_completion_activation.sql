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
			'run.cancel_requested', 'run.completed', 'run.canceled',
			'run.expired'
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
			NEW.`kind` = 'run.created'
			AND NOT EXISTS (
				SELECT 1
				FROM `runs` run
				WHERE run.`id` = NEW.`run_id`
					AND run.`organization_id` = NEW.`organization_id`
					AND (
						(
							run.`kind` = 'diagnostic'
							AND run.`engine` IS NULL
						)
						OR (
							run.`kind` = 'engine_prompt'
							AND run.`requested_by` = NEW.`actor_id`
							AND run.`created_at` = NEW.`occurred_at`
							AND NEW.`sequence` = 1
							AND json_type(
								NEW.`metadata_json`, '$'
							) = 'object'
							AND json_type(
								NEW.`metadata_json`, '$.engine'
							) = 'text'
							AND json_extract(
								NEW.`metadata_json`, '$.engine'
							) = run.`engine`
							AND json_type(
								NEW.`metadata_json`, '$.promptBytes'
							) = 'integer'
							AND json_type(
								NEW.`metadata_json`, '$.promptSha256'
							) = 'text'
							AND EXISTS (
								SELECT 1
								FROM `run_prompts` prompt
								WHERE prompt.`run_id` = run.`id`
									AND prompt.`organization_id`
										= run.`organization_id`
									AND prompt.`prompt_bytes`
										= json_extract(
											NEW.`metadata_json`,
											'$.promptBytes'
										)
									AND prompt.`prompt_sha256`
										= json_extract(
											NEW.`metadata_json`,
											'$.promptSha256'
										)
							)
							AND (
								SELECT COUNT(*)
								FROM json_each(NEW.`metadata_json`)
							) = 3
							AND NOT EXISTS (
								SELECT 1
								FROM json_each(NEW.`metadata_json`) field
								WHERE field.`key` NOT IN (
									'engine', 'promptBytes', 'promptSha256'
								)
							)
						)
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
					AND EXISTS (
						SELECT 1
						FROM `runners` claim_runner
						WHERE claim_runner.`id` = lease.`runner_id`
							AND claim_runner.`organization_id`
								= lease.`organization_id`
							AND claim_runner.`principal_id` = NEW.`actor_id`
					)
					AND json_type(NEW.`metadata_json`, '$') = 'object'
					AND json_type(NEW.`metadata_json`, '$.leaseId') = 'text'
					AND json_extract(NEW.`metadata_json`, '$.leaseId')
						= lease.`id`
					AND json_type(
						NEW.`metadata_json`, '$.operationId'
					) = 'text'
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
					AND json_extract(
						NEW.`metadata_json`, '$.admissionEngine'
					) IS lease.`admission_engine`
					AND json_extract(
						NEW.`metadata_json`, '$.admissionEngineReportId'
					) IS lease.`admission_engine_report_id`
					AND json_extract(
						NEW.`metadata_json`,
						'$.admissionEngineReportReceivedAt'
					) IS lease.`admission_engine_report_received_at`
					AND json_extract(
						NEW.`metadata_json`, '$.admissionEngineVersion'
					) IS lease.`admission_engine_version`
					AND (
						(
							run.`kind` = 'diagnostic'
							AND run.`engine` IS NULL
							AND lease.`admission_basis` IS NULL
							AND (
								SELECT COUNT(*)
								FROM json_each(NEW.`metadata_json`)
							) = 2
						)
						OR (
							run.`kind` = 'diagnostic'
							AND run.`engine` IS NULL
							AND lease.`admission_basis` = 'assignment_only'
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
							run.`kind` = 'diagnostic'
							AND run.`engine` IS NULL
							AND lease.`admission_basis`
								= 'capability_declaration'
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
								NEW.`metadata_json`,
								'$.admissionFreshnessSeconds'
							) = 'integer'
							AND json_type(
								NEW.`metadata_json`,
								'$.admissionRequiredCapability'
							) = 'text'
							AND json_type(
								NEW.`metadata_json`, '$.admissionReportId'
							) = 'text'
							AND json_type(
								NEW.`metadata_json`,
								'$.admissionReportReceivedAt'
							) = 'text'
							AND (
								SELECT COUNT(*)
								FROM json_each(NEW.`metadata_json`)
							) = 10
						)
						OR (
							run.`kind` = 'engine_prompt'
							AND run.`engine` = lease.`admission_engine`
							AND lease.`admission_basis` = 'engine_inventory'
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
								NEW.`metadata_json`,
								'$.admissionFreshnessSeconds'
							) = 'integer'
							AND json_type(
								NEW.`metadata_json`, '$.admissionEngine'
							) = 'text'
							AND json_type(
								NEW.`metadata_json`,
								'$.admissionEngineReportId'
							) = 'text'
							AND json_type(
								NEW.`metadata_json`,
								'$.admissionEngineReportReceivedAt'
							) = 'text'
							AND json_type(
								NEW.`metadata_json`,
								'$.admissionEngineVersion'
							) = 'text'
							AND (
								SELECT COUNT(*)
								FROM json_each(NEW.`metadata_json`)
							) = 11
						)
					)
					AND NOT EXISTS (
						SELECT 1
						FROM json_each(NEW.`metadata_json`) field
						WHERE field.`key` NOT IN (
							'leaseId', 'operationId', 'assignedRunnerId',
							'admissionBasis', 'admissionPolicySource',
							'admissionPolicyVersion',
							'admissionFreshnessSeconds',
							'admissionRequiredCapability',
							'admissionReportId',
							'admissionReportReceivedAt', 'admissionEngine',
							'admissionEngineReportId',
							'admissionEngineReportReceivedAt',
							'admissionEngineVersion'
						)
					)
			)
		)
		OR (
			NEW.kind = 'run.completed'
			AND NOT (
				EXISTS (
					SELECT 1 FROM runs run
					WHERE run.id = NEW.run_id
						AND run.organization_id = NEW.organization_id
						AND run.kind = 'diagnostic'
						AND run.engine IS NULL
				)
				OR EXISTS (
					SELECT 1
					FROM runs run
					INNER JOIN run_engine_receipts receipt
						ON receipt.run_id = run.id
						AND receipt.organization_id = run.organization_id
					INNER JOIN run_leases lease
						ON lease.id = receipt.lease_id
						AND lease.run_id = run.id
						AND lease.organization_id = run.organization_id
						AND lease.fence = receipt.fence
					INNER JOIN runners runner
						ON runner.id = lease.runner_id
						AND runner.organization_id = run.organization_id
					WHERE run.id = NEW.run_id
						AND run.organization_id = NEW.organization_id
						AND run.kind = 'engine_prompt'
						AND run.engine IS NOT NULL
						AND run.status = 'completed'
						AND run.current_lease_id = receipt.lease_id
						AND run.lease_generation = receipt.fence
						AND run.completed_operation_id = receipt.operation_id
						AND run.outcome_status = receipt.status
						AND run.recorded_at = receipt.recorded_at
						AND run.engine = receipt.engine
						AND lease.status = 'released'
						AND lease.ended_reason = 'engine_complete'
						AND lease.ended_at = receipt.recorded_at
						AND runner.principal_id = NEW.actor_id
						AND NEW.fence = receipt.fence
						AND NEW.occurred_at = receipt.recorded_at
						AND json_type(NEW.metadata_json, '$') = 'object'
						AND json_type(NEW.metadata_json, '$.engine') = 'text'
						AND json_extract(NEW.metadata_json, '$.engine')
							= receipt.engine
						AND json_type(NEW.metadata_json, '$.engineVersion') = 'text'
						AND json_extract(NEW.metadata_json, '$.engineVersion')
							= receipt.engine_version
						AND json_type(NEW.metadata_json, '$.operationId') = 'text'
						AND json_extract(NEW.metadata_json, '$.operationId')
							= receipt.operation_id
						AND json_type(NEW.metadata_json, '$.outcomeStatus') = 'text'
						AND json_extract(NEW.metadata_json, '$.outcomeStatus')
							= receipt.status
						AND json_type(NEW.metadata_json, '$.reason') = 'text'
						AND json_extract(NEW.metadata_json, '$.reason')
							= receipt.reason
						AND json_type(NEW.metadata_json, '$.receiptSha256') = 'text'
						AND json_extract(NEW.metadata_json, '$.receiptSha256')
							= receipt.receipt_sha256
						AND json_type(NEW.metadata_json, '$.stderrBytes') = 'integer'
						AND json_extract(NEW.metadata_json, '$.stderrBytes')
							= receipt.stderr_bytes
						AND json_type(NEW.metadata_json, '$.stdoutBytes') = 'integer'
						AND json_extract(NEW.metadata_json, '$.stdoutBytes')
							= receipt.stdout_bytes
						AND (
							SELECT COUNT(*) FROM json_each(NEW.metadata_json)
						) = 8
						AND NOT EXISTS (
							SELECT 1 FROM json_each(NEW.metadata_json) field
							WHERE field.key NOT IN (
								'engine', 'engineVersion', 'operationId',
								'outcomeStatus', 'reason', 'receiptSha256',
								'stderrBytes', 'stdoutBytes'
							)
						)
						AND NOT EXISTS (
							SELECT 1
							FROM run_events existing
							WHERE existing.run_id = run.id
								AND existing.kind = 'run.completed'
						)
				)
			)
		)
		OR (
			NEW.`kind` = 'run.expired'
			AND NOT EXISTS (
				SELECT 1
				FROM `runs` run
				INNER JOIN `run_deadline_operations` operation
					ON operation.`run_id` = run.`id`
					AND operation.`organization_id` = run.`organization_id`
				INNER JOIN `organization_system_principals` mapping
					ON mapping.`organization_id` = run.`organization_id`
					AND mapping.`purpose` = 'deadline_reconciler'
					AND mapping.`principal_id` = operation.`actor_id`
				WHERE run.`id` = NEW.`run_id`
					AND run.`organization_id` = NEW.`organization_id`
					AND run.`kind` = 'engine_prompt'
					AND run.`status` = 'expired'
					AND run.`recorded_at` = operation.`applied_at`
					AND NEW.`actor_id` = operation.`actor_id`
					AND NEW.`occurred_at` = operation.`applied_at`
					AND NEW.`fence` IS NULL
					AND NOT EXISTS (
						SELECT 1
						FROM `run_events` existing
						WHERE existing.`run_id` = run.`id`
							AND existing.`kind` = 'run.expired'
					)
					AND json_type(NEW.`metadata_json`, '$') = 'object'
					AND json_type(
						NEW.`metadata_json`, '$.deadlineAt'
					) = 'text'
					AND json_extract(
						NEW.`metadata_json`, '$.deadlineAt'
					) = operation.`deadline_at`
					AND json_type(
						NEW.`metadata_json`, '$.operationId'
					) = 'text'
					AND json_extract(
						NEW.`metadata_json`, '$.operationId'
					) = operation.`operation_id`
					AND json_type(
						NEW.`metadata_json`, '$.reason'
					) = 'text'
					AND json_extract(
						NEW.`metadata_json`, '$.reason'
					) = operation.`reason`
					AND (
						SELECT COUNT(*)
						FROM json_each(NEW.`metadata_json`)
					) = 3
					AND NOT EXISTS (
						SELECT 1
						FROM json_each(NEW.`metadata_json`) field
						WHERE field.`key` NOT IN (
							'deadlineAt', 'operationId', 'reason'
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
END;--> statement-breakpoint

DROP TRIGGER `ledger_entries_validate_run_event`;--> statement-breakpoint
CREATE TRIGGER `ledger_entries_validate_run_event`
BEFORE INSERT ON `ledger_entries`
WHEN NEW.`kind` IN ('run.requested', 'run.completed')
BEGIN
	SELECT CASE WHEN
		NEW.`intent_id` IS NOT NULL
		OR NEW.`run_id` IS NULL
		OR length(NEW.`payload_hash`) <> 64
		OR NEW.`payload_hash` GLOB '*[^0-9a-f]*'
		OR NOT (
			(
				NEW.`kind` = 'run.requested'
				AND EXISTS (
					SELECT 1 FROM `runs` run
					WHERE run.`id` = NEW.`run_id`
						AND run.`organization_id` = NEW.`organization_id`
						AND NEW.`payload_ref` = 'nexus://runs/' || run.`id`
						AND run.`requested_by` = NEW.`actor_id`
						AND run.`created_at` = NEW.`occurred_at`
						AND (
							run.`kind` = 'diagnostic'
							OR (
								run.`kind` = 'engine_prompt'
								AND EXISTS (
									SELECT 1
									FROM `run_events` event
									WHERE event.`run_id` = run.`id`
										AND event.`organization_id`
											= run.`organization_id`
										AND event.`sequence` = 1
										AND event.`kind` = 'run.created'
										AND event.`actor_id` = run.`requested_by`
										AND event.`occurred_at`
											= run.`created_at`
								)
							)
						)
				)
			)
			OR (
				NEW.kind = 'run.completed'
				AND (
					EXISTS (
						SELECT 1
						FROM runs run
						INNER JOIN run_leases lease
							ON lease.id = run.current_lease_id
							AND lease.run_id = run.id
						INNER JOIN runners runner
							ON runner.id = lease.runner_id
						WHERE run.id = NEW.run_id
							AND run.organization_id = NEW.organization_id
							AND run.kind = 'diagnostic'
							AND run.engine IS NULL
							AND run.status = 'completed'
							AND NEW.payload_ref = 'nexus://runs/' || run.id
							AND runner.principal_id = NEW.actor_id
							AND run.recorded_at = NEW.occurred_at
					)
					OR EXISTS (
						SELECT 1
						FROM runs run
						INNER JOIN run_engine_receipts receipt
							ON receipt.run_id = run.id
							AND receipt.organization_id = run.organization_id
						INNER JOIN run_leases lease
							ON lease.id = receipt.lease_id
							AND lease.run_id = run.id
							AND lease.organization_id = run.organization_id
							AND lease.fence = receipt.fence
						INNER JOIN runners runner
							ON runner.id = lease.runner_id
							AND runner.organization_id = run.organization_id
						INNER JOIN run_events event
							ON event.run_id = run.id
							AND event.organization_id = run.organization_id
							AND event.kind = 'run.completed'
						WHERE run.id = NEW.run_id
							AND run.organization_id = NEW.organization_id
							AND run.kind = 'engine_prompt'
							AND run.engine = receipt.engine
							AND run.status = 'completed'
							AND run.current_lease_id = receipt.lease_id
							AND run.lease_generation = receipt.fence
							AND run.completed_operation_id = receipt.operation_id
							AND run.outcome_status = receipt.status
							AND run.recorded_at = receipt.recorded_at
							AND NEW.payload_ref = 'nexus://runs/' || run.id
							AND runner.principal_id = NEW.actor_id
							AND NEW.occurred_at = receipt.recorded_at
							AND event.actor_id = NEW.actor_id
							AND event.fence = receipt.fence
							AND event.occurred_at = receipt.recorded_at
							AND json_extract(
								event.metadata_json, '$.receiptSha256'
							) = receipt.receipt_sha256
					)
				)
			)
		)
	THEN RAISE(ABORT, 'invalid_run_ledger_event') END;

	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM `ledger_entries` existing
		WHERE existing.`organization_id` = NEW.`organization_id`
			AND existing.`payload_ref` = NEW.`payload_ref`
			AND existing.`kind` = NEW.`kind`
	)
	THEN RAISE(ABORT, 'duplicate_run_ledger_event') END;
END;--> statement-breakpoint
