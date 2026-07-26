import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const expectedTables = [
  "action_intents",
  "agent_definitions",
  "attention_items",
  "conversation_members",
  "conversation_pins",
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
    "attention_items_org_principal_dedupe_uidx",
    "attention_items_org_principal_created_idx",
    "attention_items_org_principal_status_created_idx",
    "conversation_members_conv_principal_uidx",
    "conversation_pins_conv_message_uidx",
    "conversation_pins_org_conv_status_idx",
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
    "attention_items_prevent_delete",
    "attention_items_prevent_reference_update",
    "attention_items_validate_before_insert",
    "attention_items_validate_lifecycle",
    "conversation_members_prevent_delete",
    "conversation_members_prevent_reference_update",
    "conversation_members_require_active_principal",
    "conversation_members_require_owner",
    "conversation_members_validate_before_insert",
    "conversation_members_validate_before_reference_update",
    "conversation_pins_prevent_delete",
    "conversation_pins_prevent_reference_update",
    "conversation_pins_validate_before_insert",
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
  database
    .prepare(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
    )
    .run("principal-member", "org-1", "human", "Workspace member");
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
      "INSERT INTO memberships (id, organization_id, principal_id, role) VALUES (?, ?, ?, ?)",
    )
    .run("membership-1", "org-1", "principal-1", "owner");
  database
    .prepare(
      "INSERT INTO memberships (id, organization_id, principal_id, role) VALUES (?, ?, ?, ?)",
    )
    .run("membership-member", "org-1", "principal-member", "member");
  database
    .prepare(
      `INSERT INTO action_intents (
        id, organization_id, project_id, proposer_id, proposer_kind,
        action_type, target_ref, parameters_json, parameters_hash,
        risk_tier, policy_decision_json, expires_at, idempotency_key, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "intent-attention-1",
      "org-1",
      "project-1",
      "agent-principal-1",
      "agent",
      "nexus.test.publish",
      "nexus:test:v1",
      "{}",
      "c".repeat(64),
      "medium",
      '{"effect":"require_approval"}',
      "2099-01-01T00:00:00.000Z",
      "attention-test",
      "proposed",
    );
  database
    .prepare(
      `INSERT INTO attention_items (
        id, organization_id, principal_id, intent_id, dedupe_key
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "attention-1",
      "org-1",
      "principal-1",
      "intent-attention-1",
      "intent:intent-attention-1:approval",
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO attention_items (
          id, organization_id, principal_id, intent_id, dedupe_key,
          status, resolution
        ) VALUES (?, ?, ?, ?, ?, 'resolved', 'decided')`,
      )
      .run(
        "attention-invalid-shape",
        "org-1",
        "principal-1",
        "intent-attention-1",
        "intent:intent-attention-1:invalid-shape",
      );
  }, /invalid_attention_reference/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO attention_items (
          id, organization_id, principal_id, intent_id, dedupe_key
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "attention-member",
        "org-1",
        "principal-member",
        "intent-attention-1",
        "intent:intent-attention-1:member",
      );
  }, /invalid_attention_reference/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO attention_items (
          id, organization_id, principal_id, intent_id, dedupe_key
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "attention-agent",
        "org-1",
        "agent-principal-1",
        "intent-attention-1",
        "intent:intent-attention-1:agent",
      );
  }, /invalid_attention_reference/);
  database
    .prepare(
      `UPDATE attention_items
       SET status = 'seen', seen_at = CURRENT_TIMESTAMP,
           version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run("attention-1");
  database
    .prepare(
      `INSERT INTO attention_items (
        id, organization_id, principal_id, intent_id, dedupe_key
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "attention-expiring",
      "org-1",
      "principal-1",
      "intent-attention-1",
      "intent:intent-attention-1:expiry-test",
    );
  database
    .prepare(
      `UPDATE attention_items
       SET status = 'resolved', resolution = 'expired',
           resolved_at = CURRENT_TIMESTAMP, version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run("attention-expiring");
  assert.equal(
    database
      .prepare(
        "SELECT resolution FROM attention_items WHERE id = ?",
      )
      .get("attention-expiring").resolution,
    "expired",
  );
  assert.throws(() => {
    database
      .prepare(
        `UPDATE attention_items
         SET status = 'seen', seen_at = CURRENT_TIMESTAMP,
             version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run("attention-1");
  }, /invalid_attention_transition/);
  assert.throws(() => {
    database
      .prepare("UPDATE attention_items SET intent_id = ? WHERE id = ?")
      .run("intent-attention-other", "attention-1");
  }, /attention_reference_is_immutable/);
  database
    .prepare(
      `UPDATE attention_items
       SET status = 'resolved', resolution = 'decided',
           resolved_at = CURRENT_TIMESTAMP, version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run("attention-1");
  assert.throws(() => {
    database.prepare("DELETE FROM attention_items WHERE id = ?").run("attention-1");
  }, /attention_history_is_immutable/);
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
      `INSERT INTO conversation_pins (
        id, organization_id, conversation_id, message_id, pinned_by
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "pin-1",
      "org-1",
      "conversation-1",
      "message-1",
      "principal-1",
    );
  assert.throws(() => {
    database.prepare("DELETE FROM conversation_pins WHERE id = ?").run("pin-1");
  }, /conversation_pin_history_is_immutable/);
  database
    .prepare(
      "UPDATE conversation_pins SET status = 'removed', version = version + 1, unpinned_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .run("pin-1");
  database
    .prepare(
      `INSERT INTO conversation_pins (
        id, organization_id, conversation_id, message_id, pinned_by
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "pin-2",
      "org-1",
      "conversation-1",
      "message-1",
      "principal-1",
    );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM conversation_pins WHERE conversation_id = ?",
      )
      .get("conversation-1").count,
    2,
  );
  assert.throws(() => {
    database
      .prepare("UPDATE conversation_pins SET message_id = ? WHERE id = ?")
      .run("message-other", "pin-2");
  }, /conversation_pin_reference_is_immutable/);
  assert.throws(() => {
    database
      .prepare("DELETE FROM conversation_members WHERE id = ?")
      .run("conversation-member-1");
  }, /membership_history_is_immutable/);
  assert.throws(() => {
    database
      .prepare("UPDATE conversation_members SET role = ? WHERE id = ?")
      .run("member", "conversation-member-1");
  }, /conversation_requires_owner/);
  database
    .prepare(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
    )
    .run("principal-owner-2", "org-1", "human", "Second owner");
  database
    .prepare(
      `INSERT INTO conversation_members (
        id, organization_id, conversation_id, principal_id, role
      ) VALUES (?, ?, ?, ?, 'owner')`,
    )
    .run(
      "conversation-member-owner-2",
      "org-1",
      "conversation-1",
      "principal-owner-2",
    );
  database
    .prepare("UPDATE conversation_members SET role = ? WHERE id = ?")
    .run("member", "conversation-member-1");
  assert.equal(
    database
      .prepare("SELECT role FROM conversation_members WHERE id = ?")
      .get("conversation-member-1").role,
    "member",
  );
  assert.throws(() => {
    database
      .prepare("UPDATE conversation_members SET status = ? WHERE id = ?")
      .run("left", "conversation-member-owner-2");
  }, /conversation_requires_owner/);
  database
    .prepare(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
    )
    .run("principal-outsider", "org-1", "human", "Outsider");
  assert.throws(() => {
    database
      .prepare(
        "UPDATE conversation_members SET principal_id = ? WHERE id = ?",
      )
      .run("principal-outsider", "conversation-member-1");
  }, /conversation_membership_reference_is_immutable/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO conversation_pins (
          id, organization_id, conversation_id, message_id, pinned_by
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "pin-outsider",
        "org-1",
        "conversation-1",
        "message-1",
        "principal-outsider",
      );
  }, /invalid_conversation_pin/);
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
    .prepare(
      `INSERT INTO conversations (
        id, organization_id, project_id, created_by, kind, title
      ) VALUES (?, ?, ?, ?, 'room', ?)`,
    )
    .run(
      "conversation-2",
      "org-1",
      "project-1",
      "principal-1",
      "Second room",
    );
  database
    .prepare(
      `INSERT INTO conversation_members (
        id, organization_id, conversation_id, principal_id, role
      ) VALUES (?, ?, ?, ?, 'owner')`,
    )
    .run(
      "conversation-member-2",
      "org-1",
      "conversation-2",
      "principal-1",
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO conversation_pins (
          id, organization_id, conversation_id, message_id, pinned_by
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "pin-cross-conversation",
        "org-1",
        "conversation-2",
        "message-1",
        "principal-1",
      );
  }, /invalid_conversation_pin/);
  database
    .prepare(
      `INSERT INTO conversation_members (
        id, organization_id, conversation_id, principal_id, role, status
      ) VALUES (?, ?, ?, ?, 'member', 'left')`,
    )
    .run(
      "conversation-member-disabled",
      "org-1",
      "conversation-2",
      "principal-outsider",
    );
  database
    .prepare("UPDATE principals SET status = 'disabled' WHERE id = ?")
    .run("principal-outsider");
  assert.throws(() => {
    database
      .prepare("UPDATE conversation_members SET status = ? WHERE id = ?")
      .run("active", "conversation-member-disabled");
  }, /invalid_collaboration_reference/);
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
        `INSERT INTO conversation_pins (
          id, organization_id, conversation_id, message_id, pinned_by
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "pin-cross-tenant",
        "org-2",
        "conversation-1",
        "message-1",
        "principal-other",
      );
  }, /invalid_conversation_pin/);
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

test("attention backfill and runtime use the same owner-admin routing rule", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0000_icy_power_man.sql",
    "0001_abandoned_ultimatum.sql",
    "0002_flashy_mimic.sql",
    "0003_tiny_lilandra.sql",
    "0004_tan_layla_miller.sql",
    "0005_hard_snowbird.sql",
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
    .run("org-routing", "routing", "Routing");
  for (const [id, kind, name] of [
    ["routing-agent", "agent", "Atlas"],
    ["routing-owner", "human", "Owner"],
    ["routing-admin", "human", "Admin"],
    ["routing-member", "human", "Member"],
  ]) {
    database
      .prepare(
        "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
      )
      .run(id, "org-routing", kind, name);
  }
  for (const [id, principalId, role] of [
    ["membership-routing-owner", "routing-owner", "owner"],
    ["membership-routing-admin", "routing-admin", "admin"],
    ["membership-routing-member", "routing-member", "member"],
  ]) {
    database
      .prepare(
        "INSERT INTO memberships (id, organization_id, principal_id, role) VALUES (?, ?, ?, ?)",
      )
      .run(id, "org-routing", principalId, role);
  }
  database
    .prepare(
      "INSERT INTO projects (id, organization_id, slug, name, objective) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      "project-routing",
      "org-routing",
      "routing",
      "Routing",
      "Route accountable attention",
    );
  database
    .prepare(
      `INSERT INTO action_intents (
        id, organization_id, project_id, proposer_id, proposer_kind,
        action_type, target_ref, parameters_json, parameters_hash, risk_tier,
        policy_decision_json, expires_at, idempotency_key, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "intent-routing",
      "org-routing",
      "project-routing",
      "routing-agent",
      "agent",
      "nexus.test.route",
      "nexus:routing",
      "{}",
      "d".repeat(64),
      "medium",
      '{"effect":"require_approval"}',
      "2099-01-01T00:00:00.000Z",
      "routing-test",
      "proposed",
    );
  for (const migration of [
    "0006_wonderful_madame_web.sql",
    "0007_heavy_brood.sql",
  ]) {
    database.exec(
      readFileSync(
        new URL(`../drizzle/${migration}`, import.meta.url),
        "utf8",
      ).replaceAll("--> statement-breakpoint", ""),
    );
  }
  assert.deepEqual(
    database
      .prepare(
        "SELECT principal_id FROM attention_items WHERE intent_id = ? ORDER BY principal_id",
      )
      .all("intent-routing")
      .map((row) => row.principal_id),
    ["routing-admin", "routing-owner"],
  );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO attention_items (
          id, organization_id, principal_id, intent_id, dedupe_key
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "attention-routing-member",
        "org-routing",
        "routing-member",
        "intent-routing",
        "intent:intent-routing:member",
      );
  }, /invalid_attention_reference/);
  database.close();
});
