CREATE TABLE `message_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`uploader_id` text NOT NULL,
	`message_id` text,
	`object_key` text NOT NULL,
	`original_name` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`content_hash` text NOT NULL,
	`scan_status` text DEFAULT 'not_scanned' NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`created_at` text NOT NULL,
	`attached_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploader_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `message_attachments_name_length` CHECK(length(`original_name`) BETWEEN 1 AND 180),
	CONSTRAINT `message_attachments_media_type_length` CHECK(length(`media_type`) BETWEEN 3 AND 120),
	CONSTRAINT `message_attachments_size` CHECK(`byte_size` BETWEEN 1 AND 26214400),
	CONSTRAINT `message_attachments_hash_length` CHECK(length(`content_hash`) = 43),
	CONSTRAINT `message_attachments_scan_status` CHECK(`scan_status` IN ('not_scanned', 'clean', 'rejected')),
	CONSTRAINT `message_attachments_status` CHECK(`status` IN ('staged', 'attached')),
	CONSTRAINT `message_attachments_binding` CHECK(
		(`status` = 'staged' AND `message_id` IS NULL AND `attached_at` IS NULL)
		OR
		(`status` = 'attached' AND `message_id` IS NOT NULL AND `attached_at` IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_attachments_object_key_uidx` ON `message_attachments` (`object_key`);
--> statement-breakpoint
CREATE INDEX `message_attachments_conversation_status_idx` ON `message_attachments` (`organization_id`,`conversation_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `message_attachments_message_idx` ON `message_attachments` (`message_id`);
--> statement-breakpoint
CREATE TRIGGER `messages_validate_attachment_envelope`
BEFORE INSERT ON `messages`
WHEN json_type(NEW.`metadata_json`, '$.attachmentIds') IS NOT NULL
BEGIN
	SELECT CASE WHEN
		json_type(NEW.`metadata_json`, '$.attachmentIds') != 'array'
		OR json_array_length(NEW.`metadata_json`, '$.attachmentIds') NOT BETWEEN 1 AND 3
		OR (
			SELECT COUNT(DISTINCT value)
			FROM json_each(NEW.`metadata_json`, '$.attachmentIds')
		) != json_array_length(NEW.`metadata_json`, '$.attachmentIds')
		OR EXISTS (
			SELECT 1
			FROM json_each(NEW.`metadata_json`, '$.attachmentIds') requested
			LEFT JOIN `message_attachments` attachment
				ON attachment.`id` = requested.value
				AND attachment.`organization_id` = NEW.`organization_id`
				AND attachment.`conversation_id` = NEW.`conversation_id`
				AND attachment.`uploader_id` = NEW.`sender_id`
				AND attachment.`status` = 'staged'
				AND attachment.`message_id` IS NULL
			WHERE requested.type != 'text' OR attachment.`id` IS NULL
		)
	THEN RAISE(ABORT, 'message_attachment_envelope_invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER `message_attachments_validate_insert`
BEFORE INSERT ON `message_attachments`
BEGIN
	SELECT CASE WHEN NOT EXISTS (
		SELECT 1
		FROM `conversation_members` member
		INNER JOIN `conversations` conversation
			ON conversation.`id` = member.`conversation_id`
			AND conversation.`organization_id` = member.`organization_id`
		WHERE member.`organization_id` = NEW.`organization_id`
			AND member.`conversation_id` = NEW.`conversation_id`
			AND member.`principal_id` = NEW.`uploader_id`
			AND member.`status` = 'active'
			AND member.`role` != 'observer'
			AND conversation.`status` = 'active'
	) THEN RAISE(ABORT, 'attachment_conversation_membership_required') END;
END;
--> statement-breakpoint
CREATE TRIGGER `message_attachments_restrict_update`
BEFORE UPDATE ON `message_attachments`
WHEN NOT (
	OLD.`status` = 'staged'
	AND NEW.`status` = 'attached'
	AND OLD.`message_id` IS NULL
	AND NEW.`message_id` IS NOT NULL
	AND OLD.`attached_at` IS NULL
	AND NEW.`attached_at` IS NOT NULL
	AND NEW.`id` IS OLD.`id`
	AND NEW.`organization_id` IS OLD.`organization_id`
	AND NEW.`conversation_id` IS OLD.`conversation_id`
	AND NEW.`uploader_id` IS OLD.`uploader_id`
	AND NEW.`object_key` IS OLD.`object_key`
	AND NEW.`original_name` IS OLD.`original_name`
	AND NEW.`media_type` IS OLD.`media_type`
	AND NEW.`byte_size` IS OLD.`byte_size`
	AND NEW.`content_hash` IS OLD.`content_hash`
	AND NEW.`scan_status` IS OLD.`scan_status`
	AND NEW.`created_at` IS OLD.`created_at`
	AND EXISTS (
		SELECT 1
		FROM `messages` message
		WHERE message.`id` = NEW.`message_id`
			AND message.`organization_id` = NEW.`organization_id`
			AND message.`conversation_id` = NEW.`conversation_id`
			AND message.`sender_id` = NEW.`uploader_id`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'message_attachment_transition_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `message_attachments_prevent_attached_delete`
BEFORE DELETE ON `message_attachments`
WHEN OLD.`status` = 'attached'
BEGIN
	SELECT RAISE(ABORT, 'attached_message_files_are_immutable');
END;
