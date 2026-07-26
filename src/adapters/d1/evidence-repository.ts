import { desc, eq } from "drizzle-orm";
import { getD1, getDb } from "@/db";
import { ledgerEntries } from "@/db/schema";
import type {
  IntentArtifactEvidence,
  IntentEvidenceCandidate,
  LedgerEntry,
  LedgerEvent,
} from "@/src/contracts/governance";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  appendLedgerEntry,
  evidenceHashEnvelope,
  EvidenceValidationError,
  hashCanonical,
  requireHumanEvidenceRelation,
} from "@/src/domain/governance";
import {
  requireWorkspaceContributor,
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "./workspace-repository";

type JsonRecord = Record<string, unknown>;

export type IntentEvidenceState = {
  intentId: string;
  intentStatus: string;
  frozen: boolean;
  evidence: IntentArtifactEvidence[];
  candidates: IntentEvidenceCandidate[];
  candidatesTruncated: boolean;
};

export async function listIntentEvidence(
  identity: RequestIdentity,
  intentId: string,
): Promise<IntentEvidenceState> {
  await requireWorkspaceMember(identity);
  const intent = await requireIntent(identity.organizationId, intentId);
  const [evidenceRows, candidateRows] = await Promise.all([
    getD1()
      .prepare(
        `${EVIDENCE_SELECT}
         WHERE evidence.organization_id = ? AND evidence.intent_id = ?
         ORDER BY evidence.created_at, evidence.id`,
      )
      .bind(identity.organizationId, intentId)
      .all<EvidenceRow>(),
    getD1()
      .prepare(
        `SELECT
           artifact.id AS artifact_id,
           version.id AS artifact_version_id,
           artifact.title AS artifact_title,
           version.version_number,
           artifact.work_item_id,
           work_item.ref AS work_item_ref,
           version.content_hash,
           version.byte_size,
           payload.erased_at
         FROM artifact_versions version
         INNER JOIN artifacts artifact
           ON artifact.id = version.artifact_id
          AND artifact.organization_id = version.organization_id
         INNER JOIN work_items work_item
           ON work_item.id = artifact.work_item_id
          AND work_item.organization_id = artifact.organization_id
         INNER JOIN artifact_payloads payload
           ON payload.id = version.content_ref
          AND payload.organization_id = version.organization_id
         WHERE version.organization_id = ?
           AND artifact.project_id = ?
         ORDER BY version.created_at DESC, version.id DESC
         LIMIT 101`,
      )
      .bind(identity.organizationId, intent.project_id)
      .all<CandidateRow>(),
  ]);
  return {
    intentId,
    intentStatus: intent.status,
    frozen: !["draft", "proposed"].includes(intent.status),
    evidence: evidenceRows.results.map(toEvidence),
    candidates: candidateRows.results.slice(0, 100).map(toCandidate),
    candidatesTruncated: candidateRows.results.length > 100,
  };
}

export async function attachIntentEvidence(
  identity: RequestIdentity,
  intentId: string,
  input: JsonRecord,
): Promise<IntentArtifactEvidence> {
  await requireWorkspaceContributor(identity);
  const relation = translateRelation(input.relation);
  const artifactVersionId = requiredId(
    input.artifactVersionId,
    "invalid_artifact_version_id",
  );
  const intent = await requireIntent(identity.organizationId, intentId);
  if (!["draft", "proposed"].includes(intent.status)) {
    throw new WorkspaceRepositoryError("evidence_set_frozen", 409);
  }
  const version = await getD1()
    .prepare(
      `SELECT
         artifact.id AS artifact_id,
         version.id AS artifact_version_id,
         artifact.title AS artifact_title,
         version.version_number,
         artifact.project_id,
         artifact.work_item_id,
         work_item.ref AS work_item_ref,
         version.content_hash,
         version.byte_size,
         creator.display_name AS actor_name,
         payload.erased_at AS payload_erased_at,
         CASE WHEN payload.body_text IS NULL THEN 0 ELSE 1 END
           AS payload_body_available
       FROM artifact_versions version
       INNER JOIN artifacts artifact
         ON artifact.id = version.artifact_id
        AND artifact.organization_id = version.organization_id
       INNER JOIN work_items work_item
         ON work_item.id = artifact.work_item_id
        AND work_item.organization_id = artifact.organization_id
       INNER JOIN principals creator
         ON creator.id = ?
        AND creator.organization_id = version.organization_id
        AND creator.status = 'active'
       INNER JOIN artifact_payloads payload
         ON payload.id = version.content_ref
        AND payload.organization_id = version.organization_id
       WHERE version.id = ? AND version.organization_id = ?
         AND artifact.project_id = ?
       LIMIT 1`,
    )
    .bind(
      identity.id,
      artifactVersionId,
      identity.organizationId,
      intent.project_id,
    )
    .first<AttachVersionRow>();
  if (!version) {
    throw new WorkspaceRepositoryError("artifact_version_not_found", 404);
  }
  if (version.payload_erased_at || version.payload_body_available !== 1) {
    throw new WorkspaceRepositoryError("artifact_payload_erased", 409);
  }
  const duplicate = await getD1()
    .prepare(
      `SELECT 1 FROM intent_artifact_evidence
       WHERE organization_id = ? AND intent_id = ?
         AND artifact_version_id = ? AND relation = ?
         AND status = 'active'
       LIMIT 1`,
    )
    .bind(
      identity.organizationId,
      intentId,
      artifactVersionId,
      relation,
    )
    .first();
  if (duplicate) {
    throw new WorkspaceRepositoryError("evidence_already_linked", 409);
  }
  const now = new Date().toISOString();
  const evidence: IntentArtifactEvidence = {
    id: crypto.randomUUID(),
    intentId,
    artifactId: version.artifact_id,
    artifactVersionId,
    artifactTitle: version.artifact_title,
    versionNumber: version.version_number,
    projectId: version.project_id,
    workItemId: version.work_item_id,
    workItemRef: version.work_item_ref,
    contentHash: version.content_hash,
    byteSize: version.byte_size,
    relation,
    status: "active",
    addedBy: { id: identity.id, displayName: version.actor_name },
    createdAt: now,
  };
  const ledger = await nextEvidenceLedgerEntry(
    identity.organizationId,
    identity.id,
    "evidence.linked",
    evidence,
    now,
  );
  let results;
  try {
    results = await getD1().batch([
      getD1()
        .prepare(
          `INSERT INTO intent_artifact_evidence (
            id, organization_id, intent_id, artifact_id,
            artifact_version_id, content_hash, byte_size, relation, status,
            added_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .bind(
          evidence.id,
          identity.organizationId,
          intentId,
          evidence.artifactId,
          evidence.artifactVersionId,
          evidence.contentHash,
          evidence.byteSize,
          evidence.relation,
          identity.id,
          now,
        ),
      prepareEvidenceLedgerInsert(ledger),
    ]);
  } catch (error) {
    translateEvidenceStorageError(error);
  }
  if (
    Number(results?.[0]?.meta?.changes ?? 0) !== 1 ||
    Number(results?.[1]?.meta?.changes ?? 0) !== 1
  ) {
    throw new WorkspaceRepositoryError("conflict_retry", 409);
  }
  return evidence;
}

export async function supersedeIntentEvidence(
  identity: RequestIdentity,
  intentId: string,
  evidenceId: string,
): Promise<IntentArtifactEvidence> {
  const role = await requireWorkspaceContributor(identity);
  const intent = await requireIntent(identity.organizationId, intentId);
  if (!["draft", "proposed"].includes(intent.status)) {
    throw new WorkspaceRepositoryError("evidence_set_frozen", 409);
  }
  const current = await loadEvidence(
    identity.organizationId,
    intentId,
    requiredId(evidenceId, "invalid_evidence_id"),
  );
  if (current.status !== "active") {
    throw new WorkspaceRepositoryError("evidence_already_superseded", 409);
  }
  if (
    current.addedBy.id !== identity.id &&
    role !== "owner" &&
    role !== "admin"
  ) {
    throw new WorkspaceRepositoryError(
      "evidence_supersession_forbidden",
      403,
    );
  }
  const actor = await requirePrincipal(
    identity.organizationId,
    identity.id,
  );
  const now = new Date().toISOString();
  const superseded: IntentArtifactEvidence = {
    ...current,
    status: "superseded",
    supersededBy: { id: identity.id, displayName: actor.display_name },
    supersededAt: now,
  };
  const ledger = await nextEvidenceLedgerEntry(
    identity.organizationId,
    identity.id,
    "evidence.superseded",
    superseded,
    now,
  );
  let results;
  try {
    results = await getD1().batch([
      getD1()
        .prepare(
          `UPDATE intent_artifact_evidence
           SET status = 'superseded', superseded_by = ?,
               superseded_at = ?
           WHERE id = ? AND organization_id = ? AND intent_id = ?
             AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM action_intents
               WHERE id = ? AND organization_id = ?
                 AND status IN ('draft', 'proposed')
             )`,
        )
        .bind(
          identity.id,
          now,
          evidenceId,
          identity.organizationId,
          intentId,
          intentId,
          identity.organizationId,
        ),
      prepareEvidenceLedgerInsert(ledger),
    ]);
  } catch (error) {
    translateEvidenceStorageError(error);
  }
  if (
    Number(results?.[0]?.meta?.changes ?? 0) !== 1 ||
    Number(results?.[1]?.meta?.changes ?? 0) !== 1
  ) {
    throw new WorkspaceRepositoryError("conflict_retry", 409);
  }
  return superseded;
}

async function loadEvidence(
  organizationId: string,
  intentId: string,
  evidenceId: string,
): Promise<IntentArtifactEvidence> {
  const row = await getD1()
    .prepare(
      `${EVIDENCE_SELECT}
       WHERE evidence.organization_id = ? AND evidence.intent_id = ?
         AND evidence.id = ?
       LIMIT 1`,
    )
    .bind(organizationId, intentId, evidenceId)
    .first<EvidenceRow>();
  if (!row) {
    throw new WorkspaceRepositoryError("evidence_not_found", 404);
  }
  return toEvidence(row);
}

async function requireIntent(
  organizationId: string,
  intentId: string,
): Promise<{ project_id: string; status: string }> {
  const intent = await getD1()
    .prepare(
      `SELECT project_id, status
       FROM action_intents
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind(intentId, organizationId)
    .first<{ project_id: string; status: string }>();
  if (!intent) {
    throw new WorkspaceRepositoryError("intent_not_found", 404);
  }
  return intent;
}

async function requirePrincipal(
  organizationId: string,
  principalId: string,
): Promise<{ display_name: string }> {
  const principal = await getD1()
    .prepare(
      `SELECT display_name FROM principals
       WHERE id = ? AND organization_id = ? AND status = 'active'
       LIMIT 1`,
    )
    .bind(principalId, organizationId)
    .first<{ display_name: string }>();
  if (!principal) {
    throw new WorkspaceRepositoryError("workspace_membership_required", 403);
  }
  return principal;
}

async function nextEvidenceLedgerEntry(
  organizationId: string,
  actorId: string,
  kind: "evidence.linked" | "evidence.superseded",
  evidence: IntentArtifactEvidence,
  occurredAt: string,
): Promise<LedgerEntry> {
  const [row] = await getDb()
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.organizationId, organizationId))
    .orderBy(desc(ledgerEntries.sequence))
    .limit(1);
  const event: LedgerEvent = {
    id: crypto.randomUUID(),
    organizationId,
    kind,
    actorId,
    occurredAt,
    payloadHash: await hashCanonical(evidenceHashEnvelope(evidence)),
    payloadRef: `nexus://intent-evidence/${evidence.id}`,
    intentId: evidence.intentId,
  };
  return appendLedgerEntry(row ? toLedgerEntry(row) : undefined, event);
}

function prepareEvidenceLedgerInsert(entry: LedgerEntry) {
  return getD1()
    .prepare(
      `INSERT INTO ledger_entries (
         id, organization_id, sequence, kind, actor_id, occurred_at,
         payload_hash, payload_ref, intent_id, run_id, previous_hash, hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      entry.intentId ?? null,
      null,
      entry.previousHash,
      entry.hash,
    );
}

function translateRelation(value: unknown): "basis" {
  try {
    return requireHumanEvidenceRelation(value);
  } catch (error) {
    if (error instanceof EvidenceValidationError) {
      throw new WorkspaceRepositoryError(error.code, 400);
    }
    throw error;
  }
}

function requiredId(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new WorkspaceRepositoryError(code, 400);
  }
  return value;
}

function translateEvidenceStorageError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (
    /UNIQUE constraint failed: intent_artifact_evidence\.intent_id/i.test(
      message,
    )
  ) {
    throw new WorkspaceRepositoryError("evidence_already_linked", 409);
  }
  if (/evidence_set_frozen|evidence_phase_invalid/i.test(message)) {
    throw new WorkspaceRepositoryError("evidence_set_frozen", 409);
  }
  if (/evidence_principal_inactive/i.test(message)) {
    throw new WorkspaceRepositoryError("workspace_contributor_required", 403);
  }
  if (/invalid_evidence_reference|invalid_evidence_metadata/i.test(message)) {
    throw new WorkspaceRepositoryError("invalid_evidence_reference", 422);
  }
  if (/evidence_is_immutable/i.test(message)) {
    throw new WorkspaceRepositoryError("evidence_is_immutable", 409);
  }
  if (
    /invalid_evidence_ledger_event|duplicate_evidence_ledger_event/i.test(
      message,
    )
  ) {
    throw new WorkspaceRepositoryError("conflict_retry", 409);
  }
  if (/UNIQUE constraint failed/i.test(message)) {
    throw new WorkspaceRepositoryError("conflict_retry", 409);
  }
  throw error;
}

function toEvidence(row: EvidenceRow): IntentArtifactEvidence {
  return {
    id: row.id,
    intentId: row.intent_id,
    artifactId: row.artifact_id,
    artifactVersionId: row.artifact_version_id,
    artifactTitle: row.artifact_title,
    versionNumber: row.version_number,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    workItemRef: row.work_item_ref,
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    relation: row.relation,
    status: row.status,
    addedBy: { id: row.added_by, displayName: row.added_by_name },
    createdAt: row.created_at,
    ...(row.superseded_by && row.superseded_by_name
      ? {
          supersededBy: {
            id: row.superseded_by,
            displayName: row.superseded_by_name,
          },
        }
      : {}),
    ...(row.superseded_at ? { supersededAt: row.superseded_at } : {}),
    ...(row.erased_at ? { erasedAt: row.erased_at } : {}),
  };
}

function toCandidate(row: CandidateRow): IntentEvidenceCandidate {
  return {
    artifactId: row.artifact_id,
    artifactVersionId: row.artifact_version_id,
    artifactTitle: row.artifact_title,
    versionNumber: row.version_number,
    workItemId: row.work_item_id,
    workItemRef: row.work_item_ref,
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    ...(row.erased_at ? { erasedAt: row.erased_at } : {}),
  };
}

function toLedgerEntry(row: typeof ledgerEntries.$inferSelect): LedgerEntry {
  return {
    id: row.id,
    organizationId: row.organizationId,
    sequence: row.sequence,
    kind: row.kind,
    actorId: row.actorId,
    occurredAt: row.occurredAt,
    payloadHash: row.payloadHash,
    ...(row.payloadRef !== null ? { payloadRef: row.payloadRef } : {}),
    ...(row.intentId !== null ? { intentId: row.intentId } : {}),
    ...(row.runId !== null ? { runId: row.runId } : {}),
    previousHash: row.previousHash,
    hash: row.hash,
  };
}

const EVIDENCE_SELECT = `
  SELECT
    evidence.id, evidence.intent_id, evidence.artifact_id,
    evidence.artifact_version_id, artifact.title AS artifact_title,
    version.version_number, artifact.project_id, artifact.work_item_id,
    work_item.ref AS work_item_ref, evidence.content_hash,
    evidence.byte_size, evidence.relation, evidence.status,
    evidence.added_by, added_by.display_name AS added_by_name,
    evidence.created_at, evidence.superseded_by,
    superseded_by.display_name AS superseded_by_name,
    evidence.superseded_at, payload.erased_at
  FROM intent_artifact_evidence evidence
  INNER JOIN artifact_versions version
    ON version.id = evidence.artifact_version_id
   AND version.organization_id = evidence.organization_id
  INNER JOIN artifacts artifact
    ON artifact.id = evidence.artifact_id
   AND artifact.id = version.artifact_id
   AND artifact.organization_id = evidence.organization_id
  INNER JOIN work_items work_item
    ON work_item.id = artifact.work_item_id
   AND work_item.organization_id = evidence.organization_id
  INNER JOIN artifact_payloads payload
    ON payload.id = version.content_ref
   AND payload.organization_id = evidence.organization_id
  INNER JOIN principals added_by
    ON added_by.id = evidence.added_by
   AND added_by.organization_id = evidence.organization_id
  LEFT JOIN principals superseded_by
    ON superseded_by.id = evidence.superseded_by
   AND superseded_by.organization_id = evidence.organization_id`;

type EvidenceRow = {
  id: string;
  intent_id: string;
  artifact_id: string;
  artifact_version_id: string;
  artifact_title: string;
  version_number: number;
  project_id: string;
  work_item_id: string;
  work_item_ref: string;
  content_hash: string;
  byte_size: number;
  relation: IntentArtifactEvidence["relation"];
  status: IntentArtifactEvidence["status"];
  added_by: string;
  added_by_name: string;
  created_at: string;
  superseded_by: string | null;
  superseded_by_name: string | null;
  superseded_at: string | null;
  erased_at: string | null;
};

type CandidateRow = {
  artifact_id: string;
  artifact_version_id: string;
  artifact_title: string;
  version_number: number;
  work_item_id: string;
  work_item_ref: string;
  content_hash: string;
  byte_size: number;
  erased_at: string | null;
};

type AttachVersionRow = CandidateRow & {
  project_id: string;
  actor_name: string;
  payload_erased_at: string | null;
  payload_body_available: number;
};
