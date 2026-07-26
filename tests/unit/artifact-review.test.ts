import assert from "node:assert/strict";
import test from "node:test";
import {
  ArtifactReviewValidationError,
  reviewHashEnvelope,
  validateArtifactReviewInput,
} from "../../src/domain/artifacts";
import type { ArtifactReview } from "../../src/contracts/artifacts";

test("artifact review verdicts accept only compatible bounded reasons", () => {
  assert.deepEqual(validateArtifactReviewInput("approved", "accurate"), {
    verdict: "approved",
    reasonCode: "accurate",
  });
  assert.deepEqual(
    validateArtifactReviewInput("changes_requested", "needs_evidence"),
    {
      verdict: "changes_requested",
      reasonCode: "needs_evidence",
    },
  );
  assert.throws(
    () => validateArtifactReviewInput("approved", "needs_correction"),
    (error: unknown) =>
      error instanceof ArtifactReviewValidationError &&
      error.code === "invalid_review_reason",
  );
});

test("review ledger envelope excludes titles, notes and payload content", () => {
  const review: ArtifactReview = {
    id: "review-1",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    versionNumber: 1,
    contentHash: "a".repeat(64),
    byteSize: 42,
    verdict: "approved",
    reasonCode: "complete",
    reviewer: { id: "human-1", displayName: "Rafael" },
    status: "active",
    createdAt: "2026-07-26T12:00:00.000Z",
  };
  const envelope = reviewHashEnvelope(review);
  assert.equal(envelope.reviewerId, "human-1");
  assert.equal(envelope.artifactVersionId, "version-1");
  assert.equal(envelope.versionNumber, 1);
  assert.equal(envelope.contentHash, "a".repeat(64));
  assert.equal("displayName" in envelope, false);
  assert.equal("content" in envelope, false);
  assert.equal("note" in envelope, false);
});
