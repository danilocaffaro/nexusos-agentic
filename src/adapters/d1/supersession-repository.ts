import { desc, eq } from "drizzle-orm";
import { getD1, getDb } from "@/db";
import { ledgerEntries } from "@/db/schema";
import type {
  ArtifactSupersession,
  ArtifactSupersessionCandidate,
  ArtifactSupersessionState,
} from "@/src/contracts/artifacts";
import type {
  LedgerEntry,
  LedgerEvent,
} from "@/src/contracts/governance";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  ArtifactSupersessionValidationError,
  supersessionHashEnvelope,
  validateArtifactSupersessionReason,
  validateArtifactSupersessionRetractionReason,
} from "@/src/domain/artifacts";
import {
  appendLedgerEntry,
  hashCanonical,
} from "@/src/domain/governance";
import {
  requireWorkspaceMember,
  requireWorkspaceOwner,
  WorkspaceRepositoryError,
} from "./workspace-repository";
import { getArtifactVersion } from "./artifact-repository";

type JsonRecord = Record<string, unknown>;

const DECLARE_KEYS = new Set([
  "targetArtifactId",
  "sourceVersionNumber",
  "targetVersionNumber",
  "reasonCode",
]);
const RETRACT_KEYS = new Set([
  "expectedRelationId",
  "retractionReasonCode",
]);

export async function listArtifactSupersessions(
  identity: RequestIdentity,
  artifactId: string,
): Promise<ArtifactSupersessionState> {
  await requireWorkspaceMember(identity);
  await requireArtifactHead(identity.organizationId, artifactId);
  const [
    activeRows,
    historyRows,
    inboundRows,
    chainRows,
    candidateRows,
    canGovern,
  ] = await Promise.all([
    getD1()
      .prepare(
        `${SUPERSESSION_SELECT}
         WHERE relation.organization_id = ?
           AND relation.source_artifact_id = ?
           AND relation.status = 'active'
         ORDER BY relation.declared_at DESC, relation.id DESC
         LIMIT 1`,
      )
      .bind(identity.organizationId, artifactId)
      .all<SupersessionRow>(),
    getD1()
      .prepare(
        `${SUPERSESSION_SELECT}
         WHERE relation.organization_id = ?
           AND relation.source_artifact_id = ?
           AND relation.status = 'retracted'
         ORDER BY relation.declared_at DESC, relation.id DESC
         LIMIT 101`,
      )
      .bind(identity.organizationId, artifactId)
      .all<SupersessionRow>(),
    getD1()
      .prepare(
        `${SUPERSESSION_SELECT}
         WHERE relation.organization_id = ?
           AND relation.target_artifact_id = ?
           AND relation.status = 'active'
         ORDER BY relation.declared_at DESC, relation.id DESC
         LIMIT 101`,
      )
      .bind(identity.organizationId, artifactId)
      .all<SupersessionRow>(),
    getD1()
      .prepare(CHAIN_SELECT)
      .bind(
        identity.organizationId,
        artifactId,
        identity.organizationId,
      )
      .all<SupersessionRow>(),
    getD1()
      .prepare(CANDIDATE_SELECT)
      .bind(identity.organizationId, artifactId)
      .all<CandidateRow>(),
    canGovernSupersessions(identity),
  ]);
  const active = activeRows.results[0];
  const history = historyRows.results;
  return {
    artifactId,
    canGovern,
    ...(active ? { active: toSupersession(active) } : {}),
    inbound: inboundRows.results.slice(0, 100).map(toSupersession),
    inboundTruncated: inboundRows.results.length > 100,
    history: history.slice(0, 100).map(toSupersession),
    historyTruncated: historyRows.results.length > 100,
    chain: chainRows.results.slice(0, 100).map(toSupersession),
    chainTruncated: chainRows.results.length > 100,
    candidates: candidateRows.results.slice(0, 100).map(toCandidate),
    candidatesTruncated: candidateRows.results.length > 100,
  };
}

