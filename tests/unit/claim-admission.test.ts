import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateClaimAdmission,
  leaseClaimedMetadata,
  type ClaimAdmissionSnapshot,
} from "../../src/domain/runners/claim-admission";

const now = "2026-07-26T12:00:00.000Z";
const runnerId = `rnr_${"1".repeat(32)}`;
const assignedRunnerId = runnerId;
const otherRunnerId = `rnr_${"2".repeat(32)}`;
const runId = `run_${"1".repeat(32)}`;
const reportId = `cap_${"1".repeat(32)}`;

function snapshot(
  patch: Partial<ClaimAdmissionSnapshot> = {},
): ClaimAdmissionSnapshot {
  return {
    runnerId,
    runnerOrganizationId: "org-local-aurora",
    runnerActive: true,
    now,
    run: {
      id: runId,
      organizationId: "org-local-aurora",
      status: "queued",
      claimCount: 0,
      maxClaims: 5,
      deadlineAt: "2026-07-27T12:00:00.000Z",
      assignedRunnerId: null,
      requiredCapability: null,
      leaseStatus: null,
      leaseExpiresAt: null,
    },
    runnerLeases: [],
    configuredPolicy: null,
    capabilityReports: [],
    ...patch,
  };
}

function withRun(
  base: ClaimAdmissionSnapshot,
  patch: Partial<NonNullable<ClaimAdmissionSnapshot["run"]>>,
): ClaimAdmissionSnapshot {
  assert.ok(base.run);
  return { ...base, run: { ...base.run, ...patch } };
}

test("claim evaluator freezes multi-violation precedence", () => {
  const mismatchAndStale = withRun(snapshot(), {
    assignedRunnerId: otherRunnerId,
    requiredCapability: "bubblewrap",
  });
  mismatchAndStale.capabilityReports = [
    {
      reportId,
      receivedAt: "2026-07-25T11:59:59.999Z",
      requiredCapabilityStatus: "available",
    },
  ];
  const busyAndDisallowed = withRun(snapshot(), {
    assignedRunnerId,
    requiredCapability: "bubblewrap",
  });
  busyAndDisallowed.runnerLeases = [
    {
      runId: `run_${"9".repeat(32)}`,
      expiresAt: "2026-07-26T12:00:01.000Z",
    },
  ];
  busyAndDisallowed.configuredPolicy = {
    version: 1,
    capabilityFreshnessSeconds: 86_400,
    allowedCapabilities: [],
    versionRecorded: true,
  };

  const cases: Array<{
    name: string;
    value: ClaimAdmissionSnapshot;
    code: string;
  }> = [
    {
      name: "revoked beats missing run",
      value: snapshot({ runnerActive: false, run: null }),
      code: "runner_rejected",
    },
    {
      name: "revoked beats assignment mismatch",
      value: {
        ...withRun(snapshot(), { assignedRunnerId: otherRunnerId }),
        runnerActive: false,
      },
      code: "runner_rejected",
    },
    {
      name: "missing run beats conflict",
      value: snapshot({
        run: null,
        runnerLeases: [
          { runId: "a", expiresAt: "2026-07-26T12:00:01.000Z" },
          { runId: "b", expiresAt: "2026-07-26T12:00:01.000Z" },
        ],
      }),
      code: "run_unavailable",
    },
    {
      name: "cross tenant beats mismatch",
      value: withRun(snapshot(), {
        organizationId: "org-other",
        assignedRunnerId: otherRunnerId,
      }),
      code: "run_unavailable",
    },
    {
      name: "deadline beats busy",
      value: {
        ...withRun(snapshot(), { deadlineAt: now }),
        runnerLeases: [
          {
            runId: `run_${"9".repeat(32)}`,
            expiresAt: "2026-07-26T12:00:01.000Z",
          },
        ],
      },
      code: "run_unavailable",
    },
    {
      name: "claim cap beats mismatch",
      value: withRun(snapshot(), {
        claimCount: 5,
        assignedRunnerId: otherRunnerId,
      }),
      code: "run_unavailable",
    },
    {
      name: "live current lease beats runner busy",
      value: {
        ...withRun(snapshot(), {
          status: "leased",
          leaseStatus: "active",
          leaseExpiresAt: "2026-07-26T12:00:01.000Z",
        }),
        runnerLeases: [
          {
            runId: `run_${"9".repeat(32)}`,
            expiresAt: "2026-07-26T12:00:01.000Z",
          },
        ],
      },
      code: "run_unavailable",
    },
    {
      name: "assignment mismatch beats stale declaration",
      value: mismatchAndStale,
      code: "run_assignment_mismatch",
    },
    {
      name: "runner conflict beats declaration",
      value: {
        ...withRun(snapshot(), {
          assignedRunnerId,
          requiredCapability: "bubblewrap",
        }),
        runnerLeases: [
          { runId: "a", expiresAt: now },
          { runId: "b", expiresAt: now },
        ],
      },
      code: "runner_conflict",
    },
    {
      name: "runner busy beats disallowed declaration",
      value: busyAndDisallowed,
      code: "runner_busy",
    },
  ];

  for (const item of cases) {
    const result = evaluateClaimAdmission(item.value);
    assert.equal(result.kind, "denied", item.name);
    if (result.kind === "denied") assert.equal(result.code, item.code, item.name);
  }
});

