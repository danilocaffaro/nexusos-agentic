ALTER TABLE `conversations` ADD `next_sequence` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE `conversations`
SET `next_sequence` = COALESCE(
	(
		SELECT MAX(`sequence`) + 1
		FROM `messages`
		WHERE `conversation_id` = `conversations`.`id`
	),
	1
);--> statement-breakpoint
CREATE TRIGGER `messages_prevent_delete`
BEFORE DELETE ON `messages`
BEGIN
	SELECT RAISE(ABORT, 'messages_are_append_only');
END;
