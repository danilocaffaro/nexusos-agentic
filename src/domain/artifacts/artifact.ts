import {
  ARTIFACT_MEDIA_TYPE,
  MAX_ARTIFACT_CONTENT_BYTES,
  type ArtifactMediaType,
} from "@/src/contracts/artifacts";
import { sha256Hex } from "@/src/domain/governance/crypto";

export type ValidatedArtifactContent = {
  content: string;
  contentHash: string;
  byteSize: number;
};

export class ArtifactValidationError extends Error {
  constructor(
    public readonly code:
      | "invalid_artifact_title"
      | "invalid_artifact_content"
      | "artifact_content_too_large"
      | "invalid_artifact_note"
      | "invalid_artifact_media_type"
      | "invalid_expected_version",
  ) {
    super(code);
    this.name = "ArtifactValidationError";
  }
}

export function validateArtifactTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new ArtifactValidationError("invalid_artifact_title");
  }
  const title = value.trim();
  if (!title || title.length > 160) {
    throw new ArtifactValidationError("invalid_artifact_title");
  }
  return title;
}

export function validateArtifactMediaType(
  value: unknown,
): ArtifactMediaType {
  if (value === undefined || value === ARTIFACT_MEDIA_TYPE) {
    return ARTIFACT_MEDIA_TYPE;
  }
  throw new ArtifactValidationError("invalid_artifact_media_type");
}

export function validateArtifactNote(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new ArtifactValidationError("invalid_artifact_note");
  }
  const note = value.trim();
  if (note.length > 500) {
    throw new ArtifactValidationError("invalid_artifact_note");
  }
  return note;
}

export function validateExpectedArtifactVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ArtifactValidationError("invalid_expected_version");
  }
  return Number(value);
}

export async function validateArtifactContent(
  value: unknown,
): Promise<ValidatedArtifactContent> {
  if (typeof value !== "string" || value.length === 0) {
    throw new ArtifactValidationError("invalid_artifact_content");
  }
  const byteSize = new TextEncoder().encode(value).byteLength;
  if (byteSize > MAX_ARTIFACT_CONTENT_BYTES) {
    throw new ArtifactValidationError("artifact_content_too_large");
  }
  return {
    content: value,
    contentHash: await sha256Hex(value),
    byteSize,
  };
}
