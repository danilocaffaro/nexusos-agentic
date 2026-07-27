import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const emptySha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const recordedAt = "2026-07-27T12:05:00.000Z";

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

function seedReceiptFixture(hex = "a") {
  const database = migratedDatabase();
  const organizationId = `org-receipt-${hex}`;
  const ownerId = `owner-receipt-${hex}`;
  const runnerPrincipalId = `principal-receipt-runner-${hex}`;
  const runnerId = `runner-receipt-${hex}`;
  const tokenId = `token-receipt-${hex}`;
  const reportId = `egr_${hex.repeat(32)}`;
  const runId = `run_${hex.repeat(32)}`;
  const leaseHex = (
    (Number.parseInt(hex, 16) + 1) % 16
  ).toString(16);
  const operationHex = (
    (Number.parseInt(hex, 16) + 2) % 16
  ).toString(16);
  const leaseId = `lse_${leaseHex.repeat(32)}`;
  const operationId = `op_${operationHex.repeat(32)}`;
  const excerptRef = `exc_${hex.repeat(32)}`;
  const engineVersion = "claude-2.1.219";
  const issuedAt = "2026-07-27T12:01:00.000Z";
  const expiresAt = "2026-07-27T12:12:00.000Z";
  const deadlineAt = "2026-07-27T12:20:00.000Z";

  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run(organizationId, `receipt-${hex}`, `Receipt ${hex}`);
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
    .run(`membership-receipt-${hex}`, organizationId, ownerId);
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, external_id, display_name
      ) VALUES (?, ?, 'runner', ?, ?)`,
    )
    .run(runnerPrincipalId, organizationId, runnerId, runnerId);
  database
    .prepare(
      `INSERT INTO runner_enrollment_tokens (
        id, organization_id, token_hash, issued_by, display_name,
        issued_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tokenId,
      organizationId,
      createHash("sha256").update(hex).digest("hex"),
      ownerId,
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
      organizationId,
      runnerPrincipalId,
      tokenId,
      runnerId,
      "A".repeat(43),
      "2026-07-27T10:01:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO runner_engine_reports (
        organization_id, runner_id, report_id, request_hash,
        declaration_hash, schema_version, collected_at, received_at,
        truncated, response_status, response_body
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 201, '{}')`,
    )
    .run(
      organizationId,
      runnerId,
      reportId,
      "1".repeat(64),
      "2".repeat(64),
      "2026-07-27T11:59:00.000Z",
      "2026-07-27T11:59:00.000Z",
    );
  for (const [position, engine] of [
    [0, "claude_code_cli"],
    [1, "codex_cli"],
  ]) {
    const available = engine === "claude_code_cli";
    database
      .prepare(
        `INSERT INTO runner_engine_evidence (
          runner_id, report_id, position, engine, status, readiness,
          reason, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runnerId,
        reportId,
        position,
        engine,
        available ? "available" : "unavailable",
        available ? "ready" : "attention_required",
        available ? "none" : "engine_not_configured",
        available ? engineVersion : null,
      );
  }
  database
    .prepare(
      `INSERT INTO runs (
        id, organization_id, requested_by, kind, status, max_claims,
        deadline_at, engine, assigned_runner_id, required_capability,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, 'engine_prompt', 'queued', 2, ?,
        'claude_code_cli', ?, NULL, ?, ?
      )`,
    )
    .run(
      runId,
      organizationId,
      ownerId,
      deadlineAt,
      runnerId,
      "2026-07-27T12:00:00.000Z",
      "2026-07-27T12:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO run_prompts (
        run_id, organization_id, prompt_ref, cipher_version, key_id,
        iv, ciphertext, tag, prompt_sha256, prompt_bytes, created_at
      ) VALUES (?, ?, ?, 1, 'key-a', ?, ?, ?, ?, 4, ?)`,
    )
    .run(
      runId,
      organizationId,
      `prm_${hex.repeat(32)}`,
      Buffer.alloc(12, 1),
      Buffer.alloc(4, 2),
      Buffer.alloc(16, 3),
      "3".repeat(64),
      "2026-07-27T12:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, occurred_at,
        metadata_json
      ) VALUES (?, ?, 1, 'run.created', ?, ?, ?)`,
    )
    .run(
      organizationId,
      runId,
      ownerId,
      "2026-07-27T12:00:00.000Z",
      JSON.stringify({
        engine: "claude_code_cli",
        promptBytes: 4,
        promptSha256: "3".repeat(64),
      }),
    );
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
        NULL, NULL, NULL, 'claude_code_cli', ?, ?, ?, ?, ?
      )`,
    )
    .run(
      leaseId,
      organizationId,
      runId,
      runnerId,
      issuedAt,
      expiresAt,
      reportId,
      "2026-07-27T11:59:00.000Z",
      engineVersion,
      issuedAt,
      issuedAt,
    );
  database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, fence,
        occurred_at, metadata_json
      ) VALUES (?, ?, 2, 'lease.claimed', ?, 1, ?, ?)`,
    )
    .run(
      organizationId,
      runId,
      runnerPrincipalId,
      issuedAt,
      JSON.stringify({
        leaseId,
        operationId,
        assignedRunnerId: runnerId,
        admissionBasis: "engine_inventory",
        admissionPolicySource: "default",
        admissionPolicyVersion: 0,
        admissionFreshnessSeconds: 86400,
        admissionEngine: "claude_code_cli",
        admissionEngineReportId: reportId,
        admissionEngineReportReceivedAt: "2026-07-27T11:59:00.000Z",
        admissionEngineVersion: engineVersion,
      }),
    );
  database
    .prepare(
      `INSERT INTO runner_operations (
        run_id, operation_id, request_hash, fence, response_status,
        response_body, applied_at
      ) VALUES (?, ?, ?, 1, 200, '{}', ?)`,
    )
    .run(runId, operationId, "4".repeat(64), recordedAt);
  const framed = Buffer.from([0, 0]);
  const excerptSha256 = createHash("sha256").update(framed).digest("hex");
  database
    .prepare(
      `INSERT INTO run_engine_excerpts (
        run_id, organization_id, excerpt_ref, cipher_version, key_id,
        iv, ciphertext, tag, stdout_excerpt_bytes, stderr_excerpt_bytes,
        excerpt_sha256, created_at
      ) VALUES (?, ?, ?, 1, 'key-a', ?, ?, ?, 0, 0, ?, ?)`,
    )
    .run(
      runId,
      organizationId,
      excerptRef,
      Buffer.alloc(12, 4),
      framed,
      Buffer.alloc(16, 5),
      excerptSha256,
      recordedAt,
    );
  return {
    database,
    deadlineAt,
    engineVersion,
    excerptRef,
    excerptSha256,
    leaseId,
    operationId,
    organizationId,
    ownerId,
    recordedAt,
    runId,
    runnerId,
    runnerPrincipalId,
  };
}

