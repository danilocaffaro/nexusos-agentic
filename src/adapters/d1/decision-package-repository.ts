import { getD1 } from "@/db";
import {
  MAX_DECISION_PACKAGE_BODY_BYTES,
  MAX_DECISION_PACKAGE_EVIDENCE,
  MAX_DECISION_PACKAGE_LEDGER_ENTRIES,
  MAX_DECISION_PACKAGE_REVIEWS_PER_VERSION,
  MAX_DECISION_PACKAGE_SUPERSESSIONS,
  type DecisionPackageApproval,
  type DecisionPackageEvidence,
  type DecisionPackageIntent,
  type DecisionPackageSnapshot,
  type RenderedDecisionPackage,
} from "@/src/contracts/decision-package";
import type {
  ArtifactReview,
  ArtifactSupersession,
} from "@/src/contracts/artifacts";
import type {
  IntentPrecondition,
  LedgerEntry,
  PolicyDecision,
} from "@/src/contracts/governance";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  DecisionPackageValidationError,
  renderDecisionPackage,
} from "@/src/domain/artifacts";
import {
  requireWorkspaceOwner,
} from "./workspace-repository";

export async function getRenderedDecisionPackage(
  identity: RequestIdentity,
  intentId: string,
): Promise<RenderedDecisionPackage> {
  await requireWorkspaceOwner(identity);
  if (!intentId || intentId.length > 128) {
    throw new DecisionPackageRepositoryError("invalid_intent_id", 400);
  }
  const d1 = getD1();
  const results = await d1.batch([
    d1.prepare(INTENT_QUERY).bind(identity.organizationId, intentId),
    d1.prepare(APPROVAL_QUERY).bind(identity.organizationId, intentId),
    d1.prepare(EVIDENCE_QUERY).bind(identity.organizationId, intentId),
    d1
      .prepare(REVIEW_QUERY)
      .bind(identity.organizationId, intentId, identity.organizationId),
    d1.prepare(SUPERSESSION_QUERY).bind(
      identity.organizationId,
      intentId,
      identity.organizationId,
    ),
    d1.prepare(LEDGER_QUERY).bind(
      identity.organizationId,
      intentId,
      identity.organizationId,
      identity.organizationId,
      identity.organizationId,
      intentId,
    ),
  ]);
  const intentRow = firstRow<IntentRow>(results[0]);
  if (!intentRow) {
    throw new DecisionPackageRepositoryError("intent_not_found", 404);
  }
  const evidenceRows = resultRows<EvidenceRow>(results[2]);
  const totalEvidence = evidenceRows[0]?.total_evidence ?? 0;
  if (
    totalEvidence > MAX_DECISION_PACKAGE_EVIDENCE ||
    evidenceRows.length > MAX_DECISION_PACKAGE_EVIDENCE
  ) {
    throw new DecisionPackageRepositoryError(
      "package_bounds_exceeded",
      422,
    );
  }
  const approvalRows = resultRows<ApprovalRow>(results[1]);
  const reviewRows = resultRows<ReviewRow>(results[3]);
  const supersessionRows = resultRows<SupersessionRow>(results[4]);
  const ledgerRows = resultRows<PackageLedgerRow>(results[5]);
  const approvals = approvalRows.map(toApproval);
  const evidence = evidenceRows.map((row) =>
    toEvidence(row, reviewRows, supersessionRows),
  );
  const snapshot: DecisionPackageSnapshot = {
    intent: toIntent(intentRow, approvals),
    approvals,
    evidence,
    supersessionsTotal: supersessionRows[0]?.total_supersessions ?? 0,
    supersessionsTruncated:
      (supersessionRows[0]?.total_supersessions ?? 0) >
      MAX_DECISION_PACKAGE_SUPERSESSIONS,
    ledger: ledgerRows.map(toLedgerEntry),
    ledgerTotal: ledgerRows[0]?.total_matching ?? 0,
    ledgerTruncated:
      (ledgerRows[0]?.total_matching ?? 0) >
      MAX_DECISION_PACKAGE_LEDGER_ENTRIES,
  };
  try {
    return await renderDecisionPackage(snapshot);
  } catch (error) {
    if (error instanceof DecisionPackageValidationError) {
      throw new DecisionPackageRepositoryError(
        error.code,
        error.code === "decision_not_reached"
          ? 409
          : error.code === "package_bounds_exceeded" ||
              error.code === "decision_package_graph_inconsistent"
            ? 422
            : 500,
      );
    }
    throw error;
  }
}

