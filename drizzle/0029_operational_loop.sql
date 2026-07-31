CREATE TABLE `operation_publications` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`artifact_version_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`stdout_truncated` integer NOT NULL,
	`published_by` text NOT NULL,
	`published_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`artifact_version_id`) REFERENCES `artifact_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`published_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "operation_publications_hash_check" CHECK(length("operation_publications"."content_hash") = 64
        AND "operation_publications"."content_hash" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operation_publications_org_artifact_uidx` ON `operation_publications` (`organization_id`,`artifact_id`);--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`request_hash` text NOT NULL,
	`project_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`assigned_runner_id` text NOT NULL,
	`engine` text NOT NULL,
	`run_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`agent_role` text NOT NULL,
	`agent_model` text NOT NULL,
	`work_item_ref` text NOT NULL,
	`work_item_title` text NOT NULL,
	`work_item_description` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`requested_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assigned_runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "operations_id_check" CHECK(length("operations"."id") = 36
        AND substr("operations"."id", 1, 4) = 'opr_'
        AND substr("operations"."id", 5) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "operations_hash_check" CHECK(length("operations"."request_hash") = 64
        AND "operations"."request_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "operations_engine_check" CHECK("operations"."engine" IN ('claude_code_cli', 'codex_cli'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operations_org_requester_id_uidx` ON `operations` (`organization_id`,`requested_by`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `operations_org_run_uidx` ON `operations` (`organization_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `operations_org_created_idx` ON `operations` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TRIGGER `operations_validate_before_insert`
BEFORE INSERT ON `operations`
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
				AND membership.`role` = 'owner'
				AND membership.`status` = 'active'
		)
		OR NOT EXISTS (
			SELECT 1 FROM `projects` project
			WHERE project.`id` = NEW.`project_id`
				AND project.`organization_id` = NEW.`organization_id`
				AND project.`status` = 'active'
		)
		OR NOT EXISTS (
			SELECT 1 FROM `work_items` work_item
			WHERE work_item.`id` = NEW.`work_item_id`
				AND work_item.`organization_id` = NEW.`organization_id`
				AND work_item.`project_id` = NEW.`project_id`
				AND work_item.`status` NOT IN ('done', 'cancelled')
				AND work_item.`ref` = NEW.`work_item_ref`
				AND work_item.`title` = NEW.`work_item_title`
				AND work_item.`description` = NEW.`work_item_description`
		)
		OR NOT EXISTS (
			SELECT 1
			FROM `agent_definitions` agent
			INNER JOIN `principals` principal
				ON principal.`id` = agent.`principal_id`
				AND principal.`organization_id` = agent.`organization_id`
			WHERE agent.`id` = NEW.`agent_id`
				AND agent.`organization_id` = NEW.`organization_id`
				AND agent.`status` = 'active'
				AND principal.`kind` = 'agent'
				AND principal.`status` = 'active'
				AND agent.`name` = NEW.`agent_name`
				AND agent.`role` = NEW.`agent_role`
				AND agent.`model` = NEW.`agent_model`
				AND EXISTS (
					SELECT 1
					FROM `team_members` assignment
					INNER JOIN `teams` team
						ON team.`id` = assignment.`team_id`
						AND team.`organization_id` = assignment.`organization_id`
					WHERE assignment.`organization_id` = NEW.`organization_id`
						AND assignment.`principal_id` = agent.`principal_id`
						AND assignment.`status` = 'active'
						AND team.`project_id` = NEW.`project_id`
						AND team.`status` = 'active'
				)
		)
		OR NOT EXISTS (
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
		OR NOT EXISTS (
			SELECT 1 FROM `runs` run
			WHERE run.`id` = NEW.`run_id`
				AND run.`organization_id` = NEW.`organization_id`
				AND run.`requested_by` = NEW.`requested_by`
				AND run.`kind` = 'engine_prompt'
				AND run.`status` = 'queued'
				AND run.`engine` = NEW.`engine`
				AND run.`assigned_runner_id` = NEW.`assigned_runner_id`
				AND run.`created_at` = NEW.`created_at`
		)
	THEN RAISE(ABORT, 'invalid_operation_binding') END;
END;--> statement-breakpoint
CREATE TRIGGER `operations_prevent_update`
BEFORE UPDATE ON `operations`
BEGIN
	SELECT RAISE(ABORT, 'immutable_operation_binding');
END;--> statement-breakpoint
CREATE TRIGGER `operations_prevent_delete`
BEFORE DELETE ON `operations`
BEGIN
	SELECT RAISE(ABORT, 'immutable_operation_binding');
END;--> statement-breakpoint
CREATE TRIGGER `operation_publications_validate_before_insert`
BEFORE INSERT ON `operation_publications`
BEGIN
	SELECT CASE WHEN
		NOT EXISTS (
			SELECT 1
			FROM `operations` operation
			INNER JOIN `runs` run
				ON run.`id` = operation.`run_id`
				AND run.`organization_id` = operation.`organization_id`
			INNER JOIN `run_engine_receipts` receipt
				ON receipt.`run_id` = run.`id`
				AND receipt.`organization_id` = run.`organization_id`
			INNER JOIN `run_engine_excerpts` excerpt
				ON excerpt.`run_id` = run.`id`
				AND excerpt.`organization_id` = run.`organization_id`
				AND excerpt.`excerpt_ref` = receipt.`excerpt_ref`
			WHERE operation.`id` = NEW.`operation_id`
				AND operation.`organization_id` = NEW.`organization_id`
				AND run.`status` = 'completed'
				AND run.`outcome_status` = 'succeeded'
				AND receipt.`status` = 'succeeded'
				AND receipt.`reason` = 'none'
				AND receipt.`stdout_bytes` > 0
				AND excerpt.`erased_at` IS NULL
				AND NEW.`stdout_truncated` = receipt.`stdout_truncated`
		)
		OR NOT EXISTS (
			SELECT 1
			FROM `operations` operation
			INNER JOIN `artifacts` artifact
				ON artifact.`id` = NEW.`artifact_id`
				AND artifact.`organization_id` = operation.`organization_id`
				AND artifact.`project_id` = operation.`project_id`
				AND artifact.`work_item_id` = operation.`work_item_id`
				AND artifact.`media_type` = 'text/markdown'
				AND artifact.`current_version` = 1
				AND artifact.`created_by` = NEW.`published_by`
			INNER JOIN `artifact_versions` version
				ON version.`id` = NEW.`artifact_version_id`
				AND version.`organization_id` = operation.`organization_id`
				AND version.`artifact_id` = artifact.`id`
				AND version.`version_number` = 1
				AND version.`content_hash` = NEW.`content_hash`
				AND version.`created_by` = NEW.`published_by`
			INNER JOIN `artifact_payloads` payload
				ON payload.`id` = version.`content_ref`
				AND payload.`organization_id` = operation.`organization_id`
				AND payload.`content_hash` = NEW.`content_hash`
				AND payload.`erased_at` IS NULL
			INNER JOIN `principals` principal
				ON principal.`id` = NEW.`published_by`
				AND principal.`organization_id` = operation.`organization_id`
				AND principal.`kind` = 'human'
				AND principal.`status` = 'active'
			INNER JOIN `memberships` membership
				ON membership.`organization_id` = operation.`organization_id`
				AND membership.`principal_id` = principal.`id`
				AND membership.`role` = 'owner'
				AND membership.`status` = 'active'
			WHERE operation.`id` = NEW.`operation_id`
				AND operation.`organization_id` = NEW.`organization_id`
		)
	THEN RAISE(ABORT, 'invalid_operation_publication') END;
END;--> statement-breakpoint
CREATE TRIGGER `operation_publications_prevent_update`
BEFORE UPDATE ON `operation_publications`
BEGIN
	SELECT RAISE(ABORT, 'immutable_operation_publication');
END;--> statement-breakpoint
CREATE TRIGGER `operation_publications_prevent_delete`
BEFORE DELETE ON `operation_publications`
BEGIN
	SELECT RAISE(ABORT, 'immutable_operation_publication');
END;
