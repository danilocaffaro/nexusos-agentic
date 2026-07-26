CREATE TABLE `presence_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`session_key` text NOT NULL,
	`fencing_token` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`room_conversation_id` text,
	`expires_at_epoch` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `presence_sessions_org_principal_uidx` ON `presence_sessions` (`organization_id`,`principal_id`);--> statement-breakpoint
CREATE INDEX `presence_sessions_org_expires_idx` ON `presence_sessions` (`organization_id`,`expires_at_epoch`);--> statement-breakpoint
CREATE INDEX `presence_sessions_room_idx` ON `presence_sessions` (`room_conversation_id`);--> statement-breakpoint
CREATE TRIGGER presence_sessions_validate_before_insert
BEFORE INSERT ON presence_sessions
BEGIN
  SELECT RAISE(ABORT, 'invalid_presence_state')
  WHERE NEW.status NOT IN ('available', 'focus', 'dnd')
     OR typeof(NEW.fencing_token) <> 'integer'
     OR NEW.fencing_token < 1
     OR typeof(NEW.expires_at_epoch) <> 'integer'
     OR NEW.expires_at_epoch < 1
     OR NEW.expires_at_epoch > CAST(strftime('%s', 'now') AS INTEGER) + 300
     OR length(NEW.session_key) < 16
     OR length(NEW.session_key) > 128;

  SELECT RAISE(ABORT, 'invalid_presence_reference')
  WHERE NOT EXISTS (
    SELECT 1
    FROM principals p
    JOIN memberships m
      ON m.organization_id = p.organization_id
     AND m.principal_id = p.id
     AND m.status = 'active'
    WHERE p.id = NEW.principal_id
      AND p.organization_id = NEW.organization_id
      AND p.status = 'active'
  );

  SELECT RAISE(ABORT, 'invalid_presence_room')
  WHERE NEW.room_conversation_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM conversations c
      JOIN conversation_members cm
        ON cm.organization_id = c.organization_id
       AND cm.conversation_id = c.id
       AND cm.principal_id = NEW.principal_id
       AND cm.status = 'active'
      WHERE c.id = NEW.room_conversation_id
        AND c.organization_id = NEW.organization_id
        AND c.kind = 'room'
        AND c.status = 'active'
    );
END;--> statement-breakpoint
CREATE TRIGGER presence_sessions_validate_before_update
BEFORE UPDATE ON presence_sessions
BEGIN
  SELECT RAISE(ABORT, 'invalid_presence_state')
  WHERE NEW.status NOT IN ('available', 'focus', 'dnd')
     OR typeof(NEW.fencing_token) <> 'integer'
     OR NEW.fencing_token < 1
     OR typeof(NEW.expires_at_epoch) <> 'integer'
     OR NEW.expires_at_epoch < 1
     OR NEW.expires_at_epoch > CAST(strftime('%s', 'now') AS INTEGER) + 300
     OR length(NEW.session_key) < 16
     OR length(NEW.session_key) > 128;

  SELECT RAISE(ABORT, 'presence_stale_session')
  WHERE NOT (
    (
      NEW.fencing_token = OLD.fencing_token
      AND NEW.session_key = OLD.session_key
    )
    OR NEW.fencing_token = OLD.fencing_token + 1
  );

  SELECT RAISE(ABORT, 'invalid_presence_reference')
  WHERE NOT EXISTS (
    SELECT 1
    FROM principals p
    JOIN memberships m
      ON m.organization_id = p.organization_id
     AND m.principal_id = p.id
     AND m.status = 'active'
    WHERE p.id = NEW.principal_id
      AND p.organization_id = NEW.organization_id
      AND p.status = 'active'
  );

  SELECT RAISE(ABORT, 'invalid_presence_room')
  WHERE NEW.room_conversation_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM conversations c
      JOIN conversation_members cm
        ON cm.organization_id = c.organization_id
       AND cm.conversation_id = c.id
       AND cm.principal_id = NEW.principal_id
       AND cm.status = 'active'
      WHERE c.id = NEW.room_conversation_id
        AND c.organization_id = NEW.organization_id
        AND c.kind = 'room'
        AND c.status = 'active'
    );
END;--> statement-breakpoint
CREATE TRIGGER presence_sessions_prevent_reference_update
BEFORE UPDATE OF organization_id, principal_id ON presence_sessions
WHEN NEW.organization_id <> OLD.organization_id
  OR NEW.principal_id <> OLD.principal_id
BEGIN
  SELECT RAISE(ABORT, 'presence_reference_is_immutable');
END;
