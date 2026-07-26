import { and, asc, desc, eq } from "drizzle-orm";
import { getD1, getDb } from "@/db";
import {
  actionIntents,
  intentApprovals,
  ledgerEntries,
} from "@/db/schema";
import type {
  ActionIntent,
  LedgerEntry,
  LedgerEvent,
} from "@/src/contracts/governance";
import {
  appendLedgerEntry,
  approveIntent,
  claimIntentForExecution,
  completeIntent,
  createIntent,
  hashCanonical,
  proposeIntent,
  verifyLedgerChain,
} from "@/src/domain/governance";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  ensureLocalWorkspace,
  LOCAL_AGENT_ID,
  LOCAL_PROJECT_ID,
} from "@/src/adapters/d1/local-workspace";

export { ensureLocalWorkspace } from "@/src/adapters/d1/local-workspace";

export async function listGovernanceState(organizationId: string) {
  const db = getDb();
  const [intentRows, ledgerRows] = await Promise.all([
    db
      .select()
      .from(actionIntents)
      .where(eq(actionIntents.organizationId, organizationId))
      .orderBy(desc(actionIntents.createdAt))
      .limit(20),
    db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.organizationId, organizationId))
      .orderBy(asc(ledgerEntries.sequence)),
  ]);
  const ledger = ledgerRows.map(toLedgerEntry);
  return {
    intents: intentRows.map((row) => ({
      id: row.id,
      actionType: row.actionType,
      targetRef: row.targetRef,
      riskTier: row.riskTier,
      status: row.status,
      requiredApprovals: row.requiredApprovals,
      parametersHash: row.parametersHash,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    })),
    ledger,
    verification: await verifyLedgerChain(ledger),
  };
}

