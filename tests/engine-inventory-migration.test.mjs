import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationName = "0024_chilly_shinko_yamashiro.sql";

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
  for (const migration of migrations) database.exec(migrationSql(migration));
  return database;
}

function assertEngineFreshnessChecks(database) {
  for (const table of [
    "runner_admission_policies",
    "runner_admission_policy_versions",
  ]) {
    const definition = database
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
      )
      .get(table).sql;
    assert.match(
      definition,
      /engine_freshness_seconds[^,]*CHECK\s*\(\s*`?engine_freshness_seconds`?\s+BETWEEN 3600 AND 2592000\s*\)/iu,
      `${table} must retain the handwritten inline engine freshness bound`,
    );
  }
}

function seedWorkspace(database, suffix) {
  const organizationId = `org-engine-${suffix}`;
  const ownerId = `owner-engine-${suffix}`;
  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run(organizationId, `engine-${suffix}`, `Engine ${suffix}`);
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, display_name
      ) VALUES (?, ?, 'human', ?)`,
    )
    .run(ownerId, organizationId, ownerId);
  database
    .prepare(
      `INSERT INTO memberships (
        id, organization_id, principal_id, role
      ) VALUES (?, ?, ?, 'owner')`,
    )
    .run(`membership-engine-${suffix}`, organizationId, ownerId);
  return { organizationId, ownerId };
}

function seedRunner(database, workspace, suffix) {
  const principalId = `principal-engine-runner-${suffix}`;
  const runnerId = `runner-engine-${suffix}`;
  const tokenId = `token-engine-${suffix}`;
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, external_id, display_name
      ) VALUES (?, ?, 'runner', ?, ?)`,
    )
    .run(principalId, workspace.organizationId, runnerId, runnerId);
  database
    .prepare(
      `INSERT INTO runner_enrollment_tokens (
        id, organization_id, token_hash, issued_by, display_name,
        issued_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tokenId,
      workspace.organizationId,
      createHash("sha256").update(suffix).digest("hex"),
      workspace.ownerId,
      runnerId,
      "2026-07-27T10:00:00.000Z",
      "2026-07-27T10:30:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO runners (
        id, organization_id, principal_id, enrollment_token_id,
        display_name, public_key, enrolled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runnerId,
      workspace.organizationId,
      principalId,
      tokenId,
      runnerId,
      "E".repeat(43),
      "2026-07-27T10:01:00.000Z",
    );
  return { principalId, runnerId };
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
      `ledger-engine-${input.version}`,
      input.organizationId,
      input.version,
      input.ownerId,
      input.at,
      String(input.version).repeat(64),
      `nexus://runner-admission-policies/${input.organizationId}#v${input.version}`,
      input.version === 1 ? "0".repeat(64) : String(input.version - 1).repeat(64),
      String(input.version).repeat(64),
    );
}

