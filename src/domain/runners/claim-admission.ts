import type { RunnerCapabilityName } from "@/src/contracts/runners";
import {
  CAPABILITY_REPORT_ID_PATTERN,
  isCapabilityReportFresh,
  latestRunnerCapabilityReport,
} from "./capability-protocol";
import {
  DEFAULT_RUNNER_ADMISSION_POLICY,
  MAX_ADMISSION_FRESHNESS_SECONDS,
  MIN_ADMISSION_FRESHNESS_SECONDS,
} from "./admission-policy";

export type ClaimRunSnapshot = {
  id: string;
  organizationId: string;
  status: "queued" | "leased" | "completed" | "canceled";
  claimCount: number;
  maxClaims: number;
  deadlineAt: string;
  assignedRunnerId: string | null;
  requiredCapability: RunnerCapabilityName | null;
  leaseStatus: "active" | "superseded" | "released" | "revoked" | null;
  leaseExpiresAt: string | null;
};

export type ClaimRunnerLeaseSnapshot = {
  runId: string;
  expiresAt: string;
};

export type ConfiguredAdmissionPolicySnapshot = {
  version: number;
  capabilityFreshnessSeconds: number;
  allowedCapabilities: RunnerCapabilityName[];
  versionRecorded: boolean;
};

export type ClaimCapabilityReportSnapshot = {
  reportId: string;
  receivedAt: string;
  requiredCapabilityStatus:
    | "available"
    | "unavailable"
    | "unknown"
    | null;
};

export type ClaimAdmissionSnapshot = {
  runnerId: string;
  runnerOrganizationId: string;
  runnerActive: boolean;
  now: string;
  run: ClaimRunSnapshot | null;
  runnerLeases: ClaimRunnerLeaseSnapshot[];
  configuredPolicy: ConfiguredAdmissionPolicySnapshot | null;
  capabilityReports: ClaimCapabilityReportSnapshot[];
};

type AdmissionPins = {
  assignedRunnerId: string | null;
  admissionBasis: "assignment_only" | "capability_declaration" | null;
  admissionPolicySource: "default" | "configured" | null;
  admissionPolicyVersion: number | null;
  admissionFreshnessSeconds: number | null;
  admissionRequiredCapability: RunnerCapabilityName | null;
  admissionReportId: string | null;
  admissionReportReceivedAt: string | null;
};

export type ClaimAdmission =
  | (AdmissionPins & {
      kind: "unassigned";
      assignedRunnerId: null;
      admissionBasis: null;
      admissionPolicySource: null;
      admissionPolicyVersion: null;
      admissionFreshnessSeconds: null;
      admissionRequiredCapability: null;
      admissionReportId: null;
      admissionReportReceivedAt: null;
    })
  | (AdmissionPins & {
      kind: "assignment_only";
      assignedRunnerId: string;
      admissionBasis: "assignment_only";
      admissionPolicySource: null;
      admissionPolicyVersion: null;
      admissionFreshnessSeconds: null;
      admissionRequiredCapability: null;
      admissionReportId: null;
      admissionReportReceivedAt: null;
    })
  | (AdmissionPins & {
      kind: "capability_declaration";
      assignedRunnerId: string;
      admissionBasis: "capability_declaration";
      admissionPolicySource: "default" | "configured";
      admissionPolicyVersion: number;
      admissionFreshnessSeconds: number;
      admissionRequiredCapability: RunnerCapabilityName;
      admissionReportId: string;
      admissionReportReceivedAt: string;
    });

export type ClaimAdmissionDenial = {
  kind: "denied";
  code:
    | "runner_rejected"
    | "run_unavailable"
    | "run_assignment_mismatch"
    | "runner_conflict"
    | "runner_busy"
    | "capability_declaration_mismatch";
  status: 403 | 409;
};

export type ClaimAdmissionEvaluation =
  | ClaimAdmissionDenial
  | { kind: "admitted"; admission: ClaimAdmission };