function insertValidReceipt(fixture, overrides = {}) {
  const value = {
    runId: fixture.runId,
    organizationId: fixture.organizationId,
    operationId: fixture.operationId,
    excerptRef: fixture.excerptRef,
    excerptSha256: fixture.excerptSha256,
    leaseId: fixture.leaseId,
    fence: 1,
    engine: "claude_code_cli",
    engineVersion: fixture.engineVersion,
    status: "succeeded",
    reason: "none",
    exitCode: 0,
    timedOut: 0,
    cancelRequested: 0,
    startedAt: "2026-07-27T12:02:00.000Z",
    finishedAt: "2026-07-27T12:04:59.999Z",
    stdoutBytes: 0,
    stdoutSha256: emptySha256,
    stdoutTruncated: 0,
    stdoutExcerptBytes: 0,
    stderrBytes: 0,
    stderrSha256: emptySha256,
    stderrTruncated: 0,
    stderrExcerptBytes: 0,
    receiptSha256: "5".repeat(64),
    recordedAt,
    ...overrides,
  };
  fixture.database
    .prepare(
      `INSERT INTO run_engine_receipts (
        run_id, organization_id, operation_id, excerpt_ref, excerpt_sha256,
        lease_id, fence,
        engine, engine_version, status, reason, exit_code, timed_out,
        cancel_requested, started_at, finished_at, stdout_bytes,
        stdout_sha256, stdout_truncated, stdout_excerpt_bytes,
        stderr_bytes, stderr_sha256, stderr_truncated,
        stderr_excerpt_bytes, receipt_sha256, recorded_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )`,
    )
    .run(
      value.runId,
      value.organizationId,
      value.operationId,
      value.excerptRef,
      value.excerptSha256,
      value.leaseId,
      value.fence,
      value.engine,
      value.engineVersion,
      value.status,
      value.reason,
      value.exitCode,
      value.timedOut,
      value.cancelRequested,
      value.startedAt,
      value.finishedAt,
      value.stdoutBytes,
      value.stdoutSha256,
      value.stdoutTruncated,
      value.stdoutExcerptBytes,
      value.stderrBytes,
      value.stderrSha256,
      value.stderrTruncated,
      value.stderrExcerptBytes,
      value.receiptSha256,
      value.recordedAt,
    );
  return value;
}

