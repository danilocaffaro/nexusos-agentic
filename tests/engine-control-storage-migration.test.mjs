import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationName = "0025_charming_forge.sql";
const canonicalNow = "2026-07-27T12:00:00.000Z";

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

function seedWorkspace(database, suffix) {
  const organizationId = `org-control-${suffix}`;
  const ownerId = `owner-control-${suffix}`;
  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run(organizationId, `control-${suffix}`, `Control ${suffix}`);
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
    .run(`membership-control-${suffix}`, organizationId, ownerId);
  return { organizationId, ownerId };
}

function seedRunner(database, workspace, suffix) {
  const principalId = `principal-control-runner-${suffix}`;
  const runnerId = `runner-control-${suffix}`;
  const tokenId = `token-control-${suffix}`;
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
      `${suffix.charCodeAt(0).toString(16).padStart(2, "0")}`.repeat(22).slice(
        0,
        43,
      ),
      "2026-07-27T10:01:00.000Z",
    );
  return { principalId, runnerId };
}

function systemActor(database, organizationId) {
  return database
    .prepare(
      `SELECT mapping.principal_id AS principalId
       FROM organization_system_principals mapping
       WHERE mapping.organization_id = ?
         AND mapping.purpose = 'deadline_reconciler'`,
    )
    .get(organizationId);
}

function insertEngineReport(database, input) {
  database
    .prepare(
      `INSERT INTO runner_engine_reports (
        organization_id, runner_id, report_id, request_hash, declaration_hash,
        schema_version, collected_at, received_at, truncated,
        response_status, response_body
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 201, '{}')`,
    )
    .run(
      input.organizationId,
      input.runnerId,
      input.reportId,
      input.requestHash ?? "a".repeat(64),
      input.declarationHash ?? "b".repeat(64),
      input.receivedAt,
      input.receivedAt,
    );

  const targetPosition = input.engine === "codex_cli" ? 1 : 0;
  for (let position = 0; position <= 1; position += 1) {
    const engine = position === 0 ? "claude_code_cli" : "codex_cli";
    const target = position === targetPosition;
    const ready = target && input.ready !== false;
    database
      .prepare(
        `INSERT INTO runner_engine_evidence (
          runner_id, report_id, position, engine, status, readiness,
          reason, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runnerId,
        input.reportId,
        position,
        engine,
        target ? "available" : "unavailable",
        ready ? "ready" : "attention_required",
        ready ? "none" : target ? "engine_incompatible" : "engine_not_configured",
        ready || target ? input.version : null,
      );
  }
}

function insertEngineRun(database, input) {
  const createdAt = input.createdAt ?? canonicalNow;
  const deadlineAt = input.deadlineAt ?? "2026-07-27T12:20:00.000Z";
  const promptBytes = input.promptBytes ?? 4;
  const promptSha256 = input.promptSha256 ?? "c".repeat(64);
  const promptRef = input.promptRef ?? `prm_${"d".repeat(32)}`;
  database
    .prepare(
      `INSERT INTO runs (
        id, organization_id, requested_by, kind, status, max_claims,
        deadline_at, engine, assigned_runner_id, required_capability,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, 'engine_prompt', 'queued', 2, ?, ?, ?, NULL, ?, ?
      )`,
    )
    .run(
      input.runId,
      input.organizationId,
      input.ownerId,
      deadlineAt,
      input.engine,
      input.runnerId,
      createdAt,
      createdAt,
    );
  database
    .prepare(
      `INSERT INTO run_prompts (
        run_id, organization_id, prompt_ref, cipher_version, key_id,
        iv, ciphertext, tag, prompt_sha256, prompt_bytes, created_at
      ) VALUES (?, ?, ?, 1, 'key-2026-07', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.organizationId,
      promptRef,
      Buffer.alloc(12, 1),
      Buffer.alloc(promptBytes, 2),
      Buffer.alloc(16, 3),
      promptSha256,
      promptBytes,
      createdAt,
    );
  database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, occurred_at,
        metadata_json
      ) VALUES (?, ?, 1, 'run.created', ?, ?, ?)`,
    )
    .run(
      input.organizationId,
      input.runId,
      input.ownerId,
      createdAt,
      JSON.stringify({
        engine: input.engine,
        promptBytes,
        promptSha256,
      }),
    );
  return { createdAt, deadlineAt, promptBytes, promptRef, promptSha256 };
}

function insertEngineLease(database, input) {
  const leaseId = input.leaseId ?? `lse_${"e".repeat(32)}`;
  const operationId = input.operationId ?? `op_${"f".repeat(32)}`;
  const expiresAt = input.expiresAt ?? "2026-07-27T12:12:00.000Z";
  database
    .prepare(
      `INSERT INTO run_leases (
        id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
        admission_basis, admission_policy_source, admission_policy_version,
        admission_freshness_seconds, admission_required_capability,
        admission_report_id, admission_report_received_at,
        admission_engine, admission_engine_report_id,
        admission_engine_report_received_at, admission_engine_version,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 1, ?, ?, 'engine_inventory', 'default', 0, 86400,
        NULL, NULL, NULL, ?, ?, ?, ?, ?, ?
      )`,
    )
    .run(
      leaseId,
      input.organizationId,
      input.runId,
      input.runnerId,
      input.issuedAt,
      expiresAt,
      input.engine,
      input.reportId,
      input.reportReceivedAt,
      input.version,
      input.issuedAt,
      input.issuedAt,
    );
  database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, fence,
        occurred_at, metadata_json
      ) VALUES (?, ?, 2, 'lease.claimed', ?, 1, ?, ?)`,
    )
    .run(
      input.organizationId,
      input.runId,
      input.principalId,
      input.issuedAt,
      JSON.stringify({
        leaseId,
        operationId,
        assignedRunnerId: input.runnerId,
        admissionBasis: "engine_inventory",
        admissionPolicySource: "default",
        admissionPolicyVersion: 0,
        admissionFreshnessSeconds: 86400,
        admissionEngine: input.engine,
        admissionEngineReportId: input.reportId,
        admissionEngineReportReceivedAt: input.reportReceivedAt,
        admissionEngineVersion: input.version,
      }),
    );
  return { leaseId, operationId };
}

