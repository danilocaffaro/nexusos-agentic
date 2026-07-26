import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceHashEnvelope,
  EvidenceValidationError,
  hashCanonical,
  requireHumanEvidenceRelation,
} from "../../src/domain/governance";
import type { IntentArtifactEvidence } from "../../src/contracts/governance";

const evidence: IntentArtifactEvidence = {
  id: "evidence-1",
  intentId: "intent-1",
  artifactId: "artifact-1",
  artifactVersionId: "artifact-version-1",
  artifactTitle: "Release analysis",
  versionNumber: 3,
  projectId: "project-1",
  workItemId: "work-item-1",
  workItemRef: "NX-41",
  contentHash: "a".repeat(64),
  byteSize: 1024,
  relation: "basis",
  status: "active",
  addedBy: { id: "human-1", displayName: "Rafael" },
  createdAt: "2026-07-25T12:00:00.000Z",
};

test("evidence hash envelope contains only immutable lineage metadata", async () => {
  const envelope = evidenceHashEnvelope(evidence);
  assert.deepEqual(envelope, {
    evidenceId: "evidence-1",
    intentId: "intent-1",
    artifactId: "artifact-1",
    artifactVersionId: "artifact-version-1",
    versionNumber: 3,
    contentHash: "a".repeat(64),
    byteSize: 1024,
    relation: "basis",
    status: "active",
    supersededAt: null,
  });
  assert.equal(
    await hashCanonical(envelope),
    await hashCanonical({ ...envelope }),
  );
  assert.equal("artifactTitle" in envelope, false);
  assert.equal("content" in envelope, false);
});

test("human evidence routes can only create basis links", () => {
  assert.equal(requireHumanEvidenceRelation("basis"), "basis");
  assert.throws(
    () => requireHumanEvidenceRelation("outcome"),
    (error: unknown) =>
      error instanceof EvidenceValidationError &&
      error.code === "invalid_evidence_relation",
  );
});