export async function declareArtifactSupersession(
  identity: RequestIdentity,
  sourceArtifactId: string,
  input: JsonRecord,
): Promise<{ supersession: ArtifactSupersession; created: boolean }> {
  await requireWorkspaceOwner(identity);
  validateShape(input, DECLARE_KEYS);
  const targetArtifactId = requiredId(
    input.targetArtifactId,
    "invalid_supersession_request",
  );
  const sourceVersionNumber = requiredVersion(input.sourceVersionNumber);
  const targetVersionNumber = requiredVersion(input.targetVersionNumber);
  const reasonCode = translateValidation(() =>
    validateArtifactSupersessionReason(input.reasonCode),
  );
  if (sourceArtifactId === targetArtifactId) {
    throw new WorkspaceRepositoryError(
      "supersession_self_reference",
      400,
    );
  }
  const current = await loadActiveSupersession(
    identity.organizationId,
    sourceArtifactId,
  );
  if (
    current &&
    current.target.artifactId === targetArtifactId &&
    current.source.pinnedVersionNumber === sourceVersionNumber &&
    current.target.pinnedVersionNumber === targetVersionNumber &&
    current.reasonCode === reasonCode
  ) {
    return { supersession: current, created: false };
  }
  if (current) {
    throw new WorkspaceRepositoryError("supersession_exists", 409);
  }
  const [source, target, actor] = await Promise.all([
    requireArtifactHead(identity.organizationId, sourceArtifactId),
    requireArtifactHead(identity.organizationId, targetArtifactId),
    requireActor(identity.organizationId, identity.id),
  ]);
  if (
    source.current_version !== sourceVersionNumber ||
    target.current_version !== targetVersionNumber
  ) {
    throw new WorkspaceRepositoryError("supersession_head_moved", 409);
  }
  if (source.content_hash === target.content_hash) {
    throw new WorkspaceRepositoryError(
      "supersession_target_identical",
      409,
    );
  }
  const verifiedTarget = await getArtifactVersion(
    identity,
    targetArtifactId,
    targetVersionNumber,
  );
  if (verifiedTarget.content === null) {
    throw new WorkspaceRepositoryError(
      "supersession_target_unreadable",
      409,
    );
  }
  const now = new Date().toISOString();
  const supersession: ArtifactSupersession = {
    id: crypto.randomUUID(),
    source: endpointFromHead(source, sourceVersionNumber),
    target: endpointFromHead(target, targetVersionNumber),
    reasonCode,
    status: "active",
    declaredBy: { id: identity.id, displayName: actor.display_name },
    declaredAt: now,
  };
  const ledger = await nextSupersessionLedger(
    identity.organizationId,
    identity.id,
    "supersession.declared",
    supersession,
    now,
  );
  let results;
  try {
    results = await getD1().batch([
      getD1()
        .prepare(
          `INSERT INTO artifact_supersessions (
            id, organization_id, source_artifact_id, source_version_id,
            source_version_number, source_content_hash, source_byte_size,
            target_artifact_id, target_version_id, target_version_number,
            target_content_hash, target_byte_size, relation_type, reason_code,
            status, declared_by, declared_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'supersedes', ?,
                    'active', ?, ?)`,
        )
        .bind(
          supersession.id,
          identity.organizationId,
          source.id,
          source.version_id,
          sourceVersionNumber,
          source.content_hash,
          source.byte_size,
          target.id,
          target.version_id,
          targetVersionNumber,
          target.content_hash,
          target.byte_size,
          reasonCode,
          identity.id,
          now,
        ),
      prepareLedgerInsert(ledger),
    ]);
  } catch (error) {
    translateStorageError(error);
  }
  assertBatchChanges(results);
  return { supersession, created: true };
}