export function evaluateClaimAdmission(
  snapshot: ClaimAdmissionSnapshot,
): ClaimAdmissionEvaluation {
  if (!snapshot.runnerActive) {
    return denial("runner_rejected", 403);
  }

  const run = snapshot.run;
  const nowMs = Date.parse(snapshot.now);
  const deadlineMs = run ? Date.parse(run.deadlineAt) : Number.NaN;
  const leaseExpiresAtMs =
    run?.leaseExpiresAt === null || run?.leaseExpiresAt === undefined
      ? Number.NaN
      : Date.parse(run.leaseExpiresAt);
  const liveCurrentLease =
    run?.status === "leased" &&
    run.leaseStatus === "active" &&
    Number.isFinite(leaseExpiresAtMs) &&
    Number.isFinite(nowMs) &&
    leaseExpiresAtMs > nowMs;
  if (
    !run ||
    run.organizationId !== snapshot.runnerOrganizationId ||
    !["queued", "leased"].includes(run.status) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= nowMs ||
    run.claimCount >= run.maxClaims ||
    liveCurrentLease
  ) {
    return denial("run_unavailable", 409);
  }

  if (
    run.assignedRunnerId !== null &&
    run.assignedRunnerId !== snapshot.runnerId
  ) {
    return denial("run_assignment_mismatch", 409);
  }

  if (snapshot.runnerLeases.length > 1) {
    return denial("runner_conflict", 409);
  }
  const activeForeignLease = snapshot.runnerLeases.find(
    (lease) =>
      lease.runId !== run.id &&
      Number.isFinite(Date.parse(lease.expiresAt)) &&
      Date.parse(lease.expiresAt) > nowMs,
  );
  if (activeForeignLease) {
    return denial("runner_busy", 409);
  }

  if (run.requiredCapability === null) {
    if (run.assignedRunnerId === null) {
      return {
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
      };
    }
    return {
      kind: "admitted",
      admission: {
        kind: "assignment_only",
        assignedRunnerId: run.assignedRunnerId,
        admissionBasis: "assignment_only",
        admissionPolicySource: null,
        admissionPolicyVersion: null,
        admissionFreshnessSeconds: null,
        admissionRequiredCapability: null,
        admissionReportId: null,
        admissionReportReceivedAt: null,
      },
    };
  }

  if (run.assignedRunnerId === null) {
    return denial("capability_declaration_mismatch", 409);
  }
  const policy = snapshot.configuredPolicy;
  const policySource = policy ? "configured" : "default";
  const policyVersion =
    policy?.version ?? DEFAULT_RUNNER_ADMISSION_POLICY.version;
  const freshnessSeconds =
    policy?.capabilityFreshnessSeconds ??
    DEFAULT_RUNNER_ADMISSION_POLICY.capabilityFreshnessSeconds;
  const allowedCapabilities =
    policy?.allowedCapabilities ??
    DEFAULT_RUNNER_ADMISSION_POLICY.allowedCapabilities;
  if (
    (policy !== null &&
      (!policy.versionRecorded ||
        !Number.isSafeInteger(policy.version) ||
        policy.version < 1)) ||
    !Number.isSafeInteger(freshnessSeconds) ||
    freshnessSeconds < MIN_ADMISSION_FRESHNESS_SECONDS ||
    freshnessSeconds > MAX_ADMISSION_FRESHNESS_SECONDS ||
    !allowedCapabilities.includes(run.requiredCapability)
  ) {
    return denial("capability_declaration_mismatch", 409);
  }

  const report = latestRunnerCapabilityReport(snapshot.capabilityReports);
  if (
    !report ||
    !CAPABILITY_REPORT_ID_PATTERN.test(report.reportId) ||
    report.requiredCapabilityStatus !== "available" ||
    !isCapabilityReportFresh({
      receivedAt: report.receivedAt,
      nowMs,
      maxAgeMs: freshnessSeconds * 1_000,
    })
  ) {
    return denial("capability_declaration_mismatch", 409);
  }

  return {
    kind: "admitted",
    admission: {
      kind: "capability_declaration",
      assignedRunnerId: run.assignedRunnerId,
      admissionBasis: "capability_declaration",
      admissionPolicySource: policySource,
      admissionPolicyVersion: policyVersion,
      admissionFreshnessSeconds: freshnessSeconds,
      admissionRequiredCapability: run.requiredCapability,
      admissionReportId: report.reportId,
      admissionReportReceivedAt: report.receivedAt,
    },
  };
}

export function leaseClaimedMetadata(
  admission: ClaimAdmission,
  input: { leaseId: string; operationId: string },
): Record<string, unknown> {
  if (admission.kind === "unassigned") {
    return {
      leaseId: input.leaseId,
      operationId: input.operationId,
    };
  }
  if (admission.kind === "assignment_only") {
    return {
      leaseId: input.leaseId,
      operationId: input.operationId,
      assignedRunnerId: admission.assignedRunnerId,
      admissionBasis: admission.admissionBasis,
    };
  }
  return {
    leaseId: input.leaseId,
    operationId: input.operationId,
    assignedRunnerId: admission.assignedRunnerId,
    admissionBasis: admission.admissionBasis,
    admissionPolicySource: admission.admissionPolicySource,
    admissionPolicyVersion: admission.admissionPolicyVersion,
    admissionFreshnessSeconds: admission.admissionFreshnessSeconds,
    admissionRequiredCapability: admission.admissionRequiredCapability,
    admissionReportId: admission.admissionReportId,
    admissionReportReceivedAt: admission.admissionReportReceivedAt,
  };
}

function denial(
  code: ClaimAdmissionDenial["code"],
  status: ClaimAdmissionDenial["status"],
): ClaimAdmissionDenial {
  return { kind: "denied", code, status };
}
