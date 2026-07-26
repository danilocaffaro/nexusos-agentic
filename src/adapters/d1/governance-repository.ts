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
import type { ArtifactErasureImpact } from "@/src/contracts/artifacts";
import {
  appendLedgerEntry,
  approveIntent,
  claimIntentForExecution,
  completeIntent,
  createIntent,
  expireIntent,
  failApprovedIntent,
  hashCanonical,
  IntentTransitionError,
  proposeIntent,
  verifyLedgerChain,
} from "@/src/domain/governance";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  requireWorkspaceMember,
  requireWorkspaceOwner,
  WorkspaceRepositoryError,
} from "@/src/adapters/d1/workspace-repository";
import {
  LOCAL_AGENT_ID,
  LOCAL_PROJECT_ID,
} from "@/src/adapters/d1/local-workspace";
import { getArtifactErasureImpact } from "@/src/adapters/d1/artifact-repository";
import {
  ArtifactValidationError,
  validateArtifactErasureReason,
} from "@/src/domain/artifacts";
import { scheduleRealtimeSignal } from "@/src/adapters/realtime/publish-realtime-signal";

export { ensureLocalWorkspace } from "@/src/adapters/d1/local-workspace";

const ACTIVE_HUMAN_OWNER_ADMIN_SCOPE = `
  FROM memberships membership
  INNER JOIN principals principal
    ON principal.id = membership.principal_id
   AND principal.organization_id = membership.organization_id
  WHERE membership.organization_id = ?
    AND membership.role IN ('owner', 'admin')
    AND membership.status = 'active'
    AND principal.kind = 'human'
    AND principal.status = 'active'`;

