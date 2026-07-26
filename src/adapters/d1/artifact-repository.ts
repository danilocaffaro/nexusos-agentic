import { getD1 } from "@/db";
import type {
  ArtifactDetail,
  ArtifactSummary,
  ArtifactVersionContent,
  ArtifactVersionSummary,
} from "@/src/contracts/artifacts";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  ArtifactValidationError,
  validateArtifactContent,
  validateArtifactMediaType,
  validateArtifactNote,
  validateArtifactTitle,
  validateExpectedArtifactVersion,
} from "@/src/domain/artifacts";
import { sha256Hex } from "@/src/domain/governance/crypto";
import type { ArtifactPayloadStore } from "@/src/ports/artifact-payload-store";
import {
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "./workspace-repository";
import { D1ArtifactPayloadStore } from "./artifact-payload-store";

type JsonRecord = Record<string, unknown>;

const payloadStore = new D1ArtifactPayloadStore();

export async function createArtifact(
  identity: RequestIdentity,
  workItemId: string,
  input: JsonRecord,
  store: ArtifactPayloadStore = payloadStore,
): Promise<ArtifactDetail> {
  await requireWorkspaceMember(identity);
  const workItem = await requireWorkItem(identity.organizationId, workItemId);
  const title = translateValidation(() => validateArtifactTitle(input.title));
  const mediaType = translateValidation(() =>
    validateArtifactMediaType(input.mediaType),
  );
  const note = translateValidation(() => validateArtifactNote(input.note));
  const content = await translateAsyncValidation(() =>
    validateArtifactContent(input.content),
  );
  const storedPayload = store.stage(content);
  const artifactId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await getD1().batch([
      getD1()
        .prepare(
          `INSERT INTO artifact_payloads (
            id, organization_id, content_hash, byte_size, body_text
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          storedPayload.contentRef,
          identity.organizationId,
          storedPayload.contentHash,
          storedPayload.byteSize,
          storedPayload.content,
        ),
      getD1()
        .prepare(
          `INSERT INTO artifacts (
            id, organization_id, project_id, work_item_id, title, media_type,
            current_version, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .bind(
          artifactId,
          identity.organizationId,
          workItem.project_id,
          workItemId,
          title,
          mediaType,
          identity.id,
          now,
          now,
        ),
      getD1()
        .prepare(
          `INSERT INTO artifact_versions (
            id, organization_id, artifact_id, version_number, content_ref,
            content_hash, byte_size, note, created_by, created_at
          ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          versionId,
          identity.organizationId,
          artifactId,
          storedPayload.contentRef,
          storedPayload.contentHash,
          storedPayload.byteSize,
          note,
          identity.id,
          now,
        ),
      getD1()
        .prepare(
          `UPDATE artifacts
           SET current_version = 1, updated_at = ?
           WHERE id = ? AND organization_id = ? AND current_version = 0`,
        )
        .bind(now, artifactId, identity.organizationId),
    ]);
  } catch (error) {
    translateStorageError(error);
  }

  return requireArtifactDetail(identity.organizationId, artifactId);
}

export async function appendArtifactVersion(
  identity: RequestIdentity,
  artifactId: string,
  input: JsonRecord,
  store: ArtifactPayloadStore = payloadStore,
): Promise<ArtifactVersionContent> {
  await requireWorkspaceMember(identity);
  const artifact = await requireArtifact(identity.organizationId, artifactId);
  const expectedVersion = translateValidation(() =>
    validateExpectedArtifactVersion(input.expectedVersion),
  );
  if (artifact.current_version !== expectedVersion) {
    throw new WorkspaceRepositoryError("artifact_version_conflict", 409);
  }
  const note = translateValidation(() => validateArtifactNote(input.note));
  const content = await translateAsyncValidation(() =>
    validateArtifactContent(input.content),
  );
  const storedPayload = store.stage(content);
  const nextVersion = expectedVersion + 1;
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await getD1().batch([
      getD1()
        .prepare(
          `INSERT INTO artifact_payloads (
            id, organization_id, content_hash, byte_size, body_text
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          storedPayload.contentRef,
          identity.organizationId,
          storedPayload.contentHash,
          storedPayload.byteSize,
          storedPayload.content,
        ),
      getD1()
        .prepare(
          `INSERT INTO artifact_versions (
            id, organization_id, artifact_id, version_number, content_ref,
            content_hash, byte_size, note, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          versionId,
          identity.organizationId,
          artifactId,
          nextVersion,
          storedPayload.contentRef,
          storedPayload.contentHash,
          storedPayload.byteSize,
          note,
          identity.id,
          now,
        ),
      getD1()
        .prepare(
          `UPDATE artifacts
           SET current_version = ?, updated_at = ?
           WHERE id = ? AND organization_id = ? AND current_version = ?`,
        )
        .bind(
          nextVersion,
          now,
          artifactId,
          identity.organizationId,
          expectedVersion,
        ),
    ]);
  } catch (error) {
    translateStorageError(error);
  }

  return requireArtifactVersionContent(
    identity.organizationId,
    artifactId,
    nextVersion,
    store,
  );
}

export async function listArtifactsForWorkItem(
  identity: RequestIdentity,
  workItemId: string,
): Promise<{ artifacts: ArtifactSummary[] }> {
  await requireWorkspaceMember(identity);
  await requireWorkItem(identity.organizationId, workItemId);
  const result = await getD1()
    .prepare(`${ARTIFACT_SUMMARY_QUERY}
      WHERE artifact.organization_id = ? AND artifact.work_item_id = ?
      ORDER BY artifact.updated_at DESC, artifact.id`)
    .bind(identity.organizationId, workItemId)
    .all<ArtifactSummaryRow>();
  return { artifacts: result.results.map(toArtifactSummary) };
}

export async function getArtifact(
  identity: RequestIdentity,
  artifactId: string,
): Promise<ArtifactDetail> {
  await requireWorkspaceMember(identity);
  return requireArtifactDetail(identity.organizationId, artifactId);
}

export async function getArtifactVersion(
  identity: RequestIdentity,
  artifactId: string,
  versionNumber: number,
  store: ArtifactPayloadStore = payloadStore,
): Promise<ArtifactVersionContent> {
  await requireWorkspaceMember(identity);
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
    throw new WorkspaceRepositoryError("invalid_artifact_version", 400);
  }
  return requireArtifactVersionContent(
    identity.organizationId,
    artifactId,
    versionNumber,
    store,
  );
}

async function requireArtifactDetail(
  organizationId: string,
  artifactId: string,
): Promise<ArtifactDetail> {
  const summary = await requireArtifactSummary(organizationId, artifactId);
  const versions = await getD1()
    .prepare(
      `SELECT
         version.version_number, version.content_hash, version.byte_size,
         version.note, version.created_at, creator.id AS creator_id,
         creator.display_name AS creator_name
       FROM artifact_versions version
       INNER JOIN principals creator
         ON creator.id = version.created_by
        AND creator.organization_id = version.organization_id
       WHERE version.organization_id = ? AND version.artifact_id = ?
       ORDER BY version.version_number DESC`,
    )
    .bind(organizationId, artifactId)
    .all<ArtifactVersionRow>();
  return {
    ...summary,
    versions: versions.results.map(toArtifactVersionSummary),
  };
}

async function requireArtifactSummary(
  organizationId: string,
  artifactId: string,
): Promise<ArtifactSummary> {
  const row = await getD1()
    .prepare(`${ARTIFACT_SUMMARY_QUERY}
      WHERE artifact.organization_id = ? AND artifact.id = ?
      LIMIT 1`)
    .bind(organizationId, artifactId)
    .first<ArtifactSummaryRow>();
  if (!row) {
    throw new WorkspaceRepositoryError("artifact_not_found", 404);
  }
  return toArtifactSummary(row);
}

async function requireArtifact(
  organizationId: string,
  artifactId: string,
): Promise<{ current_version: number }> {
  const artifact = await getD1()
    .prepare(
      `SELECT current_version
       FROM artifacts
       WHERE id = ? AND organization_id = ?`,
    )
    .bind(artifactId, organizationId)
    .first<{ current_version: number }>();
  if (!artifact) {
    throw new WorkspaceRepositoryError("artifact_not_found", 404);
  }
  return artifact;
}

async function requireWorkItem(
  organizationId: string,
  workItemId: string,
): Promise<{ project_id: string }> {
  const workItem = await getD1()
    .prepare(
      `SELECT work_item.project_id
       FROM work_items work_item
       INNER JOIN projects project
         ON project.id = work_item.project_id
        AND project.organization_id = work_item.organization_id
       WHERE work_item.id = ? AND work_item.organization_id = ?
       LIMIT 1`,
    )
    .bind(workItemId, organizationId)
    .first<{ project_id: string }>();
  if (!workItem) {
    throw new WorkspaceRepositoryError("work_item_not_found", 404);
  }
  return workItem;
}

async function requireArtifactVersionContent(
  organizationId: string,
  artifactId: string,
  versionNumber: number,
  store: ArtifactPayloadStore,
): Promise<ArtifactVersionContent> {
  const row = await getD1()
    .prepare(
      `SELECT
         artifact.title, artifact.media_type, version.content_ref,
         version.version_number, version.content_hash, version.byte_size,
         version.note, version.created_at, creator.id AS creator_id,
         creator.display_name AS creator_name
       FROM artifact_versions version
       INNER JOIN artifacts artifact
         ON artifact.id = version.artifact_id
        AND artifact.organization_id = version.organization_id
       INNER JOIN principals creator
         ON creator.id = version.created_by
        AND creator.organization_id = version.organization_id
       WHERE version.organization_id = ? AND version.artifact_id = ?
         AND version.version_number = ?
       LIMIT 1`,
    )
    .bind(organizationId, artifactId, versionNumber)
    .first<ArtifactVersionContentRow>();
  if (!row) {
    throw new WorkspaceRepositoryError("artifact_version_not_found", 404);
  }
  const payload = await store.get(organizationId, row.content_ref);
  if (
    !payload ||
    payload.contentHash !== row.content_hash ||
    payload.byteSize !== row.byte_size ||
    (payload.content !== null &&
      (new TextEncoder().encode(payload.content).byteLength !== row.byte_size ||
        (await sha256Hex(payload.content)) !== row.content_hash))
  ) {
    throw new WorkspaceRepositoryError("artifact_payload_unavailable", 503);
  }
  return {
    artifactId,
    title: row.title,
    mediaType: "text/markdown",
    ...toArtifactVersionSummary(row),
    content: payload.content,
    erasedAt: payload.erasedAt,
  };
}

function toArtifactSummary(row: ArtifactSummaryRow): ArtifactSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    workItemId: row.work_item_id,
    workItemRef: row.work_item_ref,
    workItemTitle: row.work_item_title,
    title: row.title,
    mediaType: "text/markdown",
    currentVersion: row.current_version,
    currentContentHash: row.current_content_hash,
    currentByteSize: row.current_byte_size,
    createdBy: {
      id: row.creator_id,
      displayName: row.creator_name,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toArtifactVersionSummary(
  row: ArtifactVersionRow,
): ArtifactVersionSummary {
  return {
    versionNumber: row.version_number,
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    note: row.note,
    createdBy: {
      id: row.creator_id,
      displayName: row.creator_name,
    },
    createdAt: row.created_at,
  };
}

function translateValidation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    translateValidationError(error);
  }
}

async function translateAsyncValidation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    translateValidationError(error);
  }
}

function translateValidationError(error: unknown): never {
  if (error instanceof ArtifactValidationError) {
    throw new WorkspaceRepositoryError(
      error.code,
      error.code === "artifact_content_too_large" ? 413 : 400,
    );
  }
  throw error;
}

function translateStorageError(error: unknown): never {
  if (
    error instanceof Error &&
    /(artifact_version_conflict|artifact_versions_artifact_number_uidx|UNIQUE constraint failed: artifact_versions)/i.test(
      error.message,
    )
  ) {
    throw new WorkspaceRepositoryError("artifact_version_conflict", 409);
  }
  if (
    error instanceof Error &&
    /artifact_principal_inactive/i.test(error.message)
  ) {
    throw new WorkspaceRepositoryError("workspace_membership_required", 403);
  }
  if (
    error instanceof Error &&
    /invalid_artifact_payload_ref/i.test(error.message)
  ) {
    throw new WorkspaceRepositoryError("artifact_payload_unavailable", 503);
  }
  if (
    error instanceof Error &&
    /(invalid_artifact_metadata|invalid_artifact_version_metadata|invalid_artifact_payload)/i.test(
      error.message,
    )
  ) {
    throw new WorkspaceRepositoryError("invalid_artifact_version", 400);
  }
  if (
    error instanceof Error &&
    /(invalid_artifact_reference|FOREIGN KEY constraint failed)/i.test(
      error.message,
    )
  ) {
    throw new WorkspaceRepositoryError("artifact_not_found", 404);
  }
  throw error;
}

const ARTIFACT_SUMMARY_QUERY = `
  SELECT
    artifact.id, artifact.project_id, project.name AS project_name,
    artifact.work_item_id, work_item.ref AS work_item_ref,
    work_item.title AS work_item_title, artifact.title, artifact.media_type,
    artifact.current_version, current.content_hash AS current_content_hash,
    current.byte_size AS current_byte_size, artifact.created_at,
    artifact.updated_at, creator.id AS creator_id,
    creator.display_name AS creator_name
  FROM artifacts artifact
  INNER JOIN projects project
    ON project.id = artifact.project_id
   AND project.organization_id = artifact.organization_id
  INNER JOIN work_items work_item
    ON work_item.id = artifact.work_item_id
   AND work_item.organization_id = artifact.organization_id
   AND work_item.project_id = artifact.project_id
  INNER JOIN principals creator
    ON creator.id = artifact.created_by
   AND creator.organization_id = artifact.organization_id
  INNER JOIN artifact_versions current
    ON current.artifact_id = artifact.id
   AND current.organization_id = artifact.organization_id
   AND current.version_number = artifact.current_version`;

type ArtifactSummaryRow = {
  id: string;
  project_id: string;
  project_name: string;
  work_item_id: string;
  work_item_ref: string;
  work_item_title: string;
  title: string;
  media_type: "text/markdown";
  current_version: number;
  current_content_hash: string;
  current_byte_size: number;
  creator_id: string;
  creator_name: string;
  created_at: string;
  updated_at: string;
};

type ArtifactVersionRow = {
  version_number: number;
  content_hash: string;
  byte_size: number;
  note: string;
  creator_id: string;
  creator_name: string;
  created_at: string;
};

type ArtifactVersionContentRow = ArtifactVersionRow & {
  title: string;
  media_type: "text/markdown";
  content_ref: string;
};
