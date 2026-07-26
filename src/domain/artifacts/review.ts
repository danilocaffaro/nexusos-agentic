import type {
  ArtifactReview,
  ArtifactReviewReasonCode,
  ArtifactReviewVerdict,
} from "@/src/contracts/artifacts";

const APPROVED_REASONS = new Set<ArtifactReviewReasonCode>([
  "accurate",
  "complete",
]);
const CHANGES_REASONS = new Set<ArtifactReviewReasonCode>([
  "needs_correction",
  "needs_evidence",
  "outdated",
]);

export function validateArtifactReviewInput(
  verdict: unknown,
  reasonCode: unknown,
): {
  verdict: ArtifactReviewVerdict;
  reasonCode: ArtifactReviewReasonCode;
} {
  if (verdict !== "approved" && verdict !== "changes_requested") {
    throw new ArtifactReviewValidationError("invalid_review_verdict");
  }
  if (
    typeof reasonCode !== "string" ||
    (verdict === "approved"
      ? !APPROVED_REASONS.has(reasonCode as ArtifactReviewReasonCode)
      : !CHANGES_REASONS.has(reasonCode as ArtifactReviewReasonCode))
  ) {
    throw new ArtifactReviewValidationError("invalid_review_reason");
  }
  return {
    verdict,
    reasonCode: reasonCode as ArtifactReviewReasonCode,
  };
}

export function reviewHashEnvelope(review: ArtifactReview) {
  return {
    reviewId: review.id,
    artifactId: review.artifactId,
    artifactVersionId: review.artifactVersionId,
    versionNumber: review.versionNumber,
    contentHash: review.contentHash,
    byteSize: review.byteSize,
    verdict: review.verdict,
    reasonCode: review.reasonCode,
    reviewerId: review.reviewer.id,
    selfReviewPolicy: review.selfReviewPolicy ?? null,
    status: review.status,
    supersedesReviewId: review.supersedesReviewId ?? null,
    supersededAt: review.supersededAt ?? null,
  };
}

export class ArtifactReviewValidationError extends Error {
  constructor(
    readonly code: "invalid_review_verdict" | "invalid_review_reason",
  ) {
    super(code);
    this.name = "ArtifactReviewValidationError";
  }
}
