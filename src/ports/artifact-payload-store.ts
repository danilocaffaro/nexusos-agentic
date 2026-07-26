import type { ValidatedArtifactContent } from "@/src/domain/artifacts";

export type StoredArtifactPayload = {
  contentRef: string;
  contentHash: string;
  byteSize: number;
};

export type StagedArtifactPayload = StoredArtifactPayload & {
  content: string;
  reused: boolean;
};

export type ReadArtifactPayload = StoredArtifactPayload & {
  content: string | null;
  erasedAt: string | null;
};

export interface ArtifactPayloadStore {
  stage(
    organizationId: string,
    content: ValidatedArtifactContent,
  ): Promise<StagedArtifactPayload>;
  get(
    organizationId: string,
    contentRef: string,
  ): Promise<ReadArtifactPayload | null>;
}

export class ArtifactPayloadStoreError extends Error {
  constructor(
    readonly code: "artifact_content_hash_conflict",
  ) {
    super(code);
    this.name = "ArtifactPayloadStoreError";
  }
}