export async function retractArtifactSupersession(
  identity: RequestIdentity,
  sourceArtifactId: string,
  relationId: string,
  input: JsonRecord,
): Promise<{ supersession: ArtifactSupersession; created: boolean }> {
  await requireWorkspaceOwner(identity);
  validateShape(input, RETRACT_KEYS);
  const expectedRelationId = requiredId(
    input.expectedRelationId,
    "invalid_supersession_request",
  );
  const normalizedRelationId = requiredId(
    relationId,
    "invalid_supersession_request",
  );
  if (normalizedRelationId !== expectedRelationId) {
    throw new WorkspaceRepositoryError(
      "invalid_supersession_request",
      400,
    );
  }
  const reasonCode = translateValidation(() =>
    validateArtifactSupersessionRetractionReason(
      input.retractionReasonCode,
    ),
  );
  const current = await loadSupersession(
    identity.organizationId,
    sourceArtifactId,
    normalizedRelationId,
  );
  if (
    current.status === "retracted" &&
    current.retractionReasonCode === reasonCode &&
    current.retractedBy?.id === identity.id
  ) {
    return { supersession: current, created: false };
  }
  if (current.status !== "active") {
    throw new WorkspaceRepositoryError(
      "supersession_not_active",
      409,
    );
  }
  const actor = await requireActor(
    identity.organizationId,
    identity.id,
  );
  const now = new Date().toISOString();
  const supersession: ArtifactSupersession = {
    ...current,
    status: "retracted",
    retractionReasonCode: reasonCode,
    retractedBy: { id: identity.id, displayName: actor.display_name },
    retractedAt: now,
  };
  const ledger = await nextSupersessionLedger(
    identity.organizationId,
    identity.id,
    "supersession.retracted",
    supersession,
    now,
  );
  let results;
  try {
    results = await getD1().batch([
      getD1()
        .prepare(
          `UPDATE artifact_supersessions
           SET status = 'retracted', retraction_reason_code = ?,
               retracted_by = ?, retracted_at = ?
           WHERE id = ? AND organization_id = ?
             AND source_artifact_id = ? AND status = 'active'`,
        )
        .bind(
          reasonCode,
          identity.id,
          now,
          normalizedRelationId,
          identity.organizationId,
          sourceArtifactId,
        ),
      prepareLedgerInsert(ledger),
    ]);
  } catch (error) {
    translateStorageError(error);
  }
  assertBatchChanges(results);
  return { supersession, created: true };
}

async function loadActiveSupersession(
  organizationId: string,
  sourceArtifactId: string,
): Promise<ArtifactSupersession | undefined> {
  const row = await getD1()
    .prepare(
      `${SUPERSESSION_SELECT}
       WHERE relation.organization_id = ?
         AND relation.source_artifact_id = ?
         AND relation.status = 'active'
       LIMIT 1`,
    )
    .bind(organizationId, sourceArtifactId)
    .first<SupersessionRow>();
  return row ? toSupersession(row) : undefined;
}

async function loadSupersession(
  organizationId: string,
  sourceArtifactId: string,
  relationId: string,
): Promise<ArtifactSupersession> {
  const row = await getD1()
    .prepare(
      `${SUPERSESSION_SELECT}
       WHERE relation.organization_id = ?
         AND relation.source_artifact_id = ?
         AND relation.id = ?
       LIMIT 1`,
    )
    .bind(organizationId, sourceArtifactId, relationId)
    .first<SupersessionRow>();
  if (!row) {
    throw new WorkspaceRepositoryError("supersession_not_found", 404);
  }
  return toSupersession(row);
}

