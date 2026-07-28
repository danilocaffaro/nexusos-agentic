import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ENGINE_RUN_OPTION_DISABLED_REASONS,
  ENGINE_RUN_OPTIONS_MAX_OPTIONS,
  ENGINE_RUN_OPTIONS_MAX_RUNNERS,
  ENGINE_RUN_OPTIONS_TRUST_DISCLOSURE,
} from "../../src/contracts/engine-run-options";
import {
  evaluateEngineClaimAdmission,
  type EngineClaimAdmissionSnapshot,
} from "../../src/domain/runners/engine-claim-admission";
import {
  evaluateEngineInventoryEligibility,
  toEngineRunOption,
  type EngineInventoryEligibilitySnapshot,
  type EngineInventoryReportSnapshot,
} from "../../src/domain/runners/engine-inventory-eligibility";

const evaluatedAt = "2026-07-27T12:00:00.000Z";
const runnerId = `rnr_${"1".repeat(32)}`;
const reportId = `egr_${"1".repeat(32)}`;

function readyReport(
  patch: Partial<EngineInventoryReportSnapshot> = {},
): EngineInventoryReportSnapshot {
  return {
    reportId,
    receivedAt: "2026-07-27T11:59:00.000Z",
    evidenceCount: 2,
    engine: "claude_code_cli",
    status: "available",
    readiness: "ready",
    reason: "none",
    version: "2.1.219",
    ...patch,
  };
}

function inventory(
  patch: Partial<EngineInventoryEligibilitySnapshot> = {},
): EngineInventoryEligibilitySnapshot {
  return {
    requestedEngine: "claude_code_cli",
    now: evaluatedAt,
    configuredPolicy: null,
    engineReports: [readyReport()],
    ...patch,
  };
}

function claim(
  patch: Partial<EngineClaimAdmissionSnapshot> = {},
): EngineClaimAdmissionSnapshot {
  return {
    runnerId,
    runnerOrganizationId: "org-local-aurora",
    runnerActive: true,
    requestedEngine: "claude_code_cli",
    now: evaluatedAt,
    run: {
      id: `run_${"2".repeat(32)}`,
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
    engineReports: [readyReport()],
    ...patch,
  };
}

test("engine option oracle returns closed, truthful, immutable facts", () => {
  const evaluation = evaluateEngineInventoryEligibility(inventory());
  assert.deepEqual(evaluation, {
    evaluatedAt,
    trust: "hostReported",
    engine: "claude_code_cli",
    policySource: "default",
    policyVersion: 0,
    freshnessSeconds: 86_400,
    reportId,
    receivedAt: "2026-07-27T11:59:00.000Z",
    freshUntil: "2026-07-28T11:59:00.000Z",
    status: "available",
    readiness: "ready",
    reason: "none",
    version: "2.1.219",
    eligible: true,
    disabledReason: null,
  });
  assert.equal(Object.isFrozen(evaluation), true);
  assert.deepEqual(ENGINE_RUN_OPTION_DISABLED_REASONS, [
    "runner_inactive",
    "engine_policy_invalid",
    "engine_report_absent",
    "engine_report_future",
    "engine_report_stale",
    "engine_evidence_missing",
    "engine_unavailable",
    "engine_auth_attention_required",
    "engine_misconfigured",
    "engine_version_missing",
    "engine_inventory_inconsistent",
  ]);
  assert.equal(ENGINE_RUN_OPTIONS_MAX_RUNNERS, 100);
  assert.equal(ENGINE_RUN_OPTIONS_MAX_OPTIONS, 200);
  for (const disclosure of [
    "hostReported",
    "server facts",
    "point-in-time selection preflight only",
    "POST and runner claim revalidate",
    "does not attest host or network isolation",
    "Browser time is never authority",
  ]) {
    assert.match(ENGINE_RUN_OPTIONS_TRUST_DISCLOSURE, new RegExp(disclosure));
  }
});

test("engine option oracle freezes every disabled reason and boundary", () => {
  const configured = {
    version: 7,
    engineFreshnessSeconds: 3_600,
    versionRecorded: true,
  };
  const cases: Array<{
    name: string;
    snapshot: EngineInventoryEligibilitySnapshot;
    reason: string;
  }> = [
    {
      name: "invalid policy",
      snapshot: inventory({
        configuredPolicy: { ...configured, versionRecorded: false },
      }),
      reason: "engine_policy_invalid",
    },
    {
      name: "absent report",
      snapshot: inventory({ engineReports: [] }),
      reason: "engine_report_absent",
    },
    {
      name: "future report",
      snapshot: inventory({
        engineReports: [
          readyReport({ receivedAt: "2026-07-27T12:00:00.001Z" }),
        ],
      }),
      reason: "engine_report_future",
    },
    {
      name: "stale report",
      snapshot: inventory({
        configuredPolicy: configured,
        engineReports: [
          readyReport({ receivedAt: "2026-07-27T10:59:59.999Z" }),
        ],
      }),
      reason: "engine_report_stale",
    },
    {
      name: "missing evidence",
      snapshot: inventory({
        engineReports: [
          readyReport({
            evidenceCount: 0,
            engine: null,
            status: null,
            readiness: null,
            reason: null,
            version: null,
          }),
        ],
      }),
      reason: "engine_evidence_missing",
    },
    {
      name: "unavailable",
      snapshot: inventory({
        engineReports: [
          readyReport({
            status: "unavailable",
            readiness: "attention_required",
            reason: "engine_not_configured",
            version: null,
          }),
        ],
      }),
      reason: "engine_unavailable",
    },
    {
      name: "authentication attention",
      snapshot: inventory({
        engineReports: [
          readyReport({
            readiness: "attention_required",
            reason: "engine_auth_attention_required",
          }),
        ],
      }),
      reason: "engine_auth_attention_required",
    },
    {
      name: "misconfigured",
      snapshot: inventory({
        engineReports: [
          readyReport({
            status: "unavailable",
            readiness: "attention_required",
            reason: "engine_binary_invalid",
            version: null,
          }),
        ],
      }),
      reason: "engine_misconfigured",
    },
    {
      name: "version missing",
      snapshot: inventory({
        engineReports: [readyReport({ version: null })],
      }),
      reason: "engine_version_missing",
    },
    {
      name: "inconsistent inventory",
      snapshot: inventory({
        engineReports: [readyReport({ evidenceCount: 1 })],
      }),
      reason: "engine_inventory_inconsistent",
    },
  ];
  for (const vector of cases) {
    const evaluation = evaluateEngineInventoryEligibility(vector.snapshot);
    assert.equal(evaluation.eligible, false, vector.name);
    assert.equal(evaluation.disabledReason, vector.reason, vector.name);
    assert.equal(Object.isFrozen(evaluation), true, vector.name);
  }

  const exactBoundary = evaluateEngineInventoryEligibility(
    inventory({
      configuredPolicy: configured,
      engineReports: [
        readyReport({ receivedAt: "2026-07-27T11:00:00.000Z" }),
      ],
    }),
  );
  assert.equal(exactBoundary.eligible, true);
  assert.equal(exactBoundary.freshUntil, evaluatedAt);
});

test("runner state fails closed without erasing pinned host-reported facts", () => {
  const source = evaluateEngineInventoryEligibility(inventory());
  const option = toEngineRunOption(
    { id: runnerId, name: "Mac Studio", state: "inactive" },
    source,
  );
  assert.deepEqual(option, {
    evaluatedAt,
    trust: "hostReported",
    reportId,
    receivedAt: "2026-07-27T11:59:00.000Z",
    freshUntil: "2026-07-28T11:59:00.000Z",
    engine: "claude_code_cli",
    status: "available",
    readiness: "ready",
    reason: "none",
    version: "2.1.219",
    runnerId,
    runnerName: "Mac Studio",
    runnerState: "inactive",
    eligible: false,
    disabledReason: "runner_inactive",
  });
  assert.equal(Object.isFrozen(option), true);
});

test("options and claim consume one oracle and cannot diverge", () => {
  const fixtures = [
    inventory(),
    inventory({ engineReports: [] }),
    inventory({
      engineReports: [
        readyReport({ receivedAt: "2026-07-27T12:00:00.001Z" }),
      ],
    }),
    inventory({
      engineReports: [readyReport({ evidenceCount: 1 })],
    }),
    inventory({
      engineReports: [
        readyReport({
          readiness: "attention_required",
          reason: "engine_auth_attention_required",
        }),
      ],
    }),
    inventory({
      engineReports: [readyReport({ version: null })],
    }),
  ];
  for (const fixture of fixtures) {
    const option = evaluateEngineInventoryEligibility(fixture);
    const admission = evaluateEngineClaimAdmission(
      claim({
        requestedEngine: fixture.requestedEngine,
        now: fixture.now,
        configuredPolicy: fixture.configuredPolicy,
        engineReports: fixture.engineReports,
      }),
    );
    assert.equal(
      admission.kind === "admitted",
      option.eligible,
      option.disabledReason ?? "eligible",
    );
    if (admission.kind === "admitted") {
      assert.equal(admission.admission.admissionEngineReportId, option.reportId);
      assert.equal(
        admission.admission.admissionEngineReportReceivedAt,
        option.receivedAt,
      );
      assert.equal(admission.admission.admissionEngineVersion, option.version);
      assert.equal(
        admission.admission.admissionPolicyVersion,
        option.policyVersion,
      );
    }
  }
});

test("GET is member-scoped, bounded and never accepts browser time", () => {
  const route = readFileSync(
    "app/api/runs/engine/options/route.ts",
    "utf8",
  );
  const readModel = readFileSync(
    "src/adapters/d1/engine-run-options-read-model.ts",
    "utf8",
  );
  const claimSource = readFileSync(
    "src/domain/runners/engine-claim-admission.ts",
    "utf8",
  );
  assert.match(route, /runnerWorkspaceRoute/);
  assert.match(route, /searchParams\.size > 0/);
  assert.doesNotMatch(route, /export async function POST/);
  assert.match(readModel, /requireWorkspaceMember/);
  assert.match(
    readModel,
    /await requireWorkspaceMember\(identity\);[\s\S]*?unexpected_query_parameter/u,
  );
  assert.match(readModel, /runner\.organization_id = \?/);
  assert.match(readModel, /latest\.organization_id = \?/);
  assert.match(readModel, /ENGINE_RUN_OPTIONS_MAX_RUNNERS \+ 1/);
  assert.match(readModel, /const evaluatedAt = new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(readModel, /browserNow|clientNow|Date\.now\(\)/);
  assert.match(claimSource, /evaluateEngineInventoryEligibility/);
});
