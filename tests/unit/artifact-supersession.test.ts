import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactSupersession } from "../../src/contracts/artifacts";
import {
  ArtifactSupersessionValidationError,
  supersessionHashEnvelope,
  validateArtifactSupersessionReason,
  validateArtifactSupersessionRetractionReason,
} from "../../src/domain/artifacts";

test("artifact supersession accepts only closed reason vocabularies", () => {
  assert.equal(
    validateArtifactSupersessionReason("replaced_by_revision"),
    "replaced_by_revision",
  );
  assert.equal(
    validateArtifactSupersessionRetractionReason("declared_in_error"),
    "declared_in_error",
  );
  assert.throws(
    () => validateArtifactSupersessionReason("because I said so"),
    (error: unknown) =>
      error instanceof ArtifactSupersessionValidationError &&
      error.code === "invalid_supersession_reason",
  );
});

test("supersession ledger envelope contains pins but no erasable text", () => {
  const relation: ArtifactSupersession = {
    id: "relation-1",
    source: {
      artifactId: "artifact-a",
      title: "Old private title",
      projectId: "project-a",
      projectName: "Private project",
      projectStatus: "active",
      pinnedVersionNumber: 2,
      currentVersionNumber: 3,
      contentHash: "a".repeat(64),
      byteSize: 42,
      contentAvailable: false,
      staleHead: true,
    },
    target: {
      artifactId: "artifact-b",
      title: "New private title",
      projectId: "project-b",
      projectName: "Other project",
      projectStatus: "archived",
      pinnedVersionNumber: 1,
      currentVersionNumber: 1,
      contentHash: "b".repeat(64),
      byteSize: 84,
      contentAvailable: true,
      staleHead: false,
    },
    reasonCode: "scope_moved",
    status: "active",
    declaredBy: { id: "human-1", displayName: "Rafael" },
    declaredAt: "2026-07-26T13:00:00.000Z",
  };
  const envelope = supersessionHashEnvelope(relation);
  assert.equal(envelope.sourceArtifactId, "artifact-a");
  assert.equal(envelope.targetArtifactId, "artifact-b");
  assert.equal(envelope.sourceVersionNumber, 2);
  assert.equal(envelope.targetContentHash, "b".repeat(64));
  assert.equal("title" in envelope, false);
  assert.equal("projectName" in envelope, false);
  assert.equal("displayName" in envelope, false);
  assert.equal("contentAvailable" in envelope, false);
});
