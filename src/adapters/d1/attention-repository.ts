import { getD1 } from "@/db";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import type {
  AttentionItem,
  AttentionPage,
} from "@/src/contracts/attention";
import {
  assertCanMarkAttentionSeen,
  AttentionTransitionError,
} from "@/src/domain/attention";
import {
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "./workspace-repository";
import { scheduleRealtimeSignal } from "../realtime/publish-realtime-signal";

type JsonRecord = Record<string, unknown>;

export async function listAttentionItems(
  identity: RequestIdentity,
  cursorValue?: string,
): Promise<AttentionPage> {
  await requireWorkspaceMember(identity);
  const now = new Date().toISOString();
  await reconcileInactiveAttention(identity, now);
  const cursor = parseCursor(cursorValue);
  const d1 = getD1();
  const [result, countRow] = await Promise.all([
    d1
    .prepare(
      `${ATTENTION_SELECT}
       WHERE item.organization_id = ?
         AND item.principal_id = ?
         AND item.status IN ('open', 'seen')
         AND intent.status = 'proposed'
         AND intent.expires_at > ?
         AND (
           ? IS NULL
           OR item.created_at < ?
           OR (item.created_at = ? AND item.id < ?)
         )
       ORDER BY item.created_at DESC, item.id DESC
       LIMIT ?`,
    )
      .bind(
        identity.organizationId,
        identity.id,
        now,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        PAGE_SIZE + 1,
      )
      .all<AttentionRow>(),
    d1
      .prepare(
        `SELECT
           COUNT(*) AS count,
           SUM(CASE WHEN item.status = 'open' THEN 1 ELSE 0 END) AS open_count,
           SUM(CASE WHEN item.status = 'seen' THEN 1 ELSE 0 END) AS seen_count
         FROM attention_items item
         INNER JOIN action_intents intent
           ON intent.id = item.intent_id
          AND intent.organization_id = item.organization_id
         WHERE item.organization_id = ?
           AND item.principal_id = ?
           AND item.status IN ('open', 'seen')
           AND intent.status = 'proposed'
           AND intent.expires_at > ?`,
      )
      .bind(identity.organizationId, identity.id, now)
      .first<{ count: number; open_count: number; seen_count: number }>(),
  ]);
  const hasNext = result.results.length > PAGE_SIZE;
  const pageRows = result.results.slice(0, PAGE_SIZE);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(toAttentionItem),
    total: Number(countRow?.count ?? 0),
    openTotal: Number(countRow?.open_count ?? 0),
    seenTotal: Number(countRow?.seen_count ?? 0),
    nextCursor: hasNext && last ? cursorFor(last) : null,
  };
}

export async function countAttentionItems(
  identity: RequestIdentity,
): Promise<{ count: number }> {
  await requireWorkspaceMember(identity);
  const now = new Date().toISOString();
  const row = await getD1()
    .prepare(
      `SELECT COUNT(*) AS count
       FROM attention_items item
       INNER JOIN action_intents intent
         ON intent.id = item.intent_id
        AND intent.organization_id = item.organization_id
       WHERE item.organization_id = ?
         AND item.principal_id = ?
         AND item.status IN ('open', 'seen')
         AND intent.status = 'proposed'
         AND intent.expires_at > ?`,
    )
    .bind(identity.organizationId, identity.id, now)
    .first<{ count: number }>();
  return { count: Number(row?.count ?? 0) };
}

