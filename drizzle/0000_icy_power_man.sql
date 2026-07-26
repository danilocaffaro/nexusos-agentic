CREATE TABLE `action_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`proposer_id` text NOT NULL,
	`proposer_kind` text NOT NULL,
	`action_type` text NOT NULL,
	`target_ref` text NOT NULL,
	`parameters_json` text NOT NULL,
	`parameters_hash` text NOT NULL,
	`preconditions_json` text DEFAULT '[]' NOT NULL,
	`risk_tier` text NOT NULL,
	`policy_decision_json` text NOT NULL,
	`required_approvals` integer DEFAULT 1 NOT NULL,
	`expires_at` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`supersedes_intent_id` text,
	`fencing_token` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposer_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_intents_org_idempotency_uidx` ON `action_intents` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `action_intents_project_status_idx` ON `action_intents` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `intent_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`parameters_hash` text NOT NULL,
	`approved_at` text NOT NULL,
	FOREIGN KEY (`intent_id`) REFERENCES `action_intents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intent_approvals_intent_actor_uidx` ON `intent_approvals` (`intent_id`,`actor_id`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`payload_hash` text NOT NULL,
	`payload_ref` text,
	`intent_id` text,
	`run_id` text,
	`previous_hash` text NOT NULL,
	`hash` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intent_id`) REFERENCES `action_intents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_entries_org_sequence_uidx` ON `ledger_entries` (`organization_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_entries_org_hash_uidx` ON `ledger_entries` (`organization_id`,`hash`);--> statement-breakpoint
CREATE INDEX `ledger_entries_intent_idx` ON `ledger_entries` (`intent_id`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_org_principal_uidx` ON `memberships` (`organization_id`,`principal_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_uidx` ON `organizations` (`slug`);--> statement-breakpoint
CREATE TABLE `principals` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `principals_org_idx` ON `principals` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `principals_org_external_uidx` ON `principals` (`organization_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`objective` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_org_slug_uidx` ON `projects` (`organization_id`,`slug`);--> statement-breakpoint
CREATE INDEX `projects_org_status_idx` ON `projects` (`organization_id`,`status`);