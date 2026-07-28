import type {
  EngineProbeReadiness,
  EngineProbeStatus,
  ExecutionEngineName,
} from "@/src/contracts/execution-engines";
import {
  ENGINE_PROBE_READINESS,
  ENGINE_PROBE_REASONS,
  ENGINE_PROBE_STATUSES,
  EXECUTION_ENGINE_NAMES,
} from "@/src/contracts/execution-engines";
import type {
  EngineRunInventoryEligibility,
  EngineRunOption,
  EngineRunOptionDisabledReason,
} from "@/src/contracts/engine-run-options";
import { DEFAULT_RUNNER_ADMISSION_POLICY } from "./admission-policy";
import {
  ENGINE_REPORT_ID_PATTERN,
  isEngineFreshnessSeconds,
  isEngineReportVersion,
} from "./engine-report-protocol";
import { RUNNER_TIMESTAMP_PATTERN } from "./runner-protocol";

type InventoryDisabledReason = Exclude<
  EngineRunOptionDisabledReason,
  "runner_inactive"
>;

export type ConfiguredEngineAdmissionPolicySnapshot = {
  version: number;
  engineFreshnessSeconds: number;
  versionRecorded: boolean;
};

export type EngineInventoryReportSnapshot = {
  reportId: string;
  receivedAt: string;
  evidenceCount: number;
  engine: ExecutionEngineName | null;
  status: EngineProbeStatus | null;
  readiness: EngineProbeReadiness | null;
  reason: string | null;
  version: string | null;
};

export type EngineInventoryEligibilitySnapshot = {
  requestedEngine: ExecutionEngineName;
  now: string;
  configuredPolicy: ConfiguredEngineAdmissionPolicySnapshot | null;
  engineReports: EngineInventoryReportSnapshot[];
};

export type EngineInventoryEligibilityEvaluation =
  EngineRunInventoryEligibility & Readonly<{
    policySource: "default" | "configured";
    policyVersion: number;
    freshnessSeconds: number;
  }>;

export function evaluateEngineInventoryEligibility(
  snapshot: EngineInventoryEligibilitySnapshot,
): EngineInventoryEligibilityEvaluation {
  if (
    !isExecutionEngineName(snapshot.requestedEngine) ||
    !isCanonicalTimestamp(snapshot.now) ||
    !Array.isArray(snapshot.engineReports)
  ) {
    throw new TypeError("Invalid engine inventory eligibility snapshot.");
  }

  const policy = snapshot.configuredPolicy;
  const policySource: "default" | "configured" = policy
    ? "configured"
    : "default";
  const policyVersion =
    policy?.version ?? DEFAULT_RUNNER_ADMISSION_POLICY.version;
  const freshnessSeconds =
    policy?.engineFreshnessSeconds ??
    DEFAULT_RUNNER_ADMISSION_POLICY.engineFreshnessSeconds;
  const policyValid =
    (policy === null ||
      (
        policy.versionRecorded === true &&
        Number.isSafeInteger(policy.version) &&
        policy.version >= 1
      )) &&
    isEngineFreshnessSeconds(freshnessSeconds);
  const common = {
    evaluatedAt: snapshot.now,
    trust: "hostReported" as const,
    engine: snapshot.requestedEngine,
    policySource,
    policyVersion,
    freshnessSeconds,
  };
  if (!policyValid) {
    return disabled(common, "engine_policy_invalid");
  }

  const report = latestEngineReport(snapshot.engineReports);
  if (!report) return disabled(common, "engine_report_absent");
  if (
    !ENGINE_REPORT_ID_PATTERN.test(report.reportId) ||
    !isCanonicalTimestamp(report.receivedAt)
  ) {
    return disabled(common, "engine_inventory_inconsistent");
  }
  const reportReceivedMs = Date.parse(report.receivedAt);
  const evaluatedMs = Date.parse(snapshot.now);
  const freshUntilMs = reportReceivedMs + freshnessSeconds * 1_000;
  if (
    !Number.isFinite(freshUntilMs) ||
    freshUntilMs > Date.parse("9999-12-31T23:59:59.999Z")
  ) {
    return disabled(common, "engine_inventory_inconsistent", {
      reportId: report.reportId,
      receivedAt: report.receivedAt,
    });
  }
  const reportFacts = {
    reportId: report.reportId,
    receivedAt: report.receivedAt,
    freshUntil: new Date(freshUntilMs).toISOString(),
  };
  if (reportReceivedMs > evaluatedMs) {
    return disabled(common, "engine_report_future", reportFacts);
  }
  if (evaluatedMs > freshUntilMs) {
    return disabled(common, "engine_report_stale", reportFacts);
  }

  const evidenceMissing =
    report.engine === null &&
    report.status === null &&
    report.readiness === null &&
    report.reason === null &&
    report.version === null;
  if (evidenceMissing) {
    return disabled(
      common,
      "engine_evidence_missing",
      reportFacts,
    );
  }

  const safeStatus = member(ENGINE_PROBE_STATUSES, report.status)
    ? report.status
    : null;
  const safeReadiness = member(ENGINE_PROBE_READINESS, report.readiness)
    ? report.readiness
    : null;
  const safeReason = member(ENGINE_PROBE_REASONS, report.reason)
    ? report.reason
    : null;
  const safeVersion = report.version === null
    ? null
    : isEngineReportVersion(report.version)
      ? report.version
      : null;
  const evidenceFacts = {
    ...reportFacts,
    status: safeStatus,
    readiness: safeReadiness,
    reason: safeReason,
    version: safeVersion,
  };
  if (
    report.evidenceCount !== EXECUTION_ENGINE_NAMES.length ||
    report.engine !== snapshot.requestedEngine ||
    safeStatus === null ||
    safeReadiness === null ||
    safeReason === null ||
    (report.version !== null && safeVersion === null)
  ) {
    return disabled(
      common,
      "engine_inventory_inconsistent",
      evidenceFacts,
    );
  }

  if (
    safeStatus === "available" &&
    safeReadiness === "ready" &&
    safeReason === "none"
  ) {
    if (safeVersion === null) {
      return disabled(
        common,
        "engine_version_missing",
        evidenceFacts,
      );
    }
    return deepFreeze({
      ...common,
      ...evidenceFacts,
      eligible: true,
      disabledReason: null,
    });
  }
  if (
    safeStatus === "unavailable" &&
    safeReadiness === "attention_required" &&
    safeReason === "engine_not_configured" &&
    safeVersion === null
  ) {
    return disabled(common, "engine_unavailable", evidenceFacts);
  }
  if (
    (
      safeStatus === "unavailable" &&
      safeReadiness === "attention_required" &&
      safeReason === "engine_binary_invalid" &&
      safeVersion === null
    ) ||
    (
      safeStatus === "available" &&
      safeReadiness === "attention_required" &&
      safeReason === "engine_incompatible" &&
      safeVersion !== null
    )
  ) {
    return disabled(common, "engine_misconfigured", evidenceFacts);
  }
  if (
    safeStatus === "available" &&
    safeReadiness === "attention_required" &&
    safeReason === "engine_auth_attention_required" &&
    safeVersion !== null
  ) {
    return disabled(
      common,
      "engine_auth_attention_required",
      evidenceFacts,
    );
  }
  if (
    safeStatus === "unknown" &&
    safeReadiness === "unknown" &&
    safeReason === "engine_probe_failed" &&
    safeVersion === null
  ) {
    return disabled(common, "engine_unavailable", evidenceFacts);
  }
  return disabled(
    common,
    "engine_inventory_inconsistent",
    evidenceFacts,
  );
}

export function toEngineRunOption(
  runner: Readonly<{
    id: string;
    name: string;
    state: "active" | "inactive";
  }>,
  inventory: EngineInventoryEligibilityEvaluation,
): EngineRunOption {
  const runnerActive = runner.state === "active";
  return deepFreeze({
    evaluatedAt: inventory.evaluatedAt,
    trust: inventory.trust,
    reportId: inventory.reportId,
    receivedAt: inventory.receivedAt,
    freshUntil: inventory.freshUntil,
    engine: inventory.engine,
    status: inventory.status,
    readiness: inventory.readiness,
    reason: inventory.reason,
    version: inventory.version,
    runnerId: runner.id,
    runnerName: runner.name,
    runnerState: runner.state,
    eligible: runnerActive && inventory.eligible,
    disabledReason: runnerActive
      ? inventory.disabledReason
      : "runner_inactive",
  });
}

function latestEngineReport(
  reports: EngineInventoryReportSnapshot[],
): EngineInventoryReportSnapshot | undefined {
  return [...reports].sort((left, right) => {
    if (left.receivedAt !== right.receivedAt) {
      return left.receivedAt < right.receivedAt ? 1 : -1;
    }
    if (left.reportId === right.reportId) return 0;
    return left.reportId < right.reportId ? 1 : -1;
  })[0];
}

function disabled(
  common: Pick<
    EngineInventoryEligibilityEvaluation,
    | "engine"
    | "evaluatedAt"
    | "freshnessSeconds"
    | "policySource"
    | "policyVersion"
    | "trust"
  >,
  disabledReason: InventoryDisabledReason,
  facts: Partial<
    Pick<
      EngineRunInventoryEligibility,
      | "freshUntil"
      | "readiness"
      | "reason"
      | "reportId"
      | "receivedAt"
      | "status"
      | "version"
    >
  > = {},
): EngineInventoryEligibilityEvaluation {
  return deepFreeze({
    ...common,
    reportId: facts.reportId ?? null,
    receivedAt: facts.receivedAt ?? null,
    freshUntil: facts.freshUntil ?? null,
    status: facts.status ?? null,
    readiness: facts.readiness ?? null,
    reason: facts.reason ?? null,
    version: facts.version ?? null,
    eligible: false,
    disabledReason,
  });
}

function isExecutionEngineName(
  value: unknown,
): value is ExecutionEngineName {
  return member(EXECUTION_ENGINE_NAMES, value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !RUNNER_TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function member<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
