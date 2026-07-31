import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const expectedTables = [
  "action_intents",
  "agent_definitions",
  "artifact_payloads",
  "artifact_reviews",
  "artifact_supersessions",
  "artifact_versions",
  "artifacts",
  "attention_items",
  "conversation_members",
  "conversation_pins",
  "conversations",
  "engine_run_creations",
  "intent_approvals",
  "intent_artifact_evidence",
  "ledger_entries",
  "memberships",
  "message_payloads",
  "messages",
  "model_connections",
  "objectives",
  "operation_publications",
  "operations",
  "organization_system_principals",
  "organizations",
  "presence_sessions",
  "principals",
  "projects",
  "run_deadline_operations",
  "run_engine_excerpts",
  "run_engine_receipts",
  "run_events",
  "run_leases",
  "run_prompts",
  "runner_admission_policies",
  "runner_admission_policy_capabilities",
  "runner_admission_policy_versions",
  "runner_capability_evidence",
  "runner_capability_nonces",
  "runner_capability_reports",
  "runner_engine_evidence",
  "runner_engine_reports",
  "runner_enrollment_tokens",
  "runner_heartbeat_nonces",
  "runner_lease_nonces",
  "runner_operations",
  "runners",
  "runs",
  "team_members",
  "teams",
  "work_items",
];

