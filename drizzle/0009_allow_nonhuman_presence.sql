DROP TRIGGER presence_sessions_validate_before_insert;--> statement-breakpoint
DROP TRIGGER presence_sessions_validate_before_update;--> statement-breakpoint
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
    WHERE p.id = NEW.principal_id
      AND p.organization_id = NEW.organization_id
      AND p.status = 'active'
      AND (
        p.kind != 'human'
        OR EXISTS (
          SELECT 1
          FROM memberships m
          WHERE m.organization_id = p.organization_id
            AND m.principal_id = p.id
            AND m.status = 'active'
        )
      )
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
    WHERE p.id = NEW.principal_id
      AND p.organization_id = NEW.organization_id
      AND p.status = 'active'
      AND (
        p.kind != 'human'
        OR EXISTS (
          SELECT 1
          FROM memberships m
          WHERE m.organization_id = p.organization_id
            AND m.principal_id = p.id
            AND m.status = 'active'
        )
      )
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
END;
