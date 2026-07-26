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
END;