function completeEngineRun(fixture, overrides = {}) {
  const value = {
    operationId: fixture.operationId,
    outcomeStatus: "succeeded",
    outcomeSummary: "completed",
    recordedAt,
    ...overrides,
  };
  fixture.database
    .prepare(
      `UPDATE runs
       SET status = 'completed', outcome_status = ?,
           outcome_summary = ?, completed_operation_id = ?,
           recorded_at = ?, updated_at = ?, version = version + 1
       WHERE id = ?`,
    )
    .run(
      value.outcomeStatus,
      value.outcomeSummary,
      value.operationId,
      value.recordedAt,
      value.recordedAt,
      fixture.runId,
    );
}

test("0026 is additive and stays dark until the 0027 activation", () => {
  const before = migratedDatabase("0025_charming_forge.sql");
  const eventValidatorBefore = before
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    )
    .get("run_events_validate_before_insert").sql;
  const ledgerValidatorBefore = before
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    )
    .get("ledger_entries_validate_run_event").sql;
  before.exec(migrationSql("0026_sticky_valkyrie.sql"));
  assert.equal(
    before
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      )
      .get("run_events_validate_before_insert").sql,
    eventValidatorBefore,
  );
  assert.equal(
    before
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      )
      .get("ledger_entries_validate_run_event").sql,
    ledgerValidatorBefore,
  );
  assert.deepEqual(
    before
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'run_engine_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name),
    ["run_engine_excerpts", "run_engine_receipts"],
  );

  const fixture = seedReceiptFixture("1");
  assert.throws(
    () => completeEngineRun(fixture),
    /invalid_run_transition/,
  );
  insertValidReceipt(fixture);
  completeEngineRun(fixture);
  assert.equal(
    fixture.database
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(fixture.runId).status,
    "completed",
  );
  assert.throws(
    () =>
      fixture.database
        .prepare(
          `INSERT INTO run_events (
            organization_id, run_id, sequence, kind, actor_id, fence,
            occurred_at, metadata_json
          ) VALUES (?, ?, 3, 'run.completed', ?, 1, ?, '{}')`,
        )
        .run(
          fixture.organizationId,
          fixture.runId,
          fixture.runnerPrincipalId,
          recordedAt,
        ),
    /invalid_run_event/,
  );
  assert.equal(
    existsSync(
      new URL(
        "../app/api/runs/[runId]/engine-complete/route.ts",
        import.meta.url,
      ),
    ),
    true,
  );
  const runner = readFileSync(
    new URL("../runner/nexus-runner.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(runner, /run_engine_receipts/u);
  assert.doesNotMatch(
    runner,
    /command === ["']engine-complete["']|case ["']engine-complete["']/u,
  );
});

test("0027 activates receipt-bound engine completion events and ledger entries", () => {
  const fixture = seedReceiptFixture("8");
  const receipt = insertValidReceipt(fixture);
  completeEngineRun(fixture);
  fixture.database
    .prepare(
      `UPDATE run_leases
       SET status = 'released', ended_at = ?,
           ended_reason = 'engine_complete', updated_at = ?
       WHERE id = ?`,
    )
    .run(recordedAt, recordedAt, fixture.leaseId);
  fixture.database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, fence,
        occurred_at, metadata_json
      ) VALUES (?, ?, 3, 'lease.released', ?, 1, ?, ?)`,
    )
    .run(
      fixture.organizationId,
      fixture.runId,
      fixture.runnerPrincipalId,
      recordedAt,
      JSON.stringify({ reason: "engine_complete" }),
    );
  const metadata = {
    engine: receipt.engine,
    engineVersion: receipt.engineVersion,
    operationId: receipt.operationId,
    outcomeStatus: receipt.status,
    reason: receipt.reason,
    receiptSha256: receipt.receiptSha256,
    stderrBytes: receipt.stderrBytes,
    stdoutBytes: receipt.stdoutBytes,
  };
  assert.throws(
    () =>
      fixture.database
        .prepare(
          `INSERT INTO run_events (
            organization_id, run_id, sequence, kind, actor_id, fence,
            occurred_at, metadata_json
          ) VALUES (?, ?, 4, 'run.completed', ?, 1, ?, ?)`,
        )
        .run(
          fixture.organizationId,
          fixture.runId,
          fixture.runnerPrincipalId,
          recordedAt,
          JSON.stringify({ ...metadata, receiptSha256: "0".repeat(64) }),
        ),
    /invalid_run_event/,
  );
  fixture.database
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, fence,
        occurred_at, metadata_json
      ) VALUES (?, ?, 4, 'run.completed', ?, 1, ?, ?)`,
    )
    .run(
      fixture.organizationId,
      fixture.runId,
      fixture.runnerPrincipalId,
      recordedAt,
      JSON.stringify(metadata),
    );
  assert.throws(
    () =>
      fixture.database
        .prepare(
          `INSERT INTO run_events (
            organization_id, run_id, sequence, kind, actor_id, fence,
            occurred_at, metadata_json
          ) VALUES (?, ?, 5, 'run.completed', ?, 1, ?, ?)`,
        )
        .run(
          fixture.organizationId,
          fixture.runId,
          fixture.runnerPrincipalId,
          recordedAt,
          JSON.stringify(metadata),
        ),
    /invalid_run_event/,
  );

  const head = fixture.database
    .prepare(
      `SELECT sequence, hash
       FROM ledger_entries
       WHERE organization_id = ?
       ORDER BY sequence DESC
       LIMIT 1`,
    )
    .get(fixture.organizationId) ?? {
    sequence: 0,
    hash: "0".repeat(64),
  };
  const insertLedger = (actorId) =>
    fixture.database
      .prepare(
        `INSERT INTO ledger_entries (
          id, organization_id, sequence, kind, actor_id, occurred_at,
          payload_hash, payload_ref, intent_id, run_id, previous_hash, hash
        ) VALUES (?, ?, ?, 'run.completed', ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        `ledger-receipt-${actorId}`,
        fixture.organizationId,
        head.sequence + 1,
        actorId,
        recordedAt,
        "9".repeat(64),
        `nexus://runs/${fixture.runId}`,
        fixture.runId,
        head.hash,
        "8".repeat(64),
      );
  assert.throws(() => insertLedger(fixture.ownerId), /invalid_run_ledger_event/);
  insertLedger(fixture.runnerPrincipalId);
  assert.deepEqual(
    {
      ...fixture.database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM run_events
            WHERE run_id = ? AND kind = 'run.completed') AS events,
           (SELECT COUNT(*) FROM ledger_entries
            WHERE run_id = ? AND kind = 'run.completed') AS ledger`,
      )
      .get(fixture.runId, fixture.runId),
    },
    { events: 1, ledger: 1 },
  );
});

test("receipt storage pins lease, operation, version, deadline and outcome grammar", () => {
  const invalidReceipts = [
    ["wrong version", { engineVersion: "claude-0.0.0" }],
    ["wrong fence", { fence: 2 }],
    ["wrong excerpt ref", { excerptRef: `exc_${"0".repeat(32)}` }],
    ["wrong excerpt digest", { excerptSha256: "6".repeat(64) }],
    [
      "reconciler-only reason",
      { status: "failed", reason: "engine_deadline_exhausted" },
    ],
    [
      "unpersisted cancel fact",
      {
        status: "failed",
        reason: "timed_out",
        timedOut: 1,
        cancelRequested: 1,
      },
    ],
    ["late completion", { recordedAt: "2026-07-27T12:20:00.001Z" }],
    ["succeeded nonzero", { exitCode: 1 }],
    ["succeeded null exit", { exitCode: null }],
    ["succeeded reason", { reason: "spawn_failed" }],
    ["bad empty digest", { stdoutSha256: "6".repeat(64) }],
    [
      "bad truncation",
      {
        stdoutBytes: 1,
        stdoutSha256: "6".repeat(64),
        stdoutTruncated: 0,
      },
    ],
    [
      "bad canceled outcome",
      {
        status: "canceled",
        reason: "cancel_requested",
        exitCode: null,
        cancelRequested: 1,
      },
    ],
    [
      "bad failure exit",
      {
        status: "failed",
        reason: "engine_exit_nonzero",
        exitCode: null,
      },
    ],
  ];
  for (const [index, [name, overrides]] of invalidReceipts.entries()) {
    const fixture = seedReceiptFixture(
      ((2 + index) % 16).toString(16),
    );
    assert.throws(
      () => insertValidReceipt(fixture, overrides),
      /invalid_run_engine_receipt/,
      name,
    );
  }
});

test("run cancellation is an audit fact and does not override an observed engine result", () => {
  const succeeded = seedReceiptFixture("9");
  const cancelRequestedAt = "2026-07-27T12:03:00.000Z";
  succeeded.database
    .prepare(
      `UPDATE runs
       SET cancel_requested_at = ?, cancel_requested_by = ?,
           updated_at = ?, version = version + 1
       WHERE id = ?`,
    )
    .run(
      cancelRequestedAt,
      succeeded.ownerId,
      cancelRequestedAt,
      succeeded.runId,
    );
  insertValidReceipt(succeeded);
  completeEngineRun(succeeded);
  assert.deepEqual(
    {
      ...succeeded.database
        .prepare(
          `SELECT status, outcome_status AS outcomeStatus,
                  cancel_requested_at AS cancelRequestedAt
           FROM runs WHERE id = ?`,
        )
        .get(succeeded.runId),
    },
    {
      status: "completed",
      outcomeStatus: "succeeded",
      cancelRequestedAt,
    },
  );

  const canceled = seedReceiptFixture("a");
  canceled.database
    .prepare(
      `UPDATE runs
       SET cancel_requested_at = ?, cancel_requested_by = ?,
           updated_at = ?, version = version + 1
       WHERE id = ?`,
    )
    .run(
      cancelRequestedAt,
      canceled.ownerId,
      cancelRequestedAt,
      canceled.runId,
    );
  assert.throws(
    () =>
      insertValidReceipt(canceled, {
        status: "canceled",
        reason: "cancel_requested",
        exitCode: 0,
        cancelRequested: 1,
      }),
    /invalid_run_engine_receipt/,
  );
  insertValidReceipt(canceled, {
    status: "canceled",
    reason: "cancel_requested",
    exitCode: null,
    timedOut: 1,
    cancelRequested: 1,
  });
  completeEngineRun(canceled, {
    outcomeStatus: "canceled",
    outcomeSummary: "cancel_requested",
  });
});

test("receipt and excerpt provenance are immutable and excerpt erasure is exact", () => {
  const fixture = seedReceiptFixture("c");
  insertValidReceipt(fixture);
  assert.throws(
    () =>
      fixture.database
        .prepare(
          "UPDATE run_engine_receipts SET receipt_sha256 = ? WHERE run_id = ?",
        )
        .run("6".repeat(64), fixture.runId),
    /run_engine_receipt_is_immutable/,
  );
  assert.throws(
    () =>
      fixture.database
        .prepare("DELETE FROM run_engine_receipts WHERE run_id = ?")
        .run(fixture.runId),
    /run_engine_receipt_is_immutable/,
  );
  assert.throws(
    () =>
      fixture.database
        .prepare(
          "UPDATE run_engine_excerpts SET ciphertext = ? WHERE run_id = ?",
        )
        .run(Buffer.from([0, 0]), fixture.runId),
    /invalid_run_engine_excerpt_transition/,
  );
  completeEngineRun(fixture);
  assert.throws(
    () =>
      fixture.database
        .prepare(
          `UPDATE run_engine_excerpts
           SET key_id = NULL, iv = NULL, ciphertext = NULL, tag = NULL,
               erased_at = '2026-08-26T12:04:59.999Z'
           WHERE run_id = ?`,
        )
        .run(fixture.runId),
    /invalid_run_engine_excerpt_transition/,
  );
  fixture.database
    .prepare(
      `UPDATE run_engine_excerpts
       SET key_id = NULL, iv = NULL, ciphertext = NULL, tag = NULL,
           erased_at = '2026-08-26T12:05:00.000Z'
       WHERE run_id = ?`,
    )
    .run(fixture.runId);
  assert.deepEqual(
    {
      ...fixture.database
        .prepare(
          `SELECT excerpt_ref AS excerptRef, excerpt_sha256 AS excerptSha256,
                  stdout_excerpt_bytes AS stdoutBytes,
                  stderr_excerpt_bytes AS stderrBytes, key_id AS keyId,
                  ciphertext, erased_at AS erasedAt
           FROM run_engine_excerpts WHERE run_id = ?`,
        )
        .get(fixture.runId),
    },
    {
      excerptRef: fixture.excerptRef,
      excerptSha256: createHash("sha256")
        .update(Buffer.from([0, 0]))
        .digest("hex"),
      stdoutBytes: 0,
      stderrBytes: 0,
      keyId: null,
      ciphertext: null,
      erasedAt: "2026-08-26T12:05:00.000Z",
    },
  );
});

test("engine completed transition must match the immutable receipt exactly", () => {
  for (const [hex, overrides] of [
    ["d", { outcomeStatus: "failed" }],
    ["e", { outcomeSummary: "spawn_failed" }],
    ["1", { operationId: `op_${"0".repeat(32)}` }],
  ]) {
    const fixture = seedReceiptFixture(hex);
    insertValidReceipt(fixture);
    assert.throws(
      () => completeEngineRun(fixture, overrides),
      /invalid_run_transition/,
    );
  }

  const unchangedVersion = seedReceiptFixture("b");
  insertValidReceipt(unchangedVersion);
  assert.throws(
    () =>
      unchangedVersion.database
        .prepare(
          `UPDATE runs
           SET status = 'completed', outcome_status = 'succeeded',
               outcome_summary = 'completed', completed_operation_id = ?,
               recorded_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          unchangedVersion.operationId,
          unchangedVersion.recordedAt,
          unchangedVersion.recordedAt,
          unchangedVersion.runId,
        ),
    /invalid_run_transition/,
  );
});