function toIntent(
  row: IntentRow,
  approvals: DecisionPackageApproval[],
): DecisionPackageIntent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    projectId: row.project_id,
    projectName: row.project_name,
    proposerId: row.proposer_id,
    proposerKind: row.proposer_kind,
    proposerDisplayName: row.proposer_name,
    actionType: row.action_type,
    targetRef: row.target_ref,
    parameters: parseRecord(row.parameters_json),
    parametersHash: row.parameters_hash,
    preconditions: parseArray<IntentPrecondition>(row.preconditions_json),
    riskTier: row.risk_tier,
    policyDecision: parseObject<PolicyDecision>(row.policy_decision_json),
    requiredApprovals: row.required_approvals,
    separationOfDuties: row.separation_of_duties === 1,
    ...(row.self_approval_policy
      ? { selfApprovalPolicy: row.self_approval_policy }
      : {}),
    approvals,
    expiresAt: row.expires_at,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    ...(row.supersedes_intent_id
      ? { supersedesIntentId: row.supersedes_intent_id }
      : {}),
    ...(row.fencing_token !== null
      ? { fencingToken: row.fencing_token }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toApproval(row: ApprovalRow): DecisionPackageApproval {
  return {
    actorId: row.actor_id,
    actorDisplayName: row.actor_name,
    actorKind: row.actor_kind,
    parametersHash: row.parameters_hash,
    soloOwnerAcknowledged: row.solo_owner_acknowledged === 1,
    approvedAt: row.approved_at,
  };
}

function toEvidence(
  row: EvidenceRow,
  reviews: ReviewRow[],
  supersessions: SupersessionRow[],
): DecisionPackageEvidence {
  const matchingReviews = reviews.filter(
    (review) =>
      review.artifact_version_id === row.artifact_version_id &&
      review.review_rank <= MAX_DECISION_PACKAGE_REVIEWS_PER_VERSION,
  );
  const matchingSupersessions = supersessions
    .filter(
      (relation) =>
        relation.source_artifact_id === row.artifact_id &&
      relation.supersession_rank <= MAX_DECISION_PACKAGE_SUPERSESSIONS,
    )
    .map(toSupersession);
  return {
    id: row.id,
    intentId: row.intent_id,
    artifactId: row.artifact_id,
    artifactVersionId: row.artifact_version_id,
    artifactTitle: row.artifact_title,
    versionNumber: row.version_number,
    projectId: row.project_id,
    projectName: row.project_name,
    workItemId: row.work_item_id,
    workItemRef: row.work_item_ref,
    workItemTitle: row.work_item_title,
    contentHash: row.evidence_content_hash,
    byteSize: row.evidence_byte_size,
    versionContentHash: row.version_content_hash,
    versionByteSize: row.version_byte_size,
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
    artifactVersionNote: row.version_note,
    producer: { id: row.producer_id, displayName: row.producer_name },
    versionCreatedAt: row.version_created_at,
    content: row.selected_content,
    contentSelected: row.content_selected === 1,
    ...(row.payload_erased_at
      ? { payloadErasedAt: row.payload_erased_at }
      : {}),
    actualBodyBytes: row.actual_body_bytes,
    reviews: matchingReviews.map(toReview),
    reviewsTotal: matchingReviews[0]?.total_reviews ?? 0,
    reviewsTruncated:
      (matchingReviews[0]?.total_reviews ?? 0) >
      MAX_DECISION_PACKAGE_REVIEWS_PER_VERSION,
    supersessions: matchingSupersessions,
  };
}

function toReview(row: ReviewRow): ArtifactReview {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    artifactVersionId: row.artifact_version_id,
    versionNumber: row.version_number,
    contentHash: row.content_hash,
    byteSize: row.byte_size,
    verdict: row.verdict,
    reasonCode: row.reason_code,
    reviewer: { id: row.reviewer_id, displayName: row.reviewer_name },
    ...(row.self_review_policy
      ? { selfReviewPolicy: row.self_review_policy }
      : {}),
    status: row.status,
    ...(row.supersedes_review_id
      ? { supersedesReviewId: row.supersedes_review_id }
      : {}),
    ...(row.superseded_by && row.superseded_by_name
      ? {
          supersededBy: {
            id: row.superseded_by,
            displayName: row.superseded_by_name,
          },
        }
      : {}),
    createdAt: row.created_at,
    ...(row.superseded_at ? { supersededAt: row.superseded_at } : {}),
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
      staleHead: row.source_current_version !== row.source_version_number,
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
      staleHead: row.target_current_version !== row.target_version_number,
    },
    reasonCode: row.reason_code,
    status: row.status,
    declaredBy: { id: row.declared_by, displayName: row.declarer_name },
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

function toLedgerEntry(
  row: PackageLedgerRow,
): Omit<
  DecisionPackageSnapshot["ledger"][number],
  never
> {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sequence: row.sequence,
    kind: row.kind,
    actorId: row.actor_id,
    actorDisplayName: row.actor_name,
    occurredAt: row.occurred_at,
    payloadHash: row.payload_hash,
    ...(row.payload_ref ? { payloadRef: row.payload_ref } : {}),
    ...(row.intent_id ? { intentId: row.intent_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    previousHash: row.previous_hash,
    hash: row.hash,
  };
}

function resultRows<T>(result: D1Result<unknown> | undefined): T[] {
  return (result?.results ?? []) as T[];
}

function firstRow<T>(result: D1Result<unknown> | undefined): T | undefined {
  return resultRows<T>(result)[0];
}

function parseRecord(value: string): Record<string, unknown> {
  return parseObject<Record<string, unknown>>(value);
}

function parseObject<T>(value: string): T {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new DecisionPackageRepositoryError(
      "decision_package_graph_inconsistent",
      500,
    );
  }
  return parsed as T;
}

function parseArray<T>(value: string): T[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new DecisionPackageRepositoryError(
      "decision_package_graph_inconsistent",
      500,
    );
  }
  return parsed as T[];
}

