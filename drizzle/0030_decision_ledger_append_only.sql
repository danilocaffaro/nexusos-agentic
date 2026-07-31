CREATE TRIGGER `ledger_entries_prevent_replace`
BEFORE INSERT ON `ledger_entries`
WHEN EXISTS (
	SELECT 1
	FROM `ledger_entries` existing
	WHERE existing.`id` = NEW.`id`
		OR (
			existing.`organization_id` = NEW.`organization_id`
			AND existing.`sequence` = NEW.`sequence`
		)
		OR (
			existing.`organization_id` = NEW.`organization_id`
			AND existing.`hash` = NEW.`hash`
		)
)
BEGIN
	SELECT CASE
		WHEN EXISTS (
			SELECT 1
			FROM `ledger_entries` existing
			WHERE existing.`organization_id` = NEW.`organization_id`
				AND existing.`sequence` = NEW.`sequence`
		)
		THEN RAISE(
			ABORT,
			'UNIQUE constraint failed: ledger_entries.organization_id, ledger_entries.sequence'
		)
		ELSE RAISE(ABORT, 'ledger_entry_is_immutable')
	END;
END;--> statement-breakpoint
CREATE TRIGGER `ledger_entries_prevent_update`
BEFORE UPDATE ON `ledger_entries`
BEGIN
	SELECT RAISE(ABORT, 'ledger_entry_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `ledger_entries_prevent_delete`
BEFORE DELETE ON `ledger_entries`
BEGIN
	SELECT RAISE(ABORT, 'ledger_entry_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `intent_approvals_prevent_replace`
BEFORE INSERT ON `intent_approvals`
WHEN EXISTS (
	SELECT 1
	FROM `intent_approvals` existing
	WHERE existing.`id` = NEW.`id`
		OR (
			existing.`intent_id` = NEW.`intent_id`
			AND existing.`actor_id` = NEW.`actor_id`
		)
)
BEGIN
	SELECT RAISE(
		ABORT,
		'UNIQUE constraint failed: intent_approvals.intent_id, intent_approvals.actor_id'
	);
END;--> statement-breakpoint
CREATE TRIGGER `intent_approvals_prevent_update`
BEFORE UPDATE ON `intent_approvals`
BEGIN
	SELECT RAISE(ABORT, 'intent_approval_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `intent_approvals_prevent_delete`
BEFORE DELETE ON `intent_approvals`
BEGIN
	SELECT RAISE(ABORT, 'intent_approval_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `action_intents_restrict_update`
BEFORE UPDATE ON `action_intents`
BEGIN
	SELECT CASE
		WHEN
			NEW.`id` IS NOT OLD.`id`
			OR NEW.`organization_id` IS NOT OLD.`organization_id`
			OR NEW.`project_id` IS NOT OLD.`project_id`
			OR NEW.`proposer_id` IS NOT OLD.`proposer_id`
			OR NEW.`proposer_kind` IS NOT OLD.`proposer_kind`
			OR NEW.`action_type` IS NOT OLD.`action_type`
			OR NEW.`target_ref` IS NOT OLD.`target_ref`
			OR NEW.`parameters_json` IS NOT OLD.`parameters_json`
			OR NEW.`parameters_hash` IS NOT OLD.`parameters_hash`
			OR NEW.`preconditions_json` IS NOT OLD.`preconditions_json`
			OR NEW.`risk_tier` IS NOT OLD.`risk_tier`
			OR NEW.`policy_decision_json` IS NOT OLD.`policy_decision_json`
			OR NEW.`required_approvals` IS NOT OLD.`required_approvals`
			OR NEW.`separation_of_duties` IS NOT OLD.`separation_of_duties`
			OR NEW.`self_approval_policy` IS NOT OLD.`self_approval_policy`
			OR NEW.`expires_at` IS NOT OLD.`expires_at`
			OR NEW.`idempotency_key` IS NOT OLD.`idempotency_key`
			OR NEW.`supersedes_intent_id` IS NOT OLD.`supersedes_intent_id`
			OR NEW.`created_at` IS NOT OLD.`created_at`
		THEN RAISE(ABORT, 'action_intent_decision_is_immutable')
		WHEN NOT (
			(
				(
					OLD.`status` = 'proposed'
					AND NEW.`status` IN ('proposed', 'approved')
				)
				OR (
					OLD.`status` = 'approved'
					AND NEW.`status` = 'approved'
				)
			)
			AND NEW.`fencing_token` IS OLD.`fencing_token`
			AND julianday(NEW.`updated_at`) IS NOT NULL
			AND NEW.`updated_at` IS (
				SELECT approval.`approved_at`
				FROM `intent_approvals` approval
				WHERE approval.`intent_id` = OLD.`id`
					AND approval.`parameters_hash` = OLD.`parameters_hash`
				ORDER BY
					julianday(approval.`approved_at`) DESC,
					approval.`approved_at` DESC,
					approval.`id` DESC
				LIMIT 1
			)
			AND (
				(
					NEW.`status` = 'proposed'
					AND (
						SELECT COUNT(*)
						FROM `intent_approvals` approval
						WHERE approval.`intent_id` = OLD.`id`
							AND approval.`parameters_hash` = OLD.`parameters_hash`
					) < OLD.`required_approvals`
				)
				OR (
					NEW.`status` = 'approved'
					AND (
						SELECT COUNT(*)
						FROM `intent_approvals` approval
						WHERE approval.`intent_id` = OLD.`id`
							AND approval.`parameters_hash` = OLD.`parameters_hash`
					) >= OLD.`required_approvals`
				)
			)
		)
		AND NOT (
			OLD.`status` = 'approved'
			AND NEW.`status` = 'succeeded'
			AND OLD.`fencing_token` IS NULL
			AND typeof(NEW.`fencing_token`) = 'integer'
			AND NEW.`fencing_token` BETWEEN 1 AND 9007199254740991
			AND NEW.`updated_at` IS NOT OLD.`updated_at`
			AND julianday(NEW.`updated_at`) IS NOT NULL
		)
		AND NOT (
			OLD.`status` = 'approved'
			AND NEW.`status` = 'failed'
			AND NEW.`fencing_token` IS OLD.`fencing_token`
			AND NEW.`updated_at` IS NOT OLD.`updated_at`
			AND julianday(NEW.`updated_at`) IS NOT NULL
		)
		AND NOT (
			OLD.`status` IN ('proposed', 'approved')
			AND NEW.`status` = 'expired'
			AND NEW.`fencing_token` IS OLD.`fencing_token`
			AND NEW.`updated_at` IS NOT OLD.`updated_at`
			AND julianday(NEW.`updated_at`) IS NOT NULL
			AND julianday(NEW.`updated_at`) >= julianday(OLD.`expires_at`)
		)
		THEN RAISE(ABORT, 'action_intent_transition_is_invalid')
	END;
END;--> statement-breakpoint
CREATE TRIGGER `action_intents_prevent_delete`
BEFORE DELETE ON `action_intents`
BEGIN
	SELECT RAISE(ABORT, 'action_intent_history_is_immutable');
END;