test("migration breakpoints never produce an empty SQL chunk", () => {
  const migrations = readdirSync(new URL("../drizzle/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  assert.ok(migrations.length > 0, "expected at least one SQL migration");
  for (const migration of migrations) {
    const sql = readFileSync(
      new URL(`../drizzle/${migration}`, import.meta.url),
      "utf8",
    );
    assert.equal(
      sql
        .split("--> statement-breakpoint")
        .every((statement) => statement.trim().length > 0),
      true,
      `${migration} contains an empty SQL migration chunk`,
    );
  }
});

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
    "action_intents_org_live_idempotency_uidx",
    "agent_definitions_org_slug_uidx",
    "agent_definitions_principal_uidx",
    "artifact_payloads_org_hash_idx",
    "artifact_reviews_active_reviewer_uidx",
    "artifact_reviews_org_version_idx",
    "artifact_reviews_supersedes_uidx",
    "artifact_supersessions_active_source_uidx",
    "artifact_supersessions_org_source_history_idx",
    "artifact_supersessions_org_target_active_idx",
    "artifact_versions_artifact_number_uidx",
    "artifact_versions_org_artifact_idx",
    "artifact_versions_org_content_hash_idx",
    "artifacts_org_updated_idx",
    "artifacts_work_item_updated_idx",
    "attention_items_org_principal_dedupe_uidx",
    "attention_items_org_principal_created_idx",
    "attention_items_org_principal_status_created_idx",
    "conversation_members_conv_principal_uidx",
    "conversation_pins_conv_message_uidx",
    "conversation_pins_org_conv_status_idx",
    "conversations_org_direct_key_uidx",
    "engine_run_creations_org_reconciliation_uidx",
    "engine_run_creations_org_requester_creation_uidx",
    "engine_run_creations_org_run_uidx",
    "engine_run_creations_retention_idx",
    "intent_approvals_intent_actor_uidx",
    "intent_artifact_evidence_active_uidx",
    "intent_artifact_evidence_org_intent_idx",
    "intent_artifact_evidence_version_idx",
    "ledger_entries_org_hash_uidx",
    "ledger_entries_org_payload_kind_idx",
    "ledger_entries_org_sequence_uidx",
    "memberships_org_principal_uidx",
    "model_connections_org_provider_label_uidx",
    "messages_conv_sequence_uidx",
    "objectives_org_ref_uidx",
    "objectives_project_status_idx",
    "operation_publications_org_artifact_uidx",
    "operations_org_created_idx",
    "operations_org_requester_id_uidx",
    "operations_org_run_uidx",
    "presence_sessions_org_expires_idx",
    "presence_sessions_org_principal_uidx",
    "presence_sessions_room_idx",
    "projects_org_slug_uidx",
    "organization_system_principals_principal_uidx",
    "run_deadline_operations_org_applied_idx",
    "run_deadline_operations_org_operation_uidx",
    "run_engine_excerpts_live_key_idx",
    "run_engine_excerpts_org_ref_uidx",
    "run_engine_excerpts_retention_due_idx",
    "run_engine_receipts_org_operation_uidx",
    "run_engine_receipts_org_recorded_idx",
    "run_events_org_occurred_idx",
    "run_leases_active_run_uidx",
    "run_leases_active_runner_uidx",
    "run_leases_org_run_idx",
    "run_leases_run_fence_uidx",
    "run_leases_runner_status_idx",
    "run_prompts_live_key_idx",
    "run_prompts_org_ref_uidx",
    "run_prompts_retention_due_idx",
    "runner_capability_evidence_capability_uidx",
    "runner_capability_nonces_expiry_idx",
    "runner_capability_reports_compaction_idx",
    "runner_capability_reports_org_runner_history_idx",
    "runner_engine_evidence_engine_uidx",
    "runner_engine_reports_compaction_idx",
    "runner_engine_reports_org_runner_history_idx",
    "runner_enrollment_tokens_hash_uidx",
    "runner_enrollment_tokens_org_created_idx",
    "runner_heartbeat_nonces_expires_idx",
    "runner_lease_nonces_expires_idx",
    "runner_operations_applied_idx",
    "runner_operations_compacted_idx",
    "runners_enrollment_token_uidx",
    "runners_org_public_key_uidx",
    "runners_org_id_uidx",
    "runners_org_status_last_seen_idx",
    "runners_principal_uidx",
    "runs_engine_deadline_due_idx",
    "runs_engine_retention_due_idx",
    "runs_org_requested_created_idx",
    "runs_org_status_created_idx",
    "team_members_team_principal_uidx",
    "teams_project_slug_uidx",
    "work_items_objective_status_idx",
    "work_items_org_external_ref_uidx",
    "work_items_org_ref_uidx",
    "work_items_project_status_idx",
  ]) {
    assert.ok(indexes.includes(requiredIndex), `missing index ${requiredIndex}`);
  }
  const liveIdempotencyIndex = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    )
    .get("action_intents_org_live_idempotency_uidx").sql;
  assert.match(
    liveIdempotencyIndex,
    /WHERE .*status.* IN \('draft', 'proposed', 'approved', 'executing'\)/,
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT name, dflt_value, "notnull" AS required
         FROM pragma_table_info('action_intents')
         WHERE name IN ('separation_of_duties', 'self_approval_policy')
         ORDER BY name`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        name: "self_approval_policy",
        dflt_value: null,
        required: 0,
      },
      {
        name: "separation_of_duties",
        dflt_value: "true",
        required: 1,
      },
    ],
  );

  const triggers = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  assert.deepEqual(triggers, [
    "action_intents_prevent_delete",
    "action_intents_restrict_update",
    "agent_definitions_sync_members_after_update",
    "agent_definitions_sync_principal_after_update",
    "agent_definitions_validate_before_insert",
    "agent_definitions_validate_before_update",
    "artifact_payloads_prevent_delete",
    "artifact_payloads_restrict_update",
    "artifact_payloads_validate_before_insert",
    "artifact_reviews_prevent_delete",
    "artifact_reviews_restrict_update",
    "artifact_reviews_validate_before_insert",
    "artifact_supersessions_prevent_delete",
    "artifact_supersessions_restrict_update",
    "artifact_supersessions_validate_before_insert",
    "artifact_versions_prevent_delete",
    "artifact_versions_prevent_update",
    "artifact_versions_validate_before_insert",
    "artifacts_prevent_delete",
    "artifacts_validate_before_insert",
    "artifacts_validate_version_advance",
    "attention_items_prevent_delete",
    "attention_items_prevent_reference_update",
    "attention_items_validate_before_insert",
    "attention_items_validate_lifecycle",
    "conversation_members_prevent_delete",
    "conversation_members_prevent_reference_update",
    "conversation_members_reject_system_principal",
    "conversation_members_require_active_principal",
    "conversation_members_require_owner",
    "conversation_members_validate_before_insert",
    "conversation_members_validate_before_reference_update",
    "conversation_pins_prevent_delete",
    "conversation_pins_prevent_reference_update",
    "conversation_pins_validate_before_insert",
    "conversations_validate_before_insert",
    "conversations_validate_before_reference_update",
    "engine_run_creations_prevent_update",
    "engine_run_creations_restrict_delete",
    "engine_run_creations_validate_before_insert",
    "intent_approvals_prevent_delete",
    "intent_approvals_prevent_replace",
    "intent_approvals_prevent_update",
    "intent_artifact_evidence_prevent_delete",
    "intent_artifact_evidence_restrict_update",
    "intent_artifact_evidence_validate_before_insert",
    "ledger_entries_prevent_delete",
    "ledger_entries_prevent_replace",
    "ledger_entries_prevent_update",
    "ledger_entries_validate_evidence_event",
    "ledger_entries_validate_policy_event",
    "ledger_entries_validate_review_event",
    "ledger_entries_validate_run_event",
    "ledger_entries_validate_run_expired",
    "ledger_entries_validate_runner_event",
    "ledger_entries_validate_supersession_event",
    "messages_prevent_delete",
    "messages_prevent_update",
    "messages_validate_before_insert",
    "objectives_validate_before_insert",
    "objectives_validate_before_update",
    "operation_publications_prevent_delete",
    "operation_publications_prevent_update",
    "operation_publications_validate_before_insert",
    "operations_prevent_delete",
    "operations_prevent_update",
    "operations_validate_before_insert",
    "organization_system_principals_prevent_delete",
    "organization_system_principals_prevent_update",
    "organization_system_principals_validate_before_insert",
    "organizations_provision_deadline_principal_after_insert",
    "presence_sessions_prevent_reference_update",
    "presence_sessions_validate_before_insert",
    "presence_sessions_validate_before_update",
    "principals_protect_system_principal_before_delete",
    "principals_protect_system_principal_before_update",
    "run_deadline_operations_prevent_delete",
    "run_deadline_operations_prevent_replace",
    "run_deadline_operations_prevent_update",
    "run_deadline_operations_validate_before_insert",
    "run_engine_excerpts_prevent_delete",
    "run_engine_excerpts_prevent_replace",
    "run_engine_excerpts_validate_before_insert",
    "run_engine_excerpts_validate_before_update",
    "run_engine_receipts_prevent_delete",
    "run_engine_receipts_prevent_replace",
    "run_engine_receipts_prevent_update",
    "run_engine_receipts_validate_before_insert",
    "run_events_prevent_delete",
    "run_events_prevent_update",
    "run_events_validate_before_insert",
    "run_leases_attach_after_insert",
    "run_leases_detach_after_update",
    "run_leases_prevent_delete",
    "run_leases_validate_before_insert",
    "run_leases_validate_before_update",
    "run_prompts_prevent_delete",
    "run_prompts_prevent_replace",
    "run_prompts_validate_before_insert",
    "run_prompts_validate_before_update",
    "runner_admission_policies_prevent_delete",
    "runner_admission_policies_validate_before_insert",
    "runner_admission_policies_validate_before_update",
    "runner_admission_policy_capabilities_prevent_delete",
    "runner_admission_policy_capabilities_prevent_update",
    "runner_admission_policy_capabilities_validate_before_insert",
    "runner_admission_policy_versions_prevent_delete",
    "runner_admission_policy_versions_prevent_update",
    "runner_admission_policy_versions_validate_before_insert",
    "runner_capability_evidence_prevent_delete",
    "runner_capability_evidence_prevent_replace",
    "runner_capability_evidence_prevent_update",
    "runner_capability_evidence_validate_before_insert",
    "runner_capability_nonces_prevent_replace",
    "runner_capability_nonces_prevent_update",
    "runner_capability_nonces_validate_before_insert",
    "runner_capability_reports_prevent_delete",
    "runner_capability_reports_prevent_replace",
    "runner_capability_reports_validate_before_insert",
    "runner_capability_reports_validate_before_update",
    "runner_engine_evidence_prevent_delete",
    "runner_engine_evidence_prevent_replace",
    "runner_engine_evidence_prevent_update",
    "runner_engine_evidence_validate_before_insert",
    "runner_engine_reports_prevent_delete",
    "runner_engine_reports_prevent_replace",
    "runner_engine_reports_validate_before_insert",
    "runner_engine_reports_validate_before_update",
    "runner_enrollment_tokens_prevent_delete",
    "runner_enrollment_tokens_validate_before_insert",
    "runner_enrollment_tokens_validate_before_update",
    "runner_heartbeat_nonces_prevent_update",
    "runner_heartbeat_nonces_validate_before_insert",
    "runner_lease_nonces_prevent_update",
    "runner_lease_nonces_validate_before_insert",
    "runner_operations_prevent_delete",
    "runner_operations_validate_before_insert",
    "runner_operations_validate_before_update",
    "runners_prevent_delete",
    "runners_validate_before_insert",
    "runners_validate_before_update",
    "runs_prevent_delete",
    "runs_validate_before_insert",
    "runs_validate_before_update",
    "team_members_validate_before_insert",
    "teams_validate_project_before_insert",
    "work_items_validate_before_insert",
    "work_items_validate_before_update",
  ]);
  const leaseDetachTrigger = database
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'run_leases_detach_after_update'`,
    )
    .get().sql;
  assert.match(
    leaseDetachTrigger,
    /WHEN OLD\.`status` = 'active' AND NEW\.`status` <> 'active'/u,
  );
  assert.match(
    leaseDetachTrigger,
    /SET `status` = 'queued',\s+`current_lease_id` = NULL,\s+`version` = `version` \+ 1/u,
  );
  assert.match(
    leaseDetachTrigger,
    /AND `current_lease_id` = NEW\.`id`\s+AND `status` = 'leased'/u,
  );

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
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
    )
    .run(
      "principal-presence-no-membership",
      "org-1",
      "human",
      "Revoked presence human",
    );
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, display_name, status
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-presence-disabled",
      "org-1",
      "agent",
      "Disabled presence agent",
      "disabled",
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
  const presenceExpiry = Math.floor(Date.now() / 1000) + 60;
  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run("org-presence-other", "presence-other", "Presence other tenant");
  database
    .prepare(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
    )
    .run(
      "principal-presence-other",
      "org-presence-other",
      "human",
      "Other presence owner",
    );
  database
    .prepare(
      "INSERT INTO memberships (id, organization_id, principal_id, role) VALUES (?, ?, ?, ?)",
    )
    .run(
      "membership-presence-other",
      "org-presence-other",
      "principal-presence-other",
      "owner",
    );
  database
    .prepare(
      `INSERT INTO presence_sessions (
        id, organization_id, principal_id, session_key, fencing_token,
        status, room_conversation_id, expires_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "presence-1",
      "org-1",
      "principal-1",
      "opaque-session-key-1",
      1,
      "available",
      "conversation-2",
      presenceExpiry,
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO presence_sessions (
          id, organization_id, principal_id, session_key, status,
          room_conversation_id, expires_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "presence-in-direct",
        "org-1",
        "principal-member",
        "opaque-session-key-2",
        "available",
        "conversation-1",
        presenceExpiry,
      );
  }, /invalid_presence_room/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO presence_sessions (
          id, organization_id, principal_id, session_key, status,
          expires_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "presence-invalid-status",
        "org-1",
        "principal-member",
        "opaque-session-key-3",
        "offline",
        presenceExpiry,
      );
  }, /invalid_presence_state/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO presence_sessions (
          id, organization_id, principal_id, session_key, status,
          room_conversation_id, expires_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "presence-cross-tenant-room",
        "org-presence-other",
        "principal-presence-other",
        "opaque-session-key-4",
        "available",
        "conversation-2",
        presenceExpiry,
      );
  }, /invalid_presence_room/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO presence_sessions (
          id, organization_id, principal_id, session_key, status,
          expires_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "presence-cross-tenant-principal",
        "org-presence-other",
        "principal-1",
        "opaque-session-key-5",
        "available",
        presenceExpiry,
      );
  }, /invalid_presence_reference/);
  assert.equal(
    database
      .prepare(
        `UPDATE presence_sessions
         SET status = 'focus', expires_at_epoch = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND fencing_token = ? AND session_key = ?`,
      )
      .run(presenceExpiry, "presence-1", 1, "opaque-session-key-1")
      .changes,
    1,
  );
  assert.equal(
    database
      .prepare(
        `UPDATE presence_sessions
         SET fencing_token = 2, session_key = ?,
             expires_at_epoch = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND fencing_token = ? AND session_key = ?`,
      )
      .run(
        "opaque-session-takeover",
        presenceExpiry,
        "presence-1",
        1,
        "opaque-session-key-1",
      ).changes,
    1,
  );
  assert.equal(
    database
      .prepare(
        `UPDATE presence_sessions
         SET fencing_token = 2, session_key = ?,
             expires_at_epoch = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND fencing_token = ? AND session_key = ?`,
      )
      .run(
        "opaque-session-lost-race",
        presenceExpiry,
        "presence-1",
        1,
        "opaque-session-key-1",
      ).changes,
    0,
  );
  assert.throws(() => {
    database
      .prepare(
        "UPDATE presence_sessions SET fencing_token = 1 WHERE id = ?",
      )
      .run("presence-1");
  }, /presence_stale_session/);
  database
    .prepare(
      "UPDATE presence_sessions SET room_conversation_id = NULL WHERE id = ?",
    )
    .run("presence-1");
  assert.throws(() => {
    database
      .prepare(
        "UPDATE presence_sessions SET principal_id = ? WHERE id = ?",
      )
      .run("principal-member", "presence-1");
  }, /presence_reference_is_immutable/);
  assert.equal(
    database
      .prepare(
        `DELETE FROM presence_sessions
         WHERE id = ? AND fencing_token = ? AND session_key = ?`,
      )
      .run("presence-1", 1, "opaque-session-key-1").changes,
    0,
  );
  assert.equal(
    database
      .prepare(
        `DELETE FROM presence_sessions
         WHERE id = ? AND fencing_token = ? AND session_key = ?`,
      )
      .run("presence-1", 2, "opaque-session-takeover").changes,
    1,
  );
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM presence_sessions")
      .get().count,
    0,
  );
  for (const principalId of [
    "principal-presence-no-membership",
    "agent-presence-disabled",
  ]) {
    assert.throws(() => {
      database
        .prepare(
          `INSERT INTO presence_sessions (
            id, organization_id, principal_id, session_key, status,
            expires_at_epoch
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `presence-rejected-${principalId}`,
          "org-1",
          principalId,
          `opaque-${principalId}`,
          "focus",
          presenceExpiry,
        );
    }, /invalid_presence_reference/);
  }
  database
    .prepare(
      `INSERT INTO presence_sessions (
        id, organization_id, principal_id, session_key, status,
        expires_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "presence-agent",
      "org-1",
      "agent-principal-1",
      "opaque-agent-session",
      "focus",
      presenceExpiry,
    );
  assert.equal(
    database
      .prepare("SELECT status FROM presence_sessions WHERE id = ?")
      .get("presence-agent").status,
    "focus",
    "an active non-human principal can maintain its own future runner lease",
  );
  database
    .prepare("DELETE FROM presence_sessions WHERE id = ?")
    .run("presence-agent");
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
  database
    .prepare(
      `INSERT INTO work_items (
        id, organization_id, project_id, objective_id, ref, title
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "work-1",
      "org-1",
      "project-1",
      "objective-1",
      "WI-00000001",
      "Produce an immutable output",
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifact_payloads (
          id, organization_id, content_hash, byte_size, body_text
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "artifact-payload-invalid",
        "org-1",
        "Z".repeat(64),
        4,
        "test",
      );
  }, /invalid_artifact_payload/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifacts (
          id, organization_id, project_id, work_item_id, title, media_type,
          created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "artifact-invalid-media",
        "org-1",
        "project-1",
        "work-1",
        "Invalid media",
        "application/pdf",
        "principal-1",
      );
  }, /invalid_artifact_metadata/);
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, display_name, status
      ) VALUES (?, ?, 'human', ?, 'disabled')`,
    )
    .run(
      "principal-artifact-inactive",
      "org-1",
      "Inactive artifact producer",
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifacts (
          id, organization_id, project_id, work_item_id, title, created_by
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "artifact-inactive-producer",
        "org-1",
        "project-1",
        "work-1",
        "Inactive producer",
        "principal-artifact-inactive",
      );
  }, /artifact_principal_inactive/);
  database
    .prepare(
      `INSERT INTO artifact_payloads (
        id, organization_id, content_hash, byte_size, body_text
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("artifact-payload-1", "org-1", "d".repeat(64), 8, "# Output");
  database
    .prepare(
      `INSERT INTO artifacts (
        id, organization_id, project_id, work_item_id, title, created_by
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "artifact-1",
      "org-1",
      "project-1",
      "work-1",
      "Rollout plan",
      "principal-1",
    );
  database
    .prepare(
      `INSERT INTO artifact_versions (
        id, organization_id, artifact_id, version_number, content_ref,
        content_hash, byte_size, note, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "artifact-version-1",
      "org-1",
      "artifact-1",
      1,
      "artifact-payload-1",
      "d".repeat(64),
      8,
      "Initial",
      "principal-1",
    );
  database
    .prepare(
      "UPDATE artifacts SET current_version = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .run("artifact-1");
  assert.equal(
    database
      .prepare("SELECT current_version FROM artifacts WHERE id = ?")
      .get("artifact-1").current_version,
    1,
  );
  database
    .prepare(
      `INSERT INTO objectives (
        id, organization_id, project_id, ref, title
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "objective-2",
      "org-1",
      "project-2",
      "OBJ-00000002",
      "Second project outcome",
    );
  database
    .prepare(
      `INSERT INTO work_items (
        id, organization_id, project_id, objective_id, ref, title
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "work-2",
      "org-1",
      "project-2",
      "objective-2",
      "WI-00000002",
      "Produce cross-project evidence",
    );
  database
    .prepare(
      `INSERT INTO artifact_payloads (
        id, organization_id, content_hash, byte_size, body_text
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("artifact-payload-2", "org-1", "9".repeat(64), 7, "# Other");
  database
    .prepare(
      `INSERT INTO artifacts (
        id, organization_id, project_id, work_item_id, title, created_by
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "artifact-2",
      "org-1",
      "project-2",
      "work-2",
      "Other project artifact",
      "principal-1",
    );
  database
    .prepare(
      `INSERT INTO artifact_versions (
        id, organization_id, artifact_id, version_number, content_ref,
        content_hash, byte_size, note, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "artifact-version-2",
      "org-1",
      "artifact-2",
      1,
      "artifact-payload-2",
      "9".repeat(64),
      7,
      "Cross-project candidate",
      "principal-1",
    );
  database
    .prepare(
      "UPDATE artifacts SET current_version = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .run("artifact-2");
  database
    .prepare(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, ?, ?)",
    )
    .run("principal-review-viewer", "org-1", "human", "Review viewer");
  database
    .prepare(
      "INSERT INTO memberships (id, organization_id, principal_id, role) VALUES (?, ?, ?, ?)",
    )
    .run(
      "membership-review-viewer",
      "org-1",
      "principal-review-viewer",
      "viewer",
    );
  database
    .prepare(
      "INSERT INTO memberships (id, organization_id, principal_id, role) VALUES (?, ?, ?, ?)",
    )
    .run(
      "membership-review-agent",
      "org-1",
      "agent-principal-1",
      "member",
    );
  for (const [reviewId, reviewerId] of [
    ["review-agent-forbidden", "agent-principal-1"],
    ["review-viewer-forbidden", "principal-review-viewer"],
  ]) {
    assert.throws(() => {
      database
        .prepare(
          `INSERT INTO artifact_reviews (
            id, organization_id, artifact_id, artifact_version_id,
            version_number, content_hash, byte_size, verdict, reason_code,
            reviewer_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reviewId,
          "org-1",
          "artifact-1",
          "artifact-version-1",
          1,
          "d".repeat(64),
          8,
          "changes_requested",
          "needs_evidence",
          reviewerId,
        );
    }, /artifact_reviewer_ineligible/);
  }
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifact_reviews (
          id, organization_id, artifact_id, artifact_version_id,
          version_number, content_hash, byte_size, verdict, reason_code,
          reviewer_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "review-forged-version",
        "org-1",
        "artifact-1",
        "artifact-version-1",
        1,
        "e".repeat(64),
        8,
        "approved",
        "complete",
        "principal-member",
      );
  }, /invalid_artifact_review_reference/);
  database
    .prepare(
      `INSERT INTO artifact_reviews (
        id, organization_id, artifact_id, artifact_version_id,
        version_number, content_hash, byte_size, verdict, reason_code,
        reviewer_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "review-1",
      "org-1",
      "artifact-1",
      "artifact-version-1",
      1,
      "d".repeat(64),
      8,
      "approved",
      "complete",
      "principal-member",
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifact_reviews (
          id, organization_id, artifact_id, artifact_version_id,
          version_number, content_hash, byte_size, verdict, reason_code,
          reviewer_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "review-duplicate-active",
        "org-1",
        "artifact-1",
        "artifact-version-1",
        1,
        "d".repeat(64),
        8,
        "changes_requested",
        "outdated",
        "principal-member",
      );
  }, /invalid_review_supersession|UNIQUE constraint failed/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifact_reviews (
          id, organization_id, artifact_id, artifact_version_id,
          version_number, content_hash, byte_size, verdict, reason_code,
          reviewer_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "review-invalid-reason",
        "org-1",
        "artifact-1",
        "artifact-version-1",
        1,
        "d".repeat(64),
        8,
        "approved",
        "needs_correction",
        "principal-1",
      );
  }, /invalid_artifact_review/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifact_reviews (
          id, organization_id, artifact_id, artifact_version_id,
          version_number, content_hash, byte_size, verdict, reason_code,
          reviewer_id, self_review_policy
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "review-self-with-peer",
        "org-1",
        "artifact-1",
        "artifact-version-1",
        1,
        "d".repeat(64),
        8,
        "approved",
        "accurate",
        "principal-1",
        "solo_owner_ack",
      );
  }, /artifact_self_review_forbidden/);
  database
    .prepare(
      `INSERT INTO artifact_reviews (
        id, organization_id, artifact_id, artifact_version_id,
        version_number, content_hash, byte_size, verdict, reason_code,
        reviewer_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "review-self-changes",
      "org-1",
      "artifact-1",
      "artifact-version-1",
      1,
      "d".repeat(64),
      8,
      "changes_requested",
      "needs_correction",
      "principal-1",
    );
  database
    .prepare(
      "UPDATE memberships SET status = 'suspended' WHERE id = ?",
    )
    .run("membership-member");
  database
    .prepare(
      `INSERT INTO artifact_reviews (
        id, organization_id, artifact_id, artifact_version_id,
        version_number, content_hash, byte_size, verdict, reason_code,
        reviewer_id, self_review_policy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "review-solo-owner",
      "org-1",
      "artifact-2",
      "artifact-version-2",
      1,
      "9".repeat(64),
      7,
      "approved",
      "accurate",
      "principal-1",
      "solo_owner_ack",
    );
  database
    .prepare(
      "UPDATE memberships SET status = 'active' WHERE id = ?",
    )
    .run("membership-member");
  const reviewSupersededAt = "2026-07-26T12:00:00.000Z";
  database
    .prepare(
      `UPDATE artifact_reviews
       SET status = 'superseded', superseded_by = ?,
           superseded_at = ?
       WHERE id = ?`,
    )
    .run("principal-member", reviewSupersededAt, "review-1");
  database
    .prepare(
      `INSERT INTO artifact_reviews (
        id, organization_id, artifact_id, artifact_version_id,
        version_number, content_hash, byte_size, verdict, reason_code,
        reviewer_id, supersedes_review_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "review-2",
      "org-1",
      "artifact-1",
      "artifact-version-1",
      1,
      "d".repeat(64),
      8,
      "changes_requested",
      "needs_evidence",
      "principal-member",
      "review-1",
      reviewSupersededAt,
    );
  assert.throws(() => {
    database
      .prepare("UPDATE artifact_reviews SET reason_code = ? WHERE id = ?")
      .run("outdated", "review-2");
  }, /artifact_review_is_immutable/);
  assert.throws(() => {
    database.prepare("DELETE FROM artifact_reviews WHERE id = ?")
      .run("review-2");
  }, /artifact_review_is_immutable/);
  database
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, previous_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ledger-review-superseded",
      "org-1",
      1,
      "review.superseded",
      "principal-member",
      reviewSupersededAt,
      "6".repeat(64),
      "nexus://artifact-review/review-1",
      "0".repeat(64),
      "7".repeat(64),
    );
  database
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, previous_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ledger-review-recorded",
      "org-1",
      2,
      "review.recorded",
      "principal-member",
      reviewSupersededAt,
      "6".repeat(64),
      "nexus://artifact-review/review-2",
      "7".repeat(64),
      "8".repeat(64),
    );
  for (const [ledgerId, actorId, payloadRef] of [
    [
      "ledger-review-forged-ref",
      "principal-member",
      "nexus://artifact-review/missing",
    ],
    [
      "ledger-review-forged-actor",
      "principal-1",
      "nexus://artifact-review/review-2",
    ],
  ]) {
    assert.throws(() => {
      database
        .prepare(
          `INSERT INTO ledger_entries (
            id, organization_id, sequence, kind, actor_id, occurred_at,
            payload_hash, payload_ref, previous_hash, hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ledgerId,
          "org-1",
          3,
          "review.recorded",
          actorId,
          reviewSupersededAt,
          "6".repeat(64),
          payloadRef,
          "8".repeat(64),
          "b".repeat(64),
        );
    }, /invalid_review_ledger_event/);
  }
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO ledger_entries (
          id, organization_id, sequence, kind, actor_id, occurred_at,
          payload_hash, payload_ref, previous_hash, hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "ledger-review-duplicate",
        "org-1",
        3,
        "review.recorded",
        "principal-member",
        reviewSupersededAt,
        "6".repeat(64),
        "nexus://artifact-review/review-2",
        "8".repeat(64),
        "a".repeat(64),
      );
  }, /duplicate_review_ledger_event/);
  const insertSupersession = ({
    id,
    sourceArtifactId,
    sourceVersionId,
    sourceVersionNumber,
    sourceHash,
    sourceSize,
    targetArtifactId,
    targetVersionId,
    targetVersionNumber,
    targetHash,
    targetSize,
    actorId = "principal-1",
    declaredAt = "2026-07-26T13:00:00.000Z",
  }) =>
    database
      .prepare(
        `INSERT INTO artifact_supersessions (
          id, organization_id, source_artifact_id, source_version_id,
          source_version_number, source_content_hash, source_byte_size,
          target_artifact_id, target_version_id, target_version_number,
          target_content_hash, target_byte_size, reason_code, declared_by,
          declared_at
        ) VALUES (?, 'org-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  'replaced_by_revision', ?, ?)`,
      )
      .run(
        id,
        sourceArtifactId,
        sourceVersionId,
        sourceVersionNumber,
        sourceHash,
        sourceSize,
        targetArtifactId,
        targetVersionId,
        targetVersionNumber,
        targetHash,
        targetSize,
        actorId,
        declaredAt,
      );
  const relationOne = {
    id: "supersession-1",
    sourceArtifactId: "artifact-1",
    sourceVersionId: "artifact-version-1",
    sourceVersionNumber: 1,
    sourceHash: "d".repeat(64),
    sourceSize: 8,
    targetArtifactId: "artifact-2",
    targetVersionId: "artifact-version-2",
    targetVersionNumber: 1,
    targetHash: "9".repeat(64),
    targetSize: 7,
  };
  assert.throws(
    () => insertSupersession({ ...relationOne, id: "supersession-member", actorId: "principal-member" }),
    /artifact_supersession_actor_ineligible/,
  );
  assert.throws(
    () => insertSupersession({ ...relationOne, id: "supersession-agent", actorId: "agent-principal-1" }),
    /artifact_supersession_actor_ineligible/,
  );
  assert.throws(
    () =>
      insertSupersession({
        ...relationOne,
        id: "supersession-self",
        targetArtifactId: "artifact-1",
        targetVersionId: "artifact-version-1",
        targetHash: "d".repeat(64),
        targetSize: 8,
      }),
    /invalid_artifact_supersession/,
  );
  assert.throws(
    () =>
      insertSupersession({
        ...relationOne,
        id: "supersession-forged-head",
        sourceHash: "e".repeat(64),
      }),
    /artifact_supersession_head_moved/,
  );
  insertSupersession(relationOne);
  assert.throws(
    () => insertSupersession({ ...relationOne, id: "supersession-duplicate" }),
    /artifact_supersession_exists|UNIQUE constraint failed/,
  );
  const supersessionDeclaredAt = database
    .prepare(
      "SELECT declared_at FROM artifact_supersessions WHERE id = ?",
    )
    .get("supersession-1").declared_at;
  database
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, previous_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ledger-supersession-declared",
      "org-1",
      900,
      "supersession.declared",
      "principal-1",
      supersessionDeclaredAt,
      "a".repeat(64),
      "nexus://artifact-supersession/supersession-1",
      "8".repeat(64),
      "9".repeat(64),
    );
  const supersessionRetractedAt = "2026-07-26T13:10:00.000Z";
  database
    .prepare(
      `UPDATE artifact_supersessions
       SET status = 'retracted', retraction_reason_code = ?,
           retracted_by = ?, retracted_at = ?
       WHERE id = ?`,
    )
    .run(
      "declared_in_error",
      "principal-1",
      supersessionRetractedAt,
      "supersession-1",
    );
  database
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, previous_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ledger-supersession-retracted",
      "org-1",
      901,
      "supersession.retracted",
      "principal-1",
      supersessionRetractedAt,
      "b".repeat(64),
      "nexus://artifact-supersession/supersession-1",
      "9".repeat(64),
      "c".repeat(64),
    );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO ledger_entries (
            id, organization_id, sequence, kind, actor_id, occurred_at,
            payload_hash, payload_ref, previous_hash, hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "ledger-supersession-duplicate",
          "org-1",
          902,
          "supersession.retracted",
          "principal-1",
          supersessionRetractedAt,
          "b".repeat(64),
          "nexus://artifact-supersession/supersession-1",
          "c".repeat(64),
          "d".repeat(64),
        ),
    /duplicate_supersession_ledger_event/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE artifact_supersessions SET reason_code = ? WHERE id = ?",
        )
        .run("scope_moved", "supersession-1"),
    /artifact_supersession_is_immutable/,
  );
  assert.throws(
    () =>
      database
        .prepare("DELETE FROM artifact_supersessions WHERE id = ?")
        .run("supersession-1"),
    /artifact_supersession_is_immutable/,
  );
  database
    .prepare(
      `INSERT INTO artifact_payloads (
        id, organization_id, content_hash, byte_size, body_text
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("artifact-payload-3", "org-1", "8".repeat(64), 7, "# Third");
  database
    .prepare(
      `INSERT INTO artifacts (
        id, organization_id, project_id, work_item_id, title, created_by
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "artifact-3",
      "org-1",
      "project-2",
      "work-2",
      "Third artifact",
      "principal-1",
    );
  database
    .prepare(
      `INSERT INTO artifact_versions (
        id, organization_id, artifact_id, version_number, content_ref,
        content_hash, byte_size, note, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "artifact-version-3",
      "org-1",
      "artifact-3",
      1,
      "artifact-payload-3",
      "8".repeat(64),
      7,
      "",
      "principal-1",
    );
  database
    .prepare(
      "UPDATE artifacts SET current_version = 1 WHERE id = ?",
    )
    .run("artifact-3");
  database
    .prepare(
      `INSERT INTO artifact_payloads (
        id, organization_id, content_hash, byte_size, body_text
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("artifact-payload-1b", "org-1", "a".repeat(64), 8, "new-head");
  database
    .prepare(
      `INSERT INTO artifact_versions (
        id, organization_id, artifact_id, version_number, content_ref,
        content_hash, byte_size, note, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "artifact-version-1b",
      "org-1",
      "artifact-1",
      2,
      "artifact-payload-1b",
      "a".repeat(64),
      8,
      "",
      "principal-1",
    );
  database
    .prepare(
      "UPDATE artifacts SET current_version = 2 WHERE id = ?",
    )
    .run("artifact-1");
  insertSupersession({
    id: "supersession-2",
    sourceArtifactId: "artifact-2",
    sourceVersionId: "artifact-version-2",
    sourceVersionNumber: 1,
    sourceHash: "9".repeat(64),
    sourceSize: 7,
    targetArtifactId: "artifact-3",
    targetVersionId: "artifact-version-3",
    targetVersionNumber: 1,
    targetHash: "8".repeat(64),
    targetSize: 7,
  });
  insertSupersession({
    id: "supersession-3",
    sourceArtifactId: "artifact-3",
    sourceVersionId: "artifact-version-3",
    sourceVersionNumber: 1,
    sourceHash: "8".repeat(64),
    sourceSize: 7,
    targetArtifactId: "artifact-1",
    targetVersionId: "artifact-version-1b",
    targetVersionNumber: 2,
    targetHash: "a".repeat(64),
    targetSize: 8,
  });
  assert.throws(
    () =>
      insertSupersession({
        id: "supersession-recursive-cycle",
        sourceArtifactId: "artifact-1",
        sourceVersionId: "artifact-version-1b",
        sourceVersionNumber: 2,
        sourceHash: "a".repeat(64),
        sourceSize: 8,
        targetArtifactId: "artifact-2",
        targetVersionId: "artifact-version-2",
        targetVersionNumber: 1,
        targetHash: "9".repeat(64),
        targetSize: 7,
      }),
    /artifact_supersession_cycle/,
  );
  database
    .prepare(
      `INSERT INTO action_intents (
        id, organization_id, project_id, proposer_id, proposer_kind,
        action_type, target_ref, parameters_json, parameters_hash,
        risk_tier, policy_decision_json, expires_at, idempotency_key, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "intent-evidence-1",
      "org-1",
      "project-1",
      "agent-principal-1",
      "agent",
      "nexus.test.evidence",
      "nexus:test:evidence",
      "{}",
      "f".repeat(64),
      "medium",
      '{"effect":"require_approval"}',
      "2099-01-01T00:00:00.000Z",
      "evidence-test",
      "proposed",
    );
  database
    .prepare(
      `INSERT INTO intent_artifact_evidence (
        id, organization_id, intent_id, artifact_id, artifact_version_id,
        content_hash, byte_size, relation, added_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "evidence-1",
      "org-1",
      "intent-evidence-1",
      "artifact-1",
      "artifact-version-1",
      "d".repeat(64),
      8,
      "basis",
      "principal-member",
    );
  const evidenceCreatedAt = database
    .prepare(
      "SELECT created_at FROM intent_artifact_evidence WHERE id = ?",
    )
    .get("evidence-1").created_at;
  database
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, intent_id, previous_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ledger-evidence-1",
      "org-1",
      3,
      "evidence.linked",
      "principal-member",
      evidenceCreatedAt,
      "6".repeat(64),
      "nexus://intent-evidence/evidence-1",
      "intent-evidence-1",
      "8".repeat(64),
      "1".repeat(64),
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO ledger_entries (
          id, organization_id, sequence, kind, actor_id, occurred_at,
          payload_hash, payload_ref, intent_id, previous_hash, hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "ledger-evidence-duplicate",
        "org-1",
        4,
        "evidence.linked",
        "principal-member",
        evidenceCreatedAt,
        "6".repeat(64),
        "nexus://intent-evidence/evidence-1",
        "intent-evidence-1",
        "1".repeat(64),
        "2".repeat(64),
      );
  }, /duplicate_evidence_ledger_event/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO ledger_entries (
          id, organization_id, sequence, kind, actor_id, occurred_at,
          payload_hash, payload_ref, intent_id, previous_hash, hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "ledger-evidence-forged-ref",
        "org-1",
        4,
        "evidence.linked",
        "principal-member",
        evidenceCreatedAt,
        "6".repeat(64),
        "nexus://intent-evidence/missing",
        "intent-evidence-1",
        "1".repeat(64),
        "3".repeat(64),
      );
  }, /invalid_evidence_ledger_event/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO intent_artifact_evidence (
          id, organization_id, intent_id, artifact_id, artifact_version_id,
          content_hash, byte_size, relation, added_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "evidence-active-duplicate",
        "org-1",
        "intent-evidence-1",
        "artifact-1",
        "artifact-version-1",
        "d".repeat(64),
        8,
        "basis",
        "principal-1",
      );
  }, /UNIQUE constraint failed/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO intent_artifact_evidence (
          id, organization_id, intent_id, artifact_id, artifact_version_id,
          content_hash, byte_size, relation, added_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "evidence-cross-project",
        "org-1",
        "intent-evidence-1",
        "artifact-2",
        "artifact-version-2",
        "9".repeat(64),
        7,
        "basis",
        "principal-1",
      );
  }, /invalid_evidence_reference/);
  database
    .prepare(
      `UPDATE artifact_payloads
       SET body_text = NULL, erased_at = ?
       WHERE id = ?`,
    )
    .run("2026-07-26T13:00:00.000Z", "artifact-payload-2");
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifact_reviews (
          id, organization_id, artifact_id, artifact_version_id,
          version_number, content_hash, byte_size, verdict, reason_code,
          reviewer_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "review-erased-payload",
        "org-1",
        "artifact-2",
        "artifact-version-2",
        1,
        "9".repeat(64),
        7,
        "approved",
        "complete",
        "principal-member",
      );
  }, /invalid_artifact_review_reference/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO intent_artifact_evidence (
          id, organization_id, intent_id, artifact_id, artifact_version_id,
          content_hash, byte_size, relation, added_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "evidence-cross-tenant",
        "org-2",
        "intent-evidence-1",
        "artifact-1",
        "artifact-version-1",
        "d".repeat(64),
        8,
        "basis",
        "principal-other",
      );
  }, /invalid_evidence_reference/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO intent_artifact_evidence (
          id, organization_id, intent_id, artifact_id, artifact_version_id,
          content_hash, byte_size, relation, added_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "outcome-while-proposed",
        "org-1",
        "intent-evidence-1",
        "artifact-1",
        "artifact-version-1",
        "d".repeat(64),
        8,
        "outcome",
        "agent-principal-1",
      );
  }, /evidence_phase_invalid/);
  database
    .prepare(
      `INSERT INTO action_intents (
        id, organization_id, project_id, proposer_id, proposer_kind,
        action_type, target_ref, parameters_json, parameters_hash,
        risk_tier, policy_decision_json, expires_at, idempotency_key, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "intent-outcome-1",
      "org-1",
      "project-1",
      "agent-principal-1",
      "agent",
      "nexus.test.outcome",
      "nexus:test:outcome",
      "{}",
      "b".repeat(64),
      "medium",
      '{"effect":"allow"}',
      "2099-01-01T00:00:00.000Z",
      "outcome-test",
      "executing",
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO intent_artifact_evidence (
          id, organization_id, intent_id, artifact_id, artifact_version_id,
          content_hash, byte_size, relation, added_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "basis-while-executing",
        "org-1",
        "intent-outcome-1",
        "artifact-1",
        "artifact-version-1",
        "d".repeat(64),
        8,
        "basis",
        "principal-1",
      );
  }, /evidence_phase_invalid/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO intent_artifact_evidence (
          id, organization_id, intent_id, artifact_id, artifact_version_id,
          content_hash, byte_size, relation, added_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "outcome-human",
        "org-1",
        "intent-outcome-1",
        "artifact-1",
        "artifact-version-1",
        "d".repeat(64),
        8,
        "outcome",
        "principal-1",
      );
  }, /evidence_principal_inactive/);
  database
    .prepare(
      `INSERT INTO intent_artifact_evidence (
        id, organization_id, intent_id, artifact_id, artifact_version_id,
        content_hash, byte_size, relation, added_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "outcome-agent",
      "org-1",
      "intent-outcome-1",
      "artifact-1",
      "artifact-version-1",
      "d".repeat(64),
      8,
      "outcome",
      "agent-principal-1",
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO intent_artifact_evidence (
          id, organization_id, intent_id, artifact_id, artifact_version_id,
          content_hash, byte_size, relation, added_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "evidence-forged",
        "org-1",
        "intent-evidence-1",
        "artifact-1",
        "artifact-version-1",
        "a".repeat(64),
        8,
        "basis",
        "principal-1",
      );
  }, /invalid_evidence_reference/);
  assert.throws(() => {
    database
      .prepare(
        "UPDATE intent_artifact_evidence SET content_hash = ? WHERE id = ?",
      )
      .run("a".repeat(64), "evidence-1");
  }, /evidence_is_immutable/);
  assert.throws(() => {
    database
      .prepare("DELETE FROM intent_artifact_evidence WHERE id = ?")
      .run("evidence-1");
  }, /evidence_is_immutable/);
  assert.equal(
    database
      .prepare(
        `UPDATE intent_artifact_evidence
         SET status = 'superseded', superseded_by = ?,
             superseded_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run("principal-member", "evidence-1").changes,
    1,
  );
  database
    .prepare(
      `INSERT INTO intent_artifact_evidence (
        id, organization_id, intent_id, artifact_id, artifact_version_id,
        content_hash, byte_size, relation, added_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "evidence-2",
      "org-1",
      "intent-evidence-1",
      "artifact-1",
      "artifact-version-1",
      "d".repeat(64),
      8,
      "basis",
      "principal-1",
    );
  database
    .prepare(
      `INSERT INTO intent_approvals (
        id, intent_id, actor_id, actor_kind, parameters_hash, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "approval-evidence-1",
      "intent-evidence-1",
      "principal-member",
      "human",
      "f".repeat(64),
      "2026-07-30T12:00:00.000Z",
    );
  database
    .prepare(
      `UPDATE action_intents
       SET status = 'approved', updated_at = ?
       WHERE id = ?`,
    )
    .run("2026-07-30T12:00:00.000Z", "intent-evidence-1");
  assert.throws(() => {
    database
      .prepare(
        `UPDATE intent_artifact_evidence
         SET status = 'superseded', superseded_by = ?,
             superseded_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run("principal-1", "evidence-2");
  }, /evidence_is_immutable/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO intent_artifact_evidence (
          id, organization_id, intent_id, artifact_id, artifact_version_id,
          content_hash, byte_size, relation, added_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "evidence-after-decision",
        "org-1",
        "intent-evidence-1",
        "artifact-1",
        "artifact-version-1",
        "d".repeat(64),
        8,
        "basis",
        "principal-1",
      );
  }, /evidence_phase_invalid/);
  assert.throws(() => {
    database
      .prepare("UPDATE artifact_versions SET note = ? WHERE id = ?")
      .run("Mutated", "artifact-version-1");
  }, /artifact_version_is_immutable/);
  assert.throws(() => {
    database
      .prepare("DELETE FROM artifact_versions WHERE id = ?")
      .run("artifact-version-1");
  }, /artifact_version_is_immutable/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifact_versions (
          id, organization_id, artifact_id, version_number, content_ref,
          content_hash, byte_size, note, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "artifact-version-gap",
        "org-1",
        "artifact-1",
        4,
        "artifact-payload-1",
        "d".repeat(64),
        8,
        "Must reject a gap",
        "principal-1",
      );
  }, /artifact_version_conflict/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifact_versions (
          id, organization_id, artifact_id, version_number, content_ref,
          content_hash, byte_size, note, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "artifact-version-size-mismatch",
        "org-1",
        "artifact-1",
        3,
        "artifact-payload-1",
        "d".repeat(64),
        7,
        "Must reject mismatched payload metadata",
        "principal-1",
      );
  }, /invalid_artifact_payload_ref/);
  database
    .prepare(
      `INSERT INTO artifact_payloads (
        id, organization_id, content_hash, byte_size, body_text
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "artifact-payload-other-org",
      "org-2",
      "e".repeat(64),
      7,
      "# Other",
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifact_versions (
          id, organization_id, artifact_id, version_number, content_ref,
          content_hash, byte_size, note, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "artifact-version-cross-tenant-payload",
        "org-1",
        "artifact-1",
        3,
        "artifact-payload-other-org",
        "e".repeat(64),
        7,
        "Must reject a cross-tenant payload",
        "principal-1",
      );
  }, /invalid_artifact_payload_ref/);
  assert.throws(() => {
    database
      .prepare("UPDATE artifacts SET current_version = 2 WHERE id = ?")
      .run("artifact-1");
  }, /artifact_version_conflict/);
  assert.throws(() => {
    database
      .prepare("UPDATE artifact_payloads SET body_text = ? WHERE id = ?")
      .run("Changed", "artifact-payload-1");
  }, /artifact_payload_is_immutable/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifacts (
          id, organization_id, project_id, work_item_id, title, created_by
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "artifact-cross-project",
        "org-1",
        "project-2",
        "work-1",
        "Cross-project output",
        "principal-1",
      );
  }, /invalid_artifact_reference/);
  assert.throws(() => {
    database.prepare("DELETE FROM artifacts WHERE id = ?").run("artifact-1");
  }, /artifact_is_immutable/);
  assert.throws(() => {
    database
      .prepare("DELETE FROM artifact_payloads WHERE id = ?")
      .run("artifact-payload-1");
  }, /artifact_payload_is_immutable/);
  assert.throws(() => {
    database
      .prepare(
        "UPDATE artifact_payloads SET erased_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
      .run("artifact-payload-1");
  }, /artifact_payload_is_immutable/);
  assert.throws(() => {
    database
      .prepare("UPDATE artifact_payloads SET body_text = NULL WHERE id = ?")
      .run("artifact-payload-1");
  }, /artifact_payload_is_immutable/);
  assert.equal(
    database
      .prepare(
        `UPDATE artifact_payloads
         SET body_text = NULL, erased_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run("artifact-payload-1").changes,
    1,
  );
  const erasedArtifactPayload = database
    .prepare(
      "SELECT body_text, erased_at FROM artifact_payloads WHERE id = ?",
    )
    .get("artifact-payload-1");
  assert.equal(erasedArtifactPayload.body_text, null);
  assert.equal(typeof erasedArtifactPayload.erased_at, "string");
  assert.equal(
    database
      .prepare(
        "SELECT content_hash FROM intent_artifact_evidence WHERE id = ?",
      )
      .get("evidence-2").content_hash,
    "d".repeat(64),
  );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO artifact_versions (
          id, organization_id, artifact_id, version_number, content_ref,
          content_hash, byte_size, note, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "artifact-version-erased-payload",
        "org-1",
        "artifact-1",
        3,
        "artifact-payload-1",
        "d".repeat(64),
        8,
        "Must reject an erased payload",
        "principal-1",
      );
  }, /invalid_artifact_payload_ref/);
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

test("runner migration enforces identity, lifecycle and ledger references", () => {
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
      ).replaceAll("--> statement-breakpoint", ""),
    );
  }
  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run("org-runner", "runner", "Runner");
  database
    .prepare(
      "INSERT INTO principals (id, organization_id, kind, display_name) VALUES (?, ?, 'human', ?)",
    )
    .run("owner-runner", "org-runner", "Runner owner");
  database
    .prepare(
      "INSERT INTO memberships (id, organization_id, principal_id, role) VALUES (?, ?, ?, 'owner')",
    )
    .run("membership-runner", "org-runner", "owner-runner");
  database
    .prepare(
      `INSERT INTO runner_enrollment_tokens (
        id, organization_id, token_hash, issued_by, display_name,
        issued_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "token-runner",
      "org-runner",
      "a".repeat(64),
      "owner-runner",
      "Build runner",
      "2026-07-26T12:00:00.000Z",
      "2026-07-26T12:15:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, previous_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ledger-token-issued",
      "org-runner",
      1,
      "runner_token.issued",
      "owner-runner",
      "2026-07-26T12:00:00.000Z",
      "b".repeat(64),
      "nexus://runner-enrollment-tokens/token-runner",
      "0".repeat(64),
      "1".repeat(64),
    );
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, external_id, display_name
      ) VALUES (?, ?, 'runner', ?, ?)`,
    )
    .run(
      "principal-runner",
      "org-runner",
      "runner-1",
      "Build runner",
    );
  database
    .prepare(
      `INSERT INTO runners (
        id, organization_id, principal_id, enrollment_token_id,
        display_name, public_key, enrolled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "runner-1",
      "org-runner",
      "principal-runner",
      "token-runner",
      "Build runner",
      "A".repeat(43),
      "2026-07-26T12:01:00.000Z",
    );
  database
    .prepare(
      `UPDATE runner_enrollment_tokens
       SET consumed_at = ?, consumed_runner_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      "2026-07-26T12:01:00.000Z",
      "runner-1",
      "2026-07-26T12:01:00.000Z",
      "token-runner",
    );
  database
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, previous_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ledger-runner-enrolled",
      "org-runner",
      2,
      "runner.enrolled",
      "principal-runner",
      "2026-07-26T12:01:00.000Z",
      "c".repeat(64),
      "nexus://runners/runner-1",
      "1".repeat(64),
      "2".repeat(64),
    );
  database
    .prepare(
      `INSERT INTO runner_heartbeat_nonces (
        organization_id, runner_id, nonce, request_hash, response_status,
        response_body, occurred_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "org-runner",
      "runner-1",
      "A".repeat(22),
      "d".repeat(64),
      200,
      "{}",
      "2026-07-26T12:02:00.000Z",
      "2026-07-26T12:17:00.000Z",
    );

  const insertCapabilityReport = database.prepare(
    `INSERT INTO runner_capability_reports (
      organization_id, runner_id, report_id, request_hash,
      declaration_hash, schema_version, platform_os, platform_arch,
      node_version, collected_at, received_at, truncated,
      response_status, response_body
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, 201, ?)`,
  );
  const firstReportId = `cap_${"0".repeat(32)}`;
  insertCapabilityReport.run(
    "org-runner",
    "runner-1",
    firstReportId,
    "e".repeat(64),
    "f".repeat(64),
    "linux",
    "x64",
    "v22.14.0",
    "2026-07-26T12:02:00.000Z",
    "2026-07-26T12:03:00.000Z",
    '{"reportId":"cap_00000000000000000000000000000000"}',
  );
  database
    .prepare(
      `INSERT INTO runner_capability_evidence (
        runner_id, report_id, position, capability, status,
        detection, reason_code, version
      ) VALUES (?, ?, 0, 'node_permission_model', 'available',
        'node_flag', 'none', 'v22.14.0')`,
    )
    .run("runner-1", firstReportId);
  database
    .prepare(
      `INSERT INTO runner_capability_evidence (
        runner_id, report_id, position, capability, status,
        detection, reason_code, version
      ) VALUES (?, ?, 1, 'bubblewrap', 'available',
        'binary_version', 'none', '0.11.0')`,
    )
    .run("runner-1", firstReportId);
  database
    .prepare(
      `INSERT INTO runner_capability_nonces (
        organization_id, runner_id, nonce, request_hash, response_status,
        response_body, occurred_at, expires_at
      ) VALUES (?, ?, ?, ?, 201, ?, ?, ?)`,
    )
    .run(
      "org-runner",
      "runner-1",
      "C".repeat(22),
      "a".repeat(64),
      "{}",
      "2026-07-26T12:03:00.000Z",
      "2026-07-26T12:18:00.000Z",
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT OR REPLACE INTO runner_capability_reports (
          organization_id, runner_id, report_id, request_hash,
          declaration_hash, schema_version, platform_os, platform_arch,
          node_version, collected_at, received_at, truncated,
          response_status, response_body
        ) VALUES (?, ?, ?, ?, ?, 1, 'linux', 'x64', 'v22.14.0',
          ?, ?, 0, 201, '{}')`,
      )
      .run(
        "org-runner",
        "runner-1",
        firstReportId,
        "1".repeat(64),
        "2".repeat(64),
        "2026-07-26T12:02:00.000Z",
        "2026-07-26T12:03:00.000Z",
      );
  }, /capability_report_already_exists/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT OR REPLACE INTO runner_capability_evidence (
          runner_id, report_id, position, capability, status,
          detection, reason_code
        ) VALUES (?, ?, 0, 'node_permission_model', 'unknown',
          'none', 'unknown')`,
      )
      .run("runner-1", firstReportId);
  }, /capability_evidence_already_exists/);
  const originalBubblewrap = database
    .prepare(
      `SELECT position, capability, status, detection, reason_code, version
       FROM runner_capability_evidence
       WHERE runner_id = ? AND report_id = ? AND capability = 'bubblewrap'`,
    )
    .get("runner-1", firstReportId);
  assert.throws(() => {
    database
      .prepare(
        `INSERT OR REPLACE INTO runner_capability_evidence (
          runner_id, report_id, position, capability, status,
          detection, reason_code
        ) VALUES (?, ?, 2, 'bubblewrap', 'unknown',
          'none', 'unknown')`,
      )
      .run("runner-1", firstReportId);
  }, /capability_evidence_already_exists/);
  assert.deepEqual(
    database
      .prepare(
        `SELECT position, capability, status, detection, reason_code, version
         FROM runner_capability_evidence
         WHERE runner_id = ? AND report_id = ? AND capability = 'bubblewrap'`,
      )
      .get("runner-1", firstReportId),
    originalBubblewrap,
  );
  assert.throws(() => {
    database
      .prepare(
        `INSERT OR REPLACE INTO runner_capability_nonces (
          organization_id, runner_id, nonce, request_hash, response_status,
          response_body, occurred_at, expires_at
        ) VALUES (?, ?, ?, ?, 201, '{}', ?, ?)`,
      )
      .run(
        "org-runner",
        "runner-1",
        "C".repeat(22),
        "b".repeat(64),
        "2026-07-26T12:03:00.000Z",
        "2026-07-26T12:18:00.000Z",
      );
  }, /capability_nonce_already_exists/);
  assert.throws(() => {
    database
      .prepare(
        "UPDATE runner_capability_evidence SET status = 'unknown' WHERE runner_id = ? AND report_id = ?",
      )
      .run("runner-1", firstReportId);
  }, /capability_evidence_is_append_only/);
  assert.throws(() => {
    database
      .prepare(
        "DELETE FROM runner_capability_evidence WHERE runner_id = ? AND report_id = ?",
      )
      .run("runner-1", firstReportId);
  }, /capability_evidence_is_append_only/);
  assert.throws(() => {
    database
      .prepare(
        "UPDATE runner_capability_nonces SET response_body = '{}' WHERE runner_id = ? AND nonce = ?",
      )
      .run("runner-1", "C".repeat(22));
  }, /capability_nonce_is_immutable/);
  database
    .prepare(
      "UPDATE runner_capability_reports SET replay_count = replay_count + 1 WHERE runner_id = ? AND report_id = ?",
    )
    .run("runner-1", firstReportId);
  assert.throws(() => {
    database
      .prepare(
        `UPDATE runner_capability_reports
         SET replay_count = replay_count + 2
         WHERE runner_id = ? AND report_id = ?`,
      )
      .run("runner-1", firstReportId);
  }, /invalid_capability_report_transition/);
  assert.throws(() => {
    database
      .prepare(
        `UPDATE runner_capability_reports
         SET replay_count = replay_count + 1,
             response_body = NULL,
             compacted_at = '2026-08-26T12:03:00.000Z'
         WHERE runner_id = ? AND report_id = ?`,
      )
      .run("runner-1", firstReportId);
  }, /invalid_capability_report_transition/);
  database
    .prepare(
      `UPDATE runner_capability_reports
       SET response_body = NULL,
           compacted_at = '2026-08-26T12:03:00.000Z'
       WHERE runner_id = ? AND report_id = ?`,
    )
    .run("runner-1", firstReportId);
  assert.throws(() => {
    database
      .prepare(
        `UPDATE runner_capability_reports
         SET response_body = '{}'
         WHERE runner_id = ? AND report_id = ?`,
      )
      .run("runner-1", firstReportId);
  }, /invalid_capability_report_transition/);
  assert.throws(() => {
    database
      .prepare(
        "DELETE FROM runner_capability_reports WHERE runner_id = ? AND report_id = ?",
      )
      .run("runner-1", firstReportId);
  }, /capability_report_is_append_only/);
  assert.throws(() => {
    insertCapabilityReport.run(
      "org-other",
      "runner-1",
      `cap_${"1".repeat(32)}`,
      "3".repeat(64),
      "4".repeat(64),
      "linux",
      "x64",
      "v22.14.0",
      "2026-07-26T12:04:00.000Z",
      "2026-07-26T12:04:00.000Z",
      "{}",
    );
  }, /invalid_capability_report|FOREIGN KEY constraint failed/);
  assert.throws(() => {
    insertCapabilityReport.run(
      "org-runner",
      "runner-1",
      `cap_${"2".repeat(32)}`,
      "5".repeat(64),
      "6".repeat(64),
      "linux",
      "x64",
      "v22.14.0",
      "2026-07-26T12:01:00.000Z",
      "2026-07-26T12:02:59.999Z",
      "{}",
    );
  }, /invalid_capability_report/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO runner_capability_evidence (
          runner_id, report_id, position, capability, status,
          detection, reason_code, version
        ) VALUES (?, ?, 16, 'landlock', 'available',
          'syscall', 'none', NULL)`,
      )
      .run("runner-1", firstReportId);
  }, /invalid_capability_evidence|CHECK constraint failed/);
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO runner_capability_evidence (
          runner_id, report_id, position, capability, status,
          detection, reason_code, version
        ) VALUES (?, ?, 2, 'landlock', 'available',
          'syscall', 'none', ?)`,
      )
      .run("runner-1", firstReportId, "x".repeat(65));
  }, /CHECK constraint failed/);

  assert.throws(() => {
    database
      .prepare("UPDATE runners SET public_key = ? WHERE id = ?")
      .run("B".repeat(43), "runner-1");
  }, /invalid_runner_transition/);
  assert.throws(() => {
    database
      .prepare("DELETE FROM runner_enrollment_tokens WHERE id = ?")
      .run("token-runner");
  }, /runner_enrollment_token_is_immutable/);
  assert.throws(() => {
    database
      .prepare(
        "UPDATE runner_enrollment_tokens SET consumed_runner_id = NULL, consumed_at = NULL WHERE id = ?",
      )
      .run("token-runner");
  }, /invalid_runner_enrollment_token_transition/);

  database
    .prepare(
      "UPDATE principals SET status = 'disabled' WHERE id = ?",
    )
    .run("principal-runner");
  database
    .prepare(
      `UPDATE runners
       SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      "2026-07-26T12:03:00.000Z",
      "owner-runner",
      "2026-07-26T12:03:00.000Z",
      "runner-1",
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO runner_heartbeat_nonces (
          organization_id, runner_id, nonce, request_hash, response_status,
          response_body, occurred_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "org-runner",
        "runner-1",
        "B".repeat(22),
        "e".repeat(64),
        200,
        "{}",
        "2026-07-26T12:04:00.000Z",
        "2026-07-26T12:19:00.000Z",
      );
  }, /invalid_runner_heartbeat_nonce/);
  assert.throws(() => {
    database
      .prepare("UPDATE runners SET status = 'active' WHERE id = ?")
      .run("runner-1");
  }, /invalid_runner_transition/);

  database.close();
});

test("capability migrations upgrade populated S6.B2 and B3.2 additively", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(new URL("../drizzle/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations.filter((name) => name < "0019_")) {
    database.exec(
      readFileSync(
        new URL(`../drizzle/${migration}`, import.meta.url),
        "utf8",
      ).replaceAll("--> statement-breakpoint", ""),
    );
  }
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'runner_capability_%'",
      )
      .get().count,
    0,
  );
  database.exec(`
    INSERT INTO organizations (id, slug, name)
    VALUES ('org-cap-upgrade', 'cap-upgrade', 'Capability upgrade');
    INSERT INTO principals (
      id, organization_id, kind, display_name
    ) VALUES (
      'owner-cap-upgrade', 'org-cap-upgrade', 'human', 'Upgrade owner'
    );
    INSERT INTO memberships (
      id, organization_id, principal_id, role
    ) VALUES (
      'membership-cap-upgrade', 'org-cap-upgrade',
      'owner-cap-upgrade', 'owner'
    );
    INSERT INTO runner_enrollment_tokens (
      id, organization_id, token_hash, issued_by, display_name,
      issued_at, expires_at
    ) VALUES
      (
        'token-cap-upgrade-1', 'org-cap-upgrade',
        '${"1".repeat(64)}', 'owner-cap-upgrade', 'Upgrade runner 1',
        '2026-07-26T12:00:00.000Z', '2026-07-26T12:15:00.000Z'
      ),
      (
        'token-cap-upgrade-2', 'org-cap-upgrade',
        '${"2".repeat(64)}', 'owner-cap-upgrade', 'Upgrade runner 2',
        '2026-07-26T12:00:00.000Z', '2026-07-26T12:15:00.000Z'
      );
    INSERT INTO principals (
      id, organization_id, kind, external_id, display_name
    ) VALUES
      (
        'principal-cap-upgrade-1', 'org-cap-upgrade', 'runner',
        'runner-cap-upgrade-1', 'Upgrade runner 1'
      ),
      (
        'principal-cap-upgrade-2', 'org-cap-upgrade', 'runner',
        'runner-cap-upgrade-2', 'Upgrade runner 2'
      );
    INSERT INTO runners (
      id, organization_id, principal_id, enrollment_token_id,
      display_name, public_key, enrolled_at
    ) VALUES
      (
        'runner-cap-upgrade-1', 'org-cap-upgrade',
        'principal-cap-upgrade-1', 'token-cap-upgrade-1',
        'Upgrade runner 1', '${"A".repeat(43)}',
        '2026-07-26T12:01:00.000Z'
      ),
      (
        'runner-cap-upgrade-2', 'org-cap-upgrade',
        'principal-cap-upgrade-2', 'token-cap-upgrade-2',
        'Upgrade runner 2', '${"B".repeat(43)}',
        '2026-07-26T12:02:00.000Z'
      );
  `);
  const capabilityMigration = migrations.find((name) =>
    name.startsWith("0019_"),
  );
  assert.ok(capabilityMigration);
  const sql = readFileSync(
    new URL(`../drizzle/${capabilityMigration}`, import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN)\b/iu);
  database.exec(sql.replaceAll("--> statement-breakpoint", ""));
  assert.deepEqual(
    database
      .prepare(
        `SELECT id, organization_id
         FROM runners
         WHERE organization_id = 'org-cap-upgrade'
         ORDER BY id`,
      )
      .all()
      .map(({ id, organization_id }) => ({ id, organization_id })),
    [
      {
        id: "runner-cap-upgrade-1",
        organization_id: "org-cap-upgrade",
      },
      {
        id: "runner-cap-upgrade-2",
        organization_id: "org-cap-upgrade",
      },
    ],
  );
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sqlite_master
         WHERE type = 'index' AND name = 'runners_org_id_uidx'`,
      )
      .get().count,
    1,
  );
  const insertUpgradeReport = database.prepare(
    `INSERT INTO runner_capability_reports (
      organization_id, runner_id, report_id, request_hash,
      declaration_hash, schema_version, platform_os, platform_arch,
      node_version, collected_at, received_at, truncated,
      response_status, response_body
    ) VALUES (
      'org-cap-upgrade', 'runner-cap-upgrade-1', ?, ?, ?, 1,
      'linux', 'x64', 'v22.14.0', ?, ?, 0, 201, '{}'
    )`,
  );
  insertUpgradeReport.run(
    `cap_${"3".repeat(32)}`,
    "3".repeat(64),
    "4".repeat(64),
    "2026-07-26T12:02:00.000Z",
    "2026-07-26T12:03:00.000Z",
  );
  const mutationMigration = migrations.find((name) =>
    name.startsWith("0020_"),
  );
  assert.ok(mutationMigration);
  const mutationSql = readFileSync(
    new URL(`../drizzle/${mutationMigration}`, import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(mutationSql, /\b(?:CREATE|DROP)\s+TABLE\b/iu);
  assert.match(
    mutationSql,
    /WHERE report\.`organization_id` = NEW\.`organization_id`\s+AND report\.`runner_id` = NEW\.`runner_id`\s+ORDER BY report\.`received_at` DESC, report\.`report_id` DESC\s+LIMIT 1/iu,
  );
  database.exec(
    mutationSql.replaceAll("--> statement-breakpoint", ""),
  );
  insertUpgradeReport.run(
    `cap_${"4".repeat(32)}`,
    "5".repeat(64),
    "6".repeat(64),
    "2026-07-26T12:04:00.000Z",
    "2026-07-26T12:04:00.000Z",
  );
  assert.throws(() => {
    insertUpgradeReport.run(
      `cap_${"5".repeat(32)}`,
      "7".repeat(64),
      "8".repeat(64),
      "2026-07-26T12:01:00.000Z",
      "2026-07-26T12:02:59.999Z",
    );
  }, /invalid_capability_report/);
  assert.match(
    database
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'trigger'
           AND name = 'runner_capability_reports_validate_before_insert'`,
      )
      .get().sql,
    /report\.`organization_id` = NEW\.`organization_id`/u,
  );
  assert.deepEqual(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'runner_capability_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => name),
    [
      "runner_capability_evidence",
      "runner_capability_nonces",
      "runner_capability_reports",
    ],
  );
  database.close();
});

test("run migration fences ownership and preserves operation tombstones", () => {
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
      ).replaceAll("--> statement-breakpoint", ""),
    );
  }
  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run("org-lease", "lease", "Lease");
  for (const [id, kind, name] of [
    ["owner-lease", "human", "Lease owner"],
    ["principal-lease-a", "runner", "Runner A"],
    ["principal-lease-b", "runner", "Runner B"],
  ]) {
    database
      .prepare(
        "INSERT INTO principals (id, organization_id, kind, external_id, display_name) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        id,
        "org-lease",
        kind,
        kind === "runner"
          ? `runner-${id.replace("principal-", "")}`
          : null,
        name,
      );
  }
  database
    .prepare(
      "INSERT INTO memberships (id, organization_id, principal_id, role) VALUES (?, ?, ?, 'owner')",
    )
    .run("membership-lease", "org-lease", "owner-lease");
  for (const [suffix, principal, displayName, key] of [
    ["a", "principal-lease-a", "Runner A", "A".repeat(43)],
    ["b", "principal-lease-b", "Runner B", "B".repeat(43)],
  ]) {
    database
      .prepare(
        `INSERT INTO runner_enrollment_tokens (
          id, organization_id, token_hash, issued_by, display_name,
          issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `token-lease-${suffix}`,
        "org-lease",
        suffix.repeat(64),
        "owner-lease",
        displayName,
        "2026-07-26T12:00:00.000Z",
        "2026-07-26T12:15:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO runners (
          id, organization_id, principal_id, enrollment_token_id,
          display_name, public_key, enrolled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `runner-lease-${suffix}`,
        "org-lease",
        principal,
        `token-lease-${suffix}`,
        displayName,
        key,
        "2026-07-26T12:01:00.000Z",
      );
  }
  const runId = `run_${"1".repeat(32)}`;
  const firstLeaseId = `lse_${"1".repeat(32)}`;
  const secondLeaseId = `lse_${"2".repeat(32)}`;
  database
    .prepare(
      `INSERT INTO runs (
        id, organization_id, requested_by, deadline_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      "org-lease",
      "owner-lease",
      "2026-07-26T12:15:00.000Z",
      "2026-07-26T12:00:00.000Z",
      "2026-07-26T12:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, occurred_at
      ) VALUES (?, ?, 1, 'run.created', ?, ?)`,
    )
    .run(
      "org-lease",
      runId,
      "owner-lease",
      "2026-07-26T12:00:00.000Z",
    );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO run_events (
          organization_id, run_id, sequence, kind, actor_id, occurred_at
        ) VALUES (?, ?, 1, 'run.created', ?, ?)`,
      )
      .run(
        "org-lease",
        runId,
        "owner-lease",
        "2026-07-26T12:00:01.000Z",
      );
  }, /invalid_run_event/);
  database
    .prepare(
      `INSERT INTO run_leases (
        id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      firstLeaseId,
      "org-lease",
      runId,
      "runner-lease-a",
      "2026-07-26T12:01:00.000Z",
      "2026-07-26T12:02:00.000Z",
      "2026-07-26T12:01:00.000Z",
      "2026-07-26T12:01:00.000Z",
    );
  assert.deepEqual(
    {
      ...database
        .prepare(
          "SELECT status, lease_generation, current_lease_id, claim_count FROM runs WHERE id = ?",
        )
        .get(runId),
    },
    {
      status: "leased",
      lease_generation: 1,
      current_lease_id: firstLeaseId,
      claim_count: 1,
    },
  );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO run_leases (
          id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?)`,
      )
      .run(
        secondLeaseId,
        "org-lease",
        runId,
        "runner-lease-b",
        "2026-07-26T12:01:30.000Z",
        "2026-07-26T12:02:30.000Z",
        "2026-07-26T12:01:30.000Z",
        "2026-07-26T12:01:30.000Z",
      );
  }, /invalid_run_lease|UNIQUE constraint failed/);

  database
    .prepare(
      `UPDATE run_leases
       SET status = 'superseded', ended_at = ?, ended_reason = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      "2026-07-26T12:02:01.000Z",
      "expired",
      "2026-07-26T12:02:01.000Z",
      firstLeaseId,
    );
  database
    .prepare(
      `INSERT INTO run_leases (
        id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?)`,
    )
    .run(
      secondLeaseId,
      "org-lease",
      runId,
      "runner-lease-b",
      "2026-07-26T12:02:01.000Z",
      "2026-07-26T12:03:01.000Z",
      "2026-07-26T12:02:01.000Z",
      "2026-07-26T12:02:01.000Z",
    );
  database
    .prepare(
      `UPDATE run_leases
       SET renewed_at = ?, renew_count = renew_count + 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      "2026-07-26T12:02:30.000Z",
      "2026-07-26T12:02:30.000Z",
      secondLeaseId,
    );
  assert.equal(
    database
      .prepare("SELECT renew_count FROM run_leases WHERE id = ?")
      .get(secondLeaseId).renew_count,
    1,
  );
  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO runner_operations (
          run_id, operation_id, request_hash, fence, response_status,
          response_body, applied_at
        ) VALUES (?, ?, ?, 1, 200, '{}', ?)`,
      )
      .run(
        runId,
        `op_${"1".repeat(32)}`,
        "c".repeat(64),
        "2026-07-26T12:02:02.000Z",
      );
  }, /invalid_runner_operation/);

  const operationId = `op_${"2".repeat(32)}`;
  database
    .prepare(
      `INSERT INTO runner_operations (
        run_id, operation_id, request_hash, fence, response_status,
        response_body, applied_at
      ) VALUES (?, ?, ?, 2, 200, ?, ?)`,
    )
    .run(
      runId,
      operationId,
      "d".repeat(64),
      '{"recordedAt":"2026-07-26T12:02:45.000Z"}',
      "2026-07-26T12:02:45.000Z",
    );
  database
    .prepare(
      `UPDATE runs
       SET status = 'completed', outcome_status = 'succeeded',
           outcome_summary = ?, completed_operation_id = ?, recorded_at = ?,
           version = version + 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      "Diagnostic lease completed",
      operationId,
      "2026-07-26T12:02:45.000Z",
      "2026-07-26T12:02:45.000Z",
      runId,
    );
  database
    .prepare(
      `UPDATE run_leases
       SET status = 'released', ended_at = ?, ended_reason = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      "2026-07-26T12:02:45.000Z",
      "diagnostic_complete",
      "2026-07-26T12:02:45.000Z",
      secondLeaseId,
    );
  database
    .prepare(
      `UPDATE runner_operations
       SET response_body = NULL, compacted_at = ?
       WHERE run_id = ? AND operation_id = ?`,
    )
    .run("2026-08-26T12:02:45.000Z", runId, operationId);
  assert.deepEqual(
    {
      ...database
        .prepare(
          "SELECT response_body, compacted_at FROM runner_operations WHERE run_id = ? AND operation_id = ?",
        )
        .get(runId, operationId),
    },
    {
      response_body: null,
      compacted_at: "2026-08-26T12:02:45.000Z",
    },
  );
  assert.throws(() => {
    database
      .prepare(
        "DELETE FROM runner_operations WHERE run_id = ? AND operation_id = ?",
      )
      .run(runId, operationId);
  }, /runner_operation_tombstone_is_immutable/);
  assert.throws(() => {
    database
      .prepare("UPDATE runs SET outcome_summary = ? WHERE id = ?")
      .run("Tampered", runId);
  }, /invalid_run_transition/);
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