export class DecisionPackageRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "DecisionPackageRepositoryError";
  }
}

const INTENT_QUERY = `
  SELECT
    intent.*, organization.name AS organization_name,
    project.name AS project_name, proposer.display_name AS proposer_name
  FROM action_intents intent
  INNER JOIN organizations organization
    ON organization.id = intent.organization_id
  INNER JOIN projects project
    ON project.id = intent.project_id
   AND project.organization_id = intent.organization_id
  INNER JOIN principals proposer
    ON proposer.id = intent.proposer_id
   AND proposer.organization_id = intent.organization_id
  WHERE intent.organization_id = ? AND intent.id = ?
  LIMIT 1`;

const APPROVAL_QUERY = `
  SELECT
    approval.actor_id, actor.display_name AS actor_name,
    approval.actor_kind, approval.parameters_hash,
    approval.solo_owner_acknowledged, approval.approved_at
  FROM intent_approvals approval
  INNER JOIN action_intents intent
    ON intent.id = approval.intent_id
  INNER JOIN principals actor
    ON actor.id = approval.actor_id
   AND actor.organization_id = intent.organization_id
  WHERE intent.organization_id = ? AND intent.id = ?
  ORDER BY approval.approved_at, approval.actor_id`;

const EVIDENCE_QUERY = `
  WITH scoped AS (
    SELECT
      evidence.id, evidence.intent_id, evidence.artifact_id,
      evidence.artifact_version_id, evidence.content_hash
        AS evidence_content_hash,
      evidence.byte_size AS evidence_byte_size, evidence.relation,
      evidence.status, evidence.added_by,
      added.display_name AS added_by_name, evidence.created_at,
      evidence.superseded_by,
      superseder.display_name AS superseded_by_name,
      evidence.superseded_at, artifact.title AS artifact_title,
      artifact.project_id, project.name AS project_name,
      artifact.work_item_id, work_item.ref AS work_item_ref,
      work_item.title AS work_item_title,
      version.version_number, version.content_hash AS version_content_hash,
      version.byte_size AS version_byte_size, version.note AS version_note,
      version.created_by AS producer_id,
      producer.display_name AS producer_name,
      version.created_at AS version_created_at,
      payload.body_text, payload.erased_at AS payload_erased_at,
      CASE WHEN payload.body_text IS NULL THEN 0
           ELSE length(CAST(payload.body_text AS BLOB)) END
        AS actual_body_bytes,
      COUNT(*) OVER () AS total_evidence,
      SUM(
        CASE WHEN evidence.relation = 'basis'
                   AND evidence.status = 'active'
                   AND payload.body_text IS NOT NULL
                   AND payload.erased_at IS NULL
             THEN length(CAST(payload.body_text AS BLOB))
             ELSE 0 END
      ) OVER (
        ORDER BY
          CASE evidence.relation WHEN 'basis' THEN 0 ELSE 1 END,
          CASE evidence.status WHEN 'active' THEN 0 ELSE 1 END,
          evidence.created_at, evidence.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS running_body_bytes
    FROM intent_artifact_evidence evidence
    INNER JOIN action_intents intent
      ON intent.id = evidence.intent_id
     AND intent.organization_id = evidence.organization_id
    INNER JOIN artifacts artifact
      ON artifact.id = evidence.artifact_id
     AND artifact.organization_id = evidence.organization_id
    INNER JOIN projects project
      ON project.id = artifact.project_id
     AND project.organization_id = evidence.organization_id
    INNER JOIN work_items work_item
      ON work_item.id = artifact.work_item_id
     AND work_item.organization_id = evidence.organization_id
    INNER JOIN artifact_versions version
      ON version.id = evidence.artifact_version_id
     AND version.organization_id = evidence.organization_id
     AND version.artifact_id = evidence.artifact_id
    INNER JOIN artifact_payloads payload
      ON payload.id = version.content_ref
     AND payload.organization_id = evidence.organization_id
    INNER JOIN principals producer
      ON producer.id = version.created_by
     AND producer.organization_id = evidence.organization_id
    INNER JOIN principals added
      ON added.id = evidence.added_by
     AND added.organization_id = evidence.organization_id
    LEFT JOIN principals superseder
      ON superseder.id = evidence.superseded_by
     AND superseder.organization_id = evidence.organization_id
    WHERE evidence.organization_id = ? AND evidence.intent_id = ?
  )
  SELECT
    id, intent_id, artifact_id, artifact_version_id,
    evidence_content_hash, evidence_byte_size, relation, status,
    added_by, added_by_name, created_at, superseded_by,
    superseded_by_name, superseded_at, artifact_title, project_id,
    project_name, work_item_id, work_item_ref, work_item_title,
    version_number, version_content_hash, version_byte_size, version_note,
    producer_id, producer_name, version_created_at, payload_erased_at,
    actual_body_bytes, total_evidence,
    CASE WHEN total_evidence <= ${MAX_DECISION_PACKAGE_EVIDENCE}
               AND relation = 'basis' AND status = 'active'
               AND body_text IS NOT NULL
               AND payload_erased_at IS NULL
               AND running_body_bytes <= ${MAX_DECISION_PACKAGE_BODY_BYTES}
         THEN body_text ELSE NULL END AS selected_content,
    CASE WHEN total_evidence <= ${MAX_DECISION_PACKAGE_EVIDENCE}
               AND relation = 'basis' AND status = 'active'
               AND body_text IS NOT NULL
               AND payload_erased_at IS NULL
               AND running_body_bytes <= ${MAX_DECISION_PACKAGE_BODY_BYTES}
         THEN 1 ELSE 0 END AS content_selected
  FROM scoped
  ORDER BY
    CASE relation WHEN 'basis' THEN 0 ELSE 1 END,
    CASE status WHEN 'active' THEN 0 ELSE 1 END,
    created_at, id
  LIMIT ${MAX_DECISION_PACKAGE_EVIDENCE + 1}`;