function expireRun(database, input) {
  const operationId = `op_${input.runId.slice(4)}`;
  database
    .prepare(
      `INSERT INTO run_deadline_operations (
        run_id, organization_id, operation_id, actor_id, lease_id, fence,
        deadline_at, applied_at, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'engine_deadline_exhausted')`,
    )
    .run(
      input.runId,
      input.organizationId,
      operationId,
      input.actorId,
      input.leaseId ?? null,
      input.fence ?? null,
      input.deadlineAt,
      input.appliedAt,
    );
  if (input.leaseId) {
    database
      .prepare(
        `UPDATE run_leases
         SET status = 'revoked', ended_at = ?,
             ended_reason = 'deadline_exhausted', updated_at = ?
         WHERE id = ?`,
      )
      .run(input.appliedAt, input.appliedAt, input.leaseId);
  }
  database
    .prepare(
      `UPDATE runs
       SET status = 'expired', recorded_at = ?,
           version = version + 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(input.appliedAt, input.appliedAt, input.runId);
  const sequence = database
    .prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_events WHERE run_id = ?",
    )
    .get(input.runId).sequence;
  database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, occurred_at,
        metadata_json
      ) VALUES (?, ?, ?, 'run.expired', ?, ?, ?)`,
    )
    .run(
      input.organizationId,
      input.runId,
      sequence,
      input.actorId,
      input.appliedAt,
      JSON.stringify({
        deadlineAt: input.deadlineAt,
        operationId,
        reason: "engine_deadline_exhausted",
      }),
    );
  database
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, run_id, previous_hash, hash
      ) VALUES (?, ?, 1, 'run.expired', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ledger-expired-${input.runId.slice(-8)}`,
      input.organizationId,
      input.actorId,
      input.appliedAt,
      "1".repeat(64),
      `nexus://runs/${input.runId}`,
      input.runId,
      "0".repeat(64),
      "2".repeat(64),
    );
  return operationId;
}

