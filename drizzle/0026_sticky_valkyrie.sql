CREATE TABLE `run_engine_excerpts` (
	`run_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`excerpt_ref` text NOT NULL,
	`cipher_version` integer NOT NULL,
	`key_id` text,
	`iv` blob,
	`ciphertext` blob,
	`tag` blob,
	`stdout_excerpt_bytes` integer NOT NULL,
	`stderr_excerpt_bytes` integer NOT NULL,
	`excerpt_sha256` text NOT NULL,
	`created_at` text NOT NULL,
	`erased_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "run_engine_excerpts_cipher_version_check" CHECK("run_engine_excerpts"."cipher_version" = 1),
	CONSTRAINT "run_engine_excerpts_bytes_check" CHECK("run_engine_excerpts"."stdout_excerpt_bytes" BETWEEN 0 AND 1024
        AND "run_engine_excerpts"."stderr_excerpt_bytes" BETWEEN 0 AND 1024
        AND "run_engine_excerpts"."stdout_excerpt_bytes" + "run_engine_excerpts"."stderr_excerpt_bytes" <= 1024),
	CONSTRAINT "run_engine_excerpts_sha256_check" CHECK(length("run_engine_excerpts"."excerpt_sha256") = 64
        AND "run_engine_excerpts"."excerpt_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "run_engine_excerpts_crypto_state_check" CHECK((
        "run_engine_excerpts"."erased_at" IS NULL
        AND "run_engine_excerpts"."key_id" IS NOT NULL
        AND "run_engine_excerpts"."iv" IS NOT NULL
        AND "run_engine_excerpts"."ciphertext" IS NOT NULL
        AND "run_engine_excerpts"."tag" IS NOT NULL
      ) OR (
        "run_engine_excerpts"."erased_at" IS NOT NULL
        AND "run_engine_excerpts"."key_id" IS NULL
        AND "run_engine_excerpts"."iv" IS NULL
        AND "run_engine_excerpts"."ciphertext" IS NULL
        AND "run_engine_excerpts"."tag" IS NULL
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_engine_excerpts_org_ref_uidx` ON `run_engine_excerpts` (`organization_id`,`excerpt_ref`);--> statement-breakpoint
CREATE INDEX `run_engine_excerpts_live_key_idx` ON `run_engine_excerpts` (`key_id`,`run_id`) WHERE "run_engine_excerpts"."erased_at" IS NULL;--> statement-breakpoint
CREATE INDEX `run_engine_excerpts_retention_due_idx` ON `run_engine_excerpts` (`erased_at`,`created_at`,`run_id`);--> statement-breakpoint
CREATE TABLE `run_engine_receipts` (
	`run_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`excerpt_ref` text NOT NULL,
	`excerpt_sha256` text NOT NULL,
	`lease_id` text NOT NULL,
	`fence` integer NOT NULL,
	`engine` text NOT NULL,
	`engine_version` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`exit_code` integer,
	`timed_out` integer NOT NULL,
	`cancel_requested` integer NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`stdout_bytes` integer NOT NULL,
	`stdout_sha256` text NOT NULL,
	`stdout_truncated` integer NOT NULL,
	`stdout_excerpt_bytes` integer NOT NULL,
	`stderr_bytes` integer NOT NULL,
	`stderr_sha256` text NOT NULL,
	`stderr_truncated` integer NOT NULL,
	`stderr_excerpt_bytes` integer NOT NULL,
	`receipt_sha256` text NOT NULL,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lease_id`) REFERENCES `run_leases`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`run_id`,`operation_id`) REFERENCES `runner_operations`(`run_id`,`operation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`organization_id`,`excerpt_ref`) REFERENCES `run_engine_excerpts`(`organization_id`,`excerpt_ref`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "run_engine_receipts_fence_check" CHECK("run_engine_receipts"."fence" >= 1),
	CONSTRAINT "run_engine_receipts_engine_check" CHECK("run_engine_receipts"."engine" IN ('claude_code_cli', 'codex_cli')),
	CONSTRAINT "run_engine_receipts_status_check" CHECK("run_engine_receipts"."status" IN ('succeeded', 'failed', 'canceled')),
	CONSTRAINT "run_engine_receipts_reason_check" CHECK("run_engine_receipts"."reason" IN (
	        'none', 'engine_incompatible', 'prompt_unavailable',
	        'prompt_erased', 'prompt_integrity_mismatch',
        'spawn_failed', 'timed_out', 'cancel_requested', 'lease_lost',
        'output_limit_reached', 'interrupted_after_start',
        'orphan_identity_ambiguous', 'engine_exit_nonzero',
        'protocol_invalid'
      )),
	CONSTRAINT "run_engine_receipts_exit_code_check" CHECK("run_engine_receipts"."exit_code" IS NULL
        OR "run_engine_receipts"."exit_code" BETWEEN 0 AND 255),
	CONSTRAINT "run_engine_receipts_stream_bytes_check" CHECK("run_engine_receipts"."stdout_bytes" BETWEEN 0 AND 262144
        AND "run_engine_receipts"."stderr_bytes" BETWEEN 0 AND 65536
        AND "run_engine_receipts"."stdout_excerpt_bytes" BETWEEN 0 AND 1024
        AND "run_engine_receipts"."stderr_excerpt_bytes" BETWEEN 0 AND 1024
        AND "run_engine_receipts"."stdout_excerpt_bytes" + "run_engine_receipts"."stderr_excerpt_bytes" <= 1024),
	CONSTRAINT "run_engine_receipts_digests_check" CHECK(length("run_engine_receipts"."stdout_sha256") = 64
	        AND "run_engine_receipts"."stdout_sha256" NOT GLOB '*[^0-9a-f]*'
	        AND length("run_engine_receipts"."stderr_sha256") = 64
	        AND "run_engine_receipts"."stderr_sha256" NOT GLOB '*[^0-9a-f]*'
	        AND length("run_engine_receipts"."excerpt_sha256") = 64
	        AND "run_engine_receipts"."excerpt_sha256" NOT GLOB '*[^0-9a-f]*'
	        AND length("run_engine_receipts"."receipt_sha256") = 64
        AND "run_engine_receipts"."receipt_sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_engine_receipts_org_operation_uidx` ON `run_engine_receipts` (`organization_id`,`operation_id`);--> statement-breakpoint
CREATE INDEX `run_engine_receipts_org_recorded_idx` ON `run_engine_receipts` (`organization_id`,`recorded_at`);--> statement-breakpoint

CREATE TRIGGER `run_engine_excerpts_prevent_replace`
BEFORE INSERT ON `run_engine_excerpts`
WHEN EXISTS (
	SELECT 1 FROM `run_engine_excerpts`
	WHERE `run_id` = NEW.`run_id`
		OR (
			`organization_id` = NEW.`organization_id`
			AND `excerpt_ref` = NEW.`excerpt_ref`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'run_engine_excerpt_already_exists');
END;--> statement-breakpoint

CREATE TRIGGER `run_engine_excerpts_validate_before_insert`
BEFORE INSERT ON `run_engine_excerpts`
BEGIN
	SELECT CASE WHEN
		length(NEW.`excerpt_ref`) <> 36
		OR substr(NEW.`excerpt_ref`, 1, 4) <> 'exc_'
		OR substr(NEW.`excerpt_ref`, 5) GLOB '*[^0-9a-f]*'
		OR NEW.`cipher_version` <> 1
		OR NEW.`key_id` IS NULL
		OR length(NEW.`key_id`) NOT BETWEEN 1 AND 32
		OR substr(NEW.`key_id`, 1, 1) NOT GLOB '[0-9A-Za-z]'
		OR NEW.`key_id` GLOB '*[^0-9A-Za-z._-]*'
		OR typeof(NEW.`iv`) <> 'blob'
		OR length(NEW.`iv`) <> 12
		OR typeof(NEW.`ciphertext`) <> 'blob'
		OR length(NEW.`ciphertext`) <>
			2 + NEW.`stdout_excerpt_bytes` + NEW.`stderr_excerpt_bytes`
		OR typeof(NEW.`tag`) <> 'blob'
		OR length(NEW.`tag`) <> 16
		OR typeof(NEW.`stdout_excerpt_bytes`) <> 'integer'
		OR typeof(NEW.`stderr_excerpt_bytes`) <> 'integer'
		OR NEW.`stdout_excerpt_bytes` NOT BETWEEN 0 AND 1024
		OR NEW.`stderr_excerpt_bytes` NOT BETWEEN 0 AND 1024
		OR NEW.`stdout_excerpt_bytes` + NEW.`stderr_excerpt_bytes` > 1024
		OR length(NEW.`excerpt_sha256`) <> 64
		OR NEW.`excerpt_sha256` GLOB '*[^0-9a-f]*'
		OR length(NEW.`created_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`created_at`)
			IS NOT NEW.`created_at`
		OR NEW.`erased_at` IS NOT NULL
		OR EXISTS (
			SELECT 1
			FROM `run_engine_receipts` receipt
			WHERE receipt.`run_id` = NEW.`run_id`
		)
		OR NOT EXISTS (
			SELECT 1
			FROM `runs` run
			INNER JOIN `run_leases` lease
				ON lease.`id` = run.`current_lease_id`
				AND lease.`run_id` = run.`id`
				AND lease.`organization_id` = run.`organization_id`
				AND lease.`fence` = run.`lease_generation`
			WHERE run.`id` = NEW.`run_id`
				AND run.`organization_id` = NEW.`organization_id`
				AND run.`kind` = 'engine_prompt'
				AND run.`engine` IN ('claude_code_cli', 'codex_cli')
				AND run.`status` = 'leased'
				AND lease.`status` = 'active'
				AND NEW.`created_at` < lease.`expires_at`
				AND NEW.`created_at` <= run.`deadline_at`
		)
	THEN RAISE(ABORT, 'invalid_run_engine_excerpt') END;
END;--> statement-breakpoint

CREATE TRIGGER `run_engine_excerpts_validate_before_update`
BEFORE UPDATE ON `run_engine_excerpts`
BEGIN
	SELECT CASE WHEN
		NEW.`run_id` <> OLD.`run_id`
		OR NEW.`organization_id` <> OLD.`organization_id`
		OR NEW.`excerpt_ref` <> OLD.`excerpt_ref`
		OR NEW.`cipher_version` <> OLD.`cipher_version`
		OR NEW.`stdout_excerpt_bytes` <> OLD.`stdout_excerpt_bytes`
		OR NEW.`stderr_excerpt_bytes` <> OLD.`stderr_excerpt_bytes`
		OR NEW.`excerpt_sha256` <> OLD.`excerpt_sha256`
		OR NEW.`created_at` <> OLD.`created_at`
		OR OLD.`erased_at` IS NOT NULL
		OR OLD.`key_id` IS NULL
		OR OLD.`iv` IS NULL
		OR OLD.`ciphertext` IS NULL
		OR OLD.`tag` IS NULL
		OR NEW.`key_id` IS NOT NULL
		OR NEW.`iv` IS NOT NULL
		OR NEW.`ciphertext` IS NOT NULL
		OR NEW.`tag` IS NOT NULL
		OR NEW.`erased_at` IS NULL
		OR length(NEW.`erased_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`erased_at`)
			IS NOT NEW.`erased_at`
		OR NOT EXISTS (
			SELECT 1
			FROM `runs` run
			WHERE run.`id` = NEW.`run_id`
				AND run.`organization_id` = NEW.`organization_id`
				AND run.`kind` = 'engine_prompt'
				AND run.`status` IN ('completed', 'canceled', 'expired')
				AND run.`recorded_at` IS NOT NULL
				AND (
					(
						CAST(strftime(
							'%s', NEW.`erased_at`
						) AS INTEGER) * 1000
						+ CAST(substr(NEW.`erased_at`, 21, 3) AS INTEGER)
					) - (
						CAST(strftime(
							'%s', run.`recorded_at`
						) AS INTEGER) * 1000
						+ CAST(substr(run.`recorded_at`, 21, 3) AS INTEGER)
					)
				) >= 2592000000
		)
	THEN RAISE(ABORT, 'invalid_run_engine_excerpt_transition') END;
END;--> statement-breakpoint

CREATE TRIGGER `run_engine_excerpts_prevent_delete`
BEFORE DELETE ON `run_engine_excerpts`
BEGIN
	SELECT RAISE(ABORT, 'run_engine_excerpt_is_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `run_engine_receipts_prevent_replace`
BEFORE INSERT ON `run_engine_receipts`
WHEN EXISTS (
	SELECT 1 FROM `run_engine_receipts`
	WHERE `run_id` = NEW.`run_id`
		OR (
			`organization_id` = NEW.`organization_id`
			AND `operation_id` = NEW.`operation_id`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'run_engine_receipt_already_exists');
END;--> statement-breakpoint

CREATE TRIGGER `run_engine_receipts_validate_before_insert`
BEFORE INSERT ON `run_engine_receipts`
BEGIN
	SELECT CASE WHEN
		NEW.`operation_id` NOT GLOB
			'op_[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
		OR length(NEW.`operation_id`) <> 35
		OR substr(NEW.`operation_id`, 4) GLOB '*[^0-9a-f]*'
		OR NEW.`excerpt_ref` NOT GLOB
			'exc_[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
		OR length(NEW.`excerpt_ref`) <> 36
		OR substr(NEW.`excerpt_ref`, 5) GLOB '*[^0-9a-f]*'
		OR NEW.`lease_id` NOT GLOB
			'lse_[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
		OR length(NEW.`lease_id`) <> 36
		OR substr(NEW.`lease_id`, 5) GLOB '*[^0-9a-f]*'
		OR typeof(NEW.`fence`) <> 'integer'
		OR NEW.`fence` < 1
		OR NEW.`engine` NOT IN ('claude_code_cli', 'codex_cli')
		OR length(CAST(NEW.`engine_version` AS BLOB)) NOT BETWEEN 1 AND 64
		OR NEW.`engine_version` GLOB '*[^0-9A-Za-z ._+()-]*'
		OR substr(NEW.`engine_version`, 1, 1) NOT GLOB '[0-9A-Za-z]'
		OR NEW.`status` NOT IN ('succeeded', 'failed', 'canceled')
		OR NEW.`reason` NOT IN (
			'none', 'engine_incompatible', 'prompt_unavailable', 'prompt_erased',
			'prompt_integrity_mismatch', 'spawn_failed', 'timed_out',
			'cancel_requested', 'lease_lost', 'output_limit_reached',
			'interrupted_after_start', 'orphan_identity_ambiguous',
			'engine_exit_nonzero', 'protocol_invalid'
		)
		OR (
			NEW.`exit_code` IS NOT NULL
			AND (
				typeof(NEW.`exit_code`) <> 'integer'
				OR NEW.`exit_code` NOT BETWEEN 0 AND 255
			)
		)
		OR typeof(NEW.`timed_out`) <> 'integer'
		OR NEW.`timed_out` NOT IN (0, 1)
		OR typeof(NEW.`cancel_requested`) <> 'integer'
		OR NEW.`cancel_requested` NOT IN (0, 1)
		OR length(NEW.`started_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`started_at`)
			IS NOT NEW.`started_at`
		OR length(NEW.`finished_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`finished_at`)
			IS NOT NEW.`finished_at`
		OR NEW.`started_at` > NEW.`finished_at`
		OR length(NEW.`recorded_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`recorded_at`)
			IS NOT NEW.`recorded_at`
		OR typeof(NEW.`stdout_bytes`) <> 'integer'
		OR NEW.`stdout_bytes` NOT BETWEEN 0 AND 262144
		OR typeof(NEW.`stderr_bytes`) <> 'integer'
		OR NEW.`stderr_bytes` NOT BETWEEN 0 AND 65536
		OR typeof(NEW.`stdout_excerpt_bytes`) <> 'integer'
		OR NEW.`stdout_excerpt_bytes` NOT BETWEEN 0 AND 1024
		OR typeof(NEW.`stderr_excerpt_bytes`) <> 'integer'
		OR NEW.`stderr_excerpt_bytes` NOT BETWEEN 0 AND 1024
		OR NEW.`stdout_excerpt_bytes` + NEW.`stderr_excerpt_bytes` > 1024
		OR NEW.`stdout_excerpt_bytes` > NEW.`stdout_bytes`
		OR NEW.`stderr_excerpt_bytes` > NEW.`stderr_bytes`
		OR typeof(NEW.`stdout_truncated`) <> 'integer'
		OR NEW.`stdout_truncated` NOT IN (0, 1)
		OR NEW.`stdout_truncated` <>
			(NEW.`stdout_bytes` > NEW.`stdout_excerpt_bytes`)
		OR typeof(NEW.`stderr_truncated`) <> 'integer'
		OR NEW.`stderr_truncated` NOT IN (0, 1)
		OR NEW.`stderr_truncated` <>
			(NEW.`stderr_bytes` > NEW.`stderr_excerpt_bytes`)
		OR length(NEW.`stdout_sha256`) <> 64
		OR NEW.`stdout_sha256` GLOB '*[^0-9a-f]*'
		OR length(NEW.`stderr_sha256`) <> 64
		OR NEW.`stderr_sha256` GLOB '*[^0-9a-f]*'
		OR length(NEW.`excerpt_sha256`) <> 64
		OR NEW.`excerpt_sha256` GLOB '*[^0-9a-f]*'
		OR length(NEW.`receipt_sha256`) <> 64
		OR NEW.`receipt_sha256` GLOB '*[^0-9a-f]*'
		OR (
			NEW.`stdout_bytes` = 0
			AND NEW.`stdout_sha256` <>
				'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		)
		OR (
			NEW.`stdout_bytes` > 0
			AND NEW.`stdout_sha256` =
				'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		)
		OR (
			NEW.`stderr_bytes` = 0
			AND NEW.`stderr_sha256` <>
				'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		)
		OR (
			NEW.`stderr_bytes` > 0
			AND NEW.`stderr_sha256` =
				'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		)
		OR (
			NEW.`status` = 'succeeded'
			AND (
				NEW.`reason` <> 'none'
				OR NEW.`exit_code` IS NULL
				OR NEW.`exit_code` <> 0
				OR NEW.`timed_out` <> 0
				OR NEW.`cancel_requested` <> 0
			)
		)
		OR (
			NEW.`status` = 'canceled'
			AND (
				NEW.`reason` <> 'cancel_requested'
				OR NEW.`exit_code` IS NOT NULL
				OR NEW.`cancel_requested` <> 1
			)
		)
		OR (
			NEW.`status` = 'failed'
			AND (
				NEW.`reason` IN ('none', 'cancel_requested')
				OR (
					NEW.`reason` = 'timed_out'
					AND NEW.`timed_out` <> 1
				)
				OR (
					NEW.`reason` = 'engine_exit_nonzero'
					AND (
						NEW.`exit_code` IS NULL
						OR NEW.`exit_code` < 1
					)
				)
				OR (
					NEW.`reason` <> 'engine_exit_nonzero'
					AND NEW.`exit_code` IS NOT NULL
				)
				OR (
					NEW.`reason` = 'output_limit_reached'
					AND NOT (
						(
							NEW.`stdout_bytes` = 262144
							AND NEW.`stdout_truncated` = 1
						)
						OR (
							NEW.`stderr_bytes` = 65536
							AND NEW.`stderr_truncated` = 1
						)
					)
				)
			)
		)
		OR NOT EXISTS (
			SELECT 1
			FROM `runs` run
			INNER JOIN `run_leases` lease
				ON lease.`id` = NEW.`lease_id`
				AND lease.`run_id` = run.`id`
				AND lease.`organization_id` = run.`organization_id`
				AND lease.`fence` = NEW.`fence`
			INNER JOIN `runner_operations` operation
				ON operation.`run_id` = run.`id`
				AND operation.`operation_id` = NEW.`operation_id`
				AND operation.`fence` = NEW.`fence`
			INNER JOIN `run_engine_excerpts` excerpt
				ON excerpt.`run_id` = run.`id`
				AND excerpt.`organization_id` = run.`organization_id`
				AND excerpt.`excerpt_ref` = NEW.`excerpt_ref`
				AND excerpt.`excerpt_sha256` = NEW.`excerpt_sha256`
			WHERE run.`id` = NEW.`run_id`
				AND run.`organization_id` = NEW.`organization_id`
				AND run.`kind` = 'engine_prompt'
				AND run.`engine` = NEW.`engine`
				AND run.`status` = 'leased'
				AND run.`current_lease_id` = NEW.`lease_id`
				AND run.`lease_generation` = NEW.`fence`
				AND run.`assigned_runner_id` = lease.`runner_id`
				AND NEW.`recorded_at` <= run.`deadline_at`
				AND NEW.`recorded_at` < lease.`expires_at`
				AND lease.`status` = 'active'
				AND lease.`admission_basis` = 'engine_inventory'
				AND lease.`admission_engine` = NEW.`engine`
				AND lease.`admission_engine_version`
					= NEW.`engine_version`
				AND operation.`applied_at` = NEW.`recorded_at`
				AND excerpt.`created_at` = NEW.`recorded_at`
				AND excerpt.`stdout_excerpt_bytes`
					= NEW.`stdout_excerpt_bytes`
				AND excerpt.`stderr_excerpt_bytes`
					= NEW.`stderr_excerpt_bytes`
				AND excerpt.`erased_at` IS NULL
				AND (
					NEW.`cancel_requested` = 0
					OR run.`cancel_requested_at` IS NOT NULL
				)
				AND NOT EXISTS (
					SELECT 1
					FROM `run_deadline_operations` deadline
					WHERE deadline.`run_id` = run.`id`
						AND deadline.`organization_id`
							= run.`organization_id`
				)
		)
	THEN RAISE(ABORT, 'invalid_run_engine_receipt') END;
END;--> statement-breakpoint

CREATE TRIGGER `run_engine_receipts_prevent_update`
BEFORE UPDATE ON `run_engine_receipts`
BEGIN
	SELECT RAISE(ABORT, 'run_engine_receipt_is_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `run_engine_receipts_prevent_delete`
BEFORE DELETE ON `run_engine_receipts`
BEGIN
	SELECT RAISE(ABORT, 'run_engine_receipt_is_immutable');
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
		OR NEW.`engine` IS NOT OLD.`engine`
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
			AND NEW.`status`
				NOT IN ('queued', 'leased', 'canceled', 'expired')
		)
		OR (
			OLD.`status` = 'leased'
			AND NEW.`status` NOT IN ('leased', 'queued', 'completed')
		)
		OR (
			OLD.`status` IN ('completed', 'canceled', 'expired')
			AND (
				NEW.`status` <> OLD.`status`
				OR NEW.`version` <> OLD.`version`
				OR NEW.`updated_at` <> OLD.`updated_at`
				OR NEW.`lease_generation` <> OLD.`lease_generation`
				OR NEW.`current_lease_id` IS NOT OLD.`current_lease_id`
				OR NEW.`claim_count` <> OLD.`claim_count`
				OR NEW.`cancel_requested_at`
					IS NOT OLD.`cancel_requested_at`
				OR NEW.`cancel_requested_by`
					IS NOT OLD.`cancel_requested_by`
				OR NEW.`outcome_status` IS NOT OLD.`outcome_status`
				OR NEW.`outcome_summary` IS NOT OLD.`outcome_summary`
				OR NEW.`completed_operation_id`
					IS NOT OLD.`completed_operation_id`
				OR NEW.`recorded_at` IS NOT OLD.`recorded_at`
			)
		)
		OR (
			NEW.`kind` = 'diagnostic'
			AND (
				NEW.`engine` IS NOT NULL
				OR NEW.`max_claims` <> 5
				OR NEW.`status` = 'expired'
			)
		)
		OR (
			NEW.`kind` = 'engine_prompt'
			AND (
				NEW.`engine` NOT IN ('claude_code_cli', 'codex_cli')
				OR NEW.`max_claims` <> 2
				OR NEW.`assigned_runner_id` IS NULL
				OR NEW.`required_capability` IS NOT NULL
				OR NOT EXISTS (
					SELECT 1
					FROM `run_prompts` prompt
					WHERE prompt.`run_id` = NEW.`id`
						AND prompt.`organization_id` = NEW.`organization_id`
				)
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
						AND lease.`organization_id`
							= NEW.`organization_id`
						AND lease.`fence` = NEW.`lease_generation`
						AND lease.`status` = 'active'
						AND (
							NEW.`kind` = 'diagnostic'
							OR (
								lease.`admission_basis` = 'engine_inventory'
								AND lease.`admission_engine` = NEW.`engine`
							)
						)
				)
			)
		)
		OR (
			NEW.`status` = 'completed'
			AND (
				NEW.`version` <> OLD.`version` + 1
				OR NEW.`current_lease_id` IS NULL
				OR NEW.`outcome_status`
					NOT IN ('succeeded', 'failed', 'canceled')
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
						AND operation.`operation_id`
							= NEW.`completed_operation_id`
						AND operation.`fence` = NEW.`lease_generation`
						AND lease.`id` = NEW.`current_lease_id`
						AND lease.`organization_id`
							= NEW.`organization_id`
						AND lease.`status` = 'active'
				)
				OR (
					NEW.`kind` = 'diagnostic'
					AND (
						NEW.`engine` IS NOT NULL
						OR EXISTS (
							SELECT 1
							FROM `run_engine_receipts` receipt
							WHERE receipt.`run_id` = NEW.`id`
						)
					)
				)
				OR (
					NEW.`kind` = 'engine_prompt'
					AND (
						NEW.`engine`
							NOT IN ('claude_code_cli', 'codex_cli')
						OR NOT EXISTS (
							SELECT 1
							FROM `run_engine_receipts` receipt
							WHERE receipt.`run_id` = NEW.`id`
								AND receipt.`organization_id`
									= NEW.`organization_id`
								AND receipt.`operation_id`
									= NEW.`completed_operation_id`
								AND receipt.`lease_id`
									= NEW.`current_lease_id`
								AND receipt.`fence`
									= NEW.`lease_generation`
								AND receipt.`engine` = NEW.`engine`
								AND receipt.`status`
									= NEW.`outcome_status`
								AND receipt.`recorded_at`
									= NEW.`recorded_at`
								AND receipt.`recorded_at`
									= NEW.`updated_at`
								AND NEW.`outcome_summary` = CASE
									WHEN receipt.`status` = 'succeeded'
										THEN 'completed'
									ELSE receipt.`reason`
								END
						)
					)
				)
				OR NEW.`kind` NOT IN ('diagnostic', 'engine_prompt')
			)
		)
		OR (
			NEW.`status` = 'canceled'
			AND (
				OLD.`status` <> 'queued'
				OR NEW.`version` <> OLD.`version` + 1
				OR NEW.`current_lease_id` IS NOT NULL
				OR NEW.`cancel_requested_at` IS NULL
				OR NEW.`outcome_status` IS NOT NULL
				OR NEW.`outcome_summary` IS NOT NULL
				OR NEW.`completed_operation_id` IS NOT NULL
				OR NEW.`recorded_at` IS NULL
			)
		)
		OR (
			NEW.`status` = 'expired'
			AND (
				NEW.`kind` <> 'engine_prompt'
				OR OLD.`status` <> 'queued'
				OR NEW.`current_lease_id` IS NOT NULL
				OR NEW.`outcome_status` IS NOT NULL
				OR NEW.`outcome_summary` IS NOT NULL
				OR NEW.`completed_operation_id` IS NOT NULL
				OR NEW.`recorded_at` IS NULL
				OR NEW.`version` <> OLD.`version` + 1
				OR NEW.`lease_generation` <> OLD.`lease_generation`
				OR NEW.`claim_count` <> OLD.`claim_count`
				OR NEW.`cancel_requested_at`
					IS NOT OLD.`cancel_requested_at`
				OR NEW.`cancel_requested_by`
					IS NOT OLD.`cancel_requested_by`
				OR NOT EXISTS (
					SELECT 1
					FROM `run_deadline_operations` operation
					WHERE operation.`run_id` = NEW.`id`
						AND operation.`organization_id`
							= NEW.`organization_id`
						AND operation.`deadline_at` = NEW.`deadline_at`
						AND operation.`applied_at` = NEW.`recorded_at`
						AND operation.`applied_at` = NEW.`updated_at`
						AND operation.`reason`
							= 'engine_deadline_exhausted'
				)
			)
		)
	THEN RAISE(ABORT, 'invalid_run_transition') END;
END;
