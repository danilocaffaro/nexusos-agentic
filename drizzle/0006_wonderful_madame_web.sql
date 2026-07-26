CREATE TABLE `attention_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`intent_id` text NOT NULL,
	`kind` text DEFAULT 'intent_awaiting_approval' NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution` text,
	`version` integer DEFAULT 1 NOT NULL,
	`seen_at` text,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intent_id`) REFERENCES `action_intents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attention_items_org_principal_dedupe_uidx` ON `attention_items` (`organization_id`,`principal_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `attention_items_principal_status_created_idx` ON `attention_items` (`organization_id`,`principal_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `attention_items_validate_before_insert`
BEFORE INSERT ON `attention_items`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
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
	) OR NOT EXISTS (
		SELECT 1 FROM `action_intents` intent
		WHERE intent.`id` = NEW.`intent_id`
		  AND intent.`organization_id` = NEW.`organization_id`
		  AND intent.`status` IN ('proposed', 'approved')
	) THEN RAISE(ABORT, 'invalid_attention_reference') END;
END;--> statement-breakpoint
CREATE TRIGGER `attention_items_prevent_reference_update`
BEFORE UPDATE OF organization_id, principal_id, intent_id, kind, dedupe_key, created_at
ON `attention_items`
BEGIN
	SELECT RAISE(ABORT, 'attention_reference_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `attention_items_prevent_delete`
BEFORE DELETE ON `attention_items`
BEGIN
	SELECT RAISE(ABORT, 'attention_history_is_immutable');
END;--> statement-breakpoint
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
			AND NEW.`resolution` = 'decided'
			AND NEW.`resolved_at` IS NOT NULL
		)
	) THEN RAISE(ABORT, 'invalid_attention_transition') END;
END;--> statement-breakpoint
INSERT INTO `attention_items` (
	`id`, `organization_id`, `principal_id`, `intent_id`, `kind`,
	`dedupe_key`, `status`, `version`, `created_at`, `updated_at`
)
SELECT
	'attention:' || intent.`id` || ':' || membership.`principal_id`,
	intent.`organization_id`,
	membership.`principal_id`,
	intent.`id`,
	'intent_awaiting_approval',
	'intent:' || intent.`id` || ':approval',
	'open',
	1,
	intent.`created_at`,
	intent.`updated_at`
FROM `action_intents` intent
INNER JOIN `memberships` membership
  ON membership.`organization_id` = intent.`organization_id`
 AND membership.`role` IN ('owner', 'admin')
 AND membership.`status` = 'active'
INNER JOIN `principals` principal
  ON principal.`id` = membership.`principal_id`
 AND principal.`organization_id` = membership.`organization_id`
 AND principal.`kind` = 'human'
 AND principal.`status` = 'active'
WHERE intent.`status` = 'proposed';
