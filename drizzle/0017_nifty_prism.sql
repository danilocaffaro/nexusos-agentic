CREATE TABLE `run_events` (
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`fence` integer,
	`occurred_at` text NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`run_id`, `sequence`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `run_events_org_occurred_idx` ON `run_events` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `run_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`fence` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`renewed_at` text,
	`renew_count` integer DEFAULT 0 NOT NULL,
	`ended_at` text,
	`ended_reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_leases_run_fence_uidx` ON `run_leases` (`run_id`,`fence`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_leases_active_run_uidx` ON `run_leases` (`run_id`) WHERE "run_leases"."status" = 'active';--> statement-breakpoint
CREATE INDEX `run_leases_runner_status_idx` ON `run_leases` (`runner_id`,`status`);--> statement-breakpoint
CREATE INDEX `run_leases_org_run_idx` ON `run_leases` (`organization_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `runner_lease_nonces` (
	`organization_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`nonce` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text NOT NULL,
	`occurred_at` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`runner_id`, `nonce`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runner_lease_nonces_expires_idx` ON `runner_lease_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `runner_operations` (
	`run_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`fence` integer NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text,
	`replay_count` integer DEFAULT 0 NOT NULL,
	`applied_at` text NOT NULL,
	`compacted_at` text,
	PRIMARY KEY(`run_id`, `operation_id`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runner_operations_applied_idx` ON `runner_operations` (`applied_at`);--> statement-breakpoint
CREATE INDEX `runner_operations_compacted_idx` ON `runner_operations` (`compacted_at`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`kind` text DEFAULT 'diagnostic' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`lease_generation` integer DEFAULT 0 NOT NULL,
	`current_lease_id` text,
	`claim_count` integer DEFAULT 0 NOT NULL,
	`max_claims` integer DEFAULT 5 NOT NULL,
	`deadline_at` text NOT NULL,
	`cancel_requested_at` text,
	`cancel_requested_by` text,
	`outcome_status` text,
	`outcome_summary` text,
	`completed_operation_id` text,
	`recorded_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancel_requested_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_org_status_created_idx` ON `runs` (`organization_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_org_requested_created_idx` ON `runs` (`organization_id`,`requested_by`,`created_at`);--> statement-breakpoint
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
		OR NOT EXISTS (
			SELECT 1 FROM `principals` principal
			WHERE principal.`id` = NEW.`requested_by`
				AND principal.`organization_id` = NEW.`organization_id`
				AND principal.`kind` = 'human'
				AND principal.`status` = 'active'
		)
	THEN RAISE(ABORT, 'invalid_run') END;
END;--> statement-breakpoint
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
CREATE TRIGGER `runs_prevent_delete`
BEFORE DELETE ON `runs`
BEGIN
	SELECT RAISE(ABORT, 'run_is_immutable');
END;--> statement-breakpoint
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
END;--> statement-breakpoint
CREATE TRIGGER `run_leases_attach_after_insert`
AFTER INSERT ON `run_leases`
BEGIN
	UPDATE `runs`
	SET `status` = 'leased',
		`lease_generation` = NEW.`fence`,
		`current_lease_id` = NEW.`id`,
		`claim_count` = `claim_count` + 1,
		`version` = `version` + 1,
		`updated_at` = NEW.`issued_at`
	WHERE `id` = NEW.`run_id`
		AND `organization_id` = NEW.`organization_id`;
END;--> statement-breakpoint
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
					AND (
						NEW.`renewed_at` IS NULL
						OR NEW.`expires_at` = OLD.`expires_at`
					)
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
CREATE TRIGGER `run_leases_detach_after_update`
AFTER UPDATE ON `run_leases`
WHEN OLD.`status` = 'active' AND NEW.`status` <> 'active'
BEGIN
	UPDATE `runs`
	SET `status` = 'queued',
		`current_lease_id` = NULL,
		`version` = `version` + 1,
		`updated_at` = NEW.`ended_at`
	WHERE `id` = NEW.`run_id`
		AND `current_lease_id` = NEW.`id`
		AND `status` = 'leased';
END;--> statement-breakpoint
CREATE TRIGGER `run_leases_prevent_delete`
BEFORE DELETE ON `run_leases`
BEGIN
	SELECT RAISE(ABORT, 'run_lease_is_immutable');
END;--> statement-breakpoint
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
			NEW.`kind` NOT LIKE 'lease.%'
			AND NEW.`kind` <> 'run.completed'
			AND NEW.`fence` IS NOT NULL
		)
	THEN RAISE(ABORT, 'invalid_run_event') END;
END;--> statement-breakpoint
CREATE TRIGGER `run_events_prevent_update`
BEFORE UPDATE ON `run_events`
BEGIN
	SELECT RAISE(ABORT, 'run_event_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `run_events_prevent_delete`
BEFORE DELETE ON `run_events`
BEGIN
	SELECT RAISE(ABORT, 'run_event_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `runner_lease_nonces_validate_before_insert`
BEFORE INSERT ON `runner_lease_nonces`
BEGIN
	SELECT CASE WHEN
		length(NEW.`nonce`) <> 22
		OR NEW.`request_hash` NOT GLOB
			'[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
		OR length(NEW.`request_hash`) <> 64
		OR NEW.`request_hash` GLOB '*[^0-9a-f]*'
		OR NEW.`response_status` < 200
		OR NEW.`response_status` > 599
		OR length(CAST(NEW.`response_body` AS BLOB)) > 4096
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
	THEN RAISE(ABORT, 'invalid_runner_lease_nonce') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_lease_nonces_prevent_update`
BEFORE UPDATE ON `runner_lease_nonces`
BEGIN
	SELECT RAISE(ABORT, 'runner_lease_nonce_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `runner_operations_validate_before_insert`
BEFORE INSERT ON `runner_operations`
BEGIN
	SELECT CASE WHEN
		NEW.`operation_id` NOT GLOB
			'op_[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
		OR length(NEW.`operation_id`) <> 35
		OR substr(NEW.`operation_id`, 4) GLOB '*[^0-9a-f]*'
		OR NEW.`request_hash` NOT GLOB
			'[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
		OR length(NEW.`request_hash`) <> 64
		OR NEW.`request_hash` GLOB '*[^0-9a-f]*'
		OR NEW.`fence` < 1
		OR NEW.`response_status` < 200
		OR NEW.`response_status` > 599
		OR NEW.`response_body` IS NULL
		OR length(CAST(NEW.`response_body` AS BLOB)) > 4096
		OR NEW.`replay_count` <> 0
		OR NEW.`compacted_at` IS NOT NULL
		OR NOT EXISTS (
			SELECT 1
			FROM `runs` run
			INNER JOIN `run_leases` lease
				ON lease.`id` = run.`current_lease_id`
				AND lease.`run_id` = run.`id`
				AND lease.`fence` = run.`lease_generation`
			WHERE run.`id` = NEW.`run_id`
				AND run.`status` = 'leased'
				AND run.`lease_generation` = NEW.`fence`
				AND lease.`status` = 'active'
		)
	THEN RAISE(ABORT, 'invalid_runner_operation') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_operations_validate_before_update`
BEFORE UPDATE ON `runner_operations`
BEGIN
	SELECT CASE WHEN
		NEW.`run_id` <> OLD.`run_id`
		OR NEW.`operation_id` <> OLD.`operation_id`
		OR NEW.`request_hash` <> OLD.`request_hash`
		OR NEW.`fence` <> OLD.`fence`
		OR NEW.`response_status` <> OLD.`response_status`
		OR NEW.`applied_at` <> OLD.`applied_at`
		OR NEW.`replay_count` < OLD.`replay_count`
		OR NEW.`replay_count` > OLD.`replay_count` + 1
		OR (
			OLD.`compacted_at` IS NULL
			AND NEW.`compacted_at` IS NULL
			AND NEW.`response_body` IS NOT OLD.`response_body`
		)
		OR (
			OLD.`compacted_at` IS NULL
			AND NEW.`compacted_at` IS NOT NULL
			AND NEW.`response_body` IS NOT NULL
		)
		OR (
			OLD.`compacted_at` IS NOT NULL
			AND (
				NEW.`compacted_at` <> OLD.`compacted_at`
				OR NEW.`response_body` IS NOT NULL
			)
		)
	THEN RAISE(ABORT, 'invalid_runner_operation_transition') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_operations_prevent_delete`
BEFORE DELETE ON `runner_operations`
BEGIN
	SELECT RAISE(ABORT, 'runner_operation_tombstone_is_immutable');
END;--> statement-breakpoint
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
				)
			)
			OR (
				NEW.`kind` = 'run.completed'
				AND EXISTS (
					SELECT 1
					FROM `runs` run
					INNER JOIN `run_leases` lease
						ON lease.`id` = run.`current_lease_id`
						AND lease.`run_id` = run.`id`
					INNER JOIN `runners` runner
						ON runner.`id` = lease.`runner_id`
					WHERE run.`id` = NEW.`run_id`
						AND run.`organization_id` = NEW.`organization_id`
						AND run.`status` = 'completed'
						AND NEW.`payload_ref` = 'nexus://runs/' || run.`id`
						AND runner.`principal_id` = NEW.`actor_id`
						AND run.`recorded_at` = NEW.`occurred_at`
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
END;
