import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

const migrationName = "0023_s6b3_assigned_storage.sql";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const tsxPath = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url),
);
const capabilities = [
  "node_permission_model",
  "bubblewrap",
  "landlock",
  "seccomp",
  "user_namespace",
  "docker",
  "podman",
];

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

function seedWorkspace(database, suffix = "a") {
  const organizationId = `org-assigned-${suffix}`;
  const ownerId = `owner-assigned-${suffix}`;
  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run(organizationId, `assigned-${suffix}`, `Assigned ${suffix}`);
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
    .run(`membership-${suffix}`, organizationId, ownerId);
  return { organizationId, ownerId };
}

function seedRunner(database, workspace, suffix) {
  const principalId = `principal-runner-${suffix}`;
  const runnerId = `runner-assigned-${suffix}`;
  const tokenId = `token-assigned-${suffix}`;
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, external_id, display_name
      ) VALUES (?, ?, 'runner', ?, ?)`,
    )
    .run(
      principalId,
      workspace.organizationId,
      runnerId,
      `Runner ${suffix}`,
    );
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
      `Runner ${suffix}`,
      "2026-07-26T10:00:00.000Z",
      "2026-07-26T10:30:00.000Z",
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
      `Runner ${suffix}`,
      String.fromCharCode(
        65 + (suffix.charCodeAt(suffix.length - 1) % 26),
      ).repeat(43),
      "2026-07-26T10:01:00.000Z",
    );
  return { principalId, runnerId };
}

function insertRun(database, input) {
  database
    .prepare(
      `INSERT INTO runs (
        id, organization_id, requested_by, deadline_at, assigned_runner_id,
        required_capability, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.organizationId,
      input.ownerId,
      input.deadlineAt ?? "2026-07-29T12:00:00.000Z",
      input.assignedRunnerId ?? null,
      input.requiredCapability ?? null,
      input.createdAt ?? "2026-07-26T10:00:00.000Z",
      input.createdAt ?? "2026-07-26T10:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, occurred_at
      ) VALUES (?, ?, 1, 'run.created', ?, ?)`,
    )
    .run(
      input.organizationId,
      input.runId,
      input.ownerId,
      input.createdAt ?? "2026-07-26T10:00:00.000Z",
    );
}

function insertLease(database, input) {
  database
    .prepare(
      `INSERT INTO run_leases (
        id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
        admission_basis, admission_policy_source, admission_policy_version,
        admission_freshness_seconds, admission_required_capability,
        admission_report_id, admission_report_received_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.leaseId,
      input.organizationId,
      input.runId,
      input.runnerId,
      input.issuedAt,
      input.expiresAt ?? "2026-07-29T11:59:00.000Z",
      input.admissionBasis ?? null,
      input.admissionPolicySource ?? null,
      input.admissionPolicyVersion ?? null,
      input.admissionFreshnessSeconds ?? null,
      input.admissionRequiredCapability ?? null,
      input.admissionReportId ?? null,
      input.admissionReportReceivedAt ?? null,
      input.issuedAt,
      input.issuedAt,
    );
}

function releaseLease(database, leaseId, at) {
  database
    .prepare(
      `UPDATE run_leases
       SET status = 'released', ended_at = ?, ended_reason = 'test_release',
           updated_at = ?
       WHERE id = ?`,
    )
    .run(at, at, leaseId);
}

function insertReport(database, input) {
  database
    .prepare(
      `INSERT INTO runner_capability_reports (
        organization_id, runner_id, report_id, request_hash, declaration_hash,
        schema_version, platform_os, platform_arch, node_version, collected_at,
        received_at, truncated, response_status, response_body
      ) VALUES (?, ?, ?, ?, ?, 1, 'linux', 'x64', 'v22.0.0', ?, ?, 0, 201, ?)`,
    )
    .run(
      input.organizationId,
      input.runnerId,
      input.reportId,
      input.requestHash ?? "a".repeat(64),
      input.declarationHash ?? "b".repeat(64),
      input.receivedAt,
      input.receivedAt,
      "{}",
    );
  database
    .prepare(
      `INSERT INTO runner_capability_evidence (
        runner_id, report_id, position, capability, status, detection,
        reason_code, version
      ) VALUES (?, ?, 0, ?, ?, 'binary_version', 'none', '1.0')`,
    )
    .run(
      input.runnerId,
      input.reportId,
      input.capability ?? "bubblewrap",
      input.evidenceStatus ?? "available",
    );
}

