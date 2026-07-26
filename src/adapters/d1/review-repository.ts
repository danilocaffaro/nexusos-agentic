import { desc, eq } from "drizzle-orm";
import { getD1, getDb } from "@/db";
import { ledgerEntries } from "@/db/schema";
import type {
  ArtifactReview,
  ArtifactReviewState,
} from "@/src/contracts/artifacts";
import type {
  LedgerEntry,
  LedgerEvent,
} from "@/src/contracts/governance";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  ArtifactReviewValidationError,
  reviewHashEnvelope,
  validateArtifactReviewInput,
} from "@/src/domain/artifacts";
import {
  appendLedgerEntry,
  hashCanonical,
} from "@/src/domain/governance";
import {
  requireWorkspaceContributor,
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "./workspace-repository";
import { getArtifactVersion } from "./artifact-repository";

type JsonRecord = Record<string, unknown>;
const REVIEW_INPUT_KEYS = new Set([
  "verdict",
  "reasonCode",
  "soloOwnerAcknowledged",
  "expectedReviewId",
]);

export async function listArtifactReviews(
  identity: RequestIdentity,
  artifactId: string,
  versionNumber: number,
): Promise<ArtifactReviewState> {
  await requireWorkspaceMember(identity);
  const version = await requireReviewVersion(
    identity.organizationId,
    identity.id,
    artifactId,
    versionNumber,
  );
  const [reviews, peerCount] = await Promise.all([
    getD1()
      .prepare(
        `${REVIEW_SELECT}
         WHERE review.organization_id = ?
           AND review.artifact_version_id = ?
         ORDER BY review.created_at DESC, review.id DESC`,
      )
      .bind(identity.organizationId, version.artifact_version_id)
      .all<ReviewRow>(),
    countOtherEligibleReviewers(identity.organizationId, identity.id),
  ]);
  const mappedReviews = reviews.results.map(toReview);
  const myActiveReview = mappedReviews.find(
    (review) =>
      review.status === "active" && review.reviewer.id === identity.id,
  );
  return {
    artifactId,
    versionNumber,
    contentHash: version.content_hash,
    ...(version.erased_at ? { erasedAt: version.erased_at } : {}),
    selfReviewApproval:
      identity.id !== version.created_by
        ? "not_self"
        : version.membership_role === "owner" && peerCount === 0
          ? "solo_owner_ack"
          : peerCount === 0
            ? "owner_role_required"
            : "independent_required",
    ...(myActiveReview ? { myActiveReviewId: myActiveReview.id } : {}),
    reviews: mappedReviews,
  };
}

export async function recordArtifactReview(
  identity: RequestIdentity,
  artifactId: string,
  versionNumber: number,
  input: JsonRecord,
): Promise<{ review: ArtifactReview; created: boolean }> {
  const role = await requireWorkspaceContributor(identity);
  validateReviewRequestShape(input);
  const { verdict, reasonCode } = translateReviewInput(
    input.verdict,
    input.reasonCode,
  );
  const expectedReviewId = translateExpectedReviewId(
    input.expectedReviewId,
  );
  const version = await requireReviewVersion(
    identity.organizationId,
    identity.id,
    artifactId,
    versionNumber,
  );
  const current = await loadActiveReview(
    identity.organizationId,
    version.artifact_version_id,
    identity.id,
  );
  if (
    current &&
    current.verdict === verdict &&
    current.reasonCode === reasonCode
  ) {
    if (
      current.selfReviewPolicy === "solo_owner_ack" &&
      input.soloOwnerAcknowledged !== true
    ) {
      throw new WorkspaceRepositoryError("self_review_ack_required", 409);
    }
    return { review: current, created: false };
  }
  if (version.erased_at || version.body_available !== 1) {
    throw new WorkspaceRepositoryError("artifact_payload_erased", 409);
  }
  await getArtifactVersion(identity, artifactId, versionNumber);
  if ((current?.id ?? null) !== expectedReviewId) {
    throw new WorkspaceRepositoryError("review_conflict", 409);
  }
  let selfReviewPolicy: ArtifactReview["selfReviewPolicy"];
  if (verdict === "approved" && identity.id === version.created_by) {
    const peerCount = await countOtherEligibleReviewers(
      identity.organizationId,
      identity.id,
    );
    if (role !== "owner" && peerCount === 0) {
      throw new WorkspaceRepositoryError(
        "artifact_review_owner_required",
        409,
      );
    }
    if (role !== "owner" || peerCount > 0) {
      throw new WorkspaceRepositoryError(
        "independent_artifact_reviewer_required",
        409,
      );
    }
    if (input.soloOwnerAcknowledged !== true) {
      throw new WorkspaceRepositoryError("self_review_ack_required", 409);
    }
    selfReviewPolicy = "solo_owner_ack";
  }
  const now = new Date().toISOString();
  const review: ArtifactReview = {
    id: crypto.randomUUID(),
    artifactId,
    artifactVersionId: version.artifact_version_id,
    versionNumber,
    contentHash: version.content_hash,
    byteSize: version.byte_size,
    verdict,
    reasonCode,
    reviewer: {
      id: identity.id,
      displayName: version.reviewer_name,
    },
    ...(selfReviewPolicy ? { selfReviewPolicy } : {}),
    status: "active",
    ...(current ? { supersedesReviewId: current.id } : {}),
    createdAt: now,
  };
  const superseded: ArtifactReview | undefined = current
    ? {
        ...current,
        status: "superseded",
        supersededBy: {
          id: identity.id,
          displayName: version.reviewer_name,
        },
        supersededAt: now,
      }
    : undefined;
  let ledgerHead = await latestLedgerEntry(identity.organizationId);
  let supersededLedger: LedgerEntry | undefined;
  if (superseded) {
    supersededLedger = await appendLedgerEntry(
      ledgerHead,
      await reviewLedgerEvent(
        identity.organizationId,
        identity.id,
        "review.superseded",
        superseded,
        now,
      ),
    );
    ledgerHead = supersededLedger;
  }
  const recordedLedger = await appendLedgerEntry(
    ledgerHead,
    await reviewLedgerEvent(
      identity.organizationId,
      identity.id,
      "review.recorded",
      review,
      now,
    ),
  );
  const statements: D1PreparedStatement[] = [];
  if (current) {
    statements.push(
      getD1()
        .prepare(
          `UPDATE artifact_reviews
           SET status = 'superseded', superseded_by = ?,
               superseded_at = ?
           WHERE id = ? AND organization_id = ? AND status = 'active'`,
        )
        .bind(identity.id, now, current.id, identity.organizationId),
    );
  }
  statements.push(
    getD1()
      .prepare(
        `INSERT INTO artifact_reviews (
          id, organization_id, artifact_id, artifact_version_id,
          version_number, content_hash, byte_size, verdict, reason_code,
          reviewer_id, self_review_policy, status, supersedes_review_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(
        review.id,
        identity.organizationId,
        review.artifactId,
        review.artifactVersionId,
        review.versionNumber,
        review.contentHash,
        review.byteSize,
        review.verdict,
        review.reasonCode,
        identity.id,
        review.selfReviewPolicy ?? null,
        review.supersedesReviewId ?? null,
        now,
      ),
  );
  if (supersededLedger) {
    statements.push(prepareReviewLedgerInsert(supersededLedger));
  }
  statements.push(prepareReviewLedgerInsert(recordedLedger));

  let results;
  try {
    results = await getD1().batch(statements);
  } catch (error) {
    translateReviewStorageError(error);
  }
  if (results?.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
    throw new WorkspaceRepositoryError("review_conflict", 409);
  }
  return { review, created: true };
}

async function requireReviewVersion(
  organizationId: string,
  reviewerId: string,
  artifactId: string,
  versionNumber: number,
): Promise<ReviewVersionRow> {
  if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
    throw new WorkspaceRepositoryError("invalid_artifact_version", 400);
  }
  const version = await getD1()
    .prepare(
      `SELECT
         version.id AS artifact_version_id, version.content_hash,
         version.byte_size, version.created_by,
         payload.erased_at,
         CASE WHEN payload.body_text IS NULL THEN 0 ELSE 1 END
           AS body_available,
         reviewer.display_name AS reviewer_name,
         membership.role AS membership_role
       FROM artifact_versions version
       INNER JOIN artifacts artifact
         ON artifact.id = version.artifact_id
        AND artifact.organization_id = version.organization_id
       INNER JOIN artifact_payloads payload
         ON payload.id = version.content_ref
        AND payload.organization_id = version.organization_id
       INNER JOIN principals reviewer
         ON reviewer.id = ?
        AND reviewer.organization_id = version.organization_id
        AND reviewer.status = 'active'
       INNER JOIN memberships membership
         ON membership.principal_id = reviewer.id
        AND membership.organization_id = reviewer.organization_id
        AND membership.status = 'active'
       WHERE version.organization_id = ? AND version.artifact_id = ?
         AND version.version_number = ?
       LIMIT 1`,
    )
    .bind(reviewerId, organizationId, artifactId, versionNumber)
    .first<ReviewVersionRow>();
  if (!version) {
    throw new WorkspaceRepositoryError("artifact_version_not_found", 404);
  }
  return version;
}

async function loadActiveReview(
  organizationId: string,
  artifactVersionId: string,
  reviewerId: string,
): Promise<ArtifactReview | undefined> {
  const row = await getD1()
    .prepare(
      `${REVIEW_SELECT}
       WHERE review.organization_id = ?
         AND review.artifact_version_id = ?
         AND review.reviewer_id = ?
         AND review.status = 'active'
       LIMIT 1`,
    )
    .bind(organizationId, artifactVersionId, reviewerId)
    .first<ReviewRow>();
  return row ? toReview(row) : undefined;
}

async function countOtherEligibleReviewers(
  organizationId: string,
  reviewerId: string,
): Promise<number> {
  const row = await getD1()
    .prepare(
      `SELECT COUNT(*) AS count
       FROM memberships membership
       INNER JOIN principals principal
         ON principal.id = membership.principal_id
        AND principal.organization_id = membership.organization_id
       WHERE membership.organization_id = ?
         AND membership.principal_id != ?
         AND membership.status = 'active'
         AND membership.role IN ('owner', 'admin', 'member')
         AND principal.kind = 'human'
         AND principal.status = 'active'`,
    )
    .bind(organizationId, reviewerId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function latestLedgerEntry(
  organizationId: string,
): Promise<LedgerEntry | undefined> {
  const [row] = await getDb()
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.organizationId, organizationId))
    .orderBy(desc(ledgerEntries.sequence))
    .limit(1);
  return row ? toLedgerEntry(row) : undefined;
}

async function reviewLedgerEvent(
  organizationId: string,
  actorId: string,
  kind: "review.recorded" | "review.superseded",
  review: ArtifactReview,
  occurredAt: string,
): Promise<LedgerEvent> {
  return {
    id: crypto.randomUUID(),
    organizationId,
    kind,
    actorId,
    occurredAt,
    payloadHash: await hashCanonical(reviewHashEnvelope(review)),
    payloadRef: `nexus://artifact-review/${review.id}`,
  };
}

function prepareReviewLedgerInsert(entry: LedgerEntry) {
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

function translateReviewInput(verdict: unknown, reasonCode: unknown) {
  try {
    return validateArtifactReviewInput(verdict, reasonCode);
  } catch (error) {
    if (error instanceof ArtifactReviewValidationError) {
      throw new WorkspaceRepositoryError(error.code, 400);
    }
    throw error;
  }
}

function validateReviewRequestShape(input: JsonRecord): void {
  if (Object.keys(input).some((key) => !REVIEW_INPUT_KEYS.has(key))) {
    throw new WorkspaceRepositoryError("invalid_review_request", 400);
  }
}

function translateExpectedReviewId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new WorkspaceRepositoryError("invalid_review_request", 400);
  }
  return value;
}

function translateReviewStorageError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (/artifact_self_review_forbidden/i.test(message)) {
    throw new WorkspaceRepositoryError(
      "independent_artifact_reviewer_required",
      409,
    );
  }
  if (/invalid_artifact_review_reference/i.test(message)) {
    throw new WorkspaceRepositoryError("artifact_review_stale", 409);
  }
  if (/artifact_reviewer_ineligible/i.test(message)) {
    throw new WorkspaceRepositoryError("workspace_contributor_required", 403);
  }
  if (
    /invalid_artifact_review/i.test(message)
  ) {
    throw new WorkspaceRepositoryError("invalid_artifact_review", 422);
  }
  if (
    /invalid_review_supersession/i.test(message) ||
    /artifact_review_is_immutable/i.test(message) ||
    /invalid_review_ledger_event|duplicate_review_ledger_event/i.test(
      message,
    ) ||
    /UNIQUE constraint failed/i.test(message)
  ) {
    throw new WorkspaceRepositoryError("review_conflict", 409);
  }
  throw error;
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
    reviewer: {
      id: row.reviewer_id,
      displayName: row.reviewer_name,
    },
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

const REVIEW_SELECT = `
  SELECT
    review.id, review.artifact_id, review.artifact_version_id,
    review.version_number, review.content_hash, review.byte_size,
    review.verdict, review.reason_code, review.reviewer_id,
    reviewer.display_name AS reviewer_name, review.self_review_policy,
    review.status, review.supersedes_review_id, review.superseded_by,
    superseded_by.display_name AS superseded_by_name,
    review.created_at, review.superseded_at
  FROM artifact_reviews review
  INNER JOIN principals reviewer
    ON reviewer.id = review.reviewer_id
   AND reviewer.organization_id = review.organization_id
  LEFT JOIN principals superseded_by
    ON superseded_by.id = review.superseded_by
   AND superseded_by.organization_id = review.organization_id`;

type ReviewVersionRow = {
  artifact_version_id: string;
  content_hash: string;
  byte_size: number;
  created_by: string;
  erased_at: string | null;
  body_available: number;
  reviewer_name: string;
  membership_role: "owner" | "admin" | "member" | "viewer";
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
};
