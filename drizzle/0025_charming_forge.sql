CREATE TABLE `organization_system_principals` (
	`organization_id` text NOT NULL,
	`purpose` text NOT NULL,
	`principal_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`organization_id`, `purpose`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "organization_system_principals_purpose_check" CHECK("organization_system_principals"."purpose" = 'deadline_reconciler')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_system_principals_principal_uidx` ON `organization_system_principals` (`principal_id`);--> statement-breakpoint
CREATE TABLE `run_deadline_operations` (
	`run_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`lease_id` text,
	`fence` integer,
	`deadline_at` text NOT NULL,
	`applied_at` text NOT NULL,
	`reason` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lease_id`) REFERENCES `run_leases`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "run_deadline_operations_reason_check" CHECK("run_deadline_operations"."reason" = 'engine_deadline_exhausted'),
	CONSTRAINT "run_deadline_operations_lease_fence_check" CHECK(("run_deadline_operations"."lease_id" IS NULL AND "run_deadline_operations"."fence" IS NULL)
        OR ("run_deadline_operations"."lease_id" IS NOT NULL AND "run_deadline_operations"."fence" >= 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_deadline_operations_org_operation_uidx` ON `run_deadline_operations` (`organization_id`,`operation_id`);--> statement-breakpoint
CREATE INDEX `run_deadline_operations_org_applied_idx` ON `run_deadline_operations` (`organization_id`,`applied_at`);--> statement-breakpoint
CREATE TABLE `run_prompts` (
	`run_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`prompt_ref` text NOT NULL,
	`cipher_version` integer NOT NULL,
	`key_id` text,
	`iv` blob,
	`ciphertext` blob,
	`tag` blob,
	`prompt_sha256` text NOT NULL,
	`prompt_bytes` integer NOT NULL,
	`created_at` text NOT NULL,
	`erased_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "run_prompts_cipher_version_check" CHECK("run_prompts"."cipher_version" = 1),
	CONSTRAINT "run_prompts_bytes_check" CHECK("run_prompts"."prompt_bytes" BETWEEN 1 AND 8192),
	CONSTRAINT "run_prompts_sha256_check" CHECK(length("run_prompts"."prompt_sha256") = 64
        AND "run_prompts"."prompt_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "run_prompts_crypto_state_check" CHECK((
        "run_prompts"."erased_at" IS NULL
        AND "run_prompts"."key_id" IS NOT NULL
        AND "run_prompts"."iv" IS NOT NULL
        AND "run_prompts"."ciphertext" IS NOT NULL
        AND "run_prompts"."tag" IS NOT NULL
      ) OR (
        "run_prompts"."erased_at" IS NOT NULL
        AND "run_prompts"."key_id" IS NULL
        AND "run_prompts"."iv" IS NULL
        AND "run_prompts"."ciphertext" IS NULL
        AND "run_prompts"."tag" IS NULL
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_prompts_org_ref_uidx` ON `run_prompts` (`organization_id`,`prompt_ref`);--> statement-breakpoint
CREATE INDEX `run_prompts_live_key_idx` ON `run_prompts` (`key_id`,`run_id`) WHERE "run_prompts"."erased_at" IS NULL;--> statement-breakpoint
CREATE INDEX `run_prompts_retention_due_idx` ON `run_prompts` (`erased_at`,`created_at`,`run_id`);--> statement-breakpoint
ALTER TABLE `run_leases` ADD `admission_engine` text;--> statement-breakpoint
ALTER TABLE `run_leases` ADD `admission_engine_report_id` text;--> statement-breakpoint
ALTER TABLE `run_leases` ADD `admission_engine_report_received_at` text;--> statement-breakpoint
ALTER TABLE `run_leases` ADD `admission_engine_version` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `engine` text;--> statement-breakpoint
CREATE INDEX `runs_engine_deadline_due_idx` ON `runs` (`kind`,`status`,`deadline_at`,`id`);--> statement-breakpoint
CREATE INDEX `runs_engine_retention_due_idx` ON `runs` (`kind`,`status`,`recorded_at`,`id`);--> statement-breakpoint

INSERT INTO `principals` (
	`id`, `organization_id`, `kind`, `external_id`, `display_name`, `status`,
	`created_at`, `updated_at`
)
SELECT
	'principal-deadline-' || lower(hex(randomblob(16))),
	organization.`id`,
	'automation',
	'system:deadline-reconciler:v1',
	'NexusOS Deadline Reconciler',
	'active',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `organizations` organization
WHERE NOT EXISTS (
	SELECT 1
	FROM `principals` principal
	WHERE principal.`organization_id` = organization.`id`
		AND principal.`external_id` = 'system:deadline-reconciler:v1'
		AND principal.`kind` = 'automation'
		AND principal.`display_name` = 'NexusOS Deadline Reconciler'
		AND principal.`status` = 'active'
		AND principal.`created_at` = principal.`updated_at`
		AND length(principal.`created_at`) = 24
		AND strftime('%Y-%m-%dT%H:%M:%fZ', principal.`created_at`)
			IS principal.`created_at`
);--> statement-breakpoint

INSERT INTO `organization_system_principals` (
	`organization_id`, `purpose`, `principal_id`, `created_at`
)
SELECT
	organization.`id`,
	'deadline_reconciler',
	principal.`id`,
	principal.`created_at`
FROM `organizations` organization
INNER JOIN `principals` principal
	ON principal.`organization_id` = organization.`id`
	AND principal.`external_id` = 'system:deadline-reconciler:v1'
	AND principal.`kind` = 'automation'
	AND principal.`display_name` = 'NexusOS Deadline Reconciler'
	AND principal.`status` = 'active'
	AND principal.`created_at` = principal.`updated_at`
	AND length(principal.`created_at`) = 24
	AND strftime('%Y-%m-%dT%H:%M:%fZ', principal.`created_at`)
		IS principal.`created_at`;--> statement-breakpoint

CREATE TRIGGER `organizations_provision_deadline_principal_after_insert`
AFTER INSERT ON `organizations`
BEGIN
	INSERT INTO `principals` (
		`id`, `organization_id`, `kind`, `external_id`, `display_name`,
		`status`, `created_at`, `updated_at`
	) VALUES (
		'principal-deadline-' || lower(hex(randomblob(16))),
		NEW.`id`,
		'automation',
		'system:deadline-reconciler:v1',
		'NexusOS Deadline Reconciler',
		'active',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	);

	INSERT INTO `organization_system_principals` (
		`organization_id`, `purpose`, `principal_id`, `created_at`
	)
	SELECT
		NEW.`id`,
		'deadline_reconciler',
		principal.`id`,
		principal.`created_at`
	FROM `principals` principal
	WHERE principal.`organization_id` = NEW.`id`
		AND principal.`external_id` = 'system:deadline-reconciler:v1';

	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM `organization_system_principals` mapping
		WHERE mapping.`organization_id` = NEW.`id`
			AND mapping.`purpose` = 'deadline_reconciler'
	)
	THEN RAISE(ABORT, 'deadline_principal_provisioning_failed') END;
END;--> statement-breakpoint

CREATE TRIGGER `organization_system_principals_validate_before_insert`
BEFORE INSERT ON `organization_system_principals`
BEGIN
	SELECT CASE WHEN
		NEW.`purpose` <> 'deadline_reconciler'
		OR length(NEW.`created_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`created_at`)
			IS NOT NEW.`created_at`
		OR NOT EXISTS (
			SELECT 1
			FROM `principals` principal
			WHERE principal.`id` = NEW.`principal_id`
				AND principal.`organization_id` = NEW.`organization_id`
				AND principal.`kind` = 'automation'
				AND principal.`external_id`
					= 'system:deadline-reconciler:v1'
				AND principal.`display_name`
					= 'NexusOS Deadline Reconciler'
				AND principal.`status` = 'active'
				AND principal.`created_at` = NEW.`created_at`
				AND principal.`updated_at` = NEW.`created_at`
		)
	THEN RAISE(ABORT, 'invalid_organization_system_principal') END;
END;--> statement-breakpoint

CREATE TRIGGER `organization_system_principals_prevent_update`
BEFORE UPDATE ON `organization_system_principals`
BEGIN
	SELECT RAISE(ABORT, 'organization_system_principal_is_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `organization_system_principals_prevent_delete`
BEFORE DELETE ON `organization_system_principals`
BEGIN
	SELECT RAISE(ABORT, 'organization_system_principal_is_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `conversation_members_reject_system_principal`
BEFORE INSERT ON `conversation_members`
WHEN EXISTS (
	SELECT 1
	FROM `organization_system_principals` mapping
	WHERE mapping.`organization_id` = NEW.`organization_id`
		AND mapping.`principal_id` = NEW.`principal_id`
)
BEGIN
	SELECT RAISE(ABORT, 'invalid_collaboration_reference');
END;--> statement-breakpoint

CREATE TRIGGER `principals_protect_system_principal_before_update`
BEFORE UPDATE ON `principals`
WHEN EXISTS (
	SELECT 1
	FROM `organization_system_principals` mapping
	WHERE mapping.`principal_id` = OLD.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'organization_system_principal_is_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `principals_protect_system_principal_before_delete`
BEFORE DELETE ON `principals`
WHEN EXISTS (
	SELECT 1
	FROM `organization_system_principals` mapping
	WHERE mapping.`principal_id` = OLD.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'organization_system_principal_is_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `run_prompts_prevent_replace`
BEFORE INSERT ON `run_prompts`
WHEN EXISTS (
	SELECT 1 FROM `run_prompts`
	WHERE `run_id` = NEW.`run_id`
		OR (
			`organization_id` = NEW.`organization_id`
			AND `prompt_ref` = NEW.`prompt_ref`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'run_prompt_already_exists');
END;--> statement-breakpoint

CREATE TRIGGER `run_prompts_validate_before_insert`
BEFORE INSERT ON `run_prompts`
BEGIN
	SELECT CASE WHEN
		length(NEW.`prompt_ref`) <> 36
		OR substr(NEW.`prompt_ref`, 1, 4) <> 'prm_'
		OR substr(NEW.`prompt_ref`, 5) GLOB '*[^0-9a-f]*'
		OR NEW.`cipher_version` <> 1
		OR NEW.`key_id` IS NULL
		OR length(NEW.`key_id`) NOT BETWEEN 1 AND 32
		OR substr(NEW.`key_id`, 1, 1) NOT GLOB '[0-9A-Za-z]'
		OR NEW.`key_id` GLOB '*[^0-9A-Za-z._-]*'
		OR typeof(NEW.`iv`) <> 'blob'
		OR length(NEW.`iv`) <> 12
		OR typeof(NEW.`ciphertext`) <> 'blob'
		OR length(NEW.`ciphertext`) <> NEW.`prompt_bytes`
		OR typeof(NEW.`tag`) <> 'blob'
		OR length(NEW.`tag`) <> 16
		OR NEW.`prompt_bytes` NOT BETWEEN 1 AND 8192
		OR length(NEW.`prompt_sha256`) <> 64
		OR NEW.`prompt_sha256` GLOB '*[^0-9a-f]*'
		OR length(NEW.`created_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`created_at`)
			IS NOT NEW.`created_at`
		OR NEW.`erased_at` IS NOT NULL
		OR NOT EXISTS (
			SELECT 1
			FROM `runs` run
			WHERE run.`id` = NEW.`run_id`
				AND run.`organization_id` = NEW.`organization_id`
				AND run.`kind` = 'engine_prompt'
				AND run.`engine` IN ('claude_code_cli', 'codex_cli')
				AND run.`status` = 'queued'
				AND run.`created_at` = NEW.`created_at`
		)
	THEN RAISE(ABORT, 'invalid_run_prompt') END;
END;--> statement-breakpoint

CREATE TRIGGER `run_prompts_validate_before_update`
BEFORE UPDATE ON `run_prompts`
BEGIN
	SELECT CASE WHEN
		NEW.`run_id` <> OLD.`run_id`
		OR NEW.`organization_id` <> OLD.`organization_id`
		OR NEW.`prompt_ref` <> OLD.`prompt_ref`
		OR NEW.`cipher_version` <> OLD.`cipher_version`
		OR NEW.`prompt_sha256` <> OLD.`prompt_sha256`
		OR NEW.`prompt_bytes` <> OLD.`prompt_bytes`
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
	THEN RAISE(ABORT, 'invalid_run_prompt_transition') END;
END;--> statement-breakpoint

CREATE TRIGGER `run_prompts_prevent_delete`
BEFORE DELETE ON `run_prompts`
BEGIN
	SELECT RAISE(ABORT, 'run_prompt_is_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `run_deadline_operations_prevent_replace`
BEFORE INSERT ON `run_deadline_operations`
WHEN EXISTS (
	SELECT 1 FROM `run_deadline_operations`
	WHERE `run_id` = NEW.`run_id`
		OR (
			`organization_id` = NEW.`organization_id`
			AND `operation_id` = NEW.`operation_id`
		)
)
BEGIN
	SELECT RAISE(ABORT, 'run_deadline_operation_already_exists');
END;--> statement-breakpoint

CREATE TRIGGER `run_deadline_operations_validate_before_insert`
BEFORE INSERT ON `run_deadline_operations`
BEGIN
	SELECT CASE WHEN
		NEW.`operation_id` <> 'op_' || substr(NEW.`run_id`, 5)
		OR length(NEW.`operation_id`) <> 35
		OR substr(NEW.`operation_id`, 4) GLOB '*[^0-9a-f]*'
		OR NEW.`reason` <> 'engine_deadline_exhausted'
		OR length(NEW.`deadline_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`deadline_at`)
			IS NOT NEW.`deadline_at`
		OR length(NEW.`applied_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`applied_at`)
			IS NOT NEW.`applied_at`
		OR NEW.`applied_at` < NEW.`deadline_at`
		OR (NEW.`lease_id` IS NULL) <> (NEW.`fence` IS NULL)
		OR NOT EXISTS (
			SELECT 1
			FROM `runs` run
			INNER JOIN `organization_system_principals` mapping
				ON mapping.`organization_id` = run.`organization_id`
				AND mapping.`purpose` = 'deadline_reconciler'
			INNER JOIN `principals` principal
				ON principal.`id` = mapping.`principal_id`
				AND principal.`organization_id` = mapping.`organization_id`
			WHERE run.`id` = NEW.`run_id`
				AND run.`organization_id` = NEW.`organization_id`
				AND run.`kind` = 'engine_prompt'
				AND run.`engine` IN ('claude_code_cli', 'codex_cli')
				AND run.`status` IN ('queued', 'leased')
				AND run.`deadline_at` = NEW.`deadline_at`
				AND mapping.`principal_id` = NEW.`actor_id`
				AND principal.`kind` = 'automation'
				AND principal.`external_id`
					= 'system:deadline-reconciler:v1'
				AND principal.`status` = 'active'
				AND (
					(
						run.`status` = 'queued'
						AND run.`current_lease_id` IS NULL
						AND NEW.`lease_id` IS NULL
						AND NEW.`fence` IS NULL
					)
					OR (
						run.`status` = 'leased'
						AND run.`current_lease_id` = NEW.`lease_id`
						AND run.`lease_generation` = NEW.`fence`
						AND EXISTS (
							SELECT 1
							FROM `run_leases` lease
							WHERE lease.`id` = NEW.`lease_id`
								AND lease.`run_id` = NEW.`run_id`
								AND lease.`organization_id`
									= NEW.`organization_id`
								AND lease.`fence` = NEW.`fence`
								AND lease.`status` = 'active'
						)
					)
				)
		)
	THEN RAISE(ABORT, 'invalid_run_deadline_operation') END;
END;--> statement-breakpoint

CREATE TRIGGER `run_deadline_operations_prevent_update`
BEFORE UPDATE ON `run_deadline_operations`
BEGIN
	SELECT RAISE(ABORT, 'run_deadline_operation_is_immutable');
END;--> statement-breakpoint

CREATE TRIGGER `run_deadline_operations_prevent_delete`
BEFORE DELETE ON `run_deadline_operations`
BEGIN
	SELECT RAISE(ABORT, 'run_deadline_operation_is_immutable');
END;--> statement-breakpoint

DROP TRIGGER `runs_validate_before_insert`;--> statement-breakpoint
CREATE TRIGGER `runs_validate_before_insert`
BEFORE INSERT ON `runs`
BEGIN
	SELECT CASE WHEN
		NEW.`id` NOT GLOB 'run_[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*'
		OR length(NEW.`id`) <> 36
		OR substr(NEW.`id`, 5) GLOB '*[^0-9a-f]*'
		OR NEW.`status` <> 'queued'
		OR NEW.`version` <> 1
		OR NEW.`lease_generation` <> 0
		OR NEW.`current_lease_id` IS NOT NULL
		OR NEW.`claim_count` <> 0
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
		OR NOT (
			(
				NEW.`kind` = 'diagnostic'
				AND NEW.`engine` IS NULL
				AND NEW.`max_claims` = 5
				AND NEW.`deadline_at` > NEW.`created_at`
				AND (
					NEW.`required_capability` IS NULL
					OR (
						NEW.`assigned_runner_id` IS NOT NULL
						AND NEW.`required_capability` IN (
							'node_permission_model', 'bubblewrap', 'landlock',
							'seccomp', 'user_namespace', 'docker', 'podman'
						)
					)
				)
				AND (
					NEW.`assigned_runner_id` IS NULL
					OR EXISTS (
						SELECT 1
						FROM `runners` runner
						INNER JOIN `principals` principal
							ON principal.`id` = runner.`principal_id`
							AND principal.`organization_id`
								= runner.`organization_id`
						WHERE runner.`id` = NEW.`assigned_runner_id`
							AND runner.`organization_id`
								= NEW.`organization_id`
							AND runner.`status` = 'active'
							AND principal.`kind` = 'runner'
							AND principal.`status` = 'active'
					)
				)
			)
			OR (
				NEW.`kind` = 'engine_prompt'
				AND NEW.`engine` IN ('claude_code_cli', 'codex_cli')
				AND NEW.`max_claims` = 2
				AND NEW.`assigned_runner_id` IS NOT NULL
				AND NEW.`required_capability` IS NULL
				AND length(NEW.`created_at`) = 24
				AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`created_at`)
					IS NEW.`created_at`
				AND length(NEW.`deadline_at`) = 24
				AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`deadline_at`)
					IS NEW.`deadline_at`
				AND NEW.`updated_at` = NEW.`created_at`
				AND (
					(
						CAST(strftime(
							'%s', NEW.`deadline_at`
						) AS INTEGER) * 1000
						+ CAST(substr(NEW.`deadline_at`, 21, 3) AS INTEGER)
					) - (
						CAST(strftime(
							'%s', NEW.`created_at`
						) AS INTEGER) * 1000
						+ CAST(substr(NEW.`created_at`, 21, 3) AS INTEGER)
					)
				) = 1200000
				AND EXISTS (
					SELECT 1
					FROM `runners` runner
					INNER JOIN `principals` principal
						ON principal.`id` = runner.`principal_id`
						AND principal.`organization_id`
							= runner.`organization_id`
					WHERE runner.`id` = NEW.`assigned_runner_id`
						AND runner.`organization_id` = NEW.`organization_id`
						AND runner.`status` = 'active'
						AND principal.`kind` = 'runner'
						AND principal.`status` = 'active'
				)
				AND EXISTS (
					SELECT 1
					FROM `memberships` membership
					WHERE membership.`organization_id`
							= NEW.`organization_id`
						AND membership.`principal_id` = NEW.`requested_by`
						AND membership.`role` IN ('owner', 'admin')
						AND membership.`status` = 'active'
				)
			)
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
				OR NEW.`status` = 'completed'
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
						AND lease.`organization_id` = NEW.`organization_id`
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
				NEW.`kind` <> 'diagnostic'
				OR NEW.`engine` IS NOT NULL
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
				AND NOT EXISTS (
					SELECT 1
					FROM `run_deadline_operations` deadline_operation
					WHERE deadline_operation.`run_id` = run.`id`
						AND deadline_operation.`organization_id`
							= run.`organization_id`
				)
				AND (
					run.`kind` = 'diagnostic'
					OR (
						run.`kind` = 'engine_prompt'
						AND NEW.`expires_at` <= run.`deadline_at`
					)
				)
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
					run.`kind` = 'diagnostic'
					AND run.`engine` IS NULL
					AND run.`assigned_runner_id` IS NULL
					AND run.`required_capability` IS NULL
					AND NEW.`admission_basis` IS NULL
					AND NEW.`admission_policy_source` IS NULL
					AND NEW.`admission_policy_version` IS NULL
					AND NEW.`admission_freshness_seconds` IS NULL
					AND NEW.`admission_required_capability` IS NULL
					AND NEW.`admission_report_id` IS NULL
					AND NEW.`admission_report_received_at` IS NULL
					AND NEW.`admission_engine` IS NULL
					AND NEW.`admission_engine_report_id` IS NULL
					AND NEW.`admission_engine_report_received_at` IS NULL
					AND NEW.`admission_engine_version` IS NULL
				)
				OR (
					run.`kind` = 'diagnostic'
					AND run.`engine` IS NULL
					AND run.`assigned_runner_id` = NEW.`runner_id`
					AND run.`required_capability` IS NULL
					AND NEW.`admission_basis` = 'assignment_only'
					AND NEW.`admission_policy_source` IS NULL
					AND NEW.`admission_policy_version` IS NULL
					AND NEW.`admission_freshness_seconds` IS NULL
					AND NEW.`admission_required_capability` IS NULL
					AND NEW.`admission_report_id` IS NULL
					AND NEW.`admission_report_received_at` IS NULL
					AND NEW.`admission_engine` IS NULL
					AND NEW.`admission_engine_report_id` IS NULL
					AND NEW.`admission_engine_report_received_at` IS NULL
					AND NEW.`admission_engine_version` IS NULL
				)
				OR (
					run.`kind` = 'diagnostic'
					AND run.`engine` IS NULL
					AND run.`assigned_runner_id` = NEW.`runner_id`
					AND run.`required_capability` IS NOT NULL
					AND NEW.`admission_basis` = 'capability_declaration'
					AND NEW.`admission_policy_source`
						IN ('default', 'configured')
					AND typeof(NEW.`admission_policy_version`) = 'integer'
					AND typeof(NEW.`admission_freshness_seconds`) = 'integer'
					AND NEW.`admission_required_capability`
						= run.`required_capability`
					AND NEW.`admission_report_id` IS NOT NULL
					AND NEW.`admission_report_received_at` IS NOT NULL
					AND NEW.`admission_engine` IS NULL
					AND NEW.`admission_engine_report_id` IS NULL
					AND NEW.`admission_engine_report_received_at` IS NULL
					AND NEW.`admission_engine_version` IS NULL
				)
				OR (
					run.`kind` = 'engine_prompt'
					AND run.`engine` = NEW.`admission_engine`
					AND run.`assigned_runner_id` = NEW.`runner_id`
					AND run.`required_capability` IS NULL
					AND NEW.`admission_basis` = 'engine_inventory'
					AND NEW.`admission_policy_source`
						IN ('default', 'configured')
					AND typeof(NEW.`admission_policy_version`) = 'integer'
					AND typeof(NEW.`admission_freshness_seconds`) = 'integer'
					AND NEW.`admission_required_capability` IS NULL
					AND NEW.`admission_report_id` IS NULL
					AND NEW.`admission_report_received_at` IS NULL
					AND NEW.`admission_engine`
						IN ('claude_code_cli', 'codex_cli')
					AND NEW.`admission_engine_report_id` IS NOT NULL
					AND NEW.`admission_engine_report_received_at` IS NOT NULL
					AND NEW.`admission_engine_version` IS NOT NULL
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
				AND run.`kind` = 'diagnostic'
				AND run.`engine` IS NULL
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
						CAST(strftime(
							'%s', report.`received_at`
						) AS INTEGER) * 1000
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
							WHERE policy.`organization_id`
								= NEW.`organization_id`
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
							INNER JOIN
								`runner_admission_policy_capabilities` allowed
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

	SELECT CASE WHEN
		NEW.`admission_basis` = 'engine_inventory'
		AND (
			length(NEW.`expires_at`) <> 24
			OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`expires_at`)
				IS NOT NEW.`expires_at`
			OR length(NEW.`admission_engine_report_received_at`) <> 24
			OR strftime(
				'%Y-%m-%dT%H:%M:%fZ',
				NEW.`admission_engine_report_received_at`
			) IS NOT NEW.`admission_engine_report_received_at`
			OR length(CAST(
				NEW.`admission_engine_version` AS BLOB
			)) NOT BETWEEN 1 AND 64
			OR NEW.`admission_engine_version`
				GLOB '*[^0-9A-Za-z ._+()-]*'
			OR substr(
				NEW.`admission_engine_version`, 1, 1
			) NOT GLOB '[0-9A-Za-z]'
			OR NOT EXISTS (
				SELECT 1
				FROM `runs` run
				INNER JOIN `runner_engine_reports` report
					ON report.`organization_id` = run.`organization_id`
					AND report.`runner_id` = run.`assigned_runner_id`
					AND report.`report_id`
						= NEW.`admission_engine_report_id`
					AND report.`received_at`
						= NEW.`admission_engine_report_received_at`
				INNER JOIN `runner_engine_evidence` evidence
					ON evidence.`runner_id` = report.`runner_id`
					AND evidence.`report_id` = report.`report_id`
					AND evidence.`engine` = run.`engine`
					AND evidence.`status` = 'available'
					AND evidence.`readiness` = 'ready'
					AND evidence.`reason` = 'none'
					AND evidence.`version`
						= NEW.`admission_engine_version`
				WHERE run.`id` = NEW.`run_id`
					AND run.`organization_id` = NEW.`organization_id`
					AND run.`kind` = 'engine_prompt'
					AND run.`engine` = NEW.`admission_engine`
					AND run.`assigned_runner_id` = NEW.`runner_id`
					AND run.`required_capability` IS NULL
					AND report.`received_at` <= NEW.`issued_at`
					AND (
						SELECT COUNT(*)
						FROM `runner_engine_evidence` complete_evidence
						WHERE complete_evidence.`runner_id`
								= report.`runner_id`
							AND complete_evidence.`report_id`
								= report.`report_id`
					) = 2
					AND NOT EXISTS (
						SELECT 1
						FROM `runner_engine_reports` newer
						WHERE newer.`organization_id`
								= NEW.`organization_id`
							AND newer.`runner_id` = NEW.`runner_id`
							AND (
								newer.`received_at` > report.`received_at`
								OR (
									newer.`received_at`
										= report.`received_at`
									AND newer.`report_id` > report.`report_id`
								)
							)
					)
					AND (
						(
							CAST(strftime(
								'%s', NEW.`issued_at`
							) AS INTEGER) * 1000
							+ CAST(substr(
								NEW.`issued_at`, 21, 3
							) AS INTEGER)
						) - (
							CAST(strftime(
								'%s', report.`received_at`
							) AS INTEGER) * 1000
							+ CAST(substr(
								report.`received_at`, 21, 3
							) AS INTEGER)
						)
					) BETWEEN 0
						AND NEW.`admission_freshness_seconds` * 1000
					AND (
						(
							NEW.`admission_policy_source` = 'default'
							AND NEW.`admission_policy_version` = 0
							AND NEW.`admission_freshness_seconds` = 86400
							AND NOT EXISTS (
								SELECT 1
								FROM `runner_admission_policies` policy
								WHERE policy.`organization_id`
									= NEW.`organization_id`
							)
						)
						OR (
							NEW.`admission_policy_source` = 'configured'
							AND EXISTS (
								SELECT 1
								FROM `runner_admission_policies` policy
								INNER JOIN
									`runner_admission_policy_versions` version
									ON version.`organization_id`
										= policy.`organization_id`
									AND version.`version` = policy.`version`
								WHERE policy.`organization_id`
										= NEW.`organization_id`
									AND policy.`version`
										= NEW.`admission_policy_version`
									AND policy.`engine_freshness_seconds`
										= NEW.`admission_freshness_seconds`
									AND version.`engine_freshness_seconds`
										= NEW.`admission_freshness_seconds`
							)
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
		OR NEW.`admission_engine` IS NOT OLD.`admission_engine`
		OR NEW.`admission_engine_report_id`
			IS NOT OLD.`admission_engine_report_id`
		OR NEW.`admission_engine_report_received_at`
			IS NOT OLD.`admission_engine_report_received_at`
		OR NEW.`admission_engine_version`
			IS NOT OLD.`admission_engine_version`
		OR OLD.`status` <> 'active'
		OR NEW.`status` NOT IN ('active', 'superseded', 'released', 'revoked')
		OR NEW.`renew_count` NOT IN (OLD.`renew_count`, OLD.`renew_count` + 1)
		OR NEW.`expires_at` < OLD.`expires_at`
		OR (
			NEW.`admission_basis` = 'engine_inventory'
			AND NOT EXISTS (
				SELECT 1 FROM `runs` run
				WHERE run.`id` = NEW.`run_id`
					AND run.`organization_id` = NEW.`organization_id`
					AND run.`kind` = 'engine_prompt'
					AND run.`engine` = NEW.`admission_engine`
					AND NEW.`expires_at` <= run.`deadline_at`
			)
		)
		OR (
			NEW.`admission_basis` = 'engine_inventory'
			AND NEW.`status` = 'active'
			AND (
				(
					NEW.`renew_count` = OLD.`renew_count`
					AND (
						NEW.`expires_at` <> OLD.`expires_at`
						OR NEW.`renewed_at` IS NOT OLD.`renewed_at`
					)
				)
				OR (
					NEW.`renew_count` = OLD.`renew_count` + 1
					AND (
						NEW.`expires_at` <= OLD.`expires_at`
						OR NEW.`renewed_at` IS NULL
						OR length(NEW.`renewed_at`) <> 24
						OR strftime(
							'%Y-%m-%dT%H:%M:%fZ',
							NEW.`renewed_at`
						) IS NOT NEW.`renewed_at`
						OR NEW.`renewed_at` < NEW.`issued_at`
						OR NEW.`renewed_at` >= NEW.`expires_at`
					)
				)
			)
		)
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
		OR (
			NEW.`ended_reason` = 'deadline_exhausted'
			AND (
				NEW.`status` <> 'revoked'
				OR NOT EXISTS (
					SELECT 1
					FROM `run_deadline_operations` operation
					WHERE operation.`run_id` = NEW.`run_id`
						AND operation.`organization_id`
							= NEW.`organization_id`
						AND operation.`lease_id` = NEW.`id`
						AND operation.`fence` = NEW.`fence`
						AND operation.`applied_at` = NEW.`ended_at`
						AND operation.`reason`
							= 'engine_deadline_exhausted'
				)
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
			NEW.`kind` = 'run.completed'
			AND NOT EXISTS (
				SELECT 1 FROM `runs` run
				WHERE run.`id` = NEW.`run_id`
					AND run.`organization_id` = NEW.`organization_id`
					AND run.`kind` = 'diagnostic'
					AND run.`engine` IS NULL
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
						AND run.`kind` = 'diagnostic'
						AND run.`engine` IS NULL
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
END;--> statement-breakpoint

CREATE TRIGGER `ledger_entries_validate_run_expired`
BEFORE INSERT ON `ledger_entries`
WHEN NEW.`kind` = 'run.expired'
BEGIN
	SELECT CASE WHEN
		NEW.`intent_id` IS NOT NULL
		OR NEW.`run_id` IS NULL
		OR length(NEW.`payload_hash`) <> 64
		OR NEW.`payload_hash` GLOB '*[^0-9a-f]*'
		OR NOT EXISTS (
			SELECT 1
			FROM `runs` run
			INNER JOIN `run_deadline_operations` operation
				ON operation.`run_id` = run.`id`
				AND operation.`organization_id` = run.`organization_id`
			INNER JOIN `organization_system_principals` mapping
				ON mapping.`organization_id` = run.`organization_id`
				AND mapping.`purpose` = 'deadline_reconciler'
				AND mapping.`principal_id` = operation.`actor_id`
			INNER JOIN `principals` principal
				ON principal.`id` = mapping.`principal_id`
				AND principal.`organization_id` = mapping.`organization_id`
			INNER JOIN `run_events` event
				ON event.`run_id` = run.`id`
				AND event.`organization_id` = run.`organization_id`
				AND event.`kind` = 'run.expired'
				AND event.`actor_id` = operation.`actor_id`
				AND event.`occurred_at` = operation.`applied_at`
			WHERE run.`id` = NEW.`run_id`
				AND run.`organization_id` = NEW.`organization_id`
				AND run.`kind` = 'engine_prompt'
				AND run.`status` = 'expired'
				AND run.`recorded_at` = operation.`applied_at`
				AND operation.`actor_id` = NEW.`actor_id`
				AND operation.`applied_at` = NEW.`occurred_at`
				AND operation.`reason` = 'engine_deadline_exhausted'
				AND principal.`kind` = 'automation'
				AND principal.`external_id`
					= 'system:deadline-reconciler:v1'
				AND principal.`status` = 'active'
				AND NEW.`payload_ref` = 'nexus://runs/' || run.`id`
				AND json_extract(
					event.`metadata_json`, '$.operationId'
				) = operation.`operation_id`
				AND json_extract(
					event.`metadata_json`, '$.deadlineAt'
				) = operation.`deadline_at`
				AND json_extract(
					event.`metadata_json`, '$.reason'
				) = operation.`reason`
		)
	THEN RAISE(ABORT, 'invalid_run_expired_ledger_event') END;

	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM `ledger_entries` existing
		WHERE existing.`organization_id` = NEW.`organization_id`
			AND existing.`payload_ref` = NEW.`payload_ref`
			AND existing.`kind` = NEW.`kind`
	)
	THEN RAISE(ABORT, 'duplicate_run_expired_ledger_event') END;
END;
