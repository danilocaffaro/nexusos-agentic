import type {
  IntentArtifactEvidence,
  IntentEvidenceRelation,
} from "@/src/contracts/governance";

export type EvidenceHashEnvelope = {
  evidenceId: string;
  intentId: string;
  artifactId: string;
  artifactVersionId: string;
  versionNumber: number;
  contentHash: string;
  byteSize: number;
  relation: IntentEvidenceRelation;
  status: IntentArtifactEvidence["status"];
  supersededAt: string | null;
};

export function evidenceHashEnvelope(
  evidence: IntentArtifactEvidence,
): EvidenceHashEnvelope {
  return {
    evidenceId: evidence.id,
    intentId: evidence.intentId,
    artifactId: evidence.artifactId,
    artifactVersionId: evidence.artifactVersionId,
    versionNumber: evidence.versionNumber,
    contentHash: evidence.contentHash,
    byteSize: evidence.byteSize,
    relation: evidence.relation,
    status: evidence.status,
    supersededAt: evidence.supersededAt ?? null,
  };
}

export function requireHumanEvidenceRelation(
  value: unknown,
): "basis" {
  if (value !== "basis") {
    throw new EvidenceValidationError("invalid_evidence_relation");
  }
  return value;
}

export class EvidenceValidationError extends Error {
  constructor(readonly code: "invalid_evidence_relation") {
    super(code);
    this.name = "EvidenceValidationError";
  }
}
