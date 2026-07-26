import type { ValidatedArtifactContent } from "@/src/domain/artifacts";

export type StoredArtifactPayload = {
  contentRef: string;
  contentHash: string;
  byteSize: number;
};

export type StagedArtifactPayload = StoredArtifactPayload & {
  content: string;
};

export type ReadArtifactPayload = StoredArtifactPayload & {
  content: string | null;
  erasedAt: string | null;
};

export interface ArtifactPayloadStore {
  stage(content: ValidatedArtifactContent): StagedArtifactPayload;
  get(
    organizationId: string,
    contentRef: string,
  ): Promise<ReadArtifactPayload | null>;
}
