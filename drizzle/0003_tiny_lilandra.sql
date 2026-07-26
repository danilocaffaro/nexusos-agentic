CREATE TABLE `conversation_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`joined_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`left_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_members_conv_principal_uidx` ON `conversation_members` (`conversation_id`,`principal_id`);--> statement-breakpoint
CREATE INDEX `conversation_members_org_principal_idx` ON `conversation_members` (`organization_id`,`principal_id`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text,
	`team_id` text,
	`work_item_id` text,
	`intent_id` text,
	`created_by` text NOT NULL,
	`kind` text NOT NULL,
	`direct_key` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intent_id`) REFERENCES `action_intents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_org_direct_key_uidx` ON `conversations` (`organization_id`,`direct_key`);--> statement-breakpoint
CREATE INDEX `conversations_org_kind_status_idx` ON `conversations` (`organization_id`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `conversations_project_idx` ON `conversations` (`project_id`);--> statement-breakpoint
CREATE INDEX `conversations_team_idx` ON `conversations` (`team_id`);--> statement-breakpoint
CREATE TABLE `message_payloads` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`body_text` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`erased_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `message_payloads_org_created_idx` ON `message_payloads` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`content_ref` text,
	`content_hash` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text DEFAULT 'text' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_ref`) REFERENCES `message_payloads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conv_sequence_uidx` ON `messages` (`conversation_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `messages_org_conv_idx` ON `messages` (`organization_id`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `messages_sender_idx` ON `messages` (`sender_id`);--> statement-breakpoint
CREATE TRIGGER `conversations_validate_before_insert`
BEFORE INSERT ON `conversations`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `principals`
		WHERE `id` = NEW.`created_by`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` = 'active'
	) OR (
		NEW.`project_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `projects`
			WHERE `id` = NEW.`project_id`
			  AND `organization_id` = NEW.`organization_id`
			  AND `status` != 'archived'
		)
	) OR (
		NEW.`team_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `teams`
			WHERE `id` = NEW.`team_id`
			  AND `organization_id` = NEW.`organization_id`
			  AND `status` != 'archived'
			  AND (
				NEW.`project_id` IS NULL OR `project_id` = NEW.`project_id`
			  )
		)
	) OR (
		NEW.`work_item_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `work_items`
			WHERE `id` = NEW.`work_item_id`
			  AND `organization_id` = NEW.`organization_id`
			  AND (
				NEW.`project_id` IS NULL OR `project_id` = NEW.`project_id`
			  )
		)
	) OR (
		NEW.`intent_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `action_intents`
			WHERE `id` = NEW.`intent_id`
			  AND `organization_id` = NEW.`organization_id`
			  AND (
				NEW.`project_id` IS NULL OR `project_id` = NEW.`project_id`
			  )
		)
	) OR (
		NEW.`kind` = 'direct' AND NEW.`direct_key` IS NULL
	) OR (
		NEW.`kind` != 'direct' AND NEW.`direct_key` IS NOT NULL
	) THEN RAISE(ABORT, 'invalid_collaboration_reference') END;
END;--> statement-breakpoint
CREATE TRIGGER `conversations_validate_before_reference_update`
BEFORE UPDATE OF organization_id, project_id, team_id, work_item_id, intent_id, created_by, kind, direct_key ON `conversations`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `principals`
		WHERE `id` = NEW.`created_by`
		  AND `organization_id` = NEW.`organization_id`
	) OR (
		NEW.`project_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `projects`
			WHERE `id` = NEW.`project_id`
			  AND `organization_id` = NEW.`organization_id`
		)
	) OR (
		NEW.`team_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `teams`
			WHERE `id` = NEW.`team_id`
			  AND `organization_id` = NEW.`organization_id`
			  AND (
				NEW.`project_id` IS NULL OR `project_id` = NEW.`project_id`
			  )
		)
	) OR (
		NEW.`work_item_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `work_items`
			WHERE `id` = NEW.`work_item_id`
			  AND `organization_id` = NEW.`organization_id`
			  AND (
				NEW.`project_id` IS NULL OR `project_id` = NEW.`project_id`
			  )
		)
	) OR (
		NEW.`intent_id` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `action_intents`
			WHERE `id` = NEW.`intent_id`
			  AND `organization_id` = NEW.`organization_id`
			  AND (
				NEW.`project_id` IS NULL OR `project_id` = NEW.`project_id`
			  )
		)
	) OR (
		NEW.`kind` = 'direct' AND NEW.`direct_key` IS NULL
	) OR (
		NEW.`kind` != 'direct' AND NEW.`direct_key` IS NOT NULL
	) THEN RAISE(ABORT, 'invalid_collaboration_reference') END;
END;--> statement-breakpoint
CREATE TRIGGER `conversation_members_validate_before_insert`
BEFORE INSERT ON `conversation_members`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `conversations`
		WHERE `id` = NEW.`conversation_id`
		  AND `organization_id` = NEW.`organization_id`
	) OR NOT EXISTS (
		SELECT 1 FROM `principals`
		WHERE `id` = NEW.`principal_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND (
			NEW.`status` != 'active' OR `status` = 'active'
		  )
	) THEN RAISE(ABORT, 'invalid_collaboration_reference') END;
END;--> statement-breakpoint
CREATE TRIGGER `conversation_members_validate_before_reference_update`
BEFORE UPDATE OF organization_id, conversation_id, principal_id, status ON `conversation_members`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `conversations`
		WHERE `id` = NEW.`conversation_id`
		  AND `organization_id` = NEW.`organization_id`
	) OR NOT EXISTS (
		SELECT 1 FROM `principals`
		WHERE `id` = NEW.`principal_id`
		  AND `organization_id` = NEW.`organization_id`
	) THEN RAISE(ABORT, 'invalid_collaboration_reference') END;
END;--> statement-breakpoint
CREATE TRIGGER `messages_validate_before_insert`
BEFORE INSERT ON `messages`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `conversations`
		WHERE `id` = NEW.`conversation_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` = 'active'
	) OR NOT EXISTS (
		SELECT 1 FROM `principals`
		WHERE `id` = NEW.`sender_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` = 'active'
	) OR NOT EXISTS (
		SELECT 1 FROM `conversation_members`
		WHERE `conversation_id` = NEW.`conversation_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `principal_id` = NEW.`sender_id`
		  AND `status` = 'active'
		  AND `role` != 'observer'
	) OR (
		NEW.`content_ref` IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM `message_payloads`
			WHERE `id` = NEW.`content_ref`
			  AND `organization_id` = NEW.`organization_id`
			  AND `erased_at` IS NULL
		)
	) THEN RAISE(ABORT, 'conversation_membership_required') END;
END;--> statement-breakpoint
CREATE TRIGGER `messages_prevent_update`
BEFORE UPDATE ON `messages`
BEGIN
	SELECT RAISE(ABORT, 'messages_are_append_only');
END;