test("0025 upgrades populated storage and keeps a prior diagnostic runner valid", () => {
  const database = migratedDatabase("0024_chilly_shinko_yamashiro.sql");
  const workspace = seedWorkspace(database, "upgrade");
  const runner = seedRunner(database, workspace, "upgrade");
  const oldRunId = `run_${"1".repeat(32)}`;

  database
    .prepare(
      `INSERT INTO runs (
        id, organization_id, requested_by, deadline_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      oldRunId,
      workspace.organizationId,
      workspace.ownerId,
      "2026-07-27T12:15:00.000Z",
      canonicalNow,
      canonicalNow,
    );
  database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, occurred_at
      ) VALUES (?, ?, 1, 'run.created', ?, ?)`,
    )
    .run(
      workspace.organizationId,
      oldRunId,
      workspace.ownerId,
      canonicalNow,
    );

  database.exec(migrationSql(migrationName));
  assert.equal(
    database
      .prepare("SELECT kind FROM runs WHERE id = ?")
      .get(oldRunId).kind,
    "diagnostic",
  );
  assert.ok(systemActor(database, workspace.organizationId));

  const priorRunId = `run_${"2".repeat(32)}`;
  database
    .prepare(
      `INSERT INTO runs (
        id, organization_id, requested_by, deadline_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      priorRunId,
      workspace.organizationId,
      workspace.ownerId,
      "2026-07-27T12:15:00.000Z",
      canonicalNow,
      canonicalNow,
    );
  database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, occurred_at
      ) VALUES (?, ?, 1, 'run.created', ?, ?)`,
    )
    .run(
      workspace.organizationId,
      priorRunId,
      workspace.ownerId,
      canonicalNow,
    );
  database
    .prepare(
      `INSERT INTO run_leases (
        id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      `lse_${"3".repeat(32)}`,
      workspace.organizationId,
      priorRunId,
      runner.runnerId,
      "2026-07-27T12:01:00.000Z",
      "2026-07-27T12:02:00.000Z",
      "2026-07-27T12:01:00.000Z",
      "2026-07-27T12:01:00.000Z",
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
      priorRunId,
      runner.principalId,
      "2026-07-27T12:01:00.000Z",
      JSON.stringify({
        leaseId: `lse_${"3".repeat(32)}`,
        operationId: `op_${"4".repeat(32)}`,
      }),
    );
  assert.equal(
    database.prepare("SELECT status FROM runs WHERE id = ?").get(priorRunId)
      .status,
    "leased",
  );

  const future = seedWorkspace(database, "future");
  assert.ok(systemActor(database, future.organizationId));
});

test("B4.3e activates creation, lease claim and prompt read only", () => {
  assert.equal(
    existsSync(new URL("../app/api/runs/engine/route.ts", import.meta.url)),
    true,
  );
  assert.equal(
    existsSync(
      new URL(
        "../app/api/runs/[runId]/engine-lease/claim/route.ts",
        import.meta.url,
      ),
    ),
    true,
  );
  assert.equal(
    existsSync(
      new URL(
        "../app/api/runs/[runId]/prompt/route.ts",
        import.meta.url,
      ),
    ),
    true,
  );
  for (const path of [
    "../app/api/runs/[runId]/engine-complete/route.ts",
    "../app/api/runs/[runId]/prompt/erase/route.ts",
  ]) {
    assert.equal(
      existsSync(new URL(path, import.meta.url)),
      false,
      `${path} must remain absent from B4.3e`,
    );
  }
});

test("0025 fails closed on a preexisting reserved system identity collision", () => {
  const database = migratedDatabase("0024_chilly_shinko_yamashiro.sql");
  const workspace = seedWorkspace(database, "collision");
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, external_id, display_name
      ) VALUES (?, ?, 'human', 'system:deadline-reconciler:v1', 'Collision')`,
    )
    .run("collision-principal", workspace.organizationId);
  assert.throws(
    () => database.exec(migrationSql(migrationName)),
    /UNIQUE constraint failed: principals\.organization_id, principals\.external_id/,
  );
});

test("mapped system principals cannot enter collaboration while ordinary automation can", () => {
  const database = migratedDatabase();
  const workspace = seedWorkspace(database, "collaboration");
  const mappedPrincipalId = systemActor(
    database,
    workspace.organizationId,
  ).principalId;
  const ordinaryAutomationId = "automation-control-collaboration";
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, external_id, display_name
      ) VALUES (?, ?, 'automation', ?, ?)`,
    )
    .run(
      ordinaryAutomationId,
      workspace.organizationId,
      "automation:ordinary",
      "Ordinary automation",
    );
  database
    .prepare(
      `INSERT INTO conversations (
        id, organization_id, created_by, kind, title
      ) VALUES (?, ?, ?, 'room', ?)`,
    )
    .run(
      "conversation-control-collaboration",
      workspace.organizationId,
      workspace.ownerId,
      "Control collaboration room",
    );
  database
    .prepare(
      `INSERT INTO conversation_members (
        id, organization_id, conversation_id, principal_id, role
      ) VALUES (?, ?, ?, ?, 'member')`,
    )
    .run(
      "conversation-member-ordinary-automation",
      workspace.organizationId,
      "conversation-control-collaboration",
      ordinaryAutomationId,
    );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO conversation_members (
            id, organization_id, conversation_id, principal_id, role
          ) VALUES (?, ?, ?, ?, 'member')`,
        )
        .run(
          "conversation-member-system-automation",
          workspace.organizationId,
          "conversation-control-collaboration",
          mappedPrincipalId,
        ),
    /invalid_collaboration_reference/,
  );
});

