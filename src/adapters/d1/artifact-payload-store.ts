import { getD1 } from "@/db";
import type {
  ArtifactPayloadStore,
  ReadArtifactPayload,
  StagedArtifactPayload,
} from "@/src/ports/artifact-payload-store";
import type { ValidatedArtifactContent } from "@/src/domain/artifacts";

export class D1ArtifactPayloadStore implements ArtifactPayloadStore {
  stage(
    content: ValidatedArtifactContent,
  ): StagedArtifactPayload {
    return {
      contentRef: crypto.randomUUID(),
      contentHash: content.contentHash,
      byteSize: content.byteSize,
      content: content.content,
    };
  }

  async get(
    organizationId: string,
    contentRef: string,
  ): Promise<ReadArtifactPayload | null> {
    const row = await getD1()
      .prepare(
        `SELECT id, content_hash, byte_size, body_text, erased_at
         FROM artifact_payloads
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(contentRef, organizationId)
      .first<ArtifactPayloadRow>();
    return row
      ? {
          contentRef: row.id,
          contentHash: row.content_hash,
          byteSize: row.byte_size,
          content: row.body_text,
          erasedAt: row.erased_at,
        }
      : null;
  }
}

type ArtifactPayloadRow = {
  id: string;
  content_hash: string;
  byte_size: number;
  body_text: string | null;
  erased_at: string | null;
};
