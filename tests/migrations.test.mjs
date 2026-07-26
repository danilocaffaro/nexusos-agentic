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
    "intent_approvals_intent_actor_uidx",
    "ledger_entries_org_hash_uidx",
    "ledger_entries_org_sequence_uidx",
    "memberships_org_principal_uidx",
    "model_connections_org_provider_label_uidx",
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
