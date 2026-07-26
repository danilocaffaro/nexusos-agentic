import type {
  ArtifactSupersession,
  ArtifactSupersessionReasonCode,
  ArtifactSupersessionRetractionReasonCode,
} from "@/src/contracts/artifacts";

const REASONS = new Set<ArtifactSupersessionReasonCode>([
  "replaced_by_revision",
  "duplicate_output",
  "scope_moved",
]);

const RETRACTION_REASONS =
  new Set<ArtifactSupersessionRetractionReasonCode>([
    "declared_in_error",
    "no_longer_accurate",
  ]);

export function validateArtifactSupersessionReason(
  value: unknown,
): ArtifactSupersessionReasonCode {
  if (typeof value !== "string" || !REASONS.has(
    value as ArtifactSupersessionReasonCode,
  )) {
    throw new ArtifactSupersessionValidationError(
      "invalid_supersession_reason",
    );
  }
  return value as ArtifactSupersessionReasonCode;
}

export function validateArtifactSupersessionRetractionReason(
  value: unknown,
): ArtifactSupersessionRetractionReasonCode {
  if (typeof value !== "string" || !RETRACTION_REASONS.has(
    value as ArtifactSupersessionRetractionReasonCode,
  )) {
    throw new ArtifactSupersessionValidationError(
      "invalid_supersession_retraction_reason",
    );
  }
  return value as ArtifactSupersessionRetractionReasonCode;
}

export function supersessionHashEnvelope(
  relation: ArtifactSupersession,
) {
  return {
    supersessionId: relation.id,
    sourceArtifactId: relation.source.artifactId,
    sourceVersionNumber: relation.source.pinnedVersionNumber,
    sourceContentHash: relation.source.contentHash,
    sourceByteSize: relation.source.byteSize,
    targetArtifactId: relation.target.artifactId,
    targetVersionNumber: relation.target.pinnedVersionNumber,
    targetContentHash: relation.target.contentHash,
    targetByteSize: relation.target.byteSize,
    reasonCode: relation.reasonCode,
    status: relation.status,
    declaredBy: relation.declaredBy.id,
    declaredAt: relation.declaredAt,
    retractionReasonCode: relation.retractionReasonCode ?? null,
    retractedBy: relation.retractedBy?.id ?? null,
    retractedAt: relation.retractedAt ?? null,
  };
}

export class ArtifactSupersessionValidationError extends Error {
  constructor(
    readonly code:
      | "invalid_supersession_reason"
      | "invalid_supersession_retraction_reason",
  ) {
    super(code);
    this.name = "ArtifactSupersessionValidationError";
  }
}
