import type { RunnerCapabilityName } from "./runners";
import type { ExecutionEngineName } from "./execution-engines";

export type RunStatus = "queued" | "leased" | "completed" | "canceled";

export type RunOutcomeStatus = "succeeded" | "failed" | "canceled";

export const LEASE_CLAIMED_BASE_METADATA_KEYS = [
  "leaseId",
  "operationId",
] as const;

export const LEASE_CLAIMED_ASSIGNMENT_METADATA_KEYS = [
  "assignedRunnerId",
  "admissionBasis",
] as const;

export const LEASE_CLAIMED_CAPABILITY_METADATA_KEYS = [
  "admissionPolicySource",
  "admissionPolicyVersion",
  "admissionFreshnessSeconds",
  "admissionRequiredCapability",
  "admissionReportId",
  "admissionReportReceivedAt",
] as const;

export type RunEventKind =
  | "run.created"
  | "lease.claimed"
  | "lease.renewed"
  | "lease.superseded"
  | "lease.released"
  | "lease.revoked"
  | "run.cancel_requested"
  | "run.completed"
  | "run.canceled"
  | "run.expired";

export type RunEvent = {
  sequence: number;
  kind: RunEventKind;
  actorId: string;
  occurredAt: string;
  fence?: number;
  metadata: Record<string, unknown>;
};

export type DiagnosticRun = {
  id: string;
  organizationId: string;
  requestedBy: string;
  kind: "diagnostic";
  status: RunStatus;
  version: number;
  leaseGeneration: number;
  currentLeaseId?: string;
  currentRunnerId?: string;
  leaseExpiresAt?: string;
  claimCount: number;
  maxClaims: number;
  deadlineAt: string;
  assignedRunnerId?: string;
  requiredCapability?: RunnerCapabilityName;
  expired?: true;
  cancelRequestedAt?: string;
  outcomeStatus?: RunOutcomeStatus;
  outcomeSummary?: string;
  completedOperationId?: string;
  recordedAt?: string;
  replayCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DiagnosticRunDetail = {
  run: DiagnosticRun;
  events: RunEvent[];
};

export type DiagnosticRunRegistry = {
  runs: DiagnosticRun[];
};

export type EngineRunStatus =
  | "queued"
  | "leased"
  | "canceled"
  | "expired";

export type EngineRun = {
  id: string;
  organizationId: string;
  requestedBy: string;
  kind: "engine_prompt";
  engine: ExecutionEngineName;
  status: EngineRunStatus;
  version: number;
  leaseGeneration: number;
  claimCount: number;
  maxClaims: number;
  deadlineAt: string;
  assignedRunnerId: string;
  promptRef: string;
  promptSha256: string;
  promptBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type EngineRunDetail = {
  run: EngineRun;
  events: RunEvent[];
};

export type LeaseClaim = {
  runId: string;
  leaseId: string;
  fence: number;
  expiresAt: string;
  cancelRequested: boolean;
};

export type LeaseRenewal = {
  runId: string;
  leaseId: string;
  fence: number;
  expiresAt: string;
  cancelRequested: boolean;
};

export type RunCompletion = {
  runId: string;
  status: "completed";
  recordedAt: string;
  late: boolean;
};
