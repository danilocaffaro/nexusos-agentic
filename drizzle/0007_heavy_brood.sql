DROP INDEX `attention_items_principal_status_created_idx`;--> statement-breakpoint
CREATE INDEX `attention_items_org_principal_status_created_idx` ON `attention_items` (`organization_id`,`principal_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `attention_items_org_principal_created_idx` ON `attention_items` (`organization_id`,`principal_id`,`created_at`,`id`);--> statement-breakpoint
DROP TRIGGER `attention_items_validate_before_insert`;--> statement-breakpoint
CREATE TRIGGER `attention_items_validate_before_insert`
BEFORE INSERT ON `attention_items`
BEGIN
	SELECT CASE WHEN
		NEW.`kind` != 'intent_awaiting_approval'
		OR NEW.`status` != 'open'
		OR NEW.`resolution` IS NOT NULL
		OR NEW.`version` != 1
		OR NEW.`seen_at` IS NOT NULL
		OR NEW.`resolved_at` IS NOT NULL
		OR NOT EXISTS (
			SELECT 1
			FROM `principals` principal
			INNER JOIN `memberships` membership
			  ON membership.`principal_id` = principal.`id`
			 AND membership.`organization_id` = principal.`organization_id`
			WHERE principal.`id` = NEW.`principal_id`
			  AND principal.`organization_id` = NEW.`organization_id`
			  AND principal.`kind` = 'human'
			  AND principal.`status` = 'active'
			  AND membership.`status` = 'active'
			  AND membership.`role` IN ('owner', 'admin')
		) OR NOT EXISTS (
			SELECT 1 FROM `action_intents` intent
			WHERE intent.`id` = NEW.`intent_id`
			  AND intent.`organization_id` = NEW.`organization_id`
			  AND intent.`status` IN ('proposed', 'approved')
		)
	THEN RAISE(ABORT, 'invalid_attention_reference') END;
END;--> statement-breakpoint
DROP TRIGGER `attention_items_validate_lifecycle`;--> statement-breakpoint
CREATE TRIGGER `attention_items_validate_lifecycle`
BEFORE UPDATE OF status, resolution, seen_at, resolved_at ON `attention_items`
BEGIN
	SELECT CASE WHEN NOT (
		(
			OLD.`status` = 'open'
			AND NEW.`status` = 'seen'
			AND NEW.`resolution` IS NULL
			AND NEW.`seen_at` IS NOT NULL
			AND NEW.`resolved_at` IS NULL
		) OR (
			OLD.`status` IN ('open', 'seen')
			AND NEW.`status` = 'resolved'
			AND NEW.`resolution` IN ('decided', 'expired', 'superseded')
			AND NEW.`resolved_at` IS NOT NULL
			AND NEW.`seen_at` IS OLD.`seen_at`
		)
	) THEN RAISE(ABORT, 'invalid_attention_transition') END;
END;
