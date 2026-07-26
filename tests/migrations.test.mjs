import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const expectedTables = [
  "action_intents",
  "agent_definitions",
  "conversation_members",
  "conversations",
  "intent_approvals",
  "ledger_entries",
  "memberships",
  "message_payloads",
  "messages",
  "model_connections",
  "objectives",
  "organizations",
  "principals",
  "projects",
  "team_members",
  "teams",
  "work_items",
];

test("all migrations apply to an empty SQLite database", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");

  const migrations = readdirSync(new URL("../drizzle/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  assert.ok(migrations.length > 0, "expected at least one SQL migration");
  for (const migration of migrations) {
    const sql = readFileSync(
      new URL(`../drizzle/${migration}`, import.meta.url),
      "utf8",
    ).replaceAll("--> statement-breakpoint", "");
    database.exec(sql);
  }

  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);

  assert.deepEqual(tables, expectedTables);

  const indexes = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  for (const requiredIndex of [
    "action_intents_org_idempotency_uidx",
    "agent_definitions_org_slug_uidx",
    "agent_definitions_principal_uidx",
    "conversation_members_conv_principal_uidx",
    "conversations_org_direct_key_uidx",
    "intent_approvals_intent_actor_uidx",
    "ledger_entries_org_hash_uidx",
    "ledger_entries_org_sequence_uidx",
    "memberships_org_principal_uidx",
    "model_connections_org_provider_label_uidx",
    "messages_conv_sequence_uidx",
    "objectives_org_ref_uidx",
    "objectives_project_status_idx",
    "projects_org_slug_uidx",
    "team_members_team_principal_uidx",
    "teams_project_slug_uidx",
    "work_items_objective_status_idx",
    "work_items_org_external_ref_uidx",
    "work_items_org_ref_uidx",
    "work_items_project_status_idx",
  ]) {
    assert.ok(indexes.includes(requiredIndex), `missing index ${requiredIndex}`);
  }

  const triggers = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  assert.deepEqual(triggers, [
    "agent_definitions_sync_members_after_update",
    "agent_definitions_sync_principal_after_update",
    "agent_definitions_validate_before_insert",
    "agent_definitions_validate_before_update",
    "conversation_members_validate_before_insert",
    "conversation_members_validate_before_reference_update",
    "conversations_validate_before_insert",
    "conversations_validate_before_reference_update",
    "messages_prevent_delete",
    "messages_prevent_update",
    "messages_validate_before_insert",
    "objectives_validate_before_insert",
    "objectives_validate_before_update",
    "team_members_validate_before_insert",
    "teams_validate_project_before_insert",
    "work_items_validate_before_insert",
    "work_items_validate_before_update",
  ]);

  assert.throws(() => {
    database
      .prepare(
        "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
      )
      .run("principal-1", "missing-org", "human", "Rafael");
  }, /FOREIGN KEY constraint failed/);

  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run("org-1", "aurora", "Aurora Labs");
  database
    .prepare(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
    )
    .run("principal-1", "org-1", "human", "Rafael");
  assert.throws(() => {
    database
      .prepare(
        "INSERT INTO principals (id, organization_id, kind, external_id, display_name) VALUES (?, ?, ?, ?, ?)",
      )
      .run("principal-2", "org-1", "human", "gh:rafael", "Rafael");
    database
      .prepare(
        "INSERT INTO principals (id, organization_id, kind, external_id, display_name) VALUES (?, ?, ?, ?, ?)",
      )
      .run("principal-3", "org-1", "human", "gh:rafael", "Duplicate");
  }, /UNIQUE constraint failed/);

  database
    .prepare(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
    )
    .run("agent-principal-1", "org-1", "agent", "Atlas");
  database
    .prepare(
      `INSERT INTO agent_definitions (
        id, organization_id, principal_id, slug, name, role, model
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-definition-1",
      "org-1",
      "agent-principal-1",
      "atlas",
      "Atlas",
      "Engineering Lead",
      "Claude",
    );
  database
    .prepare("UPDATE principals SET status = 'disabled' WHERE id = ?")
    .run("agent-principal-1");
  database
    .prepare(
      "UPDATE agent_definitions SET name = name, status = status, model = ? WHERE id = ?",
    )
    .run("Claude Opus", "agent-definition-1");
  assert.equal(
    database
      .prepare("SELECT status FROM principals WHERE id = ?")
      .get("agent-principal-1").status,
    "disabled",
  );
  database
    .prepare("UPDATE agent_definitions SET status = 'archived' WHERE id = ?")
    .run("agent-definition-1");
  database
    .prepare("UPDATE agent_definitions SET status = 'active' WHERE id = ?")
    .run("agent-definition-1");
  assert.equal(
    database
      .prepare("SELECT status FROM principals WHERE id = ?")
      .get("agent-principal-1").status,
    "active",
  );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO teams (
          id, organization_id, project_id, slug, name, mission
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "team-invalid",
        "org-1",
        "missing-project",
        "invalid",
        "Invalid team",
        "Must be rejected",
      );
  }, /invalid_workspace_reference/);

  database
    .prepare(
      "INSERT INTO projects (id, organization_id, slug, name, objective) VALUES (?, ?, ?, ?, ?)",
    )
    .run("project-1", "org-1", "project-1", "Project 1", "Ship safely");
  database
    .prepare(
      "INSERT INTO projects (id, organization_id, slug, name, objective) VALUES (?, ?, ?, ?, ?)",
    )
    .run("project-2", "org-1", "project-2", "Project 2", "Learn quickly");
  database
    .prepare(
      `INSERT INTO conversations (
        id, organization_id, project_id, created_by, kind, direct_key, title
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "conversation-1",
      "org-1",
      "project-1",
      "principal-1",
      "direct",
      "principal-1:principal-peer",
      "Direct message",
    );
  database
    .prepare(
      `INSERT INTO conversation_members (
        id, organization_id, conversation_id, principal_id, role
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "conversation-member-1",
      "org-1",
      "conversation-1",
      "principal-1",
      "owner",
    );
  database
    .prepare(
      "INSERT INTO message_payloads (id, organization_id, body_text) VALUES (?, ?, ?)",
    )
    .run("payload-1", "org-1", "Persistent collaboration");
  database
    .prepare(
      `INSERT INTO messages (
        id, organization_id, conversation_id, sender_id, content_ref,
        content_hash, sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "message-1",
      "org-1",
      "conversation-1",
      "principal-1",
      "payload-1",
      "a".repeat(64),
      1,
    );
  assert.throws(() => {
    database
      .prepare("UPDATE messages SET metadata_json = ? WHERE id = ?")
      .run('{"mutated":true}', "message-1");
  }, /messages_are_append_only/);
  assert.throws(() => {
    database.prepare("DELETE FROM messages WHERE id = ?").run("message-1");
  }, /messages_are_append_only/);
  database
    .prepare(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
    )
    .run("principal-outsider", "org-1", "human", "Outsider");
  database
    .prepare(
      "INSERT INTO message_payloads (id, organization_id, body_text) VALUES (?, ?, ?)",
    )
    .run("payload-outsider", "org-1", "Must be rejected");
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO messages (
          id, organization_id, conversation_id, sender_id, content_ref,
          content_hash, sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "message-outsider",
        "org-1",
        "conversation-1",
        "principal-outsider",
        "payload-outsider",
        "b".repeat(64),
        2,
      );
  }, /conversation_membership_required/);
  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run("org-2", "other", "Other tenant");
  database
    .prepare(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
    )
    .run("principal-other", "org-2", "human", "Other owner");
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO conversation_members (
          id, organization_id, conversation_id, principal_id, role
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "conversation-member-cross-tenant",
        "org-1",
        "conversation-1",
        "principal-other",
        "member",
      );
  }, /invalid_collaboration_reference/);
  database
    .prepare(
      `INSERT INTO objectives (
        id, organization_id, project_id, ref, title
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("objective-1", "org-1", "project-1", "OBJ-00000001", "First outcome");
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO objectives (
          id, organization_id, project_id, ref, title
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "objective-invalid",
        "org-1",
        "missing-project",
        "OBJ-INVALID",
        "Must fail",
      );
  }, /invalid_workspace_reference/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO work_items (
          id, organization_id, project_id, objective_id, ref, title
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "work-invalid-project",
        "org-1",
        "project-2",
        "objective-1",
        "WI-INVALID",
        "Cannot cross project boundaries",
      );
  }, /invalid_workspace_reference/);

  database.close();
});

test("conversation sequence migration backfills existing message history", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0000_icy_power_man.sql",
    "0001_abandoned_ultimatum.sql",
    "0002_flashy_mimic.sql",
    "0003_tiny_lilandra.sql",
  ]) {
    database.exec(
      readFileSync(
        new URL(`../drizzle/${migration}`, import.meta.url),
        "utf8",
      ).replaceAll("--> statement-breakpoint", ""),
    );
  }
  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run("org-backfill", "backfill", "Backfill");
  database
    .prepare(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
    )
    .run("principal-backfill", "org-backfill", "human", "Owner");
  database
    .prepare(
      "INSERT INTO projects (id, organization_id, slug, name, objective) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      "project-backfill",
      "org-backfill",
      "backfill",
      "Backfill",
      "Preserve ordered history",
    );
  database
    .prepare(
      `INSERT INTO conversations (
        id, organization_id, project_id, created_by, kind, title
      ) VALUES (?, ?, ?, ?, 'room', ?)`,
    )
    .run(
      "conversation-backfill",
      "org-backfill",
      "project-backfill",
      "principal-backfill",
      "Existing room",
    );
  database
    .prepare(
      `INSERT INTO conversation_members (
        id, organization_id, conversation_id, principal_id, role
      ) VALUES (?, ?, ?, ?, 'owner')`,
    )
    .run(
      "member-backfill",
      "org-backfill",
      "conversation-backfill",
      "principal-backfill",
    );
  for (const sequence of [1, 2]) {
    database
      .prepare(
        "INSERT INTO message_payloads (id, organization_id, body_text) VALUES (?, ?, ?)",
      )
      .run(`payload-backfill-${sequence}`, "org-backfill", `Message ${sequence}`);
    database
      .prepare(
        `INSERT INTO messages (
          id, organization_id, conversation_id, sender_id, content_ref,
          content_hash, sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `message-backfill-${sequence}`,
        "org-backfill",
        "conversation-backfill",
        "principal-backfill",
        `payload-backfill-${sequence}`,
        String(sequence).repeat(64),
        sequence,
      );
  }

  database.exec(
    readFileSync(
      new URL(
        "../drizzle/0004_tan_layla_miller.sql",
        import.meta.url,
      ),
      "utf8",
    ).replaceAll("--> statement-breakpoint", ""),
  );
  assert.equal(
    database
      .prepare(
        "SELECT next_sequence FROM conversations WHERE id = ?",
      )
      .get("conversation-backfill").next_sequence,
    3,
  );
  database.close();
});
