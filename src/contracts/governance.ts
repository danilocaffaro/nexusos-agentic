export type PrincipalKind =
  | "human"
  | "agent"
  | "automation"
  | "policy"
  | "runner";

export type RiskTier = "low" | "medium" | "high" | "critical";

export type ActionIntentStatus =
  | "draft"
  | "proposed"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled"
  | "executing"
  | "succeeded"
  | "failed"
  | "interrupted";

export type IntentPrecondition = {
  ref: string;
  observedVersion: string;
};

export type IntentApproval = {
  actorId: string;
  actorKind: PrincipalKind;
  parametersHash: string;
  approvedAt: string;
};

export type PolicyDecision = {
  effect: "allow" | "deny" | "require_approval";
  policyVersion: string;
  reasons: string[];
  evaluatedAt: string;
};

export type ActionIntent = {
  id: string;
  organizationId: string;
  projectId: string;
  proposerId: string;
  proposerKind: PrincipalKind;
  actionType: string;
  targetRef: string;
  parameters: Record<string, unknown>;
  parametersHash: string;
  preconditions: IntentPrecondition[];
  riskTier: RiskTier;
  policyDecision: PolicyDecision;
  requiredApprovals: number;
  approvals: IntentApproval[];
  expiresAt: string;
  idempotencyKey: string;
  status: ActionIntentStatus;
  supersedesIntentId?: string;
  fencingToken?: number;
  createdAt: string;
  updatedAt: string;
};

export type LedgerEventKind =
  | "intent.proposed"
  | "intent.approved"
  | "intent.rejected"
  | "intent.expired"
  | "effect.started"
  | "effect.step"
  | "effect.succeeded"
  | "effect.failed"
  | "decision.recorded"
  | "artifact.registered"
  | "release.deployed";

export type LedgerEvent = {
  id: string;
  organizationId: string;
  kind: LedgerEventKind;
  actorId: string;
  occurredAt: string;
  payloadHash: string;
  payloadRef?: string;
  intentId?: string;
  runId?: string;
};

export type LedgerEntry = LedgerEvent & {
  sequence: number;
  previousHash: string;
  hash: string;
};

export const GENESIS_HASH = "0".repeat(64);