function capabilityFreshnessOracle(cases) {
  const result = spawnSync(
    tsxPath,
    [
      "--eval",
      `import { readFileSync } from "node:fs";
       import { isCapabilityReportFresh } from "./src/domain/runners/capability-protocol.ts";
       const cases = JSON.parse(readFileSync(0, "utf8"));
       process.stdout.write(JSON.stringify(cases.map((item) =>
         isCapabilityReportFresh({
           receivedAt: item.receivedAt,
           nowMs: Date.parse(item.issuedAt),
           maxAgeMs: item.freshnessSeconds * 1000,
         })
       )));`,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: JSON.stringify(cases),
      shell: false,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runtimeContractSets() {
  const result = spawnSync(
    tsxPath,
    [
      "--eval",
      `import { RUNNER_CAPABILITIES } from "./src/domain/runners/capability-protocol.ts";
       import {
         LEASE_CLAIMED_ASSIGNMENT_METADATA_KEYS,
         LEASE_CLAIMED_BASE_METADATA_KEYS,
         LEASE_CLAIMED_CAPABILITY_METADATA_KEYS,
       } from "./src/contracts/runs.ts";
       process.stdout.write(JSON.stringify({
         capabilities: RUNNER_CAPABILITIES,
         metadataKeys: [
           ...LEASE_CLAIMED_BASE_METADATA_KEYS,
           ...LEASE_CLAIMED_ASSIGNMENT_METADATA_KEYS,
           ...LEASE_CLAIMED_CAPABILITY_METADATA_KEYS,
         ],
       }));`,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
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
      `ledger-policy-${input.version}`,
      input.organizationId,
      input.version,
      input.ownerId,
      input.occurredAt,
      input.payloadHash ?? "c".repeat(64),
      `nexus://runner-admission-policies/${input.organizationId}#v${input.version}`,
      input.previousHash ?? "0".repeat(64),
      input.hash ?? String(input.version).repeat(64),
    );
}

function configurePolicy(database, input) {
  database.exec("BEGIN");
  try {
    if (input.version === 1) {
      database
        .prepare(
          `INSERT INTO runner_admission_policies (
            organization_id, version, capability_freshness_seconds,
            updated_by, created_at, updated_at
          ) VALUES (?, 1, ?, ?, ?, ?)`,
        )
        .run(
          input.organizationId,
          input.freshnessSeconds,
          input.ownerId,
          input.occurredAt,
          input.occurredAt,
        );
    } else {
      database
        .prepare(
          `UPDATE runner_admission_policies
           SET version = ?, capability_freshness_seconds = ?,
               updated_by = ?, updated_at = ?
           WHERE organization_id = ?`,
        )
        .run(
          input.version,
          input.freshnessSeconds,
          input.ownerId,
          input.occurredAt,
          input.organizationId,
        );
    }
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
        input.freshnessSeconds,
        input.ownerId,
        input.occurredAt,
      );
    for (const capability of input.allowedCapabilities) {
      database
        .prepare(
          `INSERT INTO runner_admission_policy_capabilities (
            organization_id, version, capability
          ) VALUES (?, ?, ?)`,
        )
        .run(input.organizationId, input.version, capability);
    }
    insertPolicyLedger(database, input);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function capabilityLease(input) {
  return {
    ...input,
    admissionBasis: "capability_declaration",
    admissionPolicySource: input.admissionPolicySource ?? "default",
    admissionPolicyVersion: input.admissionPolicyVersion ?? 0,
    admissionFreshnessSeconds: input.admissionFreshnessSeconds ?? 86400,
    admissionRequiredCapability: input.requiredCapability ?? "bubblewrap",
    admissionReportId: input.reportId,
    admissionReportReceivedAt: input.reportReceivedAt,
  };
}

test("0023 is a pure additive upgrade over populated assigned storage", () => {
  const sql = migrationSql(migrationName);
  assert.equal((sql.match(/ALTER TABLE/gi) ?? []).length, 9);
  assert.equal((sql.match(/ADD `/gi) ?? []).length, 9);
  assert.doesNotMatch(sql, /(?:CREATE|DROP) TABLE\s+`?(?:runs|run_leases)`?/i);
  assert.doesNotMatch(sql, /\bRENAME\b/i);
  assert.doesNotMatch(sql, /julianday/i);
  for (const trigger of [
    "runs_validate_before_insert",
    "runs_validate_before_update",
    "run_leases_validate_before_insert",
    "run_leases_validate_before_update",
    "run_events_validate_before_insert",
  ]) {
    assert.equal(
      (sql.match(new RegExp(`DROP TRIGGER \\\`${trigger}\\\``, "g")) ?? [])
        .length,
      1,
    );
    assert.equal(
      (sql.match(new RegExp(`CREATE TRIGGER \\\`${trigger}\\\``, "g")) ?? [])
        .length,
      1,
    );
  }

  const database = migratedDatabase("0022_s6b3_admission_policy.sql");
  const workspace = seedWorkspace(database, "upgrade");
  const runner = seedRunner(database, workspace, "upgrade");
  const runId = `run_${"1".repeat(32)}`;
  const leaseId = `lse_${"1".repeat(32)}`;
  database
    .prepare(
      `INSERT INTO runs (
        id, organization_id, requested_by, deadline_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      workspace.organizationId,
      workspace.ownerId,
      "2026-07-26T12:30:00.000Z",
      "2026-07-26T11:00:00.000Z",
      "2026-07-26T11:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO run_leases (
        id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      leaseId,
      workspace.organizationId,
      runId,
      runner.runnerId,
      "2026-07-26T11:30:00.000Z",
      "2026-07-26T12:00:00.000Z",
      "2026-07-26T11:30:00.000Z",
      "2026-07-26T11:30:00.000Z",
    );

  database.exec(sql);

  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT assigned_runner_id, required_capability
           FROM runs WHERE id = ?`,
        )
        .get(runId),
    },
    { assigned_runner_id: null, required_capability: null },
  );
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT admission_basis, admission_policy_source,
                  admission_policy_version, admission_freshness_seconds,
                  admission_required_capability, admission_report_id,
                  admission_report_received_at
           FROM run_leases WHERE id = ?`,
        )
        .get(leaseId),
    },
    {
      admission_basis: null,
      admission_policy_source: null,
      admission_policy_version: null,
      admission_freshness_seconds: null,
      admission_required_capability: null,
      admission_report_id: null,
      admission_report_received_at: null,
    },
  );
  for (const trigger of [
    "runs_validate_before_insert",
    "runs_validate_before_update",
    "run_leases_validate_before_insert",
    "run_leases_validate_before_update",
    "run_events_validate_before_insert",
  ]) {
    assert.equal(
      database
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        )
        .get(trigger).count,
      1,
    );
  }
  database.close();
});

test("assigned storage forbids fallback and makes every admission pin immutable", () => {
  const database = migratedDatabase();
  const workspace = seedWorkspace(database, "matrix");
  const otherWorkspace = seedWorkspace(database, "other");
  const runnerA = seedRunner(database, workspace, "matrix-a");
  const runnerB = seedRunner(database, workspace, "matrix-b");
  const otherRunner = seedRunner(database, otherWorkspace, "other-a");

  assert.throws(
    () =>
      insertRun(database, {
        runId: `run_${"2".repeat(32)}`,
        ...workspace,
        assignedRunnerId: otherRunner.runnerId,
      }),
    /invalid_run/,
  );
  assert.throws(
    () =>
      insertRun(database, {
        runId: `run_${"3".repeat(32)}`,
        ...workspace,
        requiredCapability: "bubblewrap",
      }),
    /invalid_run/,
  );
  assert.throws(
    () =>
      insertRun(database, {
        runId: `run_${"4".repeat(32)}`,
        ...workspace,
        assignedRunnerId: runnerA.runnerId,
        requiredCapability: "not_a_capability",
      }),
    /invalid_run/,
  );

  const inactiveRunner = seedRunner(database, workspace, "matrix-inactive");
  database
    .prepare("UPDATE principals SET status = 'disabled' WHERE id = ?")
    .run(inactiveRunner.principalId);
  assert.throws(
    () =>
      insertRun(database, {
        runId: `run_${"d".repeat(32)}`,
        ...workspace,
        assignedRunnerId: inactiveRunner.runnerId,
      }),
    /invalid_run/,
  );

  const runId = `run_${"5".repeat(32)}`;
  insertRun(database, {
    runId,
    ...workspace,
    assignedRunnerId: runnerA.runnerId,
  });
  assert.throws(
    () =>
      database
        .prepare("UPDATE runs SET assigned_runner_id = ? WHERE id = ?")
        .run(runnerB.runnerId, runId),
    /invalid_run_transition/,
  );
  assert.throws(
    () =>
      database
        .prepare("UPDATE runs SET required_capability = ? WHERE id = ?")
        .run("bubblewrap", runId),
    /invalid_run_transition/,
  );
  assert.throws(
    () =>
      insertLease(database, {
        leaseId: `lse_${"2".repeat(32)}`,
        organizationId: workspace.organizationId,
        runId,
        runnerId: runnerB.runnerId,
        issuedAt: "2026-07-26T12:00:00.000Z",
        admissionBasis: "assignment_only",
      }),
    /invalid_run_lease_assignment/,
  );
  assert.equal(
    database.prepare("SELECT claim_count FROM runs WHERE id = ?").get(runId)
      .claim_count,
    0,
  );

  const revokedRunId = `run_${"e".repeat(32)}`;
  insertRun(database, {
    runId: revokedRunId,
    ...workspace,
    assignedRunnerId: runnerB.runnerId,
  });
  database
    .prepare("UPDATE principals SET status = 'disabled' WHERE id = ?")
    .run(runnerB.principalId);
  database
    .prepare(
      `UPDATE runners
       SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      "2026-07-26T11:59:00.000Z",
      workspace.ownerId,
      "2026-07-26T11:59:00.000Z",
      runnerB.runnerId,
    );
  assert.throws(
    () =>
      insertLease(database, {
        leaseId: `lse_${"e".repeat(32)}`,
        organizationId: workspace.organizationId,
        runId: revokedRunId,
        runnerId: runnerB.runnerId,
        issuedAt: "2026-07-26T12:00:00.000Z",
        admissionBasis: "assignment_only",
      }),
    /invalid_run_lease/,
  );
  assert.equal(
    database
      .prepare("SELECT claim_count FROM runs WHERE id = ?")
      .get(revokedRunId).claim_count,
    0,
  );

  const leaseId = `lse_${"3".repeat(32)}`;
  insertLease(database, {
    leaseId,
    organizationId: workspace.organizationId,
    runId,
    runnerId: runnerA.runnerId,
    issuedAt: "2026-07-26T12:00:00.000Z",
    admissionBasis: "assignment_only",
  });
  const mutations = [
    ["admission_basis", "capability_declaration"],
    ["admission_policy_source", "default"],
    ["admission_policy_version", 0],
    ["admission_freshness_seconds", 86400],
    ["admission_required_capability", "bubblewrap"],
    ["admission_report_id", `cap_${"a".repeat(32)}`],
    ["admission_report_received_at", "2026-07-26T12:00:00.000Z"],
  ];
  for (const [column, value] of mutations) {
    assert.throws(
      () =>
        database
          .prepare(`UPDATE run_leases SET ${column} = ? WHERE id = ?`)
          .run(value, leaseId),
      /invalid_run_lease_transition/,
      `${column} must be immutable`,
    );
  }

  const assignmentMetadata = JSON.stringify({
    leaseId,
    operationId: `op_${"3".repeat(32)}`,
    assignedRunnerId: runnerA.runnerId,
    admissionBasis: "assignment_only",
  });
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO run_events (
            organization_id, run_id, sequence, kind, actor_id, fence,
            occurred_at, metadata_json
          ) VALUES (?, ?, 2, 'lease.claimed', ?, 1, ?, ?)`,
        )
        .run(
          workspace.organizationId,
          runId,
          runnerA.principalId,
          "2026-07-26T12:00:00.000Z",
          assignmentMetadata.replace(/}$/, ',"extra":true}'),
        ),
    /invalid_run_event/,
  );
  const wrongKeyMetadata = JSON.stringify({
    leaseId,
    operationId: `op_${"3".repeat(32)}`,
    assignedRunnerId: runnerA.runnerId,
    basis: "assignment_only",
  });
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO run_events (
            organization_id, run_id, sequence, kind, actor_id, fence,
            occurred_at, metadata_json
          ) VALUES (?, ?, 2, 'lease.claimed', ?, 1, ?, ?)`,
        )
        .run(
          workspace.organizationId,
          runId,
          runnerA.principalId,
          "2026-07-26T12:00:00.000Z",
          wrongKeyMetadata,
        ),
    /invalid_run_event/,
  );
  database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, fence,
        occurred_at, metadata_json
      ) VALUES (?, ?, 2, 'lease.claimed', ?, 1, ?, ?)`,
    )
    .run(
      workspace.organizationId,
      runId,
      runnerA.principalId,
      "2026-07-26T12:00:00.000Z",
      assignmentMetadata,
    );

  releaseLease(database, leaseId, "2026-07-26T12:01:00.000Z");
  const unassignedRunId = `run_${"6".repeat(32)}`;
  const unassignedLeaseId = `lse_${"4".repeat(32)}`;
  insertRun(database, { runId: unassignedRunId, ...workspace });
  insertLease(database, {
    leaseId: unassignedLeaseId,
    organizationId: workspace.organizationId,
    runId: unassignedRunId,
    runnerId: runnerA.runnerId,
    issuedAt: "2026-07-26T12:02:00.000Z",
  });
  const unassignedMetadata =
    `{"leaseId":"${unassignedLeaseId}",` +
    `"operationId":"op_${"4".repeat(32)}"}`;
  database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, fence,
        occurred_at, metadata_json
      ) VALUES (?, ?, 2, 'lease.claimed', ?, 1, ?, ?)`,
    )
    .run(
      workspace.organizationId,
      unassignedRunId,
      runnerA.principalId,
      "2026-07-26T12:02:00.000Z",
      unassignedMetadata,
    );
  assert.equal(
    database
      .prepare(
        "SELECT metadata_json FROM run_events WHERE run_id = ? AND sequence = 2",
      )
      .get(unassignedRunId).metadata_json,
    unassignedMetadata,
  );
  database.close();
});

