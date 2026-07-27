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
  soloOwnerAcknowledged: boolean;
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
  separationOfDuties: boolean;
  selfApprovalPolicy?: "solo_owner";
  approvals: IntentApproval[];
  expiresAt: string;
  idempotencyKey: string;
  status: ActionIntentStatus;
  supersedesIntentId?: string;
  fencingToken?: number;
  createdAt: string;
  updatedAt: string;
};

export type IntentEvidenceRelation = "basis" | "outcome";
export type IntentEvidenceStatus = "active" | "superseded";

export type IntentArtifactEvidence = {
  id: string;
  intentId: string;
  artifactId: string;
  artifactVersionId: string;
  artifactTitle: string;
  versionNumber: number;
  projectId: string;
  workItemId: string;
  workItemRef: string;
  contentHash: string;
  byteSize: number;
  relation: IntentEvidenceRelation;
  status: IntentEvidenceStatus;
  addedBy: {
    id: string;
    displayName: string;
  };
  createdAt: string;
  supersededBy?: {
    id: string;
    displayName: string;
  };
  supersededAt?: string;
  erasedAt?: string;
};

export type IntentEvidenceCandidate = {
  artifactId: string;
  artifactVersionId: string;
  artifactTitle: string;
  versionNumber: number;
  workItemId: string;
  workItemRef: string;
  contentHash: string;
  byteSize: number;
  erasedAt?: string;
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
  | "evidence.linked"
  | "evidence.superseded"
  | "review.recorded"
  | "review.superseded"
  | "supersession.declared"
  | "supersession.retracted"
  | "runner_token.issued"
  | "runner_token.revoked"
  | "runner.enrolled"
  | "runner.revoked"
  | "runner_policy.updated"
  | "run.requested"
  | "run.completed"
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
