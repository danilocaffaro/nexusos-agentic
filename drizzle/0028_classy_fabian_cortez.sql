CREATE TABLE `engine_run_creations` (
	`organization_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`creation_id` text NOT NULL,
	`request_hash` text,
	`state` text NOT NULL,
	`run_id` text,
	`reconciliation_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`retain_until` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`requested_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "engine_run_creations_creation_id_check" CHECK(length("engine_run_creations"."creation_id") = 36
        AND substr("engine_run_creations"."creation_id", 1, 4) = 'ecr_'
        AND substr("engine_run_creations"."creation_id", 5) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "engine_run_creations_state_check" CHECK((
        "engine_run_creations"."state" = 'created'
        AND "engine_run_creations"."request_hash" IS NOT NULL
        AND length("engine_run_creations"."request_hash") = 64
        AND "engine_run_creations"."request_hash" NOT GLOB '*[^0-9a-f]*'
        AND "engine_run_creations"."run_id" IS NOT NULL
        AND "engine_run_creations"."reconciliation_id" IS NULL
      ) OR (
        "engine_run_creations"."state" = 'confirmed_not_created'
        AND "engine_run_creations"."request_hash" IS NULL
        AND "engine_run_creations"."run_id" IS NULL
        AND "engine_run_creations"."reconciliation_id" IS NOT NULL
        AND length("engine_run_creations"."reconciliation_id") = 36
        AND substr("engine_run_creations"."reconciliation_id", 1, 4) = 'ncp_'
        AND substr("engine_run_creations"."reconciliation_id", 5)
          NOT GLOB '*[^0-9a-f]*'
      )),
	CONSTRAINT "engine_run_creations_retention_check" CHECK("engine_run_creations"."created_at" = "engine_run_creations"."updated_at"
        AND julianday("engine_run_creations"."created_at") IS NOT NULL
        AND julianday("engine_run_creations"."retain_until") IS NOT NULL
        AND julianday("engine_run_creations"."retain_until")
          >= julianday("engine_run_creations"."created_at") + 30)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `engine_run_creations_org_requester_creation_uidx` ON `engine_run_creations` (`organization_id`,`requested_by`,`creation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `engine_run_creations_org_run_uidx` ON `engine_run_creations` (`organization_id`,`run_id`) WHERE "engine_run_creations"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `engine_run_creations_org_reconciliation_uidx` ON `engine_run_creations` (`organization_id`,`reconciliation_id`) WHERE "engine_run_creations"."reconciliation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `engine_run_creations_retention_idx` ON `engine_run_creations` (`state`,`retain_until`,`creation_id`);--> statement-breakpoint
CREATE TRIGGER `engine_run_creations_validate_before_insert`
BEFORE INSERT ON `engine_run_creations`
BEGIN
	SELECT CASE WHEN
		NOT EXISTS (
			SELECT 1
			FROM `principals` principal
			INNER JOIN `memberships` membership
				ON membership.`organization_id` = principal.`organization_id`
				AND membership.`principal_id` = principal.`id`
			WHERE principal.`id` = NEW.`requested_by`
				AND principal.`organization_id` = NEW.`organization_id`
				AND principal.`kind` = 'human'
				AND principal.`status` = 'active'
				AND membership.`role` IN ('owner', 'admin')
				AND membership.`status` = 'active'
		)
		OR (
			NEW.`state` = 'created'
			AND NOT EXISTS (
				SELECT 1
				FROM `runs` run
				WHERE run.`id` = NEW.`run_id`
					AND run.`organization_id` = NEW.`organization_id`
					AND run.`requested_by` = NEW.`requested_by`
					AND run.`kind` = 'engine_prompt'
					AND run.`engine` IS NOT NULL
					AND run.`status` = 'queued'
					AND run.`created_at` = NEW.`created_at`
			)
		)
	THEN RAISE(ABORT, 'invalid_engine_run_creation') END;
END;--> statement-breakpoint
CREATE TRIGGER `engine_run_creations_prevent_update`
BEFORE UPDATE ON `engine_run_creations`
BEGIN
	SELECT RAISE(ABORT, 'immutable_engine_run_creation');
END;--> statement-breakpoint
-- Created resolutions live with their immutable run. Only
-- confirmed_not_created proofs may be collected, never before 30 days.
CREATE TRIGGER `engine_run_creations_restrict_delete`
BEFORE DELETE ON `engine_run_creations`
WHEN OLD.`state` = 'created'
	OR julianday(OLD.`retain_until`) > julianday('now')
BEGIN
	SELECT RAISE(ABORT, 'immutable_engine_run_creation');
END;