async function requireArtifactHead(
  organizationId: string,
  artifactId: string,
): Promise<HeadRow> {
  const row = await getD1()
    .prepare(
      `SELECT
         artifact.id, artifact.title, artifact.project_id,
         project.name AS project_name, project.status AS project_status,
         artifact.current_version, version.id AS version_id,
         version.content_hash, version.byte_size,
         CASE WHEN payload.body_text IS NOT NULL
                    AND payload.erased_at IS NULL
              THEN 1 ELSE 0 END AS content_available
       FROM artifacts artifact
       INNER JOIN projects project
         ON project.id = artifact.project_id
        AND project.organization_id = artifact.organization_id
       INNER JOIN artifact_versions version
         ON version.artifact_id = artifact.id
        AND version.organization_id = artifact.organization_id
        AND version.version_number = artifact.current_version
       INNER JOIN artifact_payloads payload
         ON payload.id = version.content_ref
        AND payload.organization_id = version.organization_id
       WHERE artifact.organization_id = ? AND artifact.id = ?
       LIMIT 1`,
    )
    .bind(organizationId, artifactId)
    .first<HeadRow>();
  if (!row) {
    throw new WorkspaceRepositoryError("artifact_not_found", 404);
  }
  return row;
}

async function requireActor(
  organizationId: string,
  actorId: string,
): Promise<{ display_name: string }> {
  const actor = await getD1()
    .prepare(
      `SELECT display_name FROM principals
       WHERE id = ? AND organization_id = ? AND status = 'active'
         AND kind = 'human'
       LIMIT 1`,
    )
    .bind(actorId, organizationId)
    .first<{ display_name: string }>();
  if (!actor) {
    throw new WorkspaceRepositoryError("workspace_owner_required", 403);
  }
  return actor;
}

async function canGovernSupersessions(
  identity: RequestIdentity,
): Promise<boolean> {
  const row = await getD1()
    .prepare(
      `SELECT 1
       FROM memberships membership
       INNER JOIN principals principal
         ON principal.id = membership.principal_id
        AND principal.organization_id = membership.organization_id
       WHERE membership.organization_id = ?
         AND membership.principal_id = ?
         AND membership.status = 'active'
         AND membership.role IN ('owner', 'admin')
         AND principal.kind = 'human'
         AND principal.status = 'active'
       LIMIT 1`,
    )
    .bind(identity.organizationId, identity.id)
    .first();
  return Boolean(row);
}

async function nextSupersessionLedger(
  organizationId: string,
  actorId: string,
  kind: "supersession.declared" | "supersession.retracted",
  supersession: ArtifactSupersession,
  occurredAt: string,
): Promise<LedgerEntry> {
  const [row] = await getDb()
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.organizationId, organizationId))
    .orderBy(desc(ledgerEntries.sequence))
    .limit(1);
  const previous = row ? toLedgerEntry(row) : undefined;
  const event: LedgerEvent = {
    id: crypto.randomUUID(),
    organizationId,
    kind,
    actorId,
    occurredAt,
    payloadHash: await hashCanonical(
      supersessionHashEnvelope(supersession),
    ),
    payloadRef: `nexus://artifact-supersession/${supersession.id}`,
  };
  return appendLedgerEntry(previous, event);
}

function prepareLedgerInsert(entry: LedgerEntry) {
  return getD1()
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, intent_id, run_id, previous_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .bind(
      entry.id,
      entry.organizationId,
      entry.sequence,
      entry.kind,
      entry.actorId,
      entry.occurredAt,
      entry.payloadHash,
      entry.payloadRef ?? null,
      entry.previousHash,
      entry.hash,
    );
}

function endpointFromHead(
  row: HeadRow,
  pinnedVersionNumber: number,
) {
  return {
    artifactId: row.id,
    title: row.title,
    projectId: row.project_id,
    projectName: row.project_name,
    projectStatus: row.project_status,
    pinnedVersionNumber,
    currentVersionNumber: row.current_version,
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    contentAvailable: row.content_available === 1,
    staleHead: row.current_version !== pinnedVersionNumber,
  };
}