function insertPolicyVersion(database, input) {
  database
    .prepare(
      `INSERT INTO runner_admission_policy_versions (
        organization_id, version, capability_freshness_seconds,
        updated_by, recorded_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.organizationId,
      input.version,
      input.capabilityFreshnessSeconds,
      input.ownerId,
      input.at,
    );
}

function insertEngineReport(database, input) {
  database
    .prepare(
      `INSERT INTO runner_engine_reports (
        organization_id, runner_id, report_id, request_hash, declaration_hash,
        schema_version, collected_at, received_at, truncated,
        response_status, response_body
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 201, ?)`,
    )
    .run(
      input.organizationId,
      input.runnerId,
      input.reportId,
      input.requestHash ?? "a".repeat(64),
      input.declarationHash ?? "b".repeat(64),
      input.collectedAt ?? input.receivedAt,
      input.receivedAt,
      input.responseBody ?? "{}",
    );
}

test("0024 adds default-only policy freshness with explicit rollback behavior", () => {
  const database = migratedDatabase("0023_s6b3_assigned_storage.sql");
  const workspace = seedWorkspace(database, "upgrade");

  database.exec("BEGIN");
  database
    .prepare(
      `INSERT INTO runner_admission_policies (
        organization_id, version, capability_freshness_seconds,
        updated_by, created_at, updated_at
      ) VALUES (?, 1, 86400, ?, ?, ?)`,
    )
    .run(
      workspace.organizationId,
      workspace.ownerId,
      "2026-07-27T11:00:00.000Z",
      "2026-07-27T11:00:00.000Z",
    );
  insertPolicyVersion(database, {
    ...workspace,
    version: 1,
    capabilityFreshnessSeconds: 86_400,
    at: "2026-07-27T11:00:00.000Z",
  });
  insertPolicyLedger(database, {
    ...workspace,
    version: 1,
    at: "2026-07-27T11:00:00.000Z",
  });
  database.exec("COMMIT");

  database.exec("BEGIN");
  database
    .prepare(
      `UPDATE runner_admission_policies
       SET version = 2, capability_freshness_seconds = 3600,
           updated_by = ?, updated_at = ?
       WHERE organization_id = ? AND version = 1`,
    )
    .run(
      workspace.ownerId,
      "2026-07-27T11:00:00.001Z",
      workspace.organizationId,
    );
  insertPolicyVersion(database, {
    ...workspace,
    version: 2,
    capabilityFreshnessSeconds: 3_600,
    at: "2026-07-27T11:00:00.001Z",
  });
  insertPolicyLedger(database, {
    ...workspace,
    version: 2,
    at: "2026-07-27T11:00:00.001Z",
  });
  database.exec("COMMIT");

  const before = database
    .prepare(
      `SELECT organization_id, version, capability_freshness_seconds,
              updated_by, recorded_at
       FROM runner_admission_policy_versions
       ORDER BY version`,
    )
    .all()
    .map((row) => ({ ...row }));
  database.exec(migrationSql(migrationName));

  assertEngineFreshnessChecks(database);

  assert.deepEqual(
    database
      .prepare(
        `SELECT organization_id, version, capability_freshness_seconds,
                updated_by, recorded_at
         FROM runner_admission_policy_versions
         ORDER BY version`,
      )
      .all()
      .map((row) => ({ ...row })),
    before,
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT version, engine_freshness_seconds
         FROM runner_admission_policy_versions
         ORDER BY version`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { version: 1, engine_freshness_seconds: 86_400 },
      { version: 2, engine_freshness_seconds: 86_400 },
    ],
  );
  assert.equal(
    database
      .prepare(
        `SELECT engine_freshness_seconds
         FROM runner_admission_policies
         WHERE organization_id = ?`,
      )
      .get(workspace.organizationId).engine_freshness_seconds,
    86_400,
  );

  database.exec("BEGIN");
  database
    .prepare(
      `UPDATE runner_admission_policies
       SET version = 3, capability_freshness_seconds = 7200,
           updated_by = ?, updated_at = ?
       WHERE organization_id = ? AND version = 2`,
    )
    .run(
      workspace.ownerId,
      "2026-07-27T11:00:00.002Z",
      workspace.organizationId,
    );
  insertPolicyVersion(database, {
    ...workspace,
    version: 3,
    capabilityFreshnessSeconds: 7_200,
    at: "2026-07-27T11:00:00.002Z",
  });
  insertPolicyLedger(database, {
    ...workspace,
    version: 3,
    at: "2026-07-27T11:00:00.002Z",
  });
  database.exec("COMMIT");

  database.exec("BEGIN");
  database
    .prepare(
      `UPDATE runner_admission_policies
       SET version = 4, engine_freshness_seconds = 7200,
           updated_by = ?, updated_at = ?
       WHERE organization_id = ? AND version = 3`,
    )
    .run(
      workspace.ownerId,
      "2026-07-27T11:00:00.003Z",
      workspace.organizationId,
    );
  database
    .prepare(
      `INSERT INTO runner_admission_policy_versions (
        organization_id, version, capability_freshness_seconds,
        engine_freshness_seconds, updated_by, recorded_at
      ) VALUES (?, 4, 7200, 7200, ?, ?)`,
    )
    .run(
      workspace.organizationId,
      workspace.ownerId,
      "2026-07-27T11:00:00.003Z",
    );
  insertPolicyLedger(database, {
    ...workspace,
    version: 4,
    at: "2026-07-27T11:00:00.003Z",
  });
  database.exec("COMMIT");

  database.exec("BEGIN");
  try {
    database
      .prepare(
        `UPDATE runner_admission_policies
         SET version = 5, capability_freshness_seconds = 3600,
             updated_by = ?, updated_at = ?
         WHERE organization_id = ? AND version = 4`,
      )
      .run(
        workspace.ownerId,
        "2026-07-27T11:00:00.004Z",
        workspace.organizationId,
      );
    assert.throws(
      () =>
        insertPolicyVersion(database, {
          ...workspace,
          version: 5,
          capabilityFreshnessSeconds: 3_600,
          at: "2026-07-27T11:00:00.004Z",
        }),
      /invalid_runner_admission_policy_version/,
    );
  } finally {
    database.exec("ROLLBACK");
  }
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT version, capability_freshness_seconds,
                  engine_freshness_seconds
           FROM runner_admission_policies
           WHERE organization_id = ?`,
        )
        .get(workspace.organizationId),
    },
    {
      version: 4,
      capability_freshness_seconds: 7_200,
      engine_freshness_seconds: 7_200,
    },
  );
  assert.equal(
    database
      .prepare(
        `SELECT count(*) AS count
         FROM runner_admission_policy_versions
         WHERE organization_id = ?`,
      )
      .get(workspace.organizationId).count,
    4,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `UPDATE runner_admission_policies
           SET version = 5, engine_freshness_seconds = 3599,
               updated_by = ?, updated_at = ?
           WHERE organization_id = ? AND version = 4`,
        )
        .run(
          workspace.ownerId,
          "2026-07-27T11:00:00.005Z",
          workspace.organizationId,
        ),
    /CHECK constraint failed|invalid_runner_admission_policy_transition/,
  );
  database.close();
});

test("0024 seals ordered engine inventory and its allowed transitions", () => {
  const database = migratedDatabase();
  assertEngineFreshnessChecks(database);
  const workspace = seedWorkspace(database, "storage");
  const runner = seedRunner(database, workspace, "storage");
  const firstReportId = `egr_${"1".repeat(32)}`;
  insertEngineReport(database, {
    ...workspace,
    ...runner,
    reportId: firstReportId,
    receivedAt: "2026-07-27T12:00:00.000Z",
  });
  database
    .prepare(
      `INSERT INTO runner_engine_evidence (
        runner_id, report_id, position, engine, status, readiness,
        reason, version
      ) VALUES (?, ?, 0, 'claude_code_cli', 'available', 'ready',
        'none', '2.1.219 (Claude Code)')`,
    )
    .run(runner.runnerId, firstReportId);
  database
    .prepare(
      `INSERT INTO runner_engine_evidence (
        runner_id, report_id, position, engine, status, readiness,
        reason, version
      ) VALUES (?, ?, 1, 'codex_cli', 'unavailable',
        'attention_required', 'engine_not_configured', NULL)`,
    )
    .run(runner.runnerId, firstReportId);

  assert.deepEqual(
    database
      .prepare(
        `SELECT position, engine, status, readiness, reason, version
         FROM runner_engine_evidence
         WHERE runner_id = ? AND report_id = ?
         ORDER BY position`,
      )
      .all(runner.runnerId, firstReportId)
      .map((row) => ({ ...row })),
    [
      {
        position: 0,
        engine: "claude_code_cli",
        status: "available",
        readiness: "ready",
        reason: "none",
        version: "2.1.219 (Claude Code)",
      },
      {
        position: 1,
        engine: "codex_cli",
        status: "unavailable",
        readiness: "attention_required",
        reason: "engine_not_configured",
        version: null,
      },
    ],
  );
  assert.throws(
    () =>
      database.exec(
        `UPDATE runner_engine_evidence SET status = 'unknown'
         WHERE runner_id = '${runner.runnerId}'`,
      ),
    /engine_evidence_is_append_only/,
  );
  assert.throws(
    () =>
      database.exec(
        `DELETE FROM runner_engine_reports
         WHERE runner_id = '${runner.runnerId}'`,
      ),
    /engine_report_is_append_only/,
  );

  database
    .prepare(
      `UPDATE runner_engine_reports
       SET replay_count = replay_count + 1
       WHERE runner_id = ? AND report_id = ?`,
    )
    .run(runner.runnerId, firstReportId);
  database
    .prepare(
      `UPDATE runner_engine_reports
       SET response_body = NULL, compacted_at = ?
       WHERE runner_id = ? AND report_id = ?`,
    )
    .run(
      "2026-07-28T12:00:00.000Z",
      runner.runnerId,
      firstReportId,
    );

  const secondReportId = `egr_${"2".repeat(32)}`;
  insertEngineReport(database, {
    ...workspace,
    ...runner,
    reportId: secondReportId,
    receivedAt: "2026-07-27T12:00:00.001Z",
  });
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO runner_engine_evidence (
            runner_id, report_id, position, engine, status, readiness,
            reason, version
          ) VALUES (?, ?, 1, 'codex_cli', 'unknown', 'unknown',
            'engine_probe_failed', NULL)`,
        )
        .run(runner.runnerId, secondReportId),
    /invalid_engine_evidence/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO runner_engine_evidence (
            runner_id, report_id, position, engine, status, readiness,
            reason, version
          ) VALUES (?, ?, 0, 'claude_code_cli', 'available', 'ready',
            'none', 'invalid@version')`,
        )
        .run(runner.runnerId, secondReportId),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO runner_engine_evidence (
            runner_id, report_id, position, engine, status, readiness,
            reason, version
          ) VALUES (?, ?, 0, 'claude_code_cli', 'unknown', 'ready',
            'none', '2.1.219')`,
        )
        .run(runner.runnerId, secondReportId),
    /invalid_engine_evidence/,
  );
  assert.throws(
    () =>
      insertEngineReport(database, {
        ...workspace,
        ...runner,
        reportId: `egr_${"3".repeat(32)}`,
        receivedAt: "2026-07-27T11:59:59.999Z",
      }),
    /invalid_engine_report/,
  );
  assert.throws(
    () =>
      insertEngineReport(database, {
        ...workspace,
        ...runner,
        reportId: "egr_invalid",
        receivedAt: "2026-07-27T12:00:00.002Z",
      }),
    /invalid_engine_report/,
  );
  database.close();
});