export async function proposeSimulatedIntent(
  identity: RequestIdentity,
  summary: string,
  idempotencyKey: string,
): Promise<{ intent: ActionIntent; created: boolean }> {
  await ensureLocalWorkspace();
  const existingIntent = await findIntentByIdempotencyKey(
    identity.organizationId,
    idempotencyKey,
  );
  if (existingIntent) {
    assertIdempotentRequestMatches(existingIntent, summary);
    return { intent: existingIntent, created: false };
  }
  const now = new Date();
  const draft = await createIntent({
    id: crypto.randomUUID(),
    organizationId: identity.organizationId,
    projectId: LOCAL_PROJECT_ID,
    proposerId: LOCAL_AGENT_ID,
    proposerKind: "agent",
    actionType: "nexus.simulator.publish_summary",
    targetRef: "nexus:simulator:v1",
    parameters: { summary },
    preconditions: [
      { ref: "nexus:simulator:version", observedVersion: "1" },
    ],
    riskTier: "medium",
    policyDecision: {
      effect: "require_approval",
      policyVersion: "local-demo-v1",
      reasons: ["Demonstrates that conversation cannot authorize an effect"],
      evaluatedAt: now.toISOString(),
    },
    requiredApprovals: 1,
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    idempotencyKey,
    now: now.toISOString(),
  });
  const intent = proposeIntent(draft, now.toISOString());
  const event = await eventForIntent(
    intent,
    "intent.proposed",
    intent.proposerId,
  );
  const ledger = await appendNextLedgerEntry(identity.organizationId, event);

  const d1 = getD1();
  try {
    await executeBatch([
      d1
        .prepare(
          `INSERT INTO action_intents (
            id, organization_id, project_id, proposer_id, proposer_kind,
            action_type, target_ref, parameters_json, parameters_hash,
            preconditions_json, risk_tier, policy_decision_json,
            required_approvals, expires_at, idempotency_key, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          intent.id,
          intent.organizationId,
          intent.projectId,
          intent.proposerId,
          intent.proposerKind,
          intent.actionType,
          intent.targetRef,
          JSON.stringify(intent.parameters),
          intent.parametersHash,
          JSON.stringify(intent.preconditions),
          intent.riskTier,
          JSON.stringify(intent.policyDecision),
          intent.requiredApprovals,
          intent.expiresAt,
          intent.idempotencyKey,
          intent.status,
          intent.createdAt,
          intent.updatedAt,
        ),
      prepareLedgerInsert(d1, ledger),
    ]);
  } catch (error) {
    if (
      error instanceof GovernanceRepositoryError &&
      error.code === "conflict_retry"
    ) {
      const racedIntent = await findIntentByIdempotencyKey(
        identity.organizationId,
        idempotencyKey,
      );
      if (racedIntent) {
        assertIdempotentRequestMatches(racedIntent, summary);
        return { intent: racedIntent, created: false };
      }
    }
    throw error;
  }
  return { intent, created: true };
}

export async function approveStoredIntent(
  identity: RequestIdentity,
  intentId: string,
  parametersHash: string,
): Promise<ActionIntent> {
  const intent = await loadIntent(identity.organizationId, intentId);
  const approvedAt = new Date().toISOString();
  const approved = approveIntent(intent, {
    actorId: identity.id,
    actorKind: identity.kind,
    parametersHash,
    approvedAt,
  });
  const event = await eventForIntent(
    approved,
    "intent.approved",
    identity.id,
  );
  const ledger = await appendNextLedgerEntry(identity.organizationId, event);
  const d1 = getD1();
  await executeBatch([
    d1
      .prepare(
        "INSERT INTO intent_approvals (id, intent_id, actor_id, actor_kind, parameters_hash, approved_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        intent.id,
        identity.id,
        identity.kind,
        parametersHash,
        approvedAt,
      ),
    d1
      .prepare(
        "UPDATE action_intents SET status = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND status = ?",
      )
      .bind(
        approved.status,
        approved.updatedAt,
        approved.id,
        approved.organizationId,
        "proposed",
      ),
    prepareLedgerInsert(d1, ledger),
  ]);
  return approved;
}

export async function executeStoredIntent(
  identity: RequestIdentity,
  intentId: string,
): Promise<ActionIntent> {
  const intent = await loadIntent(identity.organizationId, intentId);
  const startTime = new Date();
  const executing = claimIntentForExecution(
    intent,
    { "nexus:simulator:version": "1" },
    1,
    startTime.toISOString(),
  );
  const startedEvent = await eventForIntent(
    executing,
    "effect.started",
    identity.id,
  );
  const startedLedger = await appendNextLedgerEntry(
    identity.organizationId,
    startedEvent,
  );
  const succeeded = completeIntent(
    executing,
    1,
    "succeeded",
    new Date(startTime.getTime() + 1).toISOString(),
  );
  const succeededEvent = await eventForIntent(
    succeeded,
    "effect.succeeded",
    identity.id,
  );
  const succeededLedger = await appendLedgerEntry(
    startedLedger,
    succeededEvent,
  );
  const d1 = getD1();
  await executeBatch([
    d1
      .prepare(
        "UPDATE action_intents SET status = ?, fencing_token = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND status = ?",
      )
      .bind(
        succeeded.status,
        succeeded.fencingToken ?? null,
        succeeded.updatedAt,
        succeeded.id,
        succeeded.organizationId,
        "approved",
      ),
    prepareLedgerInsert(d1, startedLedger),
    prepareLedgerInsert(d1, succeededLedger),
  ]);
  return succeeded;
}

async function loadIntent(
  organizationId: string,
  intentId: string,
): Promise<ActionIntent> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(actionIntents)
    .where(
      and(
        eq(actionIntents.id, intentId),
        eq(actionIntents.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new GovernanceRepositoryError("intent_not_found", 404);
  }
  const approvals = await db
    .select()
    .from(intentApprovals)
    .where(eq(intentApprovals.intentId, intentId))
    .orderBy(asc(intentApprovals.approvedAt));
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    proposerId: row.proposerId,
    proposerKind: row.proposerKind,
    actionType: row.actionType,
    targetRef: row.targetRef,
    parameters: parseRecord(row.parametersJson),
    parametersHash: row.parametersHash,
    preconditions: JSON.parse(row.preconditionsJson),
    riskTier: row.riskTier,
    policyDecision: JSON.parse(row.policyDecisionJson),
    requiredApprovals: row.requiredApprovals,
    approvals: approvals.map((approval) => ({
      actorId: approval.actorId,
      actorKind: approval.actorKind,
      parametersHash: approval.parametersHash,
      approvedAt: approval.approvedAt,
    })),
    expiresAt: row.expiresAt,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    ...(row.supersedesIntentId
      ? { supersedesIntentId: row.supersedesIntentId }
      : {}),
    ...(row.fencingToken !== null ? { fencingToken: row.fencingToken } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function findIntentByIdempotencyKey(
  organizationId: string,
  idempotencyKey: string,
): Promise<ActionIntent | undefined> {
  const db = getDb();
  const [row] = await db
    .select({ id: actionIntents.id })
    .from(actionIntents)
    .where(
      and(
        eq(actionIntents.organizationId, organizationId),
        eq(actionIntents.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row ? loadIntent(organizationId, row.id) : undefined;
}

function assertIdempotentRequestMatches(
  intent: ActionIntent,
  summary: string,
): void {
  if (
    intent.actionType !== "nexus.simulator.publish_summary" ||
    intent.parameters.summary !== summary
  ) {
    throw new GovernanceRepositoryError("idempotency_key_reused", 422);
  }
}

async function appendNextLedgerEntry(
  organizationId: string,
  event: LedgerEvent,
): Promise<LedgerEntry> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.organizationId, organizationId))
    .orderBy(desc(ledgerEntries.sequence))
    .limit(1);
  return appendLedgerEntry(row ? toLedgerEntry(row) : undefined, event);
}

async function eventForIntent(
  intent: ActionIntent,
  kind: LedgerEvent["kind"],
  actorId: string,
): Promise<LedgerEvent> {
  return {
    id: crypto.randomUUID(),
    organizationId: intent.organizationId,
    kind,
    actorId,
    occurredAt: intent.updatedAt,
    payloadHash: await hashCanonical({
      intentId: intent.id,
      status: intent.status,
      parametersHash: intent.parametersHash,
      approvals: intent.approvals,
      fencingToken: intent.fencingToken ?? null,
    }),
    payloadRef: `nexus://intents/${intent.id}`,
    intentId: intent.id,
  };
}

function prepareLedgerInsert(d1: D1Database, entry: LedgerEntry) {
  return d1
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
      entry.runId ?? null,
      entry.previousHash,
      entry.hash,
    );
}

async function executeBatch(
  statements: D1PreparedStatement[],
): Promise<void> {
  try {
    await getD1().batch(statements);
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed/i.test(error.message)
    ) {
      throw new GovernanceRepositoryError("conflict_retry", 409);
    }
    throw error;
  }
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

function parseRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new GovernanceRepositoryError("invalid_parameters", 500);
  }
  return parsed as Record<string, unknown>;
}

export class GovernanceRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "GovernanceRepositoryError";
  }
}
