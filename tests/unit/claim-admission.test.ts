import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateClaimAdmission,
  evaluateDeclarationAdmission,
  leaseClaimedMetadata,
  type ClaimAdmissionSnapshot,
  type ConfiguredAdmissionPolicySnapshot,
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

test("claim and declaration projection share one admission matrix", () => {
  const configured: ConfiguredAdmissionPolicySnapshot = {
    version: 3,
    capabilityFreshnessSeconds: 3_600,
    allowedCapabilities: ["bubblewrap"],
    versionRecorded: true,
  };
  const report = (
    receivedAt: string,
    requiredCapabilityStatus:
      | "available"
      | "unavailable"
      | "unknown"
      | null = "available",
    id = reportId,
  ) => [{ reportId: id, receivedAt, requiredCapabilityStatus }];
  type ExpectedProjection = {
    satisfied: boolean;
    reason:
      | "satisfied"
      | "invalid_policy"
      | "capability_disallowed"
      | "declaration_absent"
      | "declaration_future"
      | "capability_absent"
      | "capability_unavailable"
      | "capability_unknown"
      | "declaration_stale";
    freshness:
      | "fresh"
      | "stale"
      | "future"
      | "absent"
      | "not_evaluated";
    status: "available" | "unavailable" | "unknown" | null;
    source: "default" | "configured";
    version: number;
    allowed: boolean;
    reportId: string | null;
    reportReceivedAt: string | null;
  };
  const expected = (
    patch: Partial<ExpectedProjection> = {},
  ): ExpectedProjection => ({
    satisfied: false,
    reason: "declaration_absent",
    freshness: "absent",
    status: null,
    source: "configured",
    version: 3,
    allowed: true,
    reportId: null,
    reportReceivedAt: null,
    ...patch,
  });
  const declared = (
    receivedAt: string,
    patch: Partial<ExpectedProjection> = {},
  ) =>
    expected({
      reportId,
      reportReceivedAt: receivedAt,
      ...patch,
    });
  const cases = [
    {
      name: "default policy fresh",
      policy: null,
      reports: report(now),
      expected: declared(now, {
        satisfied: true,
        reason: "satisfied",
        freshness: "fresh",
        status: "available",
        source: "default",
        version: 0,
      }),
    },
    {
      name: "configured policy fresh",
      policy: configured,
      reports: report(now),
      expected: declared(now, {
        satisfied: true,
        reason: "satisfied",
        freshness: "fresh",
        status: "available",
      }),
    },
    {
      name: "inclusive freshness boundary",
      policy: configured,
      reports: report("2026-07-26T11:00:00.000Z"),
      expected: declared("2026-07-26T11:00:00.000Z", {
        satisfied: true,
        reason: "satisfied",
        freshness: "fresh",
        status: "available",
      }),
    },
    {
      name: "deny all",
      policy: { ...configured, allowedCapabilities: [] },
      reports: report(now),
      expected: declared(now, {
        reason: "capability_disallowed",
        freshness: "fresh",
        status: "available",
        allowed: false,
      }),
    },
    {
      name: "partial allow list excludes requirement",
      policy: { ...configured, allowedCapabilities: ["docker"] },
      reports: report(now),
      expected: declared(now, {
        reason: "capability_disallowed",
        freshness: "fresh",
        status: "available",
        allowed: false,
      }),
    },
    {
      name: "absent report",
      policy: configured,
      reports: [],
      expected: expected(),
    },
    {
      name: "malformed report is not a declaration",
      policy: configured,
      reports: report(now, "available", "invalid"),
      expected: expected(),
    },
    {
      name: "stale report",
      policy: configured,
      reports: report("2026-07-26T10:59:59.999Z"),
      expected: declared("2026-07-26T10:59:59.999Z", {
        reason: "declaration_stale",
        freshness: "stale",
        status: "available",
      }),
    },
    {
      name: "future report",
      policy: configured,
      reports: report("2026-07-26T12:00:00.001Z"),
      expected: declared("2026-07-26T12:00:00.001Z", {
        reason: "declaration_future",
        freshness: "future",
        status: "available",
      }),
    },
    {
      name: "status reason precedes stale age",
      policy: configured,
      reports: report("2026-07-26T10:59:59.999Z", "unavailable"),
      expected: declared("2026-07-26T10:59:59.999Z", {
        reason: "capability_unavailable",
        freshness: "stale",
        status: "unavailable",
      }),
    },
    {
      name: "omitted capability reason precedes future age",
      policy: configured,
      reports: report("2026-07-26T12:00:00.001Z", null),
      expected: declared("2026-07-26T12:00:00.001Z", {
        reason: "capability_absent",
        freshness: "future",
      }),
    },
    {
      name: "capability omitted from report",
      policy: configured,
      reports: report(now, null),
      expected: declared(now, {
        reason: "capability_absent",
        freshness: "fresh",
      }),
    },
    {
      name: "unavailable capability",
      policy: configured,
      reports: report(now, "unavailable"),
      expected: declared(now, {
        reason: "capability_unavailable",
        freshness: "fresh",
        status: "unavailable",
      }),
    },
    {
      name: "unknown capability",
      policy: configured,
      reports: report(now, "unknown"),
      expected: declared(now, {
        reason: "capability_unknown",
        freshness: "fresh",
        status: "unknown",
      }),
    },
    {
      name: "unrecorded policy",
      policy: { ...configured, versionRecorded: false },
      reports: report(now),
      expected: declared(now, {
        reason: "invalid_policy",
        freshness: "not_evaluated",
        status: "available",
      }),
    },
  ] satisfies Array<{
    name: string;
    policy: ClaimAdmissionSnapshot["configuredPolicy"];
    reports: ClaimAdmissionSnapshot["capabilityReports"];
    expected: ExpectedProjection;
  }>;

  for (const item of cases) {
    const declaration = evaluateDeclarationAdmission({
      now,
      requiredCapability: "bubblewrap",
      configuredPolicy: item.policy,
      capabilityReports: item.reports,
    });
    const claimSnapshot = withRun(snapshot(), {
      assignedRunnerId,
      requiredCapability: "bubblewrap",
    });
    claimSnapshot.configuredPolicy = item.policy;
    claimSnapshot.capabilityReports = item.reports;
    const claim = evaluateClaimAdmission(claimSnapshot);

    assert.deepEqual(
      {
        satisfied: declaration.declarationSatisfied,
        reason: declaration.reason,
        freshness: declaration.freshnessState,
        status: declaration.declaredStatus,
        source: declaration.policySource,
        version: declaration.policyVersion,
        allowed: declaration.allowed,
        reportId: declaration.reportId,
        reportReceivedAt: declaration.reportReceivedAt,
      },
      item.expected,
      item.name,
    );
    assert.equal(
      claim.kind === "admitted",
      item.expected.satisfied,
      item.name,
    );
    if (!item.expected.satisfied) {
      assert.deepEqual(
        claim,
        {
          kind: "denied",
          code: "capability_declaration_mismatch",
          status: 409,
        },
        item.name,
      );
    }
  }
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
