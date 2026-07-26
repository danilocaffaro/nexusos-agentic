CREATE TABLE `conversation_pins` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`pinned_by` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`pinned_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`unpinned_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pinned_by`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_pins_conv_message_uidx` ON `conversation_pins` (`conversation_id`,`message_id`) WHERE "conversation_pins"."status" = 'active';--> statement-breakpoint
CREATE INDEX `conversation_pins_org_conv_status_idx` ON `conversation_pins` (`organization_id`,`conversation_id`,`status`);--> statement-breakpoint
CREATE TRIGGER `conversation_pins_validate_before_insert`
BEFORE INSERT ON `conversation_pins`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `conversations`
		WHERE `id` = NEW.`conversation_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` = 'active'
	) OR NOT EXISTS (
		SELECT 1 FROM `messages`
		WHERE `id` = NEW.`message_id`
		  AND `conversation_id` = NEW.`conversation_id`
		  AND `organization_id` = NEW.`organization_id`
	) OR NOT EXISTS (
		SELECT 1 FROM `principals`
		WHERE `id` = NEW.`pinned_by`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` = 'active'
	) OR NOT EXISTS (
		SELECT 1 FROM `conversation_members`
		WHERE `conversation_id` = NEW.`conversation_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `principal_id` = NEW.`pinned_by`
		  AND `status` = 'active'
		  AND `role` != 'observer'
	) THEN RAISE(ABORT, 'invalid_conversation_pin') END;
END;--> statement-breakpoint
CREATE TRIGGER `conversation_pins_prevent_reference_update`
BEFORE UPDATE OF organization_id, conversation_id, message_id, pinned_by, pinned_at
ON `conversation_pins`
BEGIN
	SELECT RAISE(ABORT, 'conversation_pin_reference_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `conversation_pins_prevent_delete`
BEFORE DELETE ON `conversation_pins`
BEGIN
	SELECT RAISE(ABORT, 'conversation_pin_history_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `conversation_members_prevent_reference_update`
BEFORE UPDATE OF organization_id, conversation_id, principal_id, joined_at
ON `conversation_members`
BEGIN
	SELECT RAISE(ABORT, 'conversation_membership_reference_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `conversation_members_prevent_delete`
BEFORE DELETE ON `conversation_members`
BEGIN
	SELECT RAISE(ABORT, 'membership_history_is_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `conversation_members_require_active_principal`
BEFORE UPDATE OF status ON `conversation_members`
WHEN NEW.`status` = 'active'
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `principals`
		WHERE `id` = NEW.`principal_id`
		  AND `organization_id` = NEW.`organization_id`
		  AND `status` = 'active'
	) THEN RAISE(ABORT, 'invalid_collaboration_reference') END;
END;--> statement-breakpoint
CREATE TRIGGER `conversation_members_require_owner`
BEFORE UPDATE OF role, status ON `conversation_members`
WHEN OLD.`role` = 'owner'
 AND OLD.`status` = 'active'
 AND (NEW.`role` != 'owner' OR NEW.`status` != 'active')
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1 FROM `conversation_members` other
		WHERE other.`conversation_id` = OLD.`conversation_id`
		  AND other.`organization_id` = OLD.`organization_id`
		  AND other.`principal_id` != OLD.`principal_id`
		  AND other.`role` = 'owner'
		  AND other.`status` = 'active'
	) THEN RAISE(ABORT, 'conversation_requires_owner') END;
END;
