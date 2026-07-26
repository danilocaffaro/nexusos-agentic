DROP INDEX `action_intents_org_idempotency_uidx`;--> statement-breakpoint
ALTER TABLE `action_intents` ADD `separation_of_duties` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `action_intents` ADD `self_approval_policy` text;--> statement-breakpoint
CREATE UNIQUE INDEX `action_intents_org_live_idempotency_uidx` ON `action_intents` (`organization_id`,`idempotency_key`) WHERE "action_intents"."status" IN ('draft', 'proposed', 'approved', 'executing');--> statement-breakpoint
ALTER TABLE `intent_approvals` ADD `solo_owner_acknowledged` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `artifact_versions_org_content_hash_idx` ON `artifact_versions` (`organization_id`,`content_hash`);