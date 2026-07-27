import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildReconcileLeasesSql } from "../scripts/lease-preflight.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL(
  "../node_modules/wrangler/bin/wrangler.js",
  import.meta.url,
));
const preflightPath = fileURLToPath(new URL(
  "../scripts/lease-preflight.mjs",
  import.meta.url,
));

test("real local Wrangler CLI exposes crash gaps and exact RETURNING counts", async () => {
  const persistPath = mkdtempSync(join(tmpdir(), "nexus-lease-preflight-"));
  try {
    await applyLegacyMigrations(persistPath);
    await executeD1(persistPath, seedSql());
    const blockedMigration = await runMigrationsApply(persistPath);
    assert.notEqual(blockedMigration.code, 0);
    assert.match(
      `${blockedMigration.stdout}\n${blockedMigration.stderr}`,
      /0021_wakeful_talkback\.sql[\s\S]*UNIQUE constraint failed:\s*run_leases\.runner_id/iu,
    );
    assert.deepEqual(await migrationState(persistPath), {
      assignedStorageMigrationCount: 0,
      indexCount: 0,
      migrationCount: 0,
    });

    const initial = await runPreflight(persistPath);
    assert.equal(initial.code, 2);
    assert.equal(initial.result.duplicateRunners, 1);
    assert.equal(initial.result.activeLeases.length, 3);
    assert.deepEqual(initial.result.missingEvents, []);

    const firstApply = await runPreflight(persistPath, ["--apply"]);
    assert.equal(firstApply.code, 0);
    assert.equal(firstApply.result.duplicateRunnersBefore, 1);
    assert.equal(firstApply.result.leasesReconciled, 2);
    assert.equal(firstApply.result.eventsAppended, 2);
    assert.equal(firstApply.result.duplicateRunnersAfter, 0);
    assert.deepEqual(firstApply.result.missingEventsAfter, []);

    const firstIdempotent = await runPreflight(persistPath, ["--apply"]);
    assert.equal(firstIdempotent.code, 0);
    assert.equal(firstIdempotent.result.leasesReconciled, 0);
    assert.equal(firstIdempotent.result.eventsAppended, 0);

    await executeD1(
      persistPath,
      `${appendActiveLeaseSql(
        "7",
        "2026-07-26T12:03:00.000Z",
        "2026-07-26T12:06:00.000Z",
      )}
      ${appendActiveLeaseSql(
        "8",
        "2026-07-26T12:04:00.000Z",
        "2026-07-26T12:07:00.000Z",
      )}`,
    );
    await executeD1(
      persistPath,
      buildReconcileLeasesSql("2026-07-26T12:08:00.000Z"),
    );
    const crashed = await runPreflight(persistPath);
    assert.equal(crashed.code, 2);
    assert.equal(crashed.result.duplicateRunners, 0);
    assert.deepEqual(crashed.result.activeLeases, []);
    assert.equal(crashed.result.missingEvents.length, 2);

    const repaired = await runPreflight(persistPath, ["--apply"]);
    assert.equal(repaired.code, 0);
    assert.equal(repaired.result.duplicateRunnersBefore, 0);
    assert.equal(repaired.result.leasesReconciled, 0);
    assert.equal(repaired.result.eventsAppended, 2);
    assert.equal(repaired.result.duplicateRunnersAfter, 0);
    assert.deepEqual(repaired.result.missingEventsAfter, []);

    const idempotent = await runPreflight(persistPath, ["--apply"]);
    assert.equal(idempotent.code, 0);
    assert.equal(idempotent.result.leasesReconciled, 0);
    assert.equal(idempotent.result.eventsAppended, 0);
    assert.equal(idempotent.result.duplicateRunnersAfter, 0);
    assert.deepEqual(idempotent.result.missingEventsAfter, []);

    const appliedMigration = await runMigrationsApply(persistPath);
    assert.equal(
      appliedMigration.code,
      0,
      `${appliedMigration.stdout}\n${appliedMigration.stderr}`,
    );
    assert.deepEqual(await migrationState(persistPath), {
      assignedStorageMigrationCount: 1,
      indexCount: 1,
      migrationCount: 1,
    });
    await verifyAssignedStorageRuntime(persistPath);
  } finally {
    rmSync(persistPath, { recursive: true, force: true });
  }
});