export async function markAttentionSeen(
  identity: RequestIdentity,
  attentionId: string,
  input: JsonRecord,
): Promise<AttentionItem> {
  await requireWorkspaceMember(identity);
  const now = new Date().toISOString();
  await reconcileInactiveAttention(identity, now);
  const item = await requireAttentionItem(identity, attentionId, now);
  try {
    assertCanMarkAttentionSeen(item.status);
  } catch (error) {
    if (error instanceof AttentionTransitionError) {
      throw new WorkspaceRepositoryError(error.code, 409);
    }
    throw error;
  }
  const expectedVersion = requiredVersion(input.expectedVersion);
  const seenAt = new Date().toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE attention_items
       SET status = 'seen', seen_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND principal_id = ?
         AND status = 'open' AND version = ?`,
    )
    .bind(
      seenAt,
      seenAt,
      attentionId,
      identity.organizationId,
      identity.id,
      expectedVersion,
    )
    .run();
  if (!result.meta.changes) {
    throw new WorkspaceRepositoryError("version_conflict", 409);
  }
  scheduleRealtimeSignal({
    kind: "attention",
    organizationId: identity.organizationId,
    principalId: identity.id,
  });
  return requireAttentionItem(identity, attentionId, seenAt);
}

async function requireAttentionItem(
  identity: RequestIdentity,
  attentionId: string,
  now: string,
): Promise<AttentionItem> {
  const row = await getD1()
    .prepare(
      `${ATTENTION_SELECT}
       WHERE item.id = ? AND item.organization_id = ?
         AND item.principal_id = ?
         AND item.status IN ('open', 'seen')
         AND intent.status = 'proposed'
         AND intent.expires_at > ?
       LIMIT 1`,
    )
    .bind(attentionId, identity.organizationId, identity.id, now)
    .first<AttentionRow>();
  if (!row) {
    throw new WorkspaceRepositoryError("attention_not_found", 404);
  }
  return toAttentionItem(row);
}

async function reconcileInactiveAttention(
  identity: RequestIdentity,
  now: string,
): Promise<void> {
  const d1 = getD1();
  const candidate = await d1
    .prepare(
      `SELECT 1
       FROM attention_items item
       INNER JOIN action_intents intent
         ON intent.id = item.intent_id
        AND intent.organization_id = item.organization_id
       WHERE item.organization_id = ?
         AND item.status IN ('open', 'seen')
         AND (
           intent.status != 'proposed'
           OR intent.expires_at <= ?
         )
       LIMIT 1`,
    )
    .bind(identity.organizationId, now)
    .first();
  if (!candidate) return;
  await d1
    .prepare(
      `UPDATE attention_items
       SET status = 'resolved',
           resolution = CASE
             WHEN EXISTS (
               SELECT 1 FROM action_intents intent
               WHERE intent.id = attention_items.intent_id
                 AND intent.organization_id = attention_items.organization_id
                 AND (
                   intent.status = 'expired'
                   OR intent.expires_at <= ?
                 )
             ) THEN 'expired'
             ELSE 'superseded'
           END,
           resolved_at = ?, version = version + 1, updated_at = ?
       WHERE organization_id = ?
         AND status IN ('open', 'seen')
         AND EXISTS (
           SELECT 1 FROM action_intents intent
           WHERE intent.id = attention_items.intent_id
             AND intent.organization_id = attention_items.organization_id
             AND (
               intent.status != 'proposed'
               OR intent.expires_at <= ?
             )
         )`,
    )
    .bind(
      now,
      now,
      now,
      identity.organizationId,
      now,
    )
    .run();
}

function requiredVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new WorkspaceRepositoryError("invalid_expectedVersion", 400);
  }
  return value as number;
}

function toAttentionItem(row: AttentionRow): AttentionItem {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    seenAt: row.seen_at,
    intent: {
      id: row.intent_id,
      actionType: row.action_type,
      targetRef: row.target_ref,
      parametersHash: row.parameters_hash,
      riskTier: row.risk_tier,
      status: row.intent_status,
      expiresAt: row.expires_at,
      projectId: row.project_id,
      projectName: row.project_name,
      proposerId: row.proposer_id,
      proposerName: row.proposer_name,
    },
  };
}

const ATTENTION_SELECT = `
  SELECT
    item.id, item.kind, item.status, item.version, item.created_at, item.seen_at,
    intent.id AS intent_id, intent.action_type, intent.target_ref,
    intent.parameters_hash, intent.risk_tier,
    intent.status AS intent_status, intent.expires_at, intent.project_id,
    project.name AS project_name, intent.proposer_id,
    proposer.display_name AS proposer_name
  FROM attention_items item
  INNER JOIN action_intents intent
    ON intent.id = item.intent_id
   AND intent.organization_id = item.organization_id
  INNER JOIN projects project
    ON project.id = intent.project_id
   AND project.organization_id = intent.organization_id
  INNER JOIN principals proposer
    ON proposer.id = intent.proposer_id
   AND proposer.organization_id = intent.organization_id`;

const PAGE_SIZE = 100;

function parseCursor(
  value: string | undefined,
): { createdAt: string; id: string } | null {
  if (!value) return null;
  const separator = value.lastIndexOf("|");
  const createdAt = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (
    separator < 1 ||
    id.length < 1 ||
    id.length > 128 ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw new WorkspaceRepositoryError("invalid_cursor", 400);
  }
  return { createdAt, id };
}

function cursorFor(row: AttentionRow): string {
  return `${row.created_at}|${row.id}`;
}

type AttentionRow = {
  id: string;
  kind: AttentionItem["kind"];
  status: AttentionItem["status"];
  version: number;
  created_at: string;
  seen_at: string | null;
  intent_id: string;
  action_type: string;
  target_ref: string;
  parameters_hash: string;
  risk_tier: AttentionItem["intent"]["riskTier"];
  intent_status: AttentionItem["intent"]["status"];
  expires_at: string;
  project_id: string;
  project_name: string;
  proposer_id: string;
  proposer_name: string;
};