function toSupersession(row: SupersessionRow): ArtifactSupersession {
  return {
    id: row.id,
    source: {
      artifactId: row.source_artifact_id,
      title: row.source_title,
      projectId: row.source_project_id,
      projectName: row.source_project_name,
      projectStatus: row.source_project_status,
      pinnedVersionNumber: row.source_version_number,
      currentVersionNumber: row.source_current_version,
      contentHash: row.source_content_hash,
      byteSize: row.source_byte_size,
      contentAvailable: row.source_content_available === 1,
      staleHead:
        row.source_current_version !== row.source_version_number,
    },
    target: {
      artifactId: row.target_artifact_id,
      title: row.target_title,
      projectId: row.target_project_id,
      projectName: row.target_project_name,
      projectStatus: row.target_project_status,
      pinnedVersionNumber: row.target_version_number,
      currentVersionNumber: row.target_current_version,
      contentHash: row.target_content_hash,
      byteSize: row.target_byte_size,
      contentAvailable: row.target_content_available === 1,
      staleHead:
        row.target_current_version !== row.target_version_number,
    },
    reasonCode: row.reason_code,
    status: row.status,
    declaredBy: {
      id: row.declared_by,
      displayName: row.declarer_name,
    },
    declaredAt: row.declared_at,
    ...(row.retraction_reason_code
      ? { retractionReasonCode: row.retraction_reason_code }
      : {}),
    ...(row.retracted_by && row.retractor_name
      ? {
          retractedBy: {
            id: row.retracted_by,
            displayName: row.retractor_name,
          },
        }
      : {}),
    ...(row.retracted_at ? { retractedAt: row.retracted_at } : {}),
  };
}

function toCandidate(row: CandidateRow): ArtifactSupersessionCandidate {
  return {
    artifactId: row.artifact_id,
    title: row.title,
    projectId: row.project_id,
    projectName: row.project_name,
    projectStatus: row.project_status,
    currentVersionNumber: row.current_version,
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    contentAvailable: row.content_available === 1,
  };
}

function validateShape(input: JsonRecord, allowed: Set<string>): void {
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new WorkspaceRepositoryError(
      "invalid_supersession_request",
      400,
    );
  }
}

function requiredId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128
  ) {
    throw new WorkspaceRepositoryError(code, 400);
  }
  return value;
}

function requiredVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new WorkspaceRepositoryError(
      "invalid_artifact_version",
      400,
    );
  }
  return Number(value);
}

function translateValidation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ArtifactSupersessionValidationError) {
      throw new WorkspaceRepositoryError(error.code, 400);
    }
    throw error;
  }
}

function translateStorageError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (
    /ledger_entries_org_sequence_uidx|UNIQUE constraint failed: ledger_entries\.organization_id, ledger_entries\.sequence/i.test(
      message,
    )
  ) {
    throw new WorkspaceRepositoryError("ledger_head_contention", 409);
  }
  if (/artifact_supersession_cycle/i.test(message)) {
    throw new WorkspaceRepositoryError(
      "supersession_cycle_rejected",
      409,
    );
  }
  if (/artifact_supersession_chain_too_long/i.test(message)) {
    throw new WorkspaceRepositoryError(
      "supersession_chain_too_long",
      409,
    );
  }
  if (/artifact_supersession_head_moved/i.test(message)) {
    throw new WorkspaceRepositoryError("supersession_head_moved", 409);
  }
  if (/artifact_supersession_target_unreadable/i.test(message)) {
    throw new WorkspaceRepositoryError(
      "supersession_target_unreadable",
      409,
    );
  }
  if (/artifact_supersession_actor_ineligible/i.test(message)) {
    throw new WorkspaceRepositoryError("workspace_owner_required", 403);
  }
  if (/artifact_supersession_exists/i.test(message)) {
    throw new WorkspaceRepositoryError("supersession_exists", 409);
  }
  if (
    /artifact_supersession_is_immutable|invalid_supersession_ledger_event|duplicate_supersession_ledger_event/i.test(
      message,
    )
  ) {
    throw new WorkspaceRepositoryError("supersession_conflict", 409);
  }
  if (
    /artifact_supersessions_active_source_uidx|UNIQUE constraint failed: artifact_supersessions\.organization_id, artifact_supersessions\.source_artifact_id/i.test(
      message,
    )
  ) {
    throw new WorkspaceRepositoryError("supersession_exists", 409);
  }
  if (/invalid_artifact_supersession/i.test(message)) {
    throw new WorkspaceRepositoryError(
      "invalid_artifact_supersession",
      422,
    );
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    throw new WorkspaceRepositoryError("artifact_not_found", 404);
  }
  throw error;
}