test("claim evaluator produces exact unassigned and assignment-only pins", () => {
  assert.deepEqual(evaluateClaimAdmission(snapshot()), {
    kind: "admitted",
    admission: {
      kind: "unassigned",
      assignedRunnerId: null,
      admissionBasis: null,
      admissionPolicySource: null,
      admissionPolicyVersion: null,
      admissionFreshnessSeconds: null,
      admissionRequiredCapability: null,
      admissionReportId: null,
      admissionReportReceivedAt: null,
    },
  });
  const assignment = evaluateClaimAdmission(
    withRun(snapshot(), { assignedRunnerId }),
  );
  assert.equal(assignment.kind, "admitted");
  if (assignment.kind !== "admitted") return;
  assert.deepEqual(
    leaseClaimedMetadata(assignment.admission, {
      leaseId: `lse_${"1".repeat(32)}`,
      operationId: `op_${"1".repeat(32)}`,
    }),
    {
      leaseId: `lse_${"1".repeat(32)}`,
      operationId: `op_${"1".repeat(32)}`,
      assignedRunnerId,
      admissionBasis: "assignment_only",
    },
  );
});

test("capability admission uses latest report, inclusive freshness and policy pins", () => {
  const base = withRun(snapshot(), {
    assignedRunnerId,
    requiredCapability: "bubblewrap",
  });
  base.configuredPolicy = {
    version: 7,
    capabilityFreshnessSeconds: 3_600,
    allowedCapabilities: ["bubblewrap"],
    versionRecorded: true,
  };
  base.capabilityReports = [
    {
      reportId: `cap_${"1".repeat(32)}`,
      receivedAt: "2026-07-26T11:00:00.000Z",
      requiredCapabilityStatus: "available",
    },
    {
      reportId: `cap_${"2".repeat(32)}`,
      receivedAt: "2026-07-26T11:00:00.000Z",
      requiredCapabilityStatus: "available",
    },
  ];
  const admitted = evaluateClaimAdmission(base);
  assert.equal(admitted.kind, "admitted");
  if (admitted.kind !== "admitted") return;
  assert.deepEqual(admitted.admission, {
    kind: "capability_declaration",
    assignedRunnerId,
    admissionBasis: "capability_declaration",
    admissionPolicySource: "configured",
    admissionPolicyVersion: 7,
    admissionFreshnessSeconds: 3_600,
    admissionRequiredCapability: "bubblewrap",
    admissionReportId: `cap_${"2".repeat(32)}`,
    admissionReportReceivedAt: "2026-07-26T11:00:00.000Z",
  });
  assert.equal(
    Object.keys(
      leaseClaimedMetadata(admitted.admission, {
        leaseId: `lse_${"1".repeat(32)}`,
        operationId: `op_${"1".repeat(32)}`,
      }),
    ).length,
    10,
  );

  const stale = structuredClone(base);
  stale.capabilityReports[1].receivedAt = "2026-07-26T10:59:59.999Z";
  stale.capabilityReports[0].receivedAt = "2026-07-26T10:59:59.998Z";
  assert.deepEqual(evaluateClaimAdmission(stale), {
    kind: "denied",
    code: "capability_declaration_mismatch",
    status: 409,
  });
});

test("capability admission fails closed on malformed policy and declaration facts", () => {
  const base = withRun(snapshot(), {
    assignedRunnerId,
    requiredCapability: "bubblewrap",
  });
  base.capabilityReports = [
    {
      reportId,
      receivedAt: now,
      requiredCapabilityStatus: "available",
    },
  ];
  const invalid = [
    {
      ...base,
      configuredPolicy: {
        version: 1,
        capabilityFreshnessSeconds: 86_400,
        allowedCapabilities: ["bubblewrap"] as const,
        versionRecorded: false,
      },
    },
    {
      ...base,
      configuredPolicy: {
        version: 1,
        capabilityFreshnessSeconds: 86_400,
        allowedCapabilities: [] as const,
        versionRecorded: true,
      },
    },
    {
      ...base,
      capabilityReports: [
        {
          reportId,
          receivedAt: now,
          requiredCapabilityStatus: "unknown" as const,
        },
      ],
    },
    {
      ...base,
      capabilityReports: [
        {
          reportId,
          receivedAt: "2026-07-26T12:00:00.001Z",
          requiredCapabilityStatus: "available" as const,
        },
      ],
    },
  ];
  for (const value of invalid) {
    const result = evaluateClaimAdmission(
      value as ClaimAdmissionSnapshot,
    );
    assert.equal(result.kind, "denied");
    if (result.kind === "denied") {
      assert.equal(result.code, "capability_declaration_mismatch");
    }
  }
});