const REVIEW_QUERY = `
  WITH evidence_versions AS (
    SELECT DISTINCT evidence.artifact_version_id
    FROM intent_artifact_evidence evidence
    WHERE evidence.organization_id = ? AND evidence.intent_id = ?
  ),
  ranked AS (
    SELECT
      review.*, reviewer.display_name AS reviewer_name,
      superseder.display_name AS superseded_by_name,
      ROW_NUMBER() OVER (
        PARTITION BY review.artifact_version_id
        ORDER BY review.created_at DESC, review.id DESC
      ) AS review_rank,
      COUNT(*) OVER (
        PARTITION BY review.artifact_version_id
      ) AS total_reviews
    FROM artifact_reviews review
    INNER JOIN evidence_versions selected
      ON selected.artifact_version_id = review.artifact_version_id
    INNER JOIN principals reviewer
      ON reviewer.id = review.reviewer_id
     AND reviewer.organization_id = review.organization_id
    LEFT JOIN principals superseder
      ON superseder.id = review.superseded_by
     AND superseder.organization_id = review.organization_id
    WHERE review.organization_id = ?
  )
  SELECT * FROM ranked
  WHERE review_rank <= ${MAX_DECISION_PACKAGE_REVIEWS_PER_VERSION + 1}
  ORDER BY artifact_version_id, created_at DESC, id DESC`;