test("engine run and prompt grammar rejects every diagnostic cross-shape", () => {
  const database = migratedDatabase();
  const workspace = seedWorkspace(database, "shape");
  const runner = seedRunner(database, workspace, "shape");

  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO runs (
            id, organization_id, requested_by, kind, deadline_at, engine,
            assigned_runner_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'diagnostic', ?, 'claude_code_cli', ?, ?, ?)`,
        )
        .run(
          `run_${"5".repeat(32)}`,
          workspace.organizationId,
          workspace.ownerId,
          "2026-07-27T12:15:00.000Z",
          runner.runnerId,
          canonicalNow,
          canonicalNow,
        ),
    /invalid_run/,
  );

  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO runs (
            id, organization_id, requested_by, kind, max_claims, deadline_at,
            engine, assigned_runner_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'engine_prompt', 5, ?, ?, ?, ?, ?)`,
        )
        .run(
          `run_${"6".repeat(32)}`,
          workspace.organizationId,
          workspace.ownerId,
          "2026-07-27T12:20:00.000Z",
          "claude_code_cli",
          runner.runnerId,
          canonicalNow,
          canonicalNow,
        ),
    /invalid_run/,
  );

  const memberId = "member-control-shape";
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, display_name
      ) VALUES (?, ?, 'human', 'Member')`,
    )
    .run(memberId, workspace.organizationId);
  database
    .prepare(
      `INSERT INTO memberships (
        id, organization_id, principal_id, role
      ) VALUES ('membership-member-shape', ?, ?, 'member')`,
    )
    .run(workspace.organizationId, memberId);
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO runs (
            id, organization_id, requested_by, kind, max_claims, deadline_at,
            engine, assigned_runner_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'engine_prompt', 2, ?, ?, ?, ?, ?)`,
        )
        .run(
          `run_${"7".repeat(32)}`,
          workspace.organizationId,
          memberId,
          "2026-07-27T12:20:00.000Z",
          "claude_code_cli",
          runner.runnerId,
          canonicalNow,
          canonicalNow,
        ),
    /invalid_run/,
  );

  const runId = `run_${"8".repeat(32)}`;
  const prompt = insertEngineRun(database, {
    ...workspace,
    ...runner,
    runId,
    engine: "claude_code_cli",
  });
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT kind, engine, max_claims AS maxClaims,
                  assigned_runner_id AS assignedRunnerId
           FROM runs WHERE id = ?`,
        )
        .get(runId),
    },
    {
      kind: "engine_prompt",
      engine: "claude_code_cli",
      maxClaims: 2,
      assignedRunnerId: runner.runnerId,
    },
  );
  assert.equal(
    database
      .prepare("SELECT length(ciphertext) AS bytes FROM run_prompts WHERE run_id = ?")
      .get(runId).bytes,
    prompt.promptBytes,
  );
  assert.throws(
    () =>
      database
        .prepare("UPDATE run_prompts SET ciphertext = ? WHERE run_id = ?")
        .run(Buffer.alloc(prompt.promptBytes, 9), runId),
    /invalid_run_prompt_transition/,
  );
  assert.throws(
    () =>
      database
        .prepare("DELETE FROM run_prompts WHERE run_id = ?")
        .run(runId),
    /run_prompt_is_immutable/,
  );
});

test("engine leases require latest fresh ready exact inventory and freeze pins", () => {
  const database = migratedDatabase();
  const workspace = seedWorkspace(database, "admission");
  const runner = seedRunner(database, workspace, "admission");
  const runId = `run_${"9".repeat(32)}`;
  insertEngineRun(database, {
    ...workspace,
    ...runner,
    runId,
    engine: "claude_code_cli",
  });
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO run_leases (
            id, organization_id, run_id, runner_id, fence,
            issued_at, expires_at, admission_basis, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, 1, ?, ?, 'assignment_only', ?, ?
          )`,
        )
        .run(
          `lse_${"0".repeat(32)}`,
          workspace.organizationId,
          runId,
          runner.runnerId,
          "2026-07-27T12:00:10.000Z",
          "2026-07-27T12:10:00.000Z",
          "2026-07-27T12:00:10.000Z",
          "2026-07-27T12:00:10.000Z",
        ),
    /invalid_run_lease_admission/,
  );
  const readyId = `egr_${"1".repeat(32)}`;
  insertEngineReport(database, {
    ...workspace,
    ...runner,
    reportId: readyId,
    receivedAt: "2026-07-27T12:00:30.000Z",
    engine: "claude_code_cli",
    version: "2.1.219",
  });
  const attentionId = `egr_${"2".repeat(32)}`;
  insertEngineReport(database, {
    ...workspace,
    ...runner,
    reportId: attentionId,
    receivedAt: "2026-07-27T12:00:31.000Z",
    engine: "claude_code_cli",
    version: "2.1.220",
    ready: false,
  });

  const leaseStatement = database.prepare(
    `INSERT INTO run_leases (
      id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
      admission_basis, admission_policy_source, admission_policy_version,
      admission_freshness_seconds, admission_engine,
      admission_engine_report_id, admission_engine_report_received_at,
      admission_engine_version, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, 1, ?, '2026-07-27T12:10:00.000Z',
      'engine_inventory', 'default', 0, 86400, ?, ?, ?, ?, ?, ?
    )`,
  );
  assert.throws(
    () =>
      leaseStatement.run(
        `lse_${"1".repeat(32)}`,
        workspace.organizationId,
        runId,
        runner.runnerId,
        "2026-07-27T12:01:00.000Z",
        "claude_code_cli",
        readyId,
        "2026-07-27T12:00:30.000Z",
        "2.1.219",
        "2026-07-27T12:01:00.000Z",
        "2026-07-27T12:01:00.000Z",
      ),
    /invalid_run_lease_admission/,
  );
  assert.throws(
    () =>
      leaseStatement.run(
        `lse_${"2".repeat(32)}`,
        workspace.organizationId,
        runId,
        runner.runnerId,
        "2026-07-27T12:01:00.000Z",
        "claude_code_cli",
        attentionId,
        "2026-07-27T12:00:31.000Z",
        "2.1.220",
        "2026-07-27T12:01:00.000Z",
        "2026-07-27T12:01:00.000Z",
      ),
    /invalid_run_lease_admission/,
  );

  const latestId = `egr_${"3".repeat(32)}`;
  insertEngineReport(database, {
    ...workspace,
    ...runner,
    reportId: latestId,
    receivedAt: "2026-07-27T12:00:32.000Z",
    engine: "claude_code_cli",
    version: "2.1.221",
  });
  const lease = insertEngineLease(database, {
    ...workspace,
    ...runner,
    runId,
    engine: "claude_code_cli",
    reportId: latestId,
    reportReceivedAt: "2026-07-27T12:00:32.000Z",
    version: "2.1.221",
    issuedAt: "2026-07-27T12:01:00.000Z",
  });
  assert.equal(
    database
      .prepare("SELECT admission_basis AS basis FROM run_leases WHERE id = ?")
      .get(lease.leaseId).basis,
    "engine_inventory",
  );
  for (const statement of [
    "UPDATE run_leases SET admission_engine = 'codex_cli' WHERE id = ?",
    `UPDATE run_leases
     SET admission_engine_report_id = 'egr_${"7".repeat(32)}'
     WHERE id = ?`,
    `UPDATE run_leases
     SET admission_engine_report_received_at =
       '2026-07-27T12:00:33.000Z' WHERE id = ?`,
    `UPDATE run_leases
     SET admission_engine_version = '2.1.222' WHERE id = ?`,
  ]) {
    assert.throws(
      () => database.prepare(statement).run(lease.leaseId),
      /invalid_run_lease_transition/,
    );
  }
  assert.throws(
    () =>
      database
        .prepare(
          `UPDATE run_leases
           SET expires_at = '2026-07-27T12:13:00.000Z'
           WHERE id = ?`,
        )
        .run(lease.leaseId),
    /invalid_run_lease_transition/,
  );
  database
    .prepare(
      `UPDATE run_leases
       SET expires_at = '2026-07-27T12:13:00.000Z',
           renewed_at = '2026-07-27T12:02:00.000Z',
           renew_count = renew_count + 1,
           updated_at = '2026-07-27T12:02:00.000Z'
       WHERE id = ?`,
    )
    .run(lease.leaseId);
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT expires_at, renewed_at, renew_count
           FROM run_leases WHERE id = ?`,
        )
        .get(lease.leaseId),
    },
    {
      expires_at: "2026-07-27T12:13:00.000Z",
      renewed_at: "2026-07-27T12:02:00.000Z",
      renew_count: 1,
    },
  );
  for (const expiresAt of [
    "2026-07-27T12:13:00.000Z",
    "2026-07-27T12:20:00.001Z",
  ]) {
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE run_leases
             SET expires_at = ?,
                 renewed_at = '2026-07-27T12:03:00.000Z',
                 renew_count = renew_count + 1,
                 updated_at = '2026-07-27T12:03:00.000Z'
             WHERE id = ?`,
          )
          .run(expiresAt, lease.leaseId),
      /invalid_run_lease_transition/,
    );
  }

  const staleWorkspace = seedWorkspace(database, "stale");
  const staleRunner = seedRunner(database, staleWorkspace, "stale");
  const staleRunId = `run_${"a".repeat(32)}`;
  insertEngineRun(database, {
    ...staleWorkspace,
    ...staleRunner,
    runId: staleRunId,
    engine: "codex_cli",
  });
  const staleReportId = `egr_${"4".repeat(32)}`;
  insertEngineReport(database, {
    ...staleWorkspace,
    ...staleRunner,
    reportId: staleReportId,
    receivedAt: "2026-07-26T12:01:00.000Z",
    engine: "codex_cli",
    version: "0.145.0",
  });
  assert.throws(
    () =>
      leaseStatement.run(
        `lse_${"4".repeat(32)}`,
        staleWorkspace.organizationId,
        staleRunId,
        staleRunner.runnerId,
        "2026-07-27T12:01:00.001Z",
        "codex_cli",
        staleReportId,
        "2026-07-26T12:01:00.000Z",
        "0.145.0",
        "2026-07-27T12:01:00.001Z",
        "2026-07-27T12:01:00.001Z",
      ),
    /invalid_run_lease_admission/,
  );

  const partialWorkspace = seedWorkspace(database, "partial");
  const partialRunner = seedRunner(database, partialWorkspace, "partial");
  const partialRunId = `run_${"e".repeat(32)}`;
  insertEngineRun(database, {
    ...partialWorkspace,
    ...partialRunner,
    runId: partialRunId,
    engine: "claude_code_cli",
    promptRef: `prm_${"f".repeat(32)}`,
  });
  const partialReportId = `egr_${"8".repeat(32)}`;
  database
    .prepare(
      `INSERT INTO runner_engine_reports (
        organization_id, runner_id, report_id, request_hash, declaration_hash,
        schema_version, collected_at, received_at, truncated,
        response_status, response_body
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 201, '{}')`,
    )
    .run(
      partialWorkspace.organizationId,
      partialRunner.runnerId,
      partialReportId,
      "8".repeat(64),
      "9".repeat(64),
      "2026-07-27T12:00:40.000Z",
      "2026-07-27T12:00:40.000Z",
    );
  database
    .prepare(
      `INSERT INTO runner_engine_evidence (
        runner_id, report_id, position, engine, status, readiness,
        reason, version
      ) VALUES (?, ?, 0, 'claude_code_cli', 'available', 'ready',
        'none', '2.1.219')`,
    )
    .run(partialRunner.runnerId, partialReportId);
  assert.throws(
    () =>
      leaseStatement.run(
        `lse_${"8".repeat(32)}`,
        partialWorkspace.organizationId,
        partialRunId,
        partialRunner.runnerId,
        "2026-07-27T12:01:00.000Z",
        "claude_code_cli",
        partialReportId,
        "2026-07-27T12:00:40.000Z",
        "2.1.219",
        "2026-07-27T12:01:00.000Z",
        "2026-07-27T12:01:00.000Z",
      ),
    /invalid_run_lease_admission/,
  );
});

