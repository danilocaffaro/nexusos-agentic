CREATE TABLE `runner_admission_policies` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`capability_freshness_seconds` integer NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runner_admission_policies_version_check" CHECK("runner_admission_policies"."version" >= 1),
	CONSTRAINT "runner_admission_policies_freshness_check" CHECK("runner_admission_policies"."capability_freshness_seconds" BETWEEN 3600 AND 2592000)
);
--> statement-breakpoint
CREATE TABLE `runner_admission_policy_capabilities` (
	`organization_id` text NOT NULL,
	`version` integer NOT NULL,
	`capability` text NOT NULL,
	PRIMARY KEY(`organization_id`, `version`, `capability`),
	FOREIGN KEY (`organization_id`,`version`) REFERENCES `runner_admission_policy_versions`(`organization_id`,`version`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runner_admission_policy_capabilities_name_check" CHECK("runner_admission_policy_capabilities"."capability" IN (
        'node_permission_model', 'bubblewrap', 'landlock', 'seccomp',
        'user_namespace', 'docker', 'podman'
      ))
);
--> statement-breakpoint
CREATE TABLE `runner_admission_policy_versions` (
	`organization_id` text NOT NULL,
	`version` integer NOT NULL,
	`capability_freshness_seconds` integer NOT NULL,
	`updated_by` text NOT NULL,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`organization_id`, `version`),
	FOREIGN KEY (`updated_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `runner_admission_policies`(`organization_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runner_admission_policy_versions_version_check" CHECK("runner_admission_policy_versions"."version" >= 1),
	CONSTRAINT "runner_admission_policy_versions_freshness_check" CHECK("runner_admission_policy_versions"."capability_freshness_seconds" BETWEEN 3600 AND 2592000)
);--> statement-breakpoint
CREATE TRIGGER `runner_admission_policies_validate_before_insert`
BEFORE INSERT ON `runner_admission_policies`
BEGIN
	SELECT CASE WHEN
		NEW.`version` <> 1
		OR NEW.`capability_freshness_seconds` NOT BETWEEN 3600 AND 2592000
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
CREATE TRIGGER `runner_admission_policies_validate_before_update`
BEFORE UPDATE ON `runner_admission_policies`
BEGIN
	SELECT CASE WHEN
		NEW.`organization_id` <> OLD.`organization_id`
		OR NEW.`created_at` <> OLD.`created_at`
		OR NEW.`version` <> OLD.`version` + 1
		OR NEW.`capability_freshness_seconds` NOT BETWEEN 3600 AND 2592000
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
CREATE TRIGGER `runner_admission_policies_prevent_delete`
BEFORE DELETE ON `runner_admission_policies`
BEGIN
	SELECT RAISE(ABORT, 'runner_admission_policy_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `runner_admission_policy_versions_validate_before_insert`
BEFORE INSERT ON `runner_admission_policy_versions`
BEGIN
	SELECT CASE WHEN
		NEW.`version` < 1
		OR NEW.`capability_freshness_seconds` NOT BETWEEN 3600 AND 2592000
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
				AND policy.`updated_by` = NEW.`updated_by`
				AND policy.`updated_at` = NEW.`recorded_at`
		)
	THEN RAISE(ABORT, 'invalid_runner_admission_policy_version') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_admission_policy_versions_prevent_update`
BEFORE UPDATE ON `runner_admission_policy_versions`
BEGIN
	SELECT RAISE(ABORT, 'runner_admission_policy_version_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `runner_admission_policy_versions_prevent_delete`
BEFORE DELETE ON `runner_admission_policy_versions`
BEGIN
	SELECT RAISE(ABORT, 'runner_admission_policy_version_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `runner_admission_policy_capabilities_validate_before_insert`
BEFORE INSERT ON `runner_admission_policy_capabilities`
BEGIN
	SELECT CASE WHEN
		NEW.`capability` NOT IN (
			'node_permission_model', 'bubblewrap', 'landlock', 'seccomp',
			'user_namespace', 'docker', 'podman'
		)
		OR NOT EXISTS (
			SELECT 1
			FROM `runner_admission_policies` policy
			INNER JOIN `runner_admission_policy_versions` version
				ON version.`organization_id` = policy.`organization_id`
				AND version.`version` = policy.`version`
			WHERE policy.`organization_id` = NEW.`organization_id`
				AND policy.`version` = NEW.`version`
		)
		OR EXISTS (
			SELECT 1 FROM `ledger_entries` ledger
			WHERE ledger.`organization_id` = NEW.`organization_id`
				AND ledger.`kind` = 'runner_policy.updated'
				AND ledger.`payload_ref` =
					'nexus://runner-admission-policies/' ||
					NEW.`organization_id` || '#v' || NEW.`version`
		)
	THEN RAISE(ABORT, 'invalid_runner_admission_policy_capability') END;
END;--> statement-breakpoint
CREATE TRIGGER `runner_admission_policy_capabilities_prevent_update`
BEFORE UPDATE ON `runner_admission_policy_capabilities`
BEGIN
	SELECT RAISE(ABORT, 'runner_admission_policy_capability_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `runner_admission_policy_capabilities_prevent_delete`
BEFORE DELETE ON `runner_admission_policy_capabilities`
BEGIN
	SELECT RAISE(ABORT, 'runner_admission_policy_capability_is_immutable');
END;--> statement-breakpoint
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
