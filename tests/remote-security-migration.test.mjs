import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const BREAKPOINT = "--> statement-breakpoint";

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of readdirSync(
    new URL("../drizzle/", import.meta.url),
  )
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(
      readFileSync(
        new URL(`../drizzle/${migration}`, import.meta.url),
        "utf8",
      ).replaceAll(BREAKPOINT, ""),
    );
  }
  return database;
}

test("remote credentials are owner-scoped and security events are append-only", () => {
  const database = migratedDatabase();
  const timestamp = "2026-07-31T12:00:00.000Z";

  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO auth_credentials (
            principal_id, login, display_name, password_salt, password_hash,
            password_iterations, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "principal-not-owner",
          "operator",
          "Operator",
          "salt",
          "hash",
          600000,
          timestamp,
          timestamp,
        ),
    /auth_credentials_owner_invalid/u,
  );

  database
    .prepare(
      `INSERT INTO auth_credentials (
        principal_id, login, display_name, password_salt, password_hash,
        password_iterations, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "principal-local-owner",
      "operator",
      "Operator",
      "salt",
      "hash",
      600000,
      timestamp,
      timestamp,
    );
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE auth_credentials SET login = ? WHERE principal_id = ?",
        )
        .run("renamed", "principal-local-owner"),
    /auth_credentials_identity_immutable/u,
  );
  assert.throws(
    () =>
      database
        .prepare("DELETE FROM auth_credentials WHERE principal_id = ?")
        .run("principal-local-owner"),
    /auth_credentials_delete_requires_recovery_workflow/u,
  );

  database
    .prepare(
      `INSERT INTO auth_events (
        id, principal_id, event_type, occurred_at
      ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      "auth-event-1",
      "principal-local-owner",
      "login_succeeded",
      timestamp,
    );
  assert.throws(
    () =>
      database
        .prepare("UPDATE auth_events SET event_type = ? WHERE id = ?")
        .run("logout_completed", "auth-event-1"),
    /auth_events_are_append_only/u,
  );
  assert.throws(
    () =>
      database
        .prepare("DELETE FROM auth_events WHERE id = ?")
        .run("auth-event-1"),
    /auth_events_are_append_only/u,
  );
});

test("message attachments require membership and become immutable after binding", () => {
  const database = migratedDatabase();
  const timestamp = "2026-07-31T12:00:00.000Z";

  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run("org-remote", "remote", "Remote workspace");
  database
    .prepare(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
    )
    .run("principal-owner", "org-remote", "human", "Owner");
  database
    .prepare(
      `INSERT INTO conversations (
        id, organization_id, created_by, kind, title
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "conversation-remote",
      "org-remote",
      "principal-owner",
      "room",
      "Remote room",
    );

  const insertAttachment = database.prepare(
    `INSERT INTO message_attachments (
      id, organization_id, conversation_id, uploader_id, object_key,
      original_name, media_type, byte_size, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  assert.throws(
    () =>
      insertAttachment.run(
        "attachment-before-membership",
        "org-remote",
        "conversation-remote",
        "principal-owner",
        "objects/before",
        "before.txt",
        "text/plain",
        12,
        "a".repeat(43),
        timestamp,
      ),
    /attachment_conversation_membership_required/u,
  );

  database
    .prepare(
      `INSERT INTO conversation_members (
        id, organization_id, conversation_id, principal_id
      ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      "member-owner",
      "org-remote",
      "conversation-remote",
      "principal-owner",
    );
  insertAttachment.run(
    "attachment-1",
    "org-remote",
    "conversation-remote",
    "principal-owner",
    "objects/attachment-1",
    "brief.txt",
    "text/plain",
    12,
    "b".repeat(43),
    timestamp,
  );

  const insertMessage = database.prepare(
    `INSERT INTO messages (
      id, organization_id, conversation_id, sender_id, content_hash,
      sequence, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  assert.throws(
    () =>
      insertMessage.run(
        "message-invalid",
        "org-remote",
        "conversation-remote",
        "principal-owner",
        "c".repeat(43),
        1,
        '{"attachmentIds":["missing-attachment"]}',
        timestamp,
      ),
    /message_attachment_envelope_invalid/u,
  );
  insertMessage.run(
    "message-1",
    "org-remote",
    "conversation-remote",
    "principal-owner",
    "d".repeat(43),
    1,
    '{"attachmentIds":["attachment-1"]}',
    timestamp,
  );
  database
    .prepare(
      `UPDATE message_attachments
       SET status = 'attached', message_id = ?, attached_at = ?
       WHERE id = ?`,
    )
    .run("message-1", timestamp, "attachment-1");

  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE message_attachments SET original_name = ? WHERE id = ?",
        )
        .run("forged.txt", "attachment-1"),
    /message_attachment_transition_invalid/u,
  );
  assert.throws(
    () =>
      database
        .prepare("DELETE FROM message_attachments WHERE id = ?")
        .run("attachment-1"),
    /attached_message_files_are_immutable/u,
  );
});