export async function listGovernanceState(
  identity: RequestIdentity,
  focusedIntentId?: string,
) {
  await requireGovernanceMember(identity);
  const organizationId = identity.organizationId;
  const db = getDb();
  const [intentRows, ledgerRows] = await Promise.all([
    db
      .select()
      .from(actionIntents)
      .where(eq(actionIntents.organizationId, organizationId))
      .orderBy(desc(actionIntents.createdAt), desc(actionIntents.id))
      .limit(20),
    db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.organizationId, organizationId))
      .orderBy(asc(ledgerEntries.sequence)),
  ]);
  let visibleIntentRows = intentRows;
  if (
    focusedIntentId &&
    !intentRows.some((intent) => intent.id === focusedIntentId)
  ) {
    const [focusedIntent] = await db
      .select()
      .from(actionIntents)
      .where(
        and(
          eq(actionIntents.id, focusedIntentId),
          eq(actionIntents.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (focusedIntent) {
      visibleIntentRows = [focusedIntent, ...intentRows];
    }
  }
  const ledger = ledgerRows.map(toLedgerEntry);
  return {
    intents: visibleIntentRows.map((row) => ({
      id: row.id,
      actionType: row.actionType,
      targetRef: row.targetRef,
      riskTier: row.riskTier,
      status: row.status,
      requiredApprovals: row.requiredApprovals,
      separationOfDuties: row.separationOfDuties,
      selfApprovalPolicy: row.selfApprovalPolicy,
      proposerId: row.proposerId,
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
  await requireGovernanceMember(identity);
  let existingIntent = await findIntentByIdempotencyKey(
    identity.organizationId,
    idempotencyKey,
  );
  if (existingIntent && isOpenIntent(existingIntent)) {
    existingIntent = await expireIntentIfNeeded(identity, existingIntent);
  }
  if (
    existingIntent &&
    (isOpenIntent(existingIntent) || existingIntent.status === "succeeded")
  ) {
    assertIdempotentRequestMatches(existingIntent, summary);
    return { intent: existingIntent, created: false };
  }
  const attentionAddressees = await listAttentionAddressees(
    identity.organizationId,
  );
  if (attentionAddressees.length === 0) {
    throw new GovernanceRepositoryError(
      "attention_addressee_required",
      409,
    );
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
    separationOfDuties: true,
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    idempotencyKey,
    ...(existingIntent ? { supersedesIntentId: existingIntent.id } : {}),
    now: now.toISOString(),
  });
  const intent = proposeIntent(draft, now.toISOString());
  try {
    await persistProposedIntent(
      intent,
      intent.proposerId,
      attentionAddressees,
    );
  } catch (error) {
    if (
      error instanceof GovernanceRepositoryError &&
      error.code === "conflict_retry"
    ) {
      const racedIntent = await findIntentByIdempotencyKey(
        identity.organizationId,
        idempotencyKey,
      );
      if (racedIntent && isOpenIntent(racedIntent)) {
        assertIdempotentRequestMatches(racedIntent, summary);
        return { intent: racedIntent, created: false };
      }
    }
    throw error;
  }
  return { intent, created: true };
}

export async function proposeArtifactErasureIntent(
  identity: RequestIdentity,
  artifactId: string,
  versionNumber: number,
  rawReason: unknown,
): Promise<{
  intent: ActionIntent;
  impact: ArtifactErasureImpact;
  created: boolean;
}> {
  await requireGovernanceOwner(identity);
  const reason = translateArtifactReason(rawReason);
  const impact = await getArtifactErasureImpact(
    identity,
    artifactId,
    versionNumber,
  );
  const idempotencyKey =
    `artifact-erase:${impact.contentHash}:${impact.referenceCount}`;
  let existingIntent = await findIntentByIdempotencyKey(
    identity.organizationId,
    idempotencyKey,
  );
  if (existingIntent && isOpenIntent(existingIntent)) {
    existingIntent = await expireIntentIfNeeded(identity, existingIntent);
  }
  if (existingIntent && isOpenIntent(existingIntent)) {
    assertArtifactErasureRequestMatches(existingIntent, impact, reason);
    return { intent: existingIntent, impact, created: false };
  }
  if (existingIntent?.status === "succeeded") {
    throw new GovernanceRepositoryError("artifact_already_erased", 409);
  }
  const attentionAddressees = await listAttentionAddressees(
    identity.organizationId,
  );
  if (attentionAddressees.length === 0) {
    throw new GovernanceRepositoryError(
      "attention_addressee_required",
      409,
    );
  }
  const separationOfDuties = attentionAddressees.length >= 2;
  const approvalAddressees = separationOfDuties
    ? attentionAddressees.filter((principalId) => principalId !== identity.id)
    : attentionAddressees;
  const now = new Date();
  const draft = await createIntent({
    id: crypto.randomUUID(),
    organizationId: identity.organizationId,
    projectId: impact.projectId,
    proposerId: identity.id,
    proposerKind: "human",
    actionType: "nexus.artifact.erase_payload",
    targetRef: artifactContentRef(impact.contentHash),
    parameters: {
      contentHash: impact.contentHash,
      byteSize: impact.byteSize,
      reason,
      referenceCount: impact.referenceCount,
      affectedVersions: impact.versions.map((version) => ({
        artifactId: version.artifactId,
        versionNumber: version.versionNumber,
        projectId: version.projectId,
        workItemId: version.workItemId,
      })),
    },
    preconditions: [
      {
        ref: artifactContentRef(impact.contentHash),
        observedVersion: String(impact.referenceCount),
      },
    ],
    riskTier: "high",
    policyDecision: {
      effect: "require_approval",
      policyVersion: "artifact-erasure-v1",
      reasons: [
        "Payload unavailability is a consequential, organization-wide effect",
      ],
      evaluatedAt: now.toISOString(),
    },
    requiredApprovals: 1,
    separationOfDuties,
    ...(separationOfDuties
      ? {}
      : { selfApprovalPolicy: "solo_owner" as const }),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    idempotencyKey,
    ...(existingIntent ? { supersedesIntentId: existingIntent.id } : {}),
    now: now.toISOString(),
  });
  const intent = proposeIntent(draft, now.toISOString());
  try {
    await persistProposedIntent(
      intent,
      identity.id,
      approvalAddressees,
    );
  } catch (error) {
    if (
      error instanceof GovernanceRepositoryError &&
      error.code === "conflict_retry"
    ) {
      const racedIntent = await findIntentByIdempotencyKey(
        identity.organizationId,
        idempotencyKey,
      );
      if (racedIntent && isOpenIntent(racedIntent)) {
        assertArtifactErasureRequestMatches(racedIntent, impact, reason);
        return { intent: racedIntent, impact, created: false };
      }
    }
    throw error;
  }
  return { intent, impact, created: true };
}

async function persistProposedIntent(
  intent: ActionIntent,
  eventActorId: string,
  attentionAddressees: string[],
): Promise<void> {
  const event = await eventForIntent(
    intent,
    "intent.proposed",
    eventActorId,
  );
  const ledger = await appendNextLedgerEntry(intent.organizationId, event);
  const d1 = getD1();
  await executeBatch([
    d1
      .prepare(
        `INSERT INTO action_intents (
          id, organization_id, project_id, proposer_id, proposer_kind,
          action_type, target_ref, parameters_json, parameters_hash,
          preconditions_json, risk_tier, policy_decision_json,
          required_approvals, separation_of_duties, self_approval_policy,
          expires_at, idempotency_key, status, supersedes_intent_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        intent.separationOfDuties ? 1 : 0,
        intent.selfApprovalPolicy ?? null,
        intent.expiresAt,
        intent.idempotencyKey,
        intent.status,
        intent.supersedesIntentId ?? null,
        intent.createdAt,
        intent.updatedAt,
      ),
    ...attentionAddressees.map((principalId) =>
      d1
        .prepare(
          `INSERT INTO attention_items (
            id, organization_id, principal_id, intent_id, kind, dedupe_key,
            status, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'intent_awaiting_approval', ?, 'open', 1, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          intent.organizationId,
          principalId,
          intent.id,
          `intent:${intent.id}:approval`,
          intent.createdAt,
          intent.updatedAt,
        ),
    ),
    prepareLedgerInsert(d1, ledger),
  ]);
  scheduleAttentionSignals(intent.organizationId, attentionAddressees);
}

function translateArtifactReason(value: unknown): string {
  try {
    return validateArtifactErasureReason(value);
  } catch (error) {
    if (error instanceof ArtifactValidationError) {
      throw new GovernanceRepositoryError(error.code, 400);
    }
    throw error;
  }
}

function assertArtifactErasureRequestMatches(
  intent: ActionIntent,
  impact: ArtifactErasureImpact,
  reason: string,
): void {
  if (
    intent.actionType !== "nexus.artifact.erase_payload" ||
    intent.parameters.contentHash !== impact.contentHash ||
    intent.parameters.referenceCount !== impact.referenceCount ||
    intent.parameters.reason !== reason
  ) {
    throw new GovernanceRepositoryError("idempotency_key_reused", 422);
  }
}

function artifactContentRef(contentHash: string): string {
  return `nexus://artifacts/content/${contentHash}`;
}

async function listAttentionAddressees(
  organizationId: string,
): Promise<string[]> {
  const result = await getD1()
    .prepare(
      `SELECT membership.principal_id
       ${ACTIVE_HUMAN_OWNER_ADMIN_SCOPE}
       ORDER BY membership.principal_id`,
    )
    .bind(organizationId)
    .all<{ principal_id: string }>();
  return result.results.map((row) => row.principal_id);
}

export async function approveStoredIntent(
  identity: RequestIdentity,
  intentId: string,
  parametersHash: string,
  soloOwnerAcknowledged = false,
): Promise<ActionIntent> {
  await requireGovernanceOwner(identity);
  const intent = await loadIntent(identity.organizationId, intentId);
  const approvedAt = new Date().toISOString();
  const effectiveSoloOwnerAcknowledgement =
    identity.id === intent.proposerId && soloOwnerAcknowledged;
  const soloOwnerCommitGuard =
    identity.id === intent.proposerId &&
    intent.selfApprovalPolicy === "solo_owner";
  const approved = approveIntent(intent, {
    actorId: identity.id,
    actorKind: identity.kind,
    parametersHash,
    soloOwnerAcknowledged: effectiveSoloOwnerAcknowledgement,
    approvedAt,
  });
  const event = await eventForIntent(
    approved,
    "intent.approved",
    identity.id,
  );
  const ledger = await appendNextLedgerEntry(identity.organizationId, event);
  const d1 = getD1();
  const approvalId = crypto.randomUUID();
  const attentionAddressees =
    approved.status === "approved"
      ? await listIntentAttentionAddressees(
          approved.organizationId,
          approved.id,
        )
      : [];
  const statements = [
    d1
      .prepare(
        `INSERT INTO intent_approvals (
          id, intent_id, actor_id, actor_kind, parameters_hash,
          solo_owner_acknowledged, approved_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM action_intents
          WHERE id = ? AND organization_id = ?
            AND status = ? AND updated_at = ?
        )
        AND (
          ? = 0 OR NOT EXISTS (
            SELECT 1
            ${ACTIVE_HUMAN_OWNER_ADMIN_SCOPE}
              AND membership.principal_id != ?
          )
        )`,
      )
      .bind(
        approvalId,
        intent.id,
        identity.id,
        identity.kind,
        parametersHash,
        effectiveSoloOwnerAcknowledgement ? 1 : 0,
        approvedAt,
        intent.id,
        intent.organizationId,
        intent.status,
        intent.updatedAt,
        soloOwnerCommitGuard ? 1 : 0,
        intent.organizationId,
        identity.id,
      ),
    d1
      .prepare(
        `UPDATE action_intents
         SET status = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = ?
           AND updated_at = ?
           AND EXISTS (
             SELECT 1 FROM intent_approvals WHERE id = ? AND intent_id = ?
           )`,
      )
      .bind(
        approved.status,
        approved.updatedAt,
        approved.id,
        approved.organizationId,
        intent.status,
        intent.updatedAt,
        approvalId,
        intent.id,
      ),
  ];
  if (approved.status === "approved") {
    statements.push(
      d1
        .prepare(
          `UPDATE attention_items
           SET status = 'resolved', resolution = 'decided',
               resolved_at = ?, version = version + 1, updated_at = ?
           WHERE organization_id = ? AND intent_id = ?
             AND status IN ('open', 'seen')`,
        )
        .bind(
          approved.updatedAt,
          approved.updatedAt,
          approved.organizationId,
          approved.id,
        ),
    );
  }
  statements.push(
    prepareApprovalLedgerInsert(d1, ledger, approved, approvalId),
  );
  const results = await executeBatchWithResults(statements);
  if (
    statementChanges(results[0]) !== 1 ||
    statementChanges(results[1]) !== 1
  ) {
    if (
      soloOwnerCommitGuard &&
      (await listAttentionAddressees(intent.organizationId)).some(
        (principalId) => principalId !== identity.id,
      )
    ) {
      throw new GovernanceRepositoryError(
        "solo_owner_peer_exists",
        409,
      );
    }
    throw new GovernanceRepositoryError("conflict_retry", 409);
  }
  if (approved.status === "approved") {
    scheduleAttentionSignals(
      approved.organizationId,
      attentionAddressees,
    );
  }
  return approved;
}

async function listIntentAttentionAddressees(
  organizationId: string,
  intentId: string,
): Promise<string[]> {
  const result = await getD1()
    .prepare(
      `SELECT DISTINCT principal_id
       FROM attention_items
       WHERE organization_id = ? AND intent_id = ?
       ORDER BY principal_id`,
    )
    .bind(organizationId, intentId)
    .all<{ principal_id: string }>();
  return result.results.map((row) => row.principal_id);
}

function scheduleAttentionSignals(
  organizationId: string,
  principalIds: string[],
): void {
  for (const principalId of principalIds) {
    scheduleRealtimeSignal({
      kind: "attention",
      organizationId,
      principalId,
    });
  }
}

export async function executeStoredIntent(
  identity: RequestIdentity,
  intentId: string,
): Promise<GovernedExecutionResult> {
  await requireGovernanceOwner(identity);
  const intent = await loadIntent(identity.organizationId, intentId);
  if ((await hashCanonical(intent.parameters)) !== intent.parametersHash) {
    throw new GovernanceRepositoryError("parameters_hash_mismatch", 422);
  }
  if (intent.actionType === "nexus.artifact.erase_payload") {
    return executeArtifactErasureIntent(identity, intent);
  }
  if (intent.actionType !== "nexus.simulator.publish_summary") {
    throw new GovernanceRepositoryError("unsupported_action_type", 422);
  }
  return executeSimulatedIntent(identity, intent);
}

async function executeSimulatedIntent(
  identity: RequestIdentity,
  intent: ActionIntent,
): Promise<GovernedExecutionResult> {
  const startTime = new Date();
  const fencingToken = randomPositiveFencingToken();
  const executing = claimIntentForExecution(
    intent,
    { "nexus:simulator:version": "1" },
    fencingToken,
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
    fencingToken,
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
  const results = await executeBatchWithResults([
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
    prepareConditionalLedgerInsert(d1, startedLedger, succeeded),
    prepareConditionalLedgerInsert(d1, succeededLedger, succeeded),
  ]);
  if (statementChanges(results[0]) !== 1) {
    throw new GovernanceRepositoryError("conflict_retry", 409);
  }
  return {
    intent: succeeded,
    receipt: {
      kind: "simulated",
      effect: "summary published in the deterministic Nexus simulator",
    },
  };
}

async function executeArtifactErasureIntent(
  identity: RequestIdentity,
  intent: ActionIntent,
): Promise<GovernedExecutionResult> {
  const parameters = parseArtifactErasureParameters(intent);
  const currentCount = await countArtifactContentReferences(
    intent.organizationId,
    parameters.contentHash,
  );
  const startTime = new Date();
  const fencingToken = randomPositiveFencingToken();
  let executing: ActionIntent;
  try {
    executing = claimIntentForExecution(
      intent,
      { [intent.targetRef]: String(currentCount) },
      fencingToken,
      startTime.toISOString(),
    );
  } catch (error) {
    if (
      error instanceof IntentTransitionError &&
      error.code === "stale_precondition"
    ) {
      await failArtifactErasureIntent(identity, intent);
      throw new GovernanceRepositoryError("stale_precondition", 409);
    }
    throw error;
  }
  const succeeded = completeIntent(
    executing,
    fencingToken,
    "succeeded",
    new Date(startTime.getTime() + 1).toISOString(),
  );
  const startedLedger = await appendNextLedgerEntry(
    intent.organizationId,
    await eventForIntent(executing, "effect.started", identity.id),
  );
  const succeededLedger = await appendLedgerEntry(
    startedLedger,
    await eventForIntent(succeeded, "effect.succeeded", identity.id),
  );
  const d1 = getD1();
  const results = await executeBatchWithResults([
    d1
      .prepare(
        `UPDATE action_intents
         SET status = ?, fencing_token = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'approved'
           AND (
             SELECT COUNT(*) FROM artifact_versions
             WHERE organization_id = ? AND content_hash = ?
           ) = ?`,
      )
      .bind(
        succeeded.status,
        succeeded.fencingToken ?? null,
        succeeded.updatedAt,
        succeeded.id,
        succeeded.organizationId,
        succeeded.organizationId,
        parameters.contentHash,
        parameters.referenceCount,
      ),
    d1
      .prepare(
        `UPDATE artifact_payloads
         SET body_text = NULL, erased_at = ?
         WHERE organization_id = ? AND content_hash = ?
           AND body_text IS NOT NULL AND erased_at IS NULL
           AND EXISTS (
             SELECT 1 FROM action_intents
             WHERE id = ? AND organization_id = ?
               AND status = 'succeeded' AND fencing_token = ?
           )`,
      )
      .bind(
        succeeded.updatedAt,
        succeeded.organizationId,
        parameters.contentHash,
        succeeded.id,
        succeeded.organizationId,
        fencingToken,
      ),
    prepareConditionalLedgerInsert(d1, startedLedger, succeeded),
    prepareConditionalLedgerInsert(d1, succeededLedger, succeeded),
  ]);
  if (statementChanges(results[0]) !== 1) {
    const latest = await loadIntent(intent.organizationId, intent.id);
    if (latest.status === "approved") {
      await failArtifactErasureIntent(identity, latest);
      throw new GovernanceRepositoryError("stale_precondition", 409);
    }
    throw new GovernanceRepositoryError("conflict_retry", 409);
  }
  return {
    intent: succeeded,
    receipt: {
      kind: "artifact_erasure",
      contentHash: parameters.contentHash,
      affectedVersions: parameters.referenceCount,
      erasedPayloadRows: statementChanges(results[1]),
      erasure: "logical_unavailability",
    },
  };
}

async function failArtifactErasureIntent(
  identity: RequestIdentity,
  intent: ActionIntent,
): Promise<void> {
  const failed = failApprovedIntent(intent, new Date().toISOString());
  const failedLedger = await appendNextLedgerEntry(
    intent.organizationId,
    await eventForIntent(failed, "effect.failed", identity.id),
  );
  const d1 = getD1();
  const results = await executeBatchWithResults([
    d1
      .prepare(
        `UPDATE action_intents
         SET status = 'failed', updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'approved'`,
      )
      .bind(
        failed.updatedAt,
        failed.id,
        failed.organizationId,
      ),
    prepareConditionalLedgerInsert(d1, failedLedger, failed),
  ]);
  if (statementChanges(results[0]) !== 1) {
    throw new GovernanceRepositoryError("conflict_retry", 409);
  }
}

async function requireGovernanceMember(
  identity: RequestIdentity,
): Promise<void> {
  try {
    await requireWorkspaceMember(identity);
  } catch (error) {
    if (error instanceof WorkspaceRepositoryError) {
      throw new GovernanceRepositoryError(error.code, error.status);
    }
    throw error;
  }
}

async function requireGovernanceOwner(
  identity: RequestIdentity,
): Promise<void> {
  try {
    await requireWorkspaceOwner(identity);
  } catch (error) {
    if (error instanceof WorkspaceRepositoryError) {
      throw new GovernanceRepositoryError(error.code, error.status);
    }
    throw error;
  }
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
    separationOfDuties: row.separationOfDuties,
    ...(row.selfApprovalPolicy
      ? { selfApprovalPolicy: row.selfApprovalPolicy }
      : {}),
    approvals: approvals.map((approval) => ({
      actorId: approval.actorId,
      actorKind: approval.actorKind,
      parametersHash: approval.parametersHash,
      soloOwnerAcknowledged: approval.soloOwnerAcknowledged,
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
    .orderBy(desc(actionIntents.createdAt), desc(actionIntents.id))
    .limit(1);
  return row ? loadIntent(organizationId, row.id) : undefined;
}

function isOpenIntent(intent: ActionIntent): boolean {
  return ["draft", "proposed", "approved", "executing"].includes(
    intent.status,
  );
}

async function expireIntentIfNeeded(
  identity: RequestIdentity,
  intent: ActionIntent,
): Promise<ActionIntent> {
  if (
    !["proposed", "approved"].includes(intent.status) ||
    Date.now() < Date.parse(intent.expiresAt)
  ) {
    return intent;
  }
  const now = new Date().toISOString();
  const expired = expireIntent(intent, now);
  const ledger = await appendNextLedgerEntry(
    intent.organizationId,
    await eventForIntent(expired, "intent.expired", identity.id),
  );
  const d1 = getD1();
  const results = await executeBatchWithResults([
    d1
      .prepare(
        `UPDATE action_intents
         SET status = 'expired', updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = ?
           AND updated_at = ?`,
      )
      .bind(
        expired.updatedAt,
        expired.id,
        expired.organizationId,
        intent.status,
        intent.updatedAt,
      ),
    d1
      .prepare(
        `UPDATE attention_items
         SET status = 'resolved', resolution = 'expired',
             resolved_at = ?, version = version + 1, updated_at = ?
         WHERE organization_id = ? AND intent_id = ?
           AND status IN ('open', 'seen')
           AND EXISTS (
             SELECT 1 FROM action_intents
             WHERE id = ? AND organization_id = ?
               AND status = 'expired' AND updated_at = ?
           )`,
      )
      .bind(
        expired.updatedAt,
        expired.updatedAt,
        expired.organizationId,
        expired.id,
        expired.id,
        expired.organizationId,
        expired.updatedAt,
      ),
    prepareConditionalLedgerInsert(d1, ledger, expired),
  ]);
  if (statementChanges(results[0]) === 1) {
    const addressees = await listIntentAttentionAddressees(
      intent.organizationId,
      intent.id,
    );
    scheduleAttentionSignals(intent.organizationId, addressees);
    return expired;
  }
  return loadIntent(intent.organizationId, intent.id);
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

function prepareConditionalLedgerInsert(
  d1: D1Database,
  entry: LedgerEntry,
  intent: ActionIntent,
) {
  return d1
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, intent_id, run_id, previous_hash, hash
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM action_intents
        WHERE id = ? AND organization_id = ?
          AND status = ? AND updated_at = ?
          AND (
            (? IS NULL AND fencing_token IS NULL) OR fencing_token = ?
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM ledger_entries
        WHERE organization_id = ? AND intent_id = ? AND kind = ?
      )`,
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
      intent.id,
      intent.organizationId,
      intent.status,
      intent.updatedAt,
      intent.fencingToken ?? null,
      intent.fencingToken ?? null,
      entry.organizationId,
      entry.intentId ?? null,
      entry.kind,
    );
}

function prepareApprovalLedgerInsert(
  d1: D1Database,
  entry: LedgerEntry,
  intent: ActionIntent,
  approvalId: string,
) {
  return d1
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, intent_id, run_id, previous_hash, hash
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM action_intents
        WHERE id = ? AND organization_id = ?
          AND status = ? AND updated_at = ?
      )
      AND EXISTS (
        SELECT 1 FROM intent_approvals
        WHERE id = ? AND intent_id = ?
      )`,
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
      intent.id,
      intent.organizationId,
      intent.status,
      intent.updatedAt,
      approvalId,
      intent.id,
    );
}

async function executeBatch(
  statements: D1PreparedStatement[],
): Promise<void> {
  await executeBatchWithResults(statements);
}

async function executeBatchWithResults(
  statements: D1PreparedStatement[],
) {
  try {
    return await getD1().batch(statements);
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

function statementChanges(
  result: { meta?: { changes?: number } } | undefined,
): number {
  return Number(result?.meta?.changes ?? 0);
}

function randomPositiveFencingToken(): number {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return ((words[0] & 0x1fffff) * 0x1_0000_0000 + words[1]) || 1;
}

async function countArtifactContentReferences(
  organizationId: string,
  contentHash: string,
): Promise<number> {
  const row = await getD1()
    .prepare(
      `SELECT COUNT(*) AS count
       FROM artifact_versions
       WHERE organization_id = ? AND content_hash = ?`,
    )
    .bind(organizationId, contentHash)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function parseArtifactErasureParameters(
  intent: ActionIntent,
): ArtifactErasureParameters {
  const contentHash = intent.parameters.contentHash;
  const byteSize = intent.parameters.byteSize;
  const referenceCount = intent.parameters.referenceCount;
  const affectedVersions = intent.parameters.affectedVersions;
  if (
    typeof contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(contentHash) ||
    !Number.isSafeInteger(byteSize) ||
    Number(byteSize) < 1 ||
    !Number.isSafeInteger(referenceCount) ||
    Number(referenceCount) < 1 ||
    !Array.isArray(affectedVersions) ||
    affectedVersions.length !== referenceCount ||
    intent.targetRef !== artifactContentRef(contentHash) ||
    intent.preconditions.length !== 1 ||
    intent.preconditions[0].ref !== intent.targetRef ||
    intent.preconditions[0].observedVersion !== String(referenceCount)
  ) {
    throw new GovernanceRepositoryError(
      "invalid_artifact_erasure_intent",
      422,
    );
  }
  return {
    contentHash,
    byteSize: Number(byteSize),
    referenceCount: Number(referenceCount),
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

function parseRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new GovernanceRepositoryError("invalid_parameters", 500);
  }
  return parsed as Record<string, unknown>;
}

type ArtifactErasureParameters = {
  contentHash: string;
  byteSize: number;
  referenceCount: number;
};

export type GovernedExecutionResult = {
  intent: ActionIntent;
  receipt:
    | {
        kind: "simulated";
        effect: string;
      }
    | {
        kind: "artifact_erasure";
        contentHash: string;
        affectedVersions: number;
        erasedPayloadRows: number;
        erasure: "logical_unavailability";
      };
};

export class GovernanceRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "GovernanceRepositoryError";
  }
}
