import assert from "node:assert/strict";
import test from "node:test";
import {
  ArtifactValidationError,
  validateArtifactContent,
  validateArtifactErasureReason,
  validateArtifactMediaType,
  validateArtifactNote,
  validateArtifactTitle,
  validateExpectedArtifactVersion,
} from "../../src/domain/artifacts";
import { MAX_ARTIFACT_CONTENT_BYTES } from "../../src/contracts/artifacts";

test("artifact content hash is deterministic over exact UTF-8 bytes", async () => {
  const first = await validateArtifactContent("# Output\n\nOlá");
  const second = await validateArtifactContent("# Output\n\nOlá");
  const changed = await validateArtifactContent("# Output\n\nOla");

  assert.equal(first.contentHash, second.contentHash);
  assert.notEqual(first.contentHash, changed.contentHash);
  assert.equal(first.byteSize, new TextEncoder().encode(first.content).byteLength);
  assert.match(first.contentHash, /^[0-9a-f]{64}$/);
});

test("artifact content enforces a 256 KiB UTF-8 boundary", async () => {
  await assert.doesNotReject(() =>
    validateArtifactContent("a".repeat(MAX_ARTIFACT_CONTENT_BYTES)),
  );
  await assert.rejects(
    () => validateArtifactContent("a".repeat(MAX_ARTIFACT_CONTENT_BYTES + 1)),
    (error) =>
      error instanceof ArtifactValidationError &&
      error.code === "artifact_content_too_large",
  );
});

test("artifact metadata accepts only the immutable Markdown contract", () => {
  assert.equal(validateArtifactTitle("  Rollout plan  "), "Rollout plan");
  assert.equal(validateArtifactNote("  initial version  "), "initial version");
  assert.equal(validateArtifactNote(` ${"a".repeat(500)} `).length, 500);
  assert.equal(validateArtifactMediaType(undefined), "text/markdown");
  assert.equal(validateExpectedArtifactVersion(2), 2);
  assert.equal(
    validateArtifactErasureReason("  Retention period has ended.  "),
    "Retention period has ended.",
  );

  assert.throws(() => validateArtifactTitle("   "), ArtifactValidationError);
  assert.throws(
    () => validateArtifactMediaType("application/pdf"),
    ArtifactValidationError,
  );
  assert.throws(
    () => validateExpectedArtifactVersion(0),
    ArtifactValidationError,
  );
  assert.throws(
    () => validateArtifactErasureReason("short"),
    ArtifactValidationError,
  );
});
