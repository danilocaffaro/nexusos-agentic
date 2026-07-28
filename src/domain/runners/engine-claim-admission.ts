import type { ExecutionEngineName } from "@/src/contracts/execution-engines";
import {
  ENGINE_EXECUTION_TIMEOUT_MAX_MS,
  ENGINE_EXECUTION_TIMEOUT_MIN_MS,
} from "@/src/contracts/execution-engines";
import {
  evaluateEngineInventoryEligibility,
  type ConfiguredEngineAdmissionPolicySnapshot,
  type EngineInventoryReportSnapshot,
} from "./engine-inventory-eligibility";

const ENGINE_DEADLINE_RESERVE_MS = 30_000;
const ENGINE_CLAIM_MIN_REMAINING_MS =
  ENGINE_EXECUTION_TIMEOUT_MIN_MS + ENGINE_DEADLINE_RESERVE_MS;

export type EngineClaimRunSnapshot = {
  id: string;
  organizationId: string;
  engine: ExecutionEngineName;
  status: "queued" | "leased" | "canceled" | "expired";
  claimCount: number;
  maxClaims: number;
  deadlineAt: string;
  assignedRunnerId: string;
  cancelRequestedAt: string | null;
  leaseStatus: "active" | "superseded" | "released" | "revoked" | null;
  leaseExpiresAt: string | null;
};

export type EngineClaimRunnerLeaseSnapshot = {
  runId: string;
  expiresAt: string;
};

export type EngineClaimReportSnapshot = EngineInventoryReportSnapshot;
export type { ConfiguredEngineAdmissionPolicySnapshot };

export type EngineClaimAdmissionSnapshot = {
  runnerId: string;
  runnerOrganizationId: string;
  runnerActive: boolean;
  requestedEngine: ExecutionEngineName;
  now: string;
  run: EngineClaimRunSnapshot | null;
  runnerLeases: EngineClaimRunnerLeaseSnapshot[];
  configuredPolicy: ConfiguredEngineAdmissionPolicySnapshot | null;
  engineReports: EngineClaimReportSnapshot[];
};

export type EngineClaimAdmission = {
  assignedRunnerId: string;
  admissionBasis: "engine_inventory";
  admissionPolicySource: "default" | "configured";
  admissionPolicyVersion: number;
  admissionFreshnessSeconds: number;
  admissionEngine: ExecutionEngineName;
  admissionEngineReportId: string;
  admissionEngineReportReceivedAt: string;
  admissionEngineVersion: string;
  timeoutMs: number;
};

export type EngineClaimAdmissionDenial = {
  kind: "denied";
  code:
    | "runner_rejected"
    | "run_unavailable"
    | "engine_mismatch"
    | "run_assignment_mismatch"
    | "runner_conflict"
    | "runner_busy"
    | "engine_deadline_insufficient"
    | "engine_inventory_mismatch";
  status: 403 | 409;
};

export type EngineClaimAdmissionEvaluation =
  | EngineClaimAdmissionDenial
  | { kind: "admitted"; admission: EngineClaimAdmission };

export function evaluateEngineClaimAdmission(
  snapshot: EngineClaimAdmissionSnapshot,
): EngineClaimAdmissionEvaluation {
  if (!snapshot.runnerActive) return denial("runner_rejected", 403);

  const run = snapshot.run;
  const nowMs = Date.parse(snapshot.now);
  const deadlineMs = run ? Date.parse(run.deadlineAt) : Number.NaN;
  const leaseExpiresAtMs = run?.leaseExpiresAt
    ? Date.parse(run.leaseExpiresAt)
    : Number.NaN;
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
    run.cancelRequestedAt !== null ||
    liveCurrentLease
  ) {
    return denial("run_unavailable", 409);
  }
  if (run.assignedRunnerId !== snapshot.runnerId) {
    return denial("run_assignment_mismatch", 409);
  }
  if (snapshot.requestedEngine !== run.engine) {
    return denial("engine_mismatch", 409);
  }
  if (snapshot.runnerLeases.length > 1) {
    return denial("runner_conflict", 409);
  }
  if (
    snapshot.runnerLeases.some(
      (lease) =>
        lease.runId !== run.id &&
        Number.isFinite(Date.parse(lease.expiresAt)) &&
        Date.parse(lease.expiresAt) > nowMs,
    )
  ) {
    return denial("runner_busy", 409);
  }

  const remainingMs = deadlineMs - nowMs;
  if (remainingMs < ENGINE_CLAIM_MIN_REMAINING_MS) {
    return denial("engine_deadline_insufficient", 409);
  }

  const inventory = evaluateEngineInventoryEligibility({
    requestedEngine: run.engine,
    now: snapshot.now,
    configuredPolicy: snapshot.configuredPolicy,
    engineReports: snapshot.engineReports,
  });
  if (
    !inventory.eligible ||
    inventory.reportId === null ||
    inventory.receivedAt === null ||
    inventory.version === null
  ) {
    return denial("engine_inventory_mismatch", 409);
  }

  return {
    kind: "admitted",
    admission: {
      assignedRunnerId: run.assignedRunnerId,
      admissionBasis: "engine_inventory",
      admissionPolicySource: inventory.policySource,
      admissionPolicyVersion: inventory.policyVersion,
      admissionFreshnessSeconds: inventory.freshnessSeconds,
      admissionEngine: run.engine,
      admissionEngineReportId: inventory.reportId,
      admissionEngineReportReceivedAt: inventory.receivedAt,
      admissionEngineVersion: inventory.version,
      timeoutMs: Math.min(
        ENGINE_EXECUTION_TIMEOUT_MAX_MS,
        remainingMs - ENGINE_DEADLINE_RESERVE_MS,
      ),
    },
  };
}

export function engineLeaseClaimedMetadata(
  admission: EngineClaimAdmission,
  input: { leaseId: string; operationId: string },
): Record<string, unknown> {
  return {
    leaseId: input.leaseId,
    operationId: input.operationId,
    assignedRunnerId: admission.assignedRunnerId,
    admissionBasis: admission.admissionBasis,
    admissionPolicySource: admission.admissionPolicySource,
    admissionPolicyVersion: admission.admissionPolicyVersion,
    admissionFreshnessSeconds: admission.admissionFreshnessSeconds,
    admissionEngine: admission.admissionEngine,
    admissionEngineReportId: admission.admissionEngineReportId,
    admissionEngineReportReceivedAt:
      admission.admissionEngineReportReceivedAt,
    admissionEngineVersion: admission.admissionEngineVersion,
  };
}

function denial(
  code: EngineClaimAdmissionDenial["code"],
  status: EngineClaimAdmissionDenial["status"],
): EngineClaimAdmissionDenial {
  return { kind: "denied", code, status };
}
