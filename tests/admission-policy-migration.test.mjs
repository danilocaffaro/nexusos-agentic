import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function migrationSql(name) {
  return readFileSync(
    new URL(`../drizzle/${name}`, import.meta.url),
    "utf8",
  ).replaceAll("--> statement-breakpoint", "");
}

function migratedDatabase(lastMigration) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(new URL("../drizzle/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) => !lastMigration || name <= lastMigration);
  for (const migration of migrations) {
    database.exec(migrationSql(migration));
  }
  return database;
}

function seedHuman(database, input) {
  database
    .prepare(
      "INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)",
    )
    .run(input.organizationId, input.slug, input.slug);
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, display_name
      ) VALUES (?, ?, 'human', ?)`,
    )
    .run(input.principalId, input.organizationId, input.principalId);
  database
    .prepare(
      `INSERT INTO memberships (
        id, organization_id, principal_id, role
      ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      `membership-${input.principalId}`,
      input.organizationId,
      input.principalId,
      input.role,
    );
}

function insertPolicyLedger(database, input) {
  database
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, previous_hash, hash
      ) VALUES (?, ?, ?, 'runner_policy.updated', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ledger-${input.organizationId}-${input.version}`,
      input.organizationId,
      input.version,
      input.actorId,
      input.occurredAt,
      input.payloadHash ?? "a".repeat(64),
      `nexus://runner-admission-policies/${input.organizationId}#v${input.version}`,
      input.previousHash ?? "0".repeat(64),
      input.hash ?? String(input.version).repeat(64),
    );
}

test("0022 upgrades a populated 0021 database without touching existing rows", () => {
  const database = migratedDatabase("0021_wakeful_talkback.sql");
  seedHuman(database, {
    organizationId: "org-existing",
    principalId: "owner-existing",
    role: "owner",
    slug: "existing",
  });
  database
    .prepare(
      `INSERT INTO projects (
        id, organization_id, slug, name, objective
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "project-existing",
      "org-existing",
      "existing",
      "Existing project",
      "Survive forward migration",
    );

  database.exec(migrationSql("0022_s6b3_admission_policy.sql"));

  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT id, slug, name, objective
           FROM projects
           WHERE id = ?`,
        )
        .get("project-existing"),
    },
    {
      id: "project-existing",
      slug: "existing",
      name: "Existing project",
      objective: "Survive forward migration",
    },
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM runner_admission_policies",
      )
      .get().count,
    0,
  );
});

