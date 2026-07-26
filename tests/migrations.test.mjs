import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const expectedTables = [
  "action_intents",
  "agent_definitions",
  "intent_approvals",
  "ledger_entries",
  "memberships",
  "model_connections",
  "organizations",
  "principals",
  "projects",
  "team_members",
  "teams",
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
    "intent_approvals_intent_actor_uidx",
    "ledger_entries_org_hash_uidx",
    "ledger_entries_org_sequence_uidx",
    "memberships_org_principal_uidx",
    "model_connections_org_provider_label_uidx",
    "projects_org_slug_uidx",
    "team_members_team_principal_uidx",
    "teams_project_slug_uidx",
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
    "team_members_validate_before_insert",
    "teams_validate_project_before_insert",
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

  database.close();
});