async function applyLegacyMigrations(persistPath) {
  const migrations = readdirSync(new URL("../drizzle/", import.meta.url))
    .filter(
      (name) =>
        /^\d{4}_[0-9A-Za-z_]+\.sql$/u.test(name) &&
        Number(name.slice(0, 4)) < 21,
    )
    .sort();
  await executeD1(
    persistPath,
    `CREATE TABLE d1_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT UNIQUE,
       applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
     )`,
  );
  for (const migration of migrations) {
    const sql = readFileSync(
      new URL(`../drizzle/${migration}`, import.meta.url),
      "utf8",
    ).replaceAll("--> statement-breakpoint", "");
    await executeD1(
      persistPath,
      `${sql}
       INSERT INTO d1_migrations (name) VALUES ('${migration}');`,
    );
  }
}

async function runMigrationsApply(persistPath) {
  return runNode([
    wranglerPath,
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    "wrangler.local.jsonc",
    "--persist-to",
    persistPath,
  ]);
}

async function migrationState(persistPath) {
  const result = await executeD1(
    persistPath,
    `SELECT
       (SELECT COUNT(*) FROM d1_migrations
        WHERE name = '0021_wakeful_talkback.sql') AS migrationCount,
       (SELECT COUNT(*) FROM d1_migrations
        WHERE name = '0023_s6b3_assigned_storage.sql')
         AS assignedStorageMigrationCount,
       (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'index'
          AND name = 'run_leases_active_runner_uidx') AS indexCount`,
  );
  return result[0]?.results[0];
}

async function runPreflight(persistPath, args = []) {
  const result = await runNode([
    preflightPath,
    "--local",
    "--persist-to",
    persistPath,
    ...args,
  ]);
  assert.equal(result.stderr, "");
  return { code: result.code, result: JSON.parse(result.stdout) };
}