test("capability admission pins latest report, policy and integer-ms boundaries", () => {
  const database = migratedDatabase();
  const workspace = seedWorkspace(database, "capability");
  const runner = seedRunner(database, workspace, "capability-a");
  const reportId = `cap_${"1".repeat(32)}`;
  const receivedAt = "2026-07-26T12:00:00.000Z";
  insertReport(database, {
    organizationId: workspace.organizationId,
    runnerId: runner.runnerId,
    reportId,
    receivedAt,
  });

  const attempts = [
    {
      digit: "d",
      issuedAt: "2026-07-26T11:59:59.999Z",
    },
    {
      digit: "7",
      issuedAt: "2026-07-27T11:59:59.999Z",
    },
    {
      digit: "8",
      issuedAt: "2026-07-27T12:00:00.000Z",
    },
    {
      digit: "9",
      issuedAt: "2026-07-27T12:00:00.001Z",
    },
  ];
  const oracleResults = capabilityFreshnessOracle(
    attempts.map((attempt) => ({
      freshnessSeconds: 86400,
      issuedAt: attempt.issuedAt,
      receivedAt,
    })),
  );
  assert.deepEqual(oracleResults, [false, true, true, false]);
  for (const [position, attempt] of attempts.entries()) {
    const runId = `run_${attempt.digit.repeat(32)}`;
    const leaseId = `lse_${attempt.digit.repeat(32)}`;
    insertRun(database, {
      runId,
      ...workspace,
      assignedRunnerId: runner.runnerId,
      requiredCapability: "bubblewrap",
    });
    const insert = () =>
      insertLease(
        database,
        capabilityLease({
          leaseId,
          organizationId: workspace.organizationId,
          runId,
          runnerId: runner.runnerId,
          issuedAt: attempt.issuedAt,
          expiresAt: "2026-07-29T11:00:00.000Z",
          reportId,
          reportReceivedAt: receivedAt,
        }),
      );
    if (oracleResults[position]) {
      insert();
      releaseLease(
        database,
        leaseId,
        new Date(Date.parse(attempt.issuedAt) + 1).toISOString(),
      );
    } else {
      assert.throws(insert, /invalid_run_lease_admission/);
      assert.equal(
        database.prepare("SELECT claim_count FROM runs WHERE id = ?").get(runId)
          .claim_count,
        0,
      );
    }
  }

  const newerReportId = `cap_${"2".repeat(32)}`;
  insertReport(database, {
    organizationId: workspace.organizationId,
    runnerId: runner.runnerId,
    reportId: newerReportId,
    receivedAt,
    requestHash: "d".repeat(64),
    declarationHash: "e".repeat(64),
  });
  const shadowedRunId = `run_${"a".repeat(32)}`;
  insertRun(database, {
    runId: shadowedRunId,
    ...workspace,
    assignedRunnerId: runner.runnerId,
    requiredCapability: "bubblewrap",
  });
  assert.throws(
    () =>
      insertLease(
        database,
        capabilityLease({
          leaseId: `lse_${"a".repeat(32)}`,
          organizationId: workspace.organizationId,
          runId: shadowedRunId,
          runnerId: runner.runnerId,
          issuedAt: "2026-07-26T12:00:01.000Z",
          reportId,
          reportReceivedAt: receivedAt,
        }),
      ),
    /invalid_run_lease_admission/,
  );

  configurePolicy(database, {
    ...workspace,
    version: 1,
    freshnessSeconds: 86400,
    allowedCapabilities: ["bubblewrap"],
    occurredAt: "2026-07-26T12:00:02.000Z",
  });
  const configuredRunId = `run_${"b".repeat(32)}`;
  const configuredLeaseId = `lse_${"b".repeat(32)}`;
  insertRun(database, {
    runId: configuredRunId,
    ...workspace,
    assignedRunnerId: runner.runnerId,
    requiredCapability: "bubblewrap",
  });
  assert.throws(
    () =>
      insertLease(
        database,
        capabilityLease({
          leaseId: configuredLeaseId,
          organizationId: workspace.organizationId,
          runId: configuredRunId,
          runnerId: runner.runnerId,
          issuedAt: "2026-07-26T12:00:03.000Z",
          reportId: newerReportId,
          reportReceivedAt: receivedAt,
        }),
      ),
    /invalid_run_lease_admission/,
    "a configured head must reject a stale default-policy pin",
  );
  insertLease(
    database,
    capabilityLease({
      leaseId: configuredLeaseId,
      organizationId: workspace.organizationId,
      runId: configuredRunId,
      runnerId: runner.runnerId,
      issuedAt: "2026-07-26T12:00:03.000Z",
      reportId: newerReportId,
      reportReceivedAt: receivedAt,
      admissionPolicySource: "configured",
      admissionPolicyVersion: 1,
      admissionFreshnessSeconds: 86400,
    }),
  );
  for (const column of [
    "admission_basis",
    "admission_policy_source",
    "admission_policy_version",
    "admission_freshness_seconds",
    "admission_required_capability",
    "admission_report_id",
    "admission_report_received_at",
  ]) {
    assert.throws(
      () =>
        database
          .prepare(`UPDATE run_leases SET ${column} = NULL WHERE id = ?`)
          .run(configuredLeaseId),
      /invalid_run_lease_transition/,
      `${column} must not transition from a value to NULL`,
    );
  }
  const capabilityMetadata = JSON.stringify({
    leaseId: configuredLeaseId,
    operationId: `op_${"b".repeat(32)}`,
    assignedRunnerId: runner.runnerId,
    admissionBasis: "capability_declaration",
    admissionPolicySource: "configured",
    admissionPolicyVersion: 1,
    admissionFreshnessSeconds: 86400,
    admissionRequiredCapability: "bubblewrap",
    admissionReportId: newerReportId,
    admissionReportReceivedAt: receivedAt,
  });
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO run_events (
            organization_id, run_id, sequence, kind, actor_id, fence,
            occurred_at, metadata_json
          ) VALUES (?, ?, 2, 'lease.claimed', ?, 1, ?, ?)`,
        )
        .run(
          workspace.organizationId,
          configuredRunId,
          runner.principalId,
          "2026-07-26T12:00:03.000Z",
          capabilityMetadata.replace(
            '"admissionFreshnessSeconds":86400',
            '"admissionFreshnessSeconds":86401',
          ),
        ),
    /invalid_run_event/,
  );
  database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, fence,
        occurred_at, metadata_json
      ) VALUES (?, ?, 2, 'lease.claimed', ?, 1, ?, ?)`,
    )
    .run(
      workspace.organizationId,
      configuredRunId,
      runner.principalId,
      "2026-07-26T12:00:03.000Z",
      capabilityMetadata,
    );
  releaseLease(database, configuredLeaseId, "2026-07-26T12:00:04.000Z");

  configurePolicy(database, {
    ...workspace,
    version: 2,
    freshnessSeconds: 86400,
    allowedCapabilities: [],
    occurredAt: "2026-07-26T12:00:05.000Z",
    previousHash: "1".repeat(64),
    hash: "2".repeat(64),
  });
  const deniedRunId = `run_${"c".repeat(32)}`;
  insertRun(database, {
    runId: deniedRunId,
    ...workspace,
    assignedRunnerId: runner.runnerId,
    requiredCapability: "bubblewrap",
  });
  assert.throws(
    () =>
      insertLease(
        database,
        capabilityLease({
          leaseId: `lse_${"c".repeat(32)}`,
          organizationId: workspace.organizationId,
          runId: deniedRunId,
          runnerId: runner.runnerId,
          issuedAt: "2026-07-26T12:00:06.000Z",
          reportId: newerReportId,
          reportReceivedAt: receivedAt,
          admissionPolicySource: "configured",
          admissionPolicyVersion: 2,
          admissionFreshnessSeconds: 86400,
        }),
      ),
    /invalid_run_lease_admission/,
    "an explicit empty allow-list must deny capability admission",
  );
  assert.equal(
    database
      .prepare("SELECT claim_count FROM runs WHERE id = ?")
      .get(deniedRunId).claim_count,
    0,
  );
  database.close();
});

