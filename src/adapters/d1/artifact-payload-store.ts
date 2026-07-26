import { getD1 } from "@/db";
import type {
  ArtifactPayloadStore,
  ReadArtifactPayload,
  StagedArtifactPayload,
} from "@/src/ports/artifact-payload-store";
import { ArtifactPayloadStoreError } from "@/src/ports/artifact-payload-store";
import type { ValidatedArtifactContent } from "@/src/domain/artifacts";

export class D1ArtifactPayloadStore implements ArtifactPayloadStore {
  async stage(
    organizationId: string,
    content: ValidatedArtifactContent,
  ): Promise<StagedArtifactPayload> {
    const existing = await getD1()
      .prepare(
        `SELECT id, byte_size, body_text
         FROM artifact_payloads
         WHERE organization_id = ? AND content_hash = ?
           AND body_text IS NOT NULL AND erased_at IS NULL
         ORDER BY created_at, id`,
      )
      .bind(organizationId, content.contentHash)
      .all<LiveArtifactPayloadRow>();
    if (existing.results.length > 0) {
      const collision = existing.results.some(
        (row) =>
          row.byte_size !== content.byteSize ||
          row.body_text !== content.content,
      );
      if (collision) {
        throw new ArtifactPayloadStoreError(
          "artifact_content_hash_conflict",
        );
      }
      return {
        contentRef: existing.results[0].id,
        contentHash: content.contentHash,
        byteSize: content.byteSize,
        content: content.content,
        reused: true,
      };
    }
    return {
      contentRef: crypto.randomUUID(),
      contentHash: content.contentHash,
      byteSize: content.byteSize,
      content: content.content,
      reused: false,
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

type LiveArtifactPayloadRow = {
  id: string;
  byte_size: number;
  body_text: string;
};

type ArtifactPayloadRow = {
  id: string;
  content_hash: string;
  byte_size: number;
  body_text: string | null;
  erased_at: string | null;
};