test("deadline expiry is actor-bound, effect-once, immutable and enables one-way shred", () => {
  const database = migratedDatabase();
  const workspace = seedWorkspace(database, "expiry");
  const runner = seedRunner(database, workspace, "expiry");
  const runId = `run_${"b".repeat(32)}`;
  const prompt = insertEngineRun(database, {
    ...workspace,
    ...runner,
    runId,
    engine: "claude_code_cli",
  });
  const reportId = `egr_${"5".repeat(32)}`;
  insertEngineReport(database, {
    ...workspace,
    ...runner,
    reportId,
    receivedAt: "2026-07-27T12:00:30.000Z",
    engine: "claude_code_cli",
    version: "2.1.219",
  });
  const lease = insertEngineLease(database, {
    ...workspace,
    ...runner,
    runId,
    engine: "claude_code_cli",
    reportId,
    reportReceivedAt: "2026-07-27T12:00:30.000Z",
    version: "2.1.219",
    issuedAt: "2026-07-27T12:01:00.000Z",
  });
  const actor = systemActor(database, workspace.organizationId);
  assert.ok(actor);

  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO run_deadline_operations (
            run_id, organization_id, operation_id, actor_id, lease_id, fence,
            deadline_at, applied_at, reason
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'engine_deadline_exhausted')`,
        )
        .run(
          runId,
          workspace.organizationId,
          `op_${"0".repeat(32)}`,
          actor.principalId,
          lease.leaseId,
          prompt.deadlineAt,
          prompt.deadlineAt,
        ),
    /invalid_run_deadline_operation/,
  );

  const operationId = expireRun(database, {
    ...workspace,
    runId,
    actorId: actor.principalId,
    leaseId: lease.leaseId,
    fence: 1,
    deadlineAt: prompt.deadlineAt,
    appliedAt: "2026-07-27T12:20:00.001Z",
  });
  assert.equal(operationId, `op_${runId.slice(4)}`);
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT run.status, lease.status AS leaseStatus,
                  lease.ended_reason AS endedReason
           FROM runs run
           INNER JOIN run_leases lease ON lease.run_id = run.id
           WHERE run.id = ?`,
        )
        .get(runId),
    },
    {
      status: "expired",
      leaseStatus: "revoked",
      endedReason: "deadline_exhausted",
    },
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO run_deadline_operations (
            run_id, organization_id, operation_id, actor_id,
            deadline_at, applied_at, reason
          ) VALUES (?, ?, ?, ?, ?, ?, 'engine_deadline_exhausted')`,
        )
        .run(
          runId,
          workspace.organizationId,
          operationId,
          actor.principalId,
          prompt.deadlineAt,
          "2026-07-27T12:20:00.002Z",
        ),
    /run_deadline_operation_already_exists|invalid_run_deadline_operation/,
  );
  assert.throws(
    () =>
      database
        .prepare("UPDATE runs SET updated_at = ? WHERE id = ?")
        .run("2026-07-27T12:20:00.002Z", runId),
    /invalid_run_transition/,
  );
  assert.throws(
    () =>
      database
        .prepare("UPDATE principals SET status = 'disabled' WHERE id = ?")
        .run(actor.principalId),
    /organization_system_principal_is_immutable/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          "DELETE FROM organization_system_principals WHERE organization_id = ?",
        )
        .run(workspace.organizationId),
    /organization_system_principal_is_immutable/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `UPDATE run_prompts
           SET key_id = NULL, iv = NULL, ciphertext = NULL, tag = NULL,
               erased_at = '2026-08-26T12:19:59.999Z'
           WHERE run_id = ?`,
        )
        .run(runId),
    /invalid_run_prompt_transition/,
  );
  database
    .prepare(
      `UPDATE run_prompts
       SET key_id = NULL, iv = NULL, ciphertext = NULL, tag = NULL,
           erased_at = '2026-08-26T12:20:00.001Z'
       WHERE run_id = ?`,
    )
    .run(runId);
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT key_id AS keyId, ciphertext, prompt_ref AS promptRef,
                  prompt_sha256 AS promptSha256,
                  prompt_bytes AS promptBytes, erased_at AS erasedAt
           FROM run_prompts WHERE run_id = ?`,
        )
        .get(runId),
    },
    {
      keyId: null,
      ciphertext: null,
      promptRef: prompt.promptRef,
      promptSha256: prompt.promptSha256,
      promptBytes: prompt.promptBytes,
      erasedAt: "2026-08-26T12:20:00.001Z",
    },
  );
  assert.throws(
    () =>
      database
        .prepare("UPDATE run_prompts SET erased_at = erased_at WHERE run_id = ?")
        .run(runId),
    /invalid_run_prompt_transition/,
  );
});