const SUPERSESSION_QUERY = `
  WITH evidence_artifacts AS (
    SELECT DISTINCT evidence.artifact_id
    FROM intent_artifact_evidence evidence
    WHERE evidence.organization_id = ? AND evidence.intent_id = ?
  ),
  ranked AS (
    SELECT
      relation.*, source.title AS source_title,
      source.project_id AS source_project_id,
      source_project.name AS source_project_name,
      source_project.status AS source_project_status,
      source.current_version AS source_current_version,
      CASE WHEN source_payload.body_text IS NOT NULL
                 AND source_payload.erased_at IS NULL
           THEN 1 ELSE 0 END AS source_content_available,
      target.title AS target_title,
      target.project_id AS target_project_id,
      target_project.name AS target_project_name,
      target_project.status AS target_project_status,
      target.current_version AS target_current_version,
      CASE WHEN target_payload.body_text IS NOT NULL
                 AND target_payload.erased_at IS NULL
           THEN 1 ELSE 0 END AS target_content_available,
      declarer.display_name AS declarer_name,
      retractor.display_name AS retractor_name,
      ROW_NUMBER() OVER (
        ORDER BY relation.declared_at DESC, relation.id DESC
      ) AS supersession_rank,
      COUNT(*) OVER () AS total_supersessions
    FROM artifact_supersessions relation
    INNER JOIN evidence_artifacts selected
      ON selected.artifact_id = relation.source_artifact_id
    INNER JOIN artifacts source
      ON source.id = relation.source_artifact_id
     AND source.organization_id = relation.organization_id
    INNER JOIN projects source_project
      ON source_project.id = source.project_id
     AND source_project.organization_id = relation.organization_id
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
     AND target_project.organization_id = relation.organization_id
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
     AND retractor.organization_id = relation.organization_id
    WHERE relation.organization_id = ?
  )
  SELECT * FROM ranked
  WHERE supersession_rank <= ${MAX_DECISION_PACKAGE_SUPERSESSIONS + 1}
  ORDER BY declared_at DESC, id DESC`;

const LEDGER_QUERY = `
  WITH evidence_rows AS (
    SELECT evidence.id, evidence.artifact_id,
           evidence.artifact_version_id
    FROM intent_artifact_evidence evidence
    WHERE evidence.organization_id = ? AND evidence.intent_id = ?
  ),
  evidence_versions AS (
    SELECT DISTINCT artifact_version_id FROM evidence_rows
  ),
  evidence_artifacts AS (
    SELECT DISTINCT artifact_id FROM evidence_rows
  ),
  ranked_reviews AS (
    SELECT review.id,
      ROW_NUMBER() OVER (
        PARTITION BY review.artifact_version_id
        ORDER BY review.created_at DESC, review.id DESC
      ) AS review_rank
    FROM artifact_reviews review
    INNER JOIN evidence_versions evidence
      ON evidence.artifact_version_id = review.artifact_version_id
    WHERE review.organization_id = ?
  ),
  included_reviews AS (
    SELECT id FROM ranked_reviews
    WHERE review_rank <= ${MAX_DECISION_PACKAGE_REVIEWS_PER_VERSION}
  ),
  ranked_supersessions AS (
    SELECT relation.id,
      ROW_NUMBER() OVER (
        ORDER BY relation.declared_at DESC, relation.id DESC
      ) AS supersession_rank
    FROM artifact_supersessions relation
    INNER JOIN evidence_artifacts evidence
      ON evidence.artifact_id = relation.source_artifact_id
    WHERE relation.organization_id = ?
  ),
  included_supersessions AS (
    SELECT id FROM ranked_supersessions
    WHERE supersession_rank <= ${MAX_DECISION_PACKAGE_SUPERSESSIONS}
  ),
  matching AS (
    SELECT ledger.*, actor.display_name AS actor_name
    FROM ledger_entries ledger
    INNER JOIN principals actor
      ON actor.id = ledger.actor_id
     AND actor.organization_id = ledger.organization_id
    WHERE ledger.organization_id = ?
      AND (
        ledger.intent_id = ?
        OR ledger.payload_ref IN (
          SELECT 'nexus://intent-evidence/' || id FROM evidence_rows
        )
        OR ledger.payload_ref IN (
          SELECT 'nexus://artifact-review/' || id FROM included_reviews
        )
        OR ledger.payload_ref IN (
          SELECT 'nexus://artifact-supersession/' || id
          FROM included_supersessions
        )
      )
  ),
  ranked_ledger AS (
    SELECT matching.*,
      COUNT(*) OVER () AS total_matching,
      ROW_NUMBER() OVER (ORDER BY sequence DESC) AS ledger_rank
    FROM matching
  )
  SELECT * FROM ranked_ledger
  WHERE ledger_rank <= ${MAX_DECISION_PACKAGE_LEDGER_ENTRIES}
  ORDER BY sequence`;

