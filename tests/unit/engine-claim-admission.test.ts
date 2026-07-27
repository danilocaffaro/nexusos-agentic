import assert from "node:assert/strict";
import test from "node:test";

import {
  engineLeaseClaimedMetadata,
  evaluateEngineClaimAdmission,
  type EngineClaimAdmissionSnapshot,
} from "../../src/domain/runners/engine-claim-admission";

const now = "2026-07-27T12:00:00.000Z";
const runnerId = `rnr_${"1".repeat(32)}`;
const otherRunnerId = `rnr_${"2".repeat(32)}`;
const runId = `run_${"1".repeat(32)}`;
const reportId = `egr_${"1".repeat(32)}`;

function snapshot(
  patch: Partial<EngineClaimAdmissionSnapshot> = {},
): EngineClaimAdmissionSnapshot {
  return {
    runnerId,
    runnerOrganizationId: "org-local-aurora",
    runnerActive: true,
    requestedEngine: "claude_code_cli",
    now,
    run: {
      id: runId,
      organizationId: "org-local-aurora",
      engine: "claude_code_cli",
      status: "queued",
      claimCount: 0,
      maxClaims: 2,
      deadlineAt: "2026-07-27T12:20:00.000Z",
      assignedRunnerId: runnerId,
      cancelRequestedAt: null,
      leaseStatus: null,
      leaseExpiresAt: null,
    },
    runnerLeases: [],
    configuredPolicy: null,
    engineReports: [
      {
        reportId,
        receivedAt: "2026-07-27T11:59:00.000Z",
        evidenceCount: 2,
        engine: "claude_code_cli",
        status: "available",
        readiness: "ready",
        reason: "none",
        version: "2.1.219",
      },
    ],
    ...patch,
  };
}

function withRun(
  base: EngineClaimAdmissionSnapshot,
  patch: Partial<NonNullable<EngineClaimAdmissionSnapshot["run"]>>,
): EngineClaimAdmissionSnapshot {
  assert.ok(base.run);
  return { ...base, run: { ...base.run, ...patch } };
}

test("engine claim admits only exact assignment and inventory pins", () => {
  const evaluation = evaluateEngineClaimAdmission(snapshot());
  assert.equal(evaluation.kind, "admitted");
  if (evaluation.kind !== "admitted") return;
  assert.deepEqual(evaluation.admission, {
    assignedRunnerId: runnerId,
    admissionBasis: "engine_inventory",
    admissionPolicySource: "default",
    admissionPolicyVersion: 0,
    admissionFreshnessSeconds: 86_400,
    admissionEngine: "claude_code_cli",
    admissionEngineReportId: reportId,
    admissionEngineReportReceivedAt: "2026-07-27T11:59:00.000Z",
    admissionEngineVersion: "2.1.219",
    timeoutMs: 600_000,
  });
  assert.deepEqual(
    engineLeaseClaimedMetadata(evaluation.admission, {
      leaseId: `lse_${"3".repeat(32)}`,
      operationId: `op_${"4".repeat(32)}`,
    }),
    {
      leaseId: `lse_${"3".repeat(32)}`,
      operationId: `op_${"4".repeat(32)}`,
      assignedRunnerId: runnerId,
      admissionBasis: "engine_inventory",
      admissionPolicySource: "default",
      admissionPolicyVersion: 0,
      admissionFreshnessSeconds: 86_400,
      admissionEngine: "claude_code_cli",
      admissionEngineReportId: reportId,
      admissionEngineReportReceivedAt: "2026-07-27T11:59:00.000Z",
      admissionEngineVersion: "2.1.219",
    },
  );
});

test("engine claim freezes denial precedence", () => {
  const cases = [
    {
      value: snapshot({ runnerActive: false, run: null }),
      code: "runner_rejected",
    },
    {
      value: snapshot({ run: null }),
      code: "run_unavailable",
    },
    {
      value: withRun(snapshot(), { status: "canceled" }),
      code: "run_unavailable",
    },
    {
      value: snapshot({ requestedEngine: "codex_cli" }),
      code: "engine_mismatch",
    },
    {
      value: withRun(snapshot({ requestedEngine: "codex_cli" }), {
        assignedRunnerId: otherRunnerId,
      }),
      code: "run_assignment_mismatch",
    },
    {
      value: snapshot({
        runnerLeases: [
          { runId: "a", expiresAt: "2026-07-27T12:01:00.000Z" },
          { runId: "b", expiresAt: "2026-07-27T12:01:00.000Z" },
        ],
      }),
      code: "runner_conflict",
    },
    {
      value: snapshot({
        runnerLeases: [
          {
            runId: `run_${"9".repeat(32)}`,
            expiresAt: "2026-07-27T12:01:00.000Z",
          },
        ],
      }),
      code: "runner_busy",
    },
  ];
  for (const { value, code } of cases) {
    assert.deepEqual(evaluateEngineClaimAdmission(value), {
      kind: "denied",
      code,
      status: code === "runner_rejected" ? 403 : 409,
    });
  }
});