test("queued expiry requires the exact mapped actor, event and ledger proof", () => {
  const database = migratedDatabase();
  const workspace = seedWorkspace(database, "queued");
  const runner = seedRunner(database, workspace, "queued");
  const runId = `run_${"c".repeat(32)}`;
  const prompt = insertEngineRun(database, {
    ...workspace,
    ...runner,
    runId,
    engine: "codex_cli",
  });
  const actor = systemActor(database, workspace.organizationId);
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO run_deadline_operations (
            run_id, organization_id, operation_id, actor_id,
            deadline_at, applied_at, reason
          ) VALUES (?, ?, ?, ?, ?, ?, 'engine_deadline_exhausted')`,
        )
        .run(
          runId,
          workspace.organizationId,
          `op_${runId.slice(4)}`,
          workspace.ownerId,
          prompt.deadlineAt,
          prompt.deadlineAt,
        ),
    /invalid_run_deadline_operation/,
  );
  expireRun(database, {
    ...workspace,
    runId,
    actorId: actor.principalId,
    deadlineAt: prompt.deadlineAt,
    appliedAt: prompt.deadlineAt,
  });
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM ledger_entries WHERE kind = 'run.expired'",
      )
      .get().count,
    1,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO run_events (
            organization_id, run_id, sequence, kind, actor_id, occurred_at,
            metadata_json
          ) VALUES (?, ?, 3, 'run.expired', ?, ?, ?)`,
        )
        .run(
          workspace.organizationId,
          runId,
          actor.principalId,
          prompt.deadlineAt,
          JSON.stringify({
            deadlineAt: prompt.deadlineAt,
            operationId: `op_${runId.slice(4)}`,
            reason: "engine_deadline_exhausted",
          }),
        ),
    /invalid_run_event/,
  );
  assert.throws(
    () =>
      database
        .prepare("UPDATE runs SET claim_count = claim_count + 1 WHERE id = ?")
        .run(runId),
    /invalid_run_transition/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO ledger_entries (
            id, organization_id, sequence, kind, actor_id, occurred_at,
            payload_hash, payload_ref, run_id, previous_hash, hash
          ) VALUES (?, ?, 2, 'run.expired', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "duplicate-expiry-ledger",
          workspace.organizationId,
          actor.principalId,
          prompt.deadlineAt,
          "3".repeat(64),
          `nexus://runs/${runId}`,
          runId,
          "2".repeat(64),
          "4".repeat(64),
        ),
    /duplicate_run_expired_ledger_event/,
  );

  const fencedRunId = `run_${"d".repeat(32)}`;
  const fencedPrompt = insertEngineRun(database, {
    ...workspace,
    ...runner,
    runId: fencedRunId,
    engine: "codex_cli",
    promptRef: `prm_${"e".repeat(32)}`,
  });
  const reportId = `egr_${"6".repeat(32)}`;
  insertEngineReport(database, {
    ...workspace,
    ...runner,
    reportId,
    receivedAt: "2026-07-27T12:00:30.000Z",
    engine: "codex_cli",
    version: "0.145.0",
  });
  database
    .prepare(
      `INSERT INTO run_deadline_operations (
        run_id, organization_id, operation_id, actor_id,
        deadline_at, applied_at, reason
      ) VALUES (?, ?, ?, ?, ?, ?, 'engine_deadline_exhausted')`,
    )
    .run(
      fencedRunId,
      workspace.organizationId,
      `op_${fencedRunId.slice(4)}`,
      actor.principalId,
      fencedPrompt.deadlineAt,
      fencedPrompt.deadlineAt,
    );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO run_leases (
            id, organization_id, run_id, runner_id, fence,
            issued_at, expires_at, admission_basis,
            admission_policy_source, admission_policy_version,
            admission_freshness_seconds, admission_engine,
            admission_engine_report_id,
            admission_engine_report_received_at,
            admission_engine_version, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, 1, ?, ?, 'engine_inventory',
            'default', 0, 86400, 'codex_cli', ?, ?, '0.145.0', ?, ?
          )`,
        )
        .run(
          `lse_${"6".repeat(32)}`,
          workspace.organizationId,
          fencedRunId,
          runner.runnerId,
          "2026-07-27T12:01:00.000Z",
          "2026-07-27T12:10:00.000Z",
          reportId,
          "2026-07-27T12:00:30.000Z",
          "2026-07-27T12:01:00.000Z",
          "2026-07-27T12:01:00.000Z",
        ),
    /invalid_run_lease/,
  );
});