function assertBatchChanges(
  results: D1Result<unknown>[] | undefined,
): void {
  if (
    !results ||
    results.length !== 2 ||
    results.some((result) => Number(result.meta?.changes ?? 0) !== 1)
  ) {
    throw new WorkspaceRepositoryError("supersession_conflict", 409);
  }
}

function toLedgerEntry(
  row: typeof ledgerEntries.$inferSelect,
): LedgerEntry {
  return {
    id: row.id,
    organizationId: row.organizationId,
    sequence: row.sequence,
    kind: row.kind,
    actorId: row.actorId,
    occurredAt: row.occurredAt,
    payloadHash: row.payloadHash,
    ...(row.payloadRef ? { payloadRef: row.payloadRef } : {}),
    ...(row.intentId ? { intentId: row.intentId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    previousHash: row.previousHash,
    hash: row.hash,
  };
}

const SUPERSESSION_JOINS = `
  INNER JOIN artifacts source
    ON source.id = relation.source_artifact_id
   AND source.organization_id = relation.organization_id
  INNER JOIN projects source_project
    ON source_project.id = source.project_id
   AND source_project.organization_id = source.organization_id
  INNER JOIN artifact_versions source_version
    ON source_version.id = relation.source_version_id
   AND source_version.organization_id = relation.organization_id
  INNER JOIN artifact_payloads source_payload
    ON source_payload.id = source_version.content_ref
   AND source_payload.organization_id = relation.organization_id
  INNER JOIN artifacts target
    ON target.id = relation.target_artifact_id
   AND target.organization_id = relation.organization_id
  INNER JOIN projects target_project
    ON target_project.id = target.project_id
   AND target_project.organization_id = target.organization_id
  INNER JOIN artifact_versions target_version
    ON target_version.id = relation.target_version_id
   AND target_version.organization_id = relation.organization_id
  INNER JOIN artifact_payloads target_payload
    ON target_payload.id = target_version.content_ref
   AND target_payload.organization_id = relation.organization_id
  INNER JOIN principals declarer
    ON declarer.id = relation.declared_by
   AND declarer.organization_id = relation.organization_id
  LEFT JOIN principals retractor
    ON retractor.id = relation.retracted_by
   AND retractor.organization_id = relation.organization_id`;

const SUPERSESSION_COLUMNS = `
  relation.id, relation.source_artifact_id, relation.source_version_id,
  relation.source_version_number, relation.source_content_hash,
  relation.source_byte_size, source.title AS source_title,
  source.project_id AS source_project_id,
  source_project.name AS source_project_name,
  source_project.status AS source_project_status,
  source.current_version AS source_current_version,
  CASE WHEN source_payload.body_text IS NOT NULL
            AND source_payload.erased_at IS NULL
       THEN 1 ELSE 0 END AS source_content_available,
  relation.target_artifact_id, relation.target_version_id,
  relation.target_version_number, relation.target_content_hash,
  relation.target_byte_size, target.title AS target_title,
  target.project_id AS target_project_id,
  target_project.name AS target_project_name,
  target_project.status AS target_project_status,
  target.current_version AS target_current_version,
  CASE WHEN target_payload.body_text IS NOT NULL
            AND target_payload.erased_at IS NULL
       THEN 1 ELSE 0 END AS target_content_available,
  relation.reason_code, relation.status, relation.declared_by,
  declarer.display_name AS declarer_name, relation.declared_at,
  relation.retraction_reason_code, relation.retracted_by,
  retractor.display_name AS retractor_name, relation.retracted_at`;

const SUPERSESSION_SELECT = `
  SELECT ${SUPERSESSION_COLUMNS}
  FROM artifact_supersessions relation
  ${SUPERSESSION_JOINS}`;

const CHAIN_SELECT = `
  WITH RECURSIVE chain(relation_id, target_artifact_id, depth) AS (
    SELECT relation.id, relation.target_artifact_id, 1
    FROM artifact_supersessions relation
    WHERE relation.organization_id = ?
      AND relation.source_artifact_id = ?
      AND relation.status = 'active'
    UNION ALL
    SELECT relation.id, relation.target_artifact_id, chain.depth + 1
    FROM artifact_supersessions relation
    INNER JOIN chain
      ON relation.source_artifact_id = chain.target_artifact_id
    WHERE relation.organization_id = ?
      AND relation.status = 'active'
      AND chain.depth < 101
  )
  SELECT ${SUPERSESSION_COLUMNS}
  FROM chain
  INNER JOIN artifact_supersessions relation
    ON relation.id = chain.relation_id
  ${SUPERSESSION_JOINS}
  ORDER BY chain.depth
  LIMIT 101`;

const CANDIDATE_SELECT = `
  SELECT
    artifact.id AS artifact_id, artifact.title, artifact.project_id,
    project.name AS project_name, project.status AS project_status,
    artifact.current_version, version.content_hash, version.byte_size,
    CASE WHEN payload.body_text IS NOT NULL AND payload.erased_at IS NULL
         THEN 1 ELSE 0 END AS content_available
  FROM artifacts artifact
  INNER JOIN projects project
    ON project.id = artifact.project_id
   AND project.organization_id = artifact.organization_id
  INNER JOIN artifact_versions version
    ON version.artifact_id = artifact.id
   AND version.organization_id = artifact.organization_id
   AND version.version_number = artifact.current_version
  INNER JOIN artifact_payloads payload
    ON payload.id = version.content_ref
   AND payload.organization_id = version.organization_id
  WHERE artifact.organization_id = ? AND artifact.id != ?
  ORDER BY artifact.updated_at DESC, artifact.id
  LIMIT 101`;

type HeadRow = {
  id: string;
  title: string;
  project_id: string;
  project_name: string;
  project_status: "active" | "paused" | "archived";
  current_version: number;
  version_id: string;
  content_hash: string;
  byte_size: number;
  content_available: number;
};

type SupersessionRow = {
  id: string;
  source_artifact_id: string;
  source_version_id: string;
  source_version_number: number;
  source_content_hash: string;
  source_byte_size: number;
  source_title: string;
  source_project_id: string;
  source_project_name: string;
  source_project_status: "active" | "paused" | "archived";
  source_current_version: number;
  source_content_available: number;
  target_artifact_id: string;
  target_version_id: string;
  target_version_number: number;
  target_content_hash: string;
  target_byte_size: number;
  target_title: string;
  target_project_id: string;
  target_project_name: string;
  target_project_status: "active" | "paused" | "archived";
  target_current_version: number;
  target_content_available: number;
  reason_code: ArtifactSupersession["reasonCode"];
  status: ArtifactSupersession["status"];
  declared_by: string;
  declarer_name: string;
  declared_at: string;
  retraction_reason_code:
    | NonNullable<ArtifactSupersession["retractionReasonCode"]>
    | null;
  retracted_by: string | null;
  retractor_name: string | null;
  retracted_at: string | null;
};

type CandidateRow = {
  artifact_id: string;
  title: string;
  project_id: string;
  project_name: string;
  project_status: "active" | "paused" | "archived";
  current_version: number;
  content_hash: string;
  byte_size: number;
  content_available: number;
};