test("engine claim enforces the exact deadline boundary", () => {
  const exact = evaluateEngineClaimAdmission(
    withRun(snapshot(), {
      deadlineAt: "2026-07-27T12:05:00.000Z",
    }),
  );
  assert.equal(exact.kind, "admitted");
  if (exact.kind === "admitted") {
    assert.equal(exact.admission.timeoutMs, 270_000);
  }
  assert.deepEqual(
    evaluateEngineClaimAdmission(
      withRun(snapshot(), {
        deadlineAt: "2026-07-27T12:04:59.999Z",
      }),
    ),
    {
      kind: "denied",
      code: "engine_deadline_insufficient",
      status: 409,
    },
  );
});

test("engine claim rejects incomplete, unavailable and unversioned evidence", () => {
  const base = snapshot().engineReports[0];
  assert.ok(base);
  for (const patch of [
    { evidenceCount: 1 },
    { status: "unavailable" as const },
    { status: "unknown" as const },
    { readiness: "attention_required" as const },
    { readiness: "unknown" as const },
    { reason: "engine_auth_attention_required" },
    { version: null },
    { engine: "codex_cli" as const },
  ]) {
    assert.deepEqual(
      evaluateEngineClaimAdmission(
        snapshot({ engineReports: [{ ...base, ...patch }] }),
      ),
      {
        kind: "denied",
        code: "engine_inventory_mismatch",
        status: 409,
      },
    );
  }
});

test("engine claim uses only the latest report and rejects future reports", () => {
  const base = snapshot().engineReports[0];
  assert.ok(base);
  const olderReady = {
    ...base,
    reportId: `egr_${"0".repeat(32)}`,
    receivedAt: "2026-07-27T11:58:00.000Z",
  };
  const newerAttention = {
    ...base,
    reportId: `egr_${"f".repeat(32)}`,
    receivedAt: "2026-07-27T11:59:30.000Z",
    readiness: "attention_required" as const,
    reason: "engine_auth_attention_required",
  };
  for (const reports of [
    [olderReady, newerAttention],
    [{ ...base, receivedAt: "2026-07-27T12:00:00.001Z" }],
  ]) {
    assert.deepEqual(
      evaluateEngineClaimAdmission(snapshot({ engineReports: reports })),
      {
        kind: "denied",
        code: "engine_inventory_mismatch",
        status: 409,
      },
    );
  }
});

test("engine claim freshness is inclusive and configured policy is recorded", () => {
  const base = snapshot().engineReports[0];
  assert.ok(base);
  const configured = {
    version: 7,
    engineFreshnessSeconds: 3_600,
    versionRecorded: true,
  };
  const exact = evaluateEngineClaimAdmission(
    snapshot({
      configuredPolicy: configured,
      engineReports: [
        { ...base, receivedAt: "2026-07-27T11:00:00.000Z" },
      ],
    }),
  );
  assert.equal(exact.kind, "admitted");
  if (exact.kind === "admitted") {
    assert.equal(exact.admission.admissionPolicySource, "configured");
    assert.equal(exact.admission.admissionPolicyVersion, 7);
    assert.equal(exact.admission.admissionFreshnessSeconds, 3_600);
  }
  for (const value of [
    snapshot({
      configuredPolicy: { ...configured, versionRecorded: false },
    }),
    snapshot({
      configuredPolicy: configured,
      engineReports: [
        { ...base, receivedAt: "2026-07-27T10:59:59.999Z" },
      ],
    }),
  ]) {
    assert.deepEqual(evaluateEngineClaimAdmission(value), {
      kind: "denied",
      code: "engine_inventory_mismatch",
      status: 409,
    });
  }
});

test("engine claim rejects live lease, claim budget and cancellation state", () => {
  for (const value of [
    withRun(snapshot(), {
      status: "leased",
      leaseStatus: "active",
      leaseExpiresAt: "2026-07-27T12:00:00.001Z",
    }),
    withRun(snapshot(), { claimCount: 2 }),
    withRun(snapshot(), {
      cancelRequestedAt: "2026-07-27T11:59:00.000Z",
    }),
  ]) {
    assert.deepEqual(evaluateEngineClaimAdmission(value), {
      kind: "denied",
      code: "run_unavailable",
      status: 409,
    });
  }
});