test("admission policy history is authorized, sealed and immutable", () => {
  const database = migratedDatabase();
  seedHuman(database, {
    organizationId: "org-policy",
    principalId: "owner-policy",
    role: "owner",
    slug: "policy",
  });
  seedHuman(database, {
    organizationId: "org-member",
    principalId: "member-policy",
    role: "member",
    slug: "member",
  });

  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO runner_admission_policies (
            organization_id, version, capability_freshness_seconds,
            updated_by, created_at, updated_at
          ) VALUES (?, 1, 86400, ?, ?, ?)`,
        )
        .run(
          "org-member",
          "member-policy",
          "2026-07-26T12:00:00.000Z",
          "2026-07-26T12:00:00.000Z",
        ),
    /invalid_runner_admission_policy_actor/,
  );

  database.exec("BEGIN");
  try {
    database
      .prepare(
        `INSERT INTO runner_admission_policies (
          organization_id, version, capability_freshness_seconds,
          updated_by, created_at, updated_at
        ) VALUES (?, 1, 86400, ?, ?, ?)`,
      )
      .run(
        "org-policy",
        "owner-policy",
        "2026-07-26T12:00:00.000Z",
        "2026-07-26T12:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO runner_admission_policy_versions (
          organization_id, version, capability_freshness_seconds,
          updated_by, recorded_at
        ) VALUES (?, 1, 86400, ?, ?)`,
      )
      .run(
        "org-policy",
        "owner-policy",
        "2026-07-26T12:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO runner_admission_policy_capabilities (
          organization_id, version, capability
        ) VALUES (?, 1, 'bubblewrap')`,
      )
      .run("org-policy");
    assert.throws(
      () =>
        insertPolicyLedger(database, {
          organizationId: "org-policy",
          version: 1,
          actorId: "owner-policy",
          occurredAt: "2026-07-26T12:00:00.000Z",
          payloadHash: "not-a-hash",
        }),
      /invalid_policy_ledger_event/,
    );
    database.exec("ROLLBACK");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM runner_admission_policies",
      )
      .get().count,
    0,
  );

  database.exec("BEGIN");
  database
    .prepare(
      `INSERT INTO runner_admission_policies (
        organization_id, version, capability_freshness_seconds,
        updated_by, created_at, updated_at
      ) VALUES (?, 1, 86400, ?, ?, ?)`,
    )
    .run(
      "org-policy",
      "owner-policy",
      "2026-07-26T12:00:00.000Z",
      "2026-07-26T12:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO runner_admission_policy_versions (
        organization_id, version, capability_freshness_seconds,
        updated_by, recorded_at
      ) VALUES (?, 1, 86400, ?, ?)`,
    )
    .run(
      "org-policy",
      "owner-policy",
      "2026-07-26T12:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO runner_admission_policy_capabilities (
        organization_id, version, capability
      ) VALUES (?, 1, 'bubblewrap')`,
    )
    .run("org-policy");
  insertPolicyLedger(database, {
    organizationId: "org-policy",
    version: 1,
    actorId: "owner-policy",
    occurredAt: "2026-07-26T12:00:00.000Z",
  });
  database.exec("COMMIT");

  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO runner_admission_policy_capabilities (
            organization_id, version, capability
          ) VALUES (?, 1, 'podman')`,
        )
        .run("org-policy"),
    /invalid_runner_admission_policy_capability/,
  );
  for (const statement of [
    "UPDATE runner_admission_policy_versions SET capability_freshness_seconds = 90000 WHERE organization_id = 'org-policy' AND version = 1",
    "DELETE FROM runner_admission_policy_versions WHERE organization_id = 'org-policy' AND version = 1",
    "UPDATE runner_admission_policy_capabilities SET capability = 'podman' WHERE organization_id = 'org-policy' AND version = 1",
    "DELETE FROM runner_admission_policy_capabilities WHERE organization_id = 'org-policy' AND version = 1",
    "DELETE FROM runner_admission_policies WHERE organization_id = 'org-policy'",
  ]) {
    assert.throws(() => database.exec(statement), /immutable/);
  }

  database.exec("BEGIN");
  database
    .prepare(
      `UPDATE runner_admission_policies
       SET version = 2, capability_freshness_seconds = 3600,
           updated_by = ?, updated_at = ?
       WHERE organization_id = ? AND version = 1`,
    )
    .run(
      "owner-policy",
      "2026-07-26T12:00:00.001Z",
      "org-policy",
    );
  database
    .prepare(
      `INSERT INTO runner_admission_policy_versions (
        organization_id, version, capability_freshness_seconds,
        updated_by, recorded_at
      ) VALUES (?, 2, 3600, ?, ?)`,
    )
    .run(
      "org-policy",
      "owner-policy",
      "2026-07-26T12:00:00.001Z",
    );
  insertPolicyLedger(database, {
    organizationId: "org-policy",
    version: 2,
    actorId: "owner-policy",
    occurredAt: "2026-07-26T12:00:00.001Z",
    previousHash: "1".repeat(64),
    hash: "2".repeat(64),
  });
  database.exec("COMMIT");

  assert.deepEqual(
    database
      .prepare(
        `SELECT version, capability_freshness_seconds
         FROM runner_admission_policy_versions
         WHERE organization_id = ?
         ORDER BY version`,
      )
      .all("org-policy")
      .map((row) => ({ ...row })),
    [
      { version: 1, capability_freshness_seconds: 86400 },
      { version: 2, capability_freshness_seconds: 3600 },
    ],
  );
  assert.equal(
    database
      .prepare(
        `SELECT count(*) AS count
         FROM runner_admission_policy_capabilities
         WHERE organization_id = ? AND version = 2`,
      )
      .get("org-policy").count,
    0,
  );

  database.exec("BEGIN");
  try {
    const lostCas = database
      .prepare(
        `UPDATE runner_admission_policies
         SET version = 3, capability_freshness_seconds = 7200,
             updated_by = ?, updated_at = ?
         WHERE organization_id = ? AND version = 1`,
      )
      .run(
        "owner-policy",
        "2026-07-26T12:00:00.002Z",
        "org-policy",
      );
    assert.equal(lostCas.changes, 0);
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO runner_admission_policy_versions (
              organization_id, version, capability_freshness_seconds,
              updated_by, recorded_at
            ) VALUES (?, 3, 7200, ?, ?)`,
          )
          .run(
            "org-policy",
            "owner-policy",
            "2026-07-26T12:00:00.002Z",
          ),
      /invalid_runner_admission_policy_version/,
    );
    database.exec("ROLLBACK");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  assert.equal(
    database
      .prepare(
        `SELECT count(*) AS count
         FROM runner_admission_policy_versions
         WHERE organization_id = ?`,
      )
      .get("org-policy").count,
    2,
  );
  assert.equal(
    database
      .prepare(
        `SELECT count(*) AS count
         FROM ledger_entries
         WHERE organization_id = ? AND kind = 'runner_policy.updated'`,
      )
      .get("org-policy").count,
    2,
  );
});