type IntentRow = {
  id: string;
  organization_id: string;
  organization_name: string;
  project_id: string;
  project_name: string;
  proposer_id: string;
  proposer_kind: DecisionPackageIntent["proposerKind"];
  proposer_name: string;
  action_type: string;
  target_ref: string;
  parameters_json: string;
  parameters_hash: string;
  preconditions_json: string;
  risk_tier: DecisionPackageIntent["riskTier"];
  policy_decision_json: string;
  required_approvals: number;
  separation_of_duties: number;
  self_approval_policy: DecisionPackageIntent["selfApprovalPolicy"] | null;
  expires_at: string;
  idempotency_key: string;
  status: DecisionPackageIntent["status"];
  supersedes_intent_id: string | null;
  fencing_token: number | null;
  created_at: string;
  updated_at: string;
};

type ApprovalRow = {
  actor_id: string;
  actor_name: string;
  actor_kind: DecisionPackageApproval["actorKind"];
  parameters_hash: string;
  solo_owner_acknowledged: number;
  approved_at: string;
};

type EvidenceRow = {
  id: string;
  intent_id: string;
  artifact_id: string;
  artifact_version_id: string;
  evidence_content_hash: string;
  evidence_byte_size: number;
  relation: DecisionPackageEvidence["relation"];
  status: DecisionPackageEvidence["status"];
  added_by: string;
  added_by_name: string;
  created_at: string;
  superseded_by: string | null;
  superseded_by_name: string | null;
  superseded_at: string | null;
  artifact_title: string;
  project_id: string;
  project_name: string;
  work_item_id: string;
  work_item_ref: string;
  work_item_title: string;
  version_number: number;
  version_content_hash: string;
  version_byte_size: number;
  version_note: string;
  producer_id: string;
  producer_name: string;
  version_created_at: string;
  payload_erased_at: string | null;
  actual_body_bytes: number;
  total_evidence: number;
  selected_content: string | null;
  content_selected: number;
};

type ReviewRow = {
  id: string;
  artifact_id: string;
  artifact_version_id: string;
  version_number: number;
  content_hash: string;
  byte_size: number;
  verdict: ArtifactReview["verdict"];
  reason_code: ArtifactReview["reasonCode"];
  reviewer_id: string;
  reviewer_name: string;
  self_review_policy: ArtifactReview["selfReviewPolicy"] | null;
  status: ArtifactReview["status"];
  supersedes_review_id: string | null;
  superseded_by: string | null;
  superseded_by_name: string | null;
  created_at: string;
  superseded_at: string | null;
  review_rank: number;
  total_reviews: number;
};

type SupersessionRow = {
  id: string;
  source_artifact_id: string;
  source_version_number: number;
  source_content_hash: string;
  source_byte_size: number;
  source_title: string;
  source_project_id: string;
  source_project_name: string;
  source_project_status: ArtifactSupersession["source"]["projectStatus"];
  source_current_version: number;
  source_content_available: number;
  target_artifact_id: string;
  target_version_number: number;
  target_content_hash: string;
  target_byte_size: number;
  target_title: string;
  target_project_id: string;
  target_project_name: string;
  target_project_status: ArtifactSupersession["target"]["projectStatus"];
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
  supersession_rank: number;
  total_supersessions: number;
};

type PackageLedgerRow = {
  id: string;
  organization_id: string;
  sequence: number;
  kind: LedgerEntry["kind"];
  actor_id: string;
  actor_name: string;
  occurred_at: string;
  payload_hash: string;
  payload_ref: string | null;
  intent_id: string | null;
  run_id: string | null;
  previous_hash: string;
  hash: string;
  total_matching: number;
};