test("SQLite integer milliseconds match Date.parse across calendar edges", () => {
  const database = new DatabaseSync(":memory:");
  for (const timestamp of [
    "1969-12-31T23:59:59.999Z",
    "1970-01-01T00:00:00.000Z",
    "2000-02-29T23:59:59.001Z",
    "2026-07-26T12:34:56.789Z",
    "2026-12-31T23:59:59.999Z",
    "2027-01-01T00:00:00.000Z",
  ]) {
    const actual = database
      .prepare(
        `SELECT
           CAST(strftime('%s', ?) AS INTEGER) * 1000
           + CAST(substr(?, 21, 3) AS INTEGER) AS milliseconds`,
      )
      .get(timestamp, timestamp).milliseconds;
    assert.equal(actual, Date.parse(timestamp), timestamp);
  }
  database.close();
});

test("capability admission denial matrix remains fail-closed", () => {
  const denialCases = [
    {
      name: "unavailable evidence",
      prepare(database, context) {
        insertReport(database, {
          ...context,
          evidenceStatus: "unavailable",
        });
        return capabilityLease(context);
      },
    },
    {
      name: "unknown evidence",
      prepare(database, context) {
        insertReport(database, {
          ...context,
          evidenceStatus: "unknown",
        });
        return capabilityLease(context);
      },
    },
    {
      name: "missing report",
      prepare(_database, context) {
        return capabilityLease(context);
      },
    },
    {
      name: "latest report missing the required capability",
      prepare(database, context) {
        insertReport(database, { ...context, capability: "docker" });
        return capabilityLease(context);
      },
    },
    {
      name: "report belongs to another runner",
      prepare(database, context) {
        const otherRunner = seedRunner(
          database,
          context.workspace,
          `${context.suffix}-b`,
        );
        insertReport(database, {
          ...context,
          runnerId: otherRunner.runnerId,
        });
        return capabilityLease(context);
      },
    },
    {
      name: "assignment-only downgrade on a capability run",
      prepare(_database, context) {
        return {
          ...context,
          admissionBasis: "assignment_only",
        };
      },
    },
    {
      name: "all-null pins on a capability run",
      prepare(_database, context) {
        return context;
      },
    },
    {
      name: "configured source without a configured policy",
      prepare(database, context) {
        insertReport(database, context);
        return capabilityLease({
          ...context,
          admissionPolicySource: "configured",
          admissionPolicyVersion: 1,
        });
      },
    },
    {
      name: "noncanonical issued timestamp",
      prepare(database, context) {
        insertReport(database, context);
        return capabilityLease({
          ...context,
          issuedAt: "2026-07-26T12:00:00.000+00:00",
        });
      },
    },
    {
      name: "noninteger policy version",
      prepare(database, context) {
        insertReport(database, context);
        return capabilityLease({
          ...context,
          admissionPolicyVersion: "zero",
        });
      },
    },
  ];

  for (const [position, denialCase] of denialCases.entries()) {
    const database = migratedDatabase();
    const suffix = `deny-${position}-a`;
    const workspace = seedWorkspace(database, `deny-${position}`);
    const runner = seedRunner(database, workspace, suffix);
    const runId = `run_${position.toString(16).repeat(32)}`;
    const context = {
      leaseId: `lse_${position.toString(16).repeat(32)}`,
      organizationId: workspace.organizationId,
      reportId: `cap_${position.toString(16).repeat(32)}`,
      reportReceivedAt: "2026-07-26T12:00:00.000Z",
      receivedAt: "2026-07-26T12:00:00.000Z",
      runId,
      runnerId: runner.runnerId,
      issuedAt: "2026-07-26T12:00:01.000Z",
      suffix,
      workspace,
    };
    insertRun(database, {
      runId,
      ...workspace,
      assignedRunnerId: runner.runnerId,
      requiredCapability: "bubblewrap",
    });
    const input = denialCase.prepare(database, context);
    assert.throws(
      () => insertLease(database, input),
      (error) =>
        error instanceof Error &&
        error.message === "invalid_run_lease_admission",
      denialCase.name,
    );
    assert.equal(
      database.prepare("SELECT claim_count FROM runs WHERE id = ?").get(runId)
        .claim_count,
      0,
      denialCase.name,
    );
    database.close();
  }
});