async function executeD1(persistPath, sql) {
  const result = await executeD1Command(persistPath, sql);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function executeD1Failure(persistPath, sql, expectedError) {
  const result = await executeD1Command(persistPath, sql);
  assert.notEqual(result.code, 0, "expected D1 command to fail");
  assert.match(`${result.stdout}\n${result.stderr}`, expectedError);
}

async function executeD1Command(persistPath, sql) {
  return runNode([
    wranglerPath,
    "d1",
    "execute",
    "DB",
    "--local",
    "--config",
    "wrangler.local.jsonc",
    "--persist-to",
    persistPath,
    "--command",
    sql,
    "--json",
  ]);
}

function runNode(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

function seedSql() {
  const statements = [
    `INSERT INTO organizations (id, slug, name)
     VALUES ('org-preflight-cli', 'preflight-cli', 'Preflight CLI')`,
    `INSERT INTO principals (
       id, organization_id, kind, display_name
     ) VALUES (
       'owner-preflight-cli',
       'org-preflight-cli',
       'human',
       'Preflight CLI owner'
     )`,
    `INSERT INTO memberships (
       id, organization_id, principal_id, role
     ) VALUES (
       'membership-preflight-cli',
       'org-preflight-cli',
       'owner-preflight-cli',
       'owner'
     )`,
    `INSERT INTO principals (
       id, organization_id, kind, external_id, display_name
     ) VALUES (
       'principal-preflight-cli-runner',
       'org-preflight-cli',
       'runner',
       'runner-preflight-cli',
       'Preflight CLI runner'
     )`,
    `INSERT INTO runner_enrollment_tokens (
       id, organization_id, token_hash, issued_by, display_name,
       issued_at, expires_at
     ) VALUES (
       'token-preflight-cli',
       'org-preflight-cli',
       '${"b".repeat(64)}',
       'owner-preflight-cli',
       'Preflight CLI runner',
       '2026-07-26T12:00:00.000Z',
       '2026-07-26T12:15:00.000Z'
     )`,
    `INSERT INTO runners (
       id, organization_id, principal_id, enrollment_token_id,
       display_name, public_key, enrolled_at
     ) VALUES (
       'runner-preflight-cli',
       'org-preflight-cli',
       'principal-preflight-cli-runner',
       'token-preflight-cli',
       'Preflight CLI runner',
       '${"B".repeat(43)}',
       '2026-07-26T12:00:30.000Z'
     )`,
  ];
  for (const [digit, issuedAt] of [
    ["4", "2026-07-26T12:01:00.000Z"],
    ["5", "2026-07-26T12:02:00.000Z"],
    ["6", "2026-07-26T12:02:00.000Z"],
  ]) {
    const runId = `run_${digit.repeat(32)}`;
    const leaseId = `lse_${digit.repeat(32)}`;
    statements.push(
      `INSERT INTO runs (
         id, organization_id, requested_by, deadline_at, created_at, updated_at
       ) VALUES (
         '${runId}',
         'org-preflight-cli',
         'owner-preflight-cli',
         '2026-07-26T12:15:00.000Z',
         '2026-07-26T12:00:00.000Z',
         '2026-07-26T12:00:00.000Z'
       )`,
      `INSERT INTO run_events (
         organization_id, run_id, sequence, kind, actor_id, occurred_at
       ) VALUES (
         'org-preflight-cli',
         '${runId}',
         1,
         'run.created',
         'owner-preflight-cli',
         '2026-07-26T12:00:00.000Z'
       )`,
      `INSERT INTO run_leases (
         id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
         created_at, updated_at
       ) VALUES (
         '${leaseId}',
         'org-preflight-cli',
         '${runId}',
         'runner-preflight-cli',
         1,
         '${issuedAt}',
         '2026-07-26T12:05:00.000Z',
         '${issuedAt}',
         '${issuedAt}'
       )`,
    );
  }
  return `${statements.join(";\n")};`;
}

function appendActiveLeaseSql(digit, issuedAt, expiresAt) {
  const runId = `run_${digit.repeat(32)}`;
  const leaseId = `lse_${digit.repeat(32)}`;
  return `
    INSERT INTO runs (
      id, organization_id, requested_by, deadline_at, created_at, updated_at
    ) VALUES (
      '${runId}',
      'org-preflight-cli',
      'owner-preflight-cli',
      '2026-07-26T12:15:00.000Z',
      '${issuedAt}',
      '${issuedAt}'
    );
    INSERT INTO run_events (
      organization_id, run_id, sequence, kind, actor_id, occurred_at
    ) VALUES (
      'org-preflight-cli',
      '${runId}',
      1,
      'run.created',
      'owner-preflight-cli',
      '${issuedAt}'
    );
    INSERT INTO run_leases (
      id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
      created_at, updated_at
    ) VALUES (
      '${leaseId}',
      'org-preflight-cli',
      '${runId}',
      'runner-preflight-cli',
      1,
      '${issuedAt}',
      '${expiresAt}',
      '${issuedAt}',
      '${issuedAt}'
    );
  `;
}

async function verifyAssignedStorageRuntime(persistPath) {
  await executeD1(persistPath, assignedStorageSeedSql());

  await executeD1Failure(
    persistPath,
    capabilityClaimedEventSql(true),
    /invalid_run_event/u,
  );
  await executeD1(persistPath, capabilityClaimedEventSql(false));
  await executeD1(
    persistPath,
    `UPDATE run_leases
     SET status = 'released',
         ended_at = '2026-07-27T12:00:00.001Z',
         ended_reason = 'runtime_smoke',
         updated_at = '2026-07-27T12:00:00.001Z'
     WHERE id = 'lse_${"b".repeat(32)}';
     INSERT INTO runs (
       id, organization_id, requested_by, deadline_at, assigned_runner_id,
       required_capability, created_at, updated_at
     ) VALUES (
       'run_${"c".repeat(32)}',
       'org-assigned-cli',
       'owner-assigned-cli',
       '2026-07-27T12:15:00.000Z',
       'runner-assigned-cli',
       'bubblewrap',
       '2026-07-26T11:00:00.000Z',
       '2026-07-26T11:00:00.000Z'
     );
     INSERT INTO run_events (
       organization_id, run_id, sequence, kind, actor_id, occurred_at
     ) VALUES (
       'org-assigned-cli',
       'run_${"c".repeat(32)}',
       1,
       'run.created',
       'owner-assigned-cli',
       '2026-07-26T11:00:00.000Z'
     );`,
  );
  await executeD1Failure(
    persistPath,
    `INSERT INTO run_leases (
       id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
       admission_basis, admission_policy_source, admission_policy_version,
       admission_freshness_seconds, admission_required_capability,
       admission_report_id, admission_report_received_at,
       created_at, updated_at
     ) VALUES (
       'lse_${"c".repeat(32)}',
       'org-assigned-cli',
       'run_${"c".repeat(32)}',
       'runner-assigned-cli',
       1,
       '2026-07-27T12:00:00.001Z',
       '2026-07-27T12:05:00.000Z',
       'capability_declaration',
       'default',
       0,
       86400,
       'bubblewrap',
       'cap_${"b".repeat(32)}',
       '2026-07-26T12:00:00.000Z',
       '2026-07-27T12:00:00.001Z',
       '2026-07-27T12:00:00.001Z'
     );`,
    /invalid_run_lease_admission/u,
  );

  const runtimeState = await executeD1(
    persistPath,
    `SELECT
       CAST(strftime(
         '%s', '2026-07-26T12:34:56.789Z'
       ) AS INTEGER) * 1000
         + CAST(substr(
           '2026-07-26T12:34:56.789Z', 21, 3
         ) AS INTEGER) AS milliseconds,
       (SELECT COUNT(*) FROM run_leases
        WHERE organization_id = 'org-assigned-cli') AS leaseCount,
       (SELECT COUNT(*) FROM run_events
        WHERE organization_id = 'org-assigned-cli'
          AND kind = 'lease.claimed') AS claimedEventCount,
       (SELECT SUM(claim_count) FROM runs
        WHERE id IN (
          'run_${"a".repeat(32)}',
          'run_${"b".repeat(32)}'
        )) AS acceptedClaimCount,
       (SELECT claim_count FROM runs
        WHERE id = 'run_${"c".repeat(32)}') AS deniedClaimCount`,
  );
  assert.deepEqual(runtimeState[0]?.results[0], {
    acceptedClaimCount: 2,
    claimedEventCount: 2,
    deniedClaimCount: 0,
    leaseCount: 2,
    milliseconds: 1785069296789,
  });
}

function assignedStorageSeedSql() {
  const assignmentRunId = `run_${"a".repeat(32)}`;
  const assignmentLeaseId = `lse_${"a".repeat(32)}`;
  const capabilityRunId = `run_${"b".repeat(32)}`;
  const capabilityLeaseId = `lse_${"b".repeat(32)}`;
  const reportId = `cap_${"b".repeat(32)}`;
  return `
    INSERT INTO organizations (id, slug, name)
    VALUES ('org-assigned-cli', 'assigned-cli', 'Assigned CLI');

    INSERT INTO principals (
      id, organization_id, kind, display_name
    ) VALUES (
      'owner-assigned-cli',
      'org-assigned-cli',
      'human',
      'Assigned CLI owner'
    );

    INSERT INTO memberships (
      id, organization_id, principal_id, role
    ) VALUES (
      'membership-assigned-cli',
      'org-assigned-cli',
      'owner-assigned-cli',
      'owner'
    );

    INSERT INTO principals (
      id, organization_id, kind, external_id, display_name
    ) VALUES (
      'principal-assigned-cli-runner',
      'org-assigned-cli',
      'runner',
      'runner-assigned-cli',
      'Assigned CLI runner'
    );

    INSERT INTO runner_enrollment_tokens (
      id, organization_id, token_hash, issued_by, display_name,
      issued_at, expires_at
    ) VALUES (
      'token-assigned-cli',
      'org-assigned-cli',
      '${"c".repeat(64)}',
      'owner-assigned-cli',
      'Assigned CLI runner',
      '2026-07-26T10:00:00.000Z',
      '2026-07-26T10:30:00.000Z'
    );

    INSERT INTO runners (
      id, organization_id, principal_id, enrollment_token_id,
      display_name, public_key, enrolled_at
    ) VALUES (
      'runner-assigned-cli',
      'org-assigned-cli',
      'principal-assigned-cli-runner',
      'token-assigned-cli',
      'Assigned CLI runner',
      '${"C".repeat(43)}',
      '2026-07-26T10:01:00.000Z'
    );

    INSERT INTO runs (
      id, organization_id, requested_by, deadline_at, assigned_runner_id,
      created_at, updated_at
    ) VALUES (
      '${assignmentRunId}',
      'org-assigned-cli',
      'owner-assigned-cli',
      '2026-07-26T12:15:00.000Z',
      'runner-assigned-cli',
      '2026-07-26T11:00:00.000Z',
      '2026-07-26T11:00:00.000Z'
    );

    INSERT INTO run_events (
      organization_id, run_id, sequence, kind, actor_id, occurred_at
    ) VALUES (
      'org-assigned-cli',
      '${assignmentRunId}',
      1,
      'run.created',
      'owner-assigned-cli',
      '2026-07-26T11:00:00.000Z'
    );

    INSERT INTO run_leases (
      id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
      admission_basis, created_at, updated_at
    ) VALUES (
      '${assignmentLeaseId}',
      'org-assigned-cli',
      '${assignmentRunId}',
      'runner-assigned-cli',
      1,
      '2026-07-26T12:00:00.000Z',
      '2026-07-26T12:05:00.000Z',
      'assignment_only',
      '2026-07-26T12:00:00.000Z',
      '2026-07-26T12:00:00.000Z'
    );

    INSERT INTO run_events (
      organization_id, run_id, sequence, kind, actor_id, fence,
      occurred_at, metadata_json
    ) VALUES (
      'org-assigned-cli',
      '${assignmentRunId}',
      2,
      'lease.claimed',
      'principal-assigned-cli-runner',
      1,
      '2026-07-26T12:00:00.000Z',
      '{"leaseId":"${assignmentLeaseId}","operationId":"op_${"a".repeat(32)}","assignedRunnerId":"runner-assigned-cli","admissionBasis":"assignment_only"}'
    );

    UPDATE run_leases
    SET status = 'released',
        ended_at = '2026-07-26T12:01:00.000Z',
        ended_reason = 'runtime_smoke',
        updated_at = '2026-07-26T12:01:00.000Z'
    WHERE id = '${assignmentLeaseId}';

    INSERT INTO runner_capability_reports (
      organization_id, runner_id, report_id, request_hash, declaration_hash,
      schema_version, platform_os, platform_arch, node_version, collected_at,
      received_at, truncated, response_status, response_body
    ) VALUES (
      'org-assigned-cli',
      'runner-assigned-cli',
      '${reportId}',
      '${"d".repeat(64)}',
      '${"e".repeat(64)}',
      1,
      'linux',
      'x64',
      'v22.0.0',
      '2026-07-26T12:00:00.000Z',
      '2026-07-26T12:00:00.000Z',
      0,
      201,
      '{}'
    );

    INSERT INTO runner_capability_evidence (
      runner_id, report_id, position, capability, status, detection,
      reason_code, version
    ) VALUES (
      'runner-assigned-cli',
      '${reportId}',
      0,
      'bubblewrap',
      'available',
      'binary_version',
      'none',
      '1.0'
    );

    INSERT INTO runs (
      id, organization_id, requested_by, deadline_at, assigned_runner_id,
      required_capability, created_at, updated_at
    ) VALUES (
      '${capabilityRunId}',
      'org-assigned-cli',
      'owner-assigned-cli',
      '2026-07-27T12:15:00.000Z',
      'runner-assigned-cli',
      'bubblewrap',
      '2026-07-26T11:00:00.000Z',
      '2026-07-26T11:00:00.000Z'
    );

    INSERT INTO run_events (
      organization_id, run_id, sequence, kind, actor_id, occurred_at
    ) VALUES (
      'org-assigned-cli',
      '${capabilityRunId}',
      1,
      'run.created',
      'owner-assigned-cli',
      '2026-07-26T11:00:00.000Z'
    );

    INSERT INTO run_leases (
      id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
      admission_basis, admission_policy_source, admission_policy_version,
      admission_freshness_seconds, admission_required_capability,
      admission_report_id, admission_report_received_at,
      created_at, updated_at
    ) VALUES (
      '${capabilityLeaseId}',
      'org-assigned-cli',
      '${capabilityRunId}',
      'runner-assigned-cli',
      1,
      '2026-07-27T12:00:00.000Z',
      '2026-07-27T12:05:00.000Z',
      'capability_declaration',
      'default',
      0,
      86400,
      'bubblewrap',
      '${reportId}',
      '2026-07-26T12:00:00.000Z',
      '2026-07-27T12:00:00.000Z',
      '2026-07-27T12:00:00.000Z'
    );
  `;
}

function capabilityClaimedEventSql(includeExtraField) {
  const runId = `run_${"b".repeat(32)}`;
  const leaseId = `lse_${"b".repeat(32)}`;
  const reportId = `cap_${"b".repeat(32)}`;
  const metadata = JSON.stringify({
    leaseId,
    operationId: `op_${"b".repeat(32)}`,
    assignedRunnerId: "runner-assigned-cli",
    admissionBasis: "capability_declaration",
    admissionPolicySource: "default",
    admissionPolicyVersion: 0,
    admissionFreshnessSeconds: 86400,
    admissionRequiredCapability: "bubblewrap",
    admissionReportId: reportId,
    admissionReportReceivedAt: "2026-07-26T12:00:00.000Z",
    ...(includeExtraField ? { extra: true } : {}),
  });
  return `
    INSERT INTO run_events (
      organization_id, run_id, sequence, kind, actor_id, fence,
      occurred_at, metadata_json
    ) VALUES (
      'org-assigned-cli',
      '${runId}',
      2,
      'lease.claimed',
      'principal-assigned-cli-runner',
      1,
      '2026-07-27T12:00:00.000Z',
      '${metadata}'
    );
  `;
}
