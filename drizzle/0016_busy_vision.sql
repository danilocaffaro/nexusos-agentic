CREATE TABLE `runner_enrollment_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`issued_by` text NOT NULL,
	`display_name` text NOT NULL,
	`issued_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`revoked_by` text,
	`consumed_at` text,
	`consumed_runner_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issued_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_enrollment_tokens_hash_uidx` ON `runner_enrollment_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `runner_enrollment_tokens_org_created_idx` ON `runner_enrollment_tokens` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `runner_heartbeat_nonces` (
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
CREATE INDEX `runner_heartbeat_nonces_expires_idx` ON `runner_heartbeat_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `runners` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`enrollment_token_id` text NOT NULL,
	`display_name` text NOT NULL,
	`public_key` text NOT NULL,
	`trust_profile` text DEFAULT 'operator_trust' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`enrolled_at` text NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	`revoked_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`enrollment_token_id`) REFERENCES `runner_enrollment_tokens`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runners_principal_uidx` ON `runners` (`principal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runners_enrollment_token_uidx` ON `runners` (`enrollment_token_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runners_org_public_key_uidx` ON `runners` (`organization_id`,`public_key`);--> statement-breakpoint
CREATE INDEX `runners_org_status_last_seen_idx` ON `runners` (`organization_id`,`status`,`last_seen_at`);--> statement-breakpoint
CREATE TRIGGER `runner_enrollment_tokens_validate_before_insert`
BEFORE INSERT ON `runner_enrollment_tokens`
BEGIN
	SELECT CASE WHEN
		length(NEW.`token_hash`) <> 64
		OR NEW.`token_hash` GLOB '*[^0-9a-f]*'
		OR length(trim(NEW.`display_name`)) NOT BETWEEN 1 AND 120
		OR NEW.`expires_at` <= NEW.`issued_at`
		OR NEW.`revoked_at` IS NOT NULL
		OR NEW.`revoked_by` IS NOT NULL
		OR NEW.`consumed_at` IS NOT NULL
		OR NEW.`consumed_runner_id` IS NOT NULL
		OR NOT EXISTS (
			SELECT 1
			FROM `principals` principal
			JOIN `memberships` membership
			  ON membership.`organization_id` = principal.`organization_id`
			 AND membership.`principal_id` = principal.`id`
			WHERE principal.`id` = NEW.`issued_by`
			  AND principal.`organization_id` = NEW.`organization_id`
			  AND principal.`kind` = 'human'
			  AND principal.`status` = 'active'
			  AND membership.`status` = 'active'
			  AND membership.`role` IN ('owner', 'admin')
		)
	THEN RAISE(ABORT, 'invalid_runner_enrollment_token') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_enrollment_tokens_validate_before_update`
BEFORE UPDATE ON `runner_enrollment_tokens`
BEGIN
	SELECT CASE WHEN
		NEW.`id` <> OLD.`id`
		OR NEW.`organization_id` <> OLD.`organization_id`
		OR NEW.`token_hash` <> OLD.`token_hash`
		OR NEW.`issued_by` <> OLD.`issued_by`
		OR NEW.`display_name` <> OLD.`display_name`
		OR NEW.`issued_at` <> OLD.`issued_at`
		OR NEW.`expires_at` <> OLD.`expires_at`
		OR NEW.`created_at` <> OLD.`created_at`
		OR (OLD.`revoked_at` IS NOT NULL AND (
			NEW.`revoked_at` IS NOT OLD.`revoked_at`
			OR NEW.`revoked_by` IS NOT OLD.`revoked_by`
		))
		OR (OLD.`consumed_at` IS NOT NULL AND (
			NEW.`consumed_at` IS NOT OLD.`consumed_at`
			OR NEW.`consumed_runner_id` IS NOT OLD.`consumed_runner_id`
		))
		OR ((NEW.`revoked_at` IS NULL) <> (NEW.`revoked_by` IS NULL))
		OR ((NEW.`consumed_at` IS NULL) <> (NEW.`consumed_runner_id` IS NULL))
		OR (NEW.`revoked_at` IS NOT NULL AND NEW.`consumed_at` IS NOT NULL)
		OR (
			OLD.`revoked_at` IS NULL
			AND NEW.`revoked_at` IS NOT NULL
			AND NOT EXISTS (
				SELECT 1
				FROM `principals` principal
				JOIN `memberships` membership
				  ON membership.`organization_id` = principal.`organization_id`
				 AND membership.`principal_id` = principal.`id`
				WHERE principal.`id` = NEW.`revoked_by`
				  AND principal.`organization_id` = NEW.`organization_id`
				  AND principal.`kind` = 'human'
				  AND principal.`status` = 'active'
				  AND membership.`status` = 'active'
				  AND membership.`role` IN ('owner', 'admin')
			)
		)
		OR (
			NEW.`consumed_runner_id` IS NOT NULL
			AND NOT EXISTS (
				SELECT 1 FROM `runners` runner
				WHERE runner.`id` = NEW.`consumed_runner_id`
				  AND runner.`organization_id` = NEW.`organization_id`
				  AND runner.`enrollment_token_id` = NEW.`id`
			)
		)
	THEN RAISE(ABORT, 'invalid_runner_enrollment_token_transition') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_enrollment_tokens_prevent_delete`
BEFORE DELETE ON `runner_enrollment_tokens`
BEGIN
	SELECT RAISE(ABORT, 'runner_enrollment_token_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `runners_validate_before_insert`
BEFORE INSERT ON `runners`
BEGIN
	SELECT CASE WHEN
		length(trim(NEW.`display_name`)) NOT BETWEEN 1 AND 120
		OR length(NEW.`public_key`) <> 43
		OR NEW.`public_key` GLOB '*[^A-Za-z0-9_-]*'
		OR NEW.`trust_profile` <> 'operator_trust'
		OR NEW.`status` <> 'active'
		OR NEW.`last_seen_at` IS NOT NULL
		OR NEW.`revoked_at` IS NOT NULL
		OR NEW.`revoked_by` IS NOT NULL
		OR NOT EXISTS (
			SELECT 1 FROM `principals` principal
			WHERE principal.`id` = NEW.`principal_id`
			  AND principal.`organization_id` = NEW.`organization_id`
			  AND principal.`kind` = 'runner'
			  AND principal.`status` = 'active'
			  AND principal.`external_id` = NEW.`id`
		)
		OR NOT EXISTS (
			SELECT 1 FROM `runner_enrollment_tokens` token
			WHERE token.`id` = NEW.`enrollment_token_id`
			  AND token.`organization_id` = NEW.`organization_id`
			  AND token.`revoked_at` IS NULL
			  AND (
				token.`consumed_runner_id` IS NULL
				OR token.`consumed_runner_id` = NEW.`id`
			  )
		)
	THEN RAISE(ABORT, 'invalid_runner') END;
END;--> statement-breakpoint
CREATE TRIGGER `runners_validate_before_update`
BEFORE UPDATE ON `runners`
BEGIN
	SELECT CASE WHEN
		NEW.`id` <> OLD.`id`
		OR NEW.`organization_id` <> OLD.`organization_id`
		OR NEW.`principal_id` <> OLD.`principal_id`
		OR NEW.`enrollment_token_id` <> OLD.`enrollment_token_id`
		OR NEW.`display_name` <> OLD.`display_name`
		OR NEW.`public_key` <> OLD.`public_key`
		OR NEW.`trust_profile` <> OLD.`trust_profile`
		OR NEW.`enrolled_at` <> OLD.`enrolled_at`
		OR NEW.`created_at` <> OLD.`created_at`
		OR NEW.`status` NOT IN ('active', 'revoked')
		OR (OLD.`status` = 'revoked' AND NEW.`status` <> 'revoked')
		OR (NEW.`last_seen_at` IS NOT NULL AND (
			OLD.`last_seen_at` IS NOT NULL
			AND NEW.`last_seen_at` < OLD.`last_seen_at`
		))
		OR ((NEW.`revoked_at` IS NULL) <> (NEW.`revoked_by` IS NULL))
		OR (
			NEW.`status` = 'active'
			AND (NEW.`revoked_at` IS NOT NULL OR NEW.`revoked_by` IS NOT NULL)
		)
		OR (
			NEW.`status` = 'revoked'
			AND (
				NEW.`revoked_at` IS NULL
				OR NEW.`revoked_by` IS NULL
				OR NOT EXISTS (
					SELECT 1
					FROM `principals` principal
					JOIN `memberships` membership
					  ON membership.`organization_id` = principal.`organization_id`
					 AND membership.`principal_id` = principal.`id`
					WHERE principal.`id` = NEW.`revoked_by`
					  AND principal.`organization_id` = NEW.`organization_id`
					  AND principal.`kind` = 'human'
					  AND principal.`status` = 'active'
					  AND membership.`status` = 'active'
					  AND membership.`role` IN ('owner', 'admin')
				)
			)
		)
		OR (
			NEW.`status` = 'revoked'
			AND NOT EXISTS (
				SELECT 1 FROM `principals` principal
				WHERE principal.`id` = NEW.`principal_id`
				  AND principal.`organization_id` = NEW.`organization_id`
				  AND principal.`kind` = 'runner'
				  AND principal.`status` = 'disabled'
			)
		)
	THEN RAISE(ABORT, 'invalid_runner_transition') END;
END;--> statement-breakpoint
CREATE TRIGGER `runners_prevent_delete`
BEFORE DELETE ON `runners`
BEGIN
	SELECT RAISE(ABORT, 'runner_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `runner_heartbeat_nonces_validate_before_insert`
BEFORE INSERT ON `runner_heartbeat_nonces`
BEGIN
	SELECT CASE WHEN
		length(NEW.`nonce`) <> 22
		OR NEW.`nonce` GLOB '*[^A-Za-z0-9_-]*'
		OR length(NEW.`request_hash`) <> 64
		OR NEW.`request_hash` GLOB '*[^0-9a-f]*'
		OR NEW.`response_status` <> 200
		OR length(CAST(NEW.`response_body` AS BLOB)) > 1024
		OR NEW.`expires_at` <= NEW.`occurred_at`
		OR NOT EXISTS (
			SELECT 1
			FROM `runners` runner
			JOIN `principals` principal
			  ON principal.`id` = runner.`principal_id`
			 AND principal.`organization_id` = runner.`organization_id`
			WHERE runner.`id` = NEW.`runner_id`
			  AND runner.`organization_id` = NEW.`organization_id`
			  AND runner.`status` = 'active'
			  AND principal.`kind` = 'runner'
			  AND principal.`status` = 'active'
		)
	THEN RAISE(ABORT, 'invalid_runner_heartbeat_nonce') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_heartbeat_nonces_prevent_update`
BEFORE UPDATE ON `runner_heartbeat_nonces`
BEGIN
	SELECT RAISE(ABORT, 'runner_heartbeat_nonce_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ledger_entries_validate_runner_event`
BEFORE INSERT ON `ledger_entries`
WHEN NEW.`kind` IN (
	'runner_token.issued', 'runner_token.revoked',
	'runner.enrolled', 'runner.revoked'
)
BEGIN
	SELECT CASE WHEN
		NEW.`intent_id` IS NOT NULL
		OR NEW.`run_id` IS NOT NULL
		OR length(NEW.`payload_hash`) <> 64
		OR NEW.`payload_hash` GLOB '*[^0-9a-f]*'
		OR NOT (
			(
				NEW.`kind` = 'runner_token.issued'
				AND EXISTS (
					SELECT 1 FROM `runner_enrollment_tokens` token
					WHERE token.`organization_id` = NEW.`organization_id`
					  AND NEW.`payload_ref` =
						'nexus://runner-enrollment-tokens/' || token.`id`
					  AND token.`issued_by` = NEW.`actor_id`
					  AND token.`issued_at` = NEW.`occurred_at`
				)
			)
			OR (
				NEW.`kind` = 'runner_token.revoked'
				AND EXISTS (
					SELECT 1 FROM `runner_enrollment_tokens` token
					WHERE token.`organization_id` = NEW.`organization_id`
					  AND NEW.`payload_ref` =
						'nexus://runner-enrollment-tokens/' || token.`id`
					  AND token.`revoked_by` = NEW.`actor_id`
					  AND token.`revoked_at` = NEW.`occurred_at`
				)
			)
			OR (
				NEW.`kind` = 'runner.enrolled'
				AND EXISTS (
					SELECT 1 FROM `runners` runner
					JOIN `runner_enrollment_tokens` token
					  ON token.`id` = runner.`enrollment_token_id`
					 AND token.`consumed_runner_id` = runner.`id`
					WHERE runner.`organization_id` = NEW.`organization_id`
					  AND NEW.`payload_ref` =
						'nexus://runners/' || runner.`id`
					  AND runner.`principal_id` = NEW.`actor_id`
					  AND runner.`enrolled_at` = NEW.`occurred_at`
				)
			)
			OR (
				NEW.`kind` = 'runner.revoked'
				AND EXISTS (
					SELECT 1 FROM `runners` runner
					WHERE runner.`organization_id` = NEW.`organization_id`
					  AND NEW.`payload_ref` =
						'nexus://runners/' || runner.`id`
					  AND runner.`revoked_by` = NEW.`actor_id`
					  AND runner.`revoked_at` = NEW.`occurred_at`
				)
			)
		)
	THEN RAISE(ABORT, 'invalid_runner_ledger_event') END;

	SELECT CASE WHEN EXISTS (
		SELECT 1 FROM `ledger_entries` existing
		WHERE existing.`organization_id` = NEW.`organization_id`
		  AND existing.`payload_ref` = NEW.`payload_ref`
		  AND existing.`kind` = NEW.`kind`
	)
	THEN RAISE(ABORT, 'duplicate_runner_ledger_event') END;
END;