test("the virtual default admits every capability in the closed set", () => {
  for (const [position, capability] of capabilities.entries()) {
    const database = migratedDatabase();
    const workspace = seedWorkspace(database, `allow-${position}`);
    const runner = seedRunner(database, workspace, `allow-${position}-a`);
    const digit = (position + 1).toString(16);
    const runId = `run_${digit.repeat(32)}`;
    const reportId = `cap_${digit.repeat(32)}`;
    insertReport(database, {
      organizationId: workspace.organizationId,
      runnerId: runner.runnerId,
      reportId,
      receivedAt: "2026-07-26T12:00:00.000Z",
      capability,
    });
    insertRun(database, {
      runId,
      ...workspace,
      assignedRunnerId: runner.runnerId,
      requiredCapability: capability,
    });
    insertLease(
      database,
      capabilityLease({
        leaseId: `lse_${digit.repeat(32)}`,
        organizationId: workspace.organizationId,
        runId,
        runnerId: runner.runnerId,
        issuedAt: "2026-07-26T12:00:01.000Z",
        reportId,
        reportReceivedAt: "2026-07-26T12:00:00.000Z",
        requiredCapability: capability,
      }),
    );
    assert.equal(
      database.prepare("SELECT claim_count FROM runs WHERE id = ?").get(runId)
        .claim_count,
      1,
      capability,
    );
    database.close();
  }
});

test("closed capability set remains synchronized with assigned storage", () => {
  const sql = migrationSql(migrationName);
  const runtimeContracts = runtimeContractSets();
  const capabilityClause = sql.match(
    /NEW\.`required_capability` NOT IN \(([\s\S]*?)\)/u,
  )?.[1];
  const metadataClause = sql.match(
    /field\.`key` NOT IN \(([\s\S]*?)\)/u,
  )?.[1];
  assert.ok(capabilityClause);
  assert.ok(metadataClause);
  const quotedValues = (value) =>
    [...value.matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  assert.deepEqual(quotedValues(capabilityClause), runtimeContracts.capabilities);
  assert.deepEqual(capabilities, runtimeContracts.capabilities);
  assert.deepEqual(quotedValues(metadataClause), runtimeContracts.metadataKeys);
  assert.match(sql, /FROM json_each\(NEW\.`metadata_json`\)\s*\) = 2/u);
  assert.match(sql, /FROM json_each\(NEW\.`metadata_json`\)\s*\) = 4/u);
  assert.match(sql, /FROM json_each\(NEW\.`metadata_json`\)\s*\) = 10/u);
});
