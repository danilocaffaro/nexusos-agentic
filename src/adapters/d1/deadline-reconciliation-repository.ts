import { getD1 } from "@/db";
import type {
  LedgerEntry,
  LedgerEvent,
} from "@/src/contracts/governance";
import { hashCanonical } from "@/src/domain/governance/crypto";
import { appendLedgerEntry } from "@/src/domain/governance/ledger";
import {
  assertCanonicalTimestamp,
  canonicalDeadlineExpiryMetadata,
  DEADLINE_RECONCILER_EXTERNAL_ID,
  DEADLINE_RECONCILER_PURPOSE,
  deadlineHealthCutoff,
  deadlineLedgerPayload,
  deadlineOperationId,
  ENGINE_DEADLINE_REASON,
  isBenignDeadlineRace,
  MUTATION_DEADLINE_RECONCILE_LIMIT,
  SCHEDULED_DEADLINE_RECONCILE_LIMIT,
} from "@/src/domain/runners/deadline-reconciliation";

const LEDGER_RETRY_LIMIT = 5;

export type DeadlineReconciliationMode = "mutation" | "scheduled";

export type DeadlineReconciliationFailure = {
  runId: string;
  code: string;
};

export type DeadlineReconciliationResult = {
  mode: DeadlineReconciliationMode;
  limit: 25 | 100;
  observedAt: string;
  scanned: number;
  expired: number;
  skipped: number;
  truncated: boolean;
  failures: DeadlineReconciliationFailure[];
};

export type DeadlineReconciliationHealth = {
  overdue: boolean;
};

export async function reconcileDueEngineRunDeadlines(input: {
  mode: DeadlineReconciliationMode;
  now?: string;
}): Promise<DeadlineReconciliationResult> {
  const observedAt = input.now ?? new Date().toISOString();
  assertCanonicalTimestamp(observedAt);
  const limit =
    input.mode === "mutation"
      ? MUTATION_DEADLINE_RECONCILE_LIMIT
      : SCHEDULED_DEADLINE_RECONCILE_LIMIT;
  const candidates = await listDueEngineRuns(observedAt, limit);
  const result: DeadlineReconciliationResult = {
    mode: input.mode,
    limit,
    observedAt,
    scanned: candidates.length,
    expired: 0,
    skipped: 0,
    truncated: candidates.length === limit,
    failures: [],
  };

  for (const candidate of candidates) {
    let outcome:
      | "expired"
      | "skipped"
      | { code: string };
    try {
      outcome = await expireCandidate(candidate, observedAt);
    } catch {
      outcome = { code: "deadline_candidate_invalid" };
    }
    if (outcome === "expired") result.expired += 1;
    else if (outcome === "skipped") result.skipped += 1;
    else result.failures.push({ runId: candidate.run_id, code: outcome.code });
  }
  return result;
}

export async function engineDeadlineReconciliationHealth(
  now = new Date().toISOString(),
): Promise<DeadlineReconciliationHealth> {
  const cutoff = deadlineHealthCutoff(now);
  const row = await getD1()
    .prepare(
      `SELECT 1 AS overdue
       FROM runs
       WHERE kind = 'engine_prompt'
         AND status IN ('queued', 'leased')
         AND deadline_at <= ?
       LIMIT 1`,
    )
    .bind(cutoff)
    .first<{ overdue: number }>();
  return { overdue: row?.overdue === 1 };
}

async function listDueEngineRuns(
  observedAt: string,
  limit: 25 | 100,
): Promise<DeadlineCandidate[]> {
  const result = await getD1()
    .prepare(
      `SELECT
         run.id AS run_id,
         run.organization_id,
         run.status,
         run.version,
         run.lease_generation,
         run.current_lease_id,
         run.deadline_at,
         lease.fence AS lease_fence,
         lease.status AS lease_status,
         mapping.principal_id AS actor_id,
         principal.kind AS actor_kind,
         principal.external_id AS actor_external_id,
         principal.status AS actor_status
       FROM runs run
       LEFT JOIN run_leases lease
         ON lease.id = run.current_lease_id
        AND lease.run_id = run.id
        AND lease.organization_id = run.organization_id
       LEFT JOIN organization_system_principals mapping
         ON mapping.organization_id = run.organization_id
        AND mapping.purpose = ?
       LEFT JOIN principals principal
         ON principal.id = mapping.principal_id
        AND principal.organization_id = mapping.organization_id
       WHERE run.kind = 'engine_prompt'
         AND run.status IN ('queued', 'leased')
         AND run.deadline_at <= ?
       ORDER BY
         CASE WHEN
           mapping.principal_id IS NOT NULL
           AND principal.kind = 'automation'
           AND principal.external_id = ?
           AND principal.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM run_deadline_operations operation
             WHERE operation.run_id = run.id
               AND operation.organization_id = run.organization_id
           )
           AND (
             (
               run.status = 'queued'
               AND run.current_lease_id IS NULL
               AND lease.id IS NULL
             )
             OR (
               run.status = 'leased'
               AND run.current_lease_id IS NOT NULL
               AND lease.id = run.current_lease_id
               AND lease.fence = run.lease_generation
               AND lease.status = 'active'
             )
           )
         THEN 0 ELSE 1 END,
         run.deadline_at, run.id
       LIMIT ?`,
    )
    .bind(
      DEADLINE_RECONCILER_PURPOSE,
      observedAt,
      DEADLINE_RECONCILER_EXTERNAL_ID,
      limit,
    )
    .all<DeadlineCandidate>();
  return result.results;
}

async function expireCandidate(
  candidate: DeadlineCandidate,
  appliedAt: string,
): Promise<"expired" | "skipped" | { code: string }> {
  if (
    !candidate.actor_id ||
    candidate.actor_kind !== "automation" ||
    candidate.actor_external_id !== DEADLINE_RECONCILER_EXTERNAL_ID ||
    candidate.actor_status !== "active"
  ) {
    return { code: "deadline_actor_unavailable" };
  }
  if (
    candidate.status === "leased" &&
    (!candidate.current_lease_id ||
      candidate.lease_fence !== candidate.lease_generation ||
      candidate.lease_status !== "active")
  ) {
    return { code: "deadline_lease_inconsistent" };
  }
  if (
    candidate.status === "queued" &&
    (candidate.current_lease_id !== null ||
      candidate.lease_fence !== null ||
      candidate.lease_status !== null)
  ) {
    return { code: "deadline_run_inconsistent" };
  }

  const event: LedgerEvent = {
    id: crypto.randomUUID(),
    organizationId: candidate.organization_id,
    kind: "run.expired",
    actorId: candidate.actor_id,
    occurredAt: appliedAt,
    payloadHash: await hashCanonical(
      deadlineLedgerPayload(candidate.run_id, candidate.deadline_at),
    ),
    payloadRef: runRef(candidate.run_id),
    runId: candidate.run_id,
  };

  for (let attempt = 0; attempt < LEDGER_RETRY_LIMIT; attempt += 1) {
    const ledger = await nextLedgerEntry(candidate.organization_id, event);
    const d1 = getD1();
    try {
      const statements: D1PreparedStatement[] = [
        prepareDeadlineOperation(d1, candidate, appliedAt),
      ];
      if (candidate.status === "leased") {
        statements.push(
          prepareDeadlineLeaseRevocation(d1, candidate, appliedAt),
        );
      }
      statements.push(
        prepareDeadlineRunExpiry(d1, candidate, appliedAt),
        prepareDeadlineEvent(d1, candidate, appliedAt),
        prepareDeadlineLedger(d1, ledger, candidate.run_id),
      );
      await d1.batch(statements);
      return "expired";
    } catch (error) {
      if (isLedgerSequenceConflict(error)) {
        await retryJitter();
        continue;
      }
      if (isDeadlineOperationConflict(error)) {
        for (let probe = 0; probe < 3; probe += 1) {
          await retryJitter();
          if (await isDeadlineEffectComplete(candidate)) return "skipped";
        }
        return { code: "deadline_state_inconsistent" };
      }
      if (isDeadlineRace(error)) {
        if (await isDeadlineEffectComplete(candidate)) return "skipped";
        return (await deadlineRaceWasBenign(candidate, appliedAt))
          ? "skipped"
          : { code: "deadline_race_lost" };
      }
      return { code: "deadline_reconciliation_failed" };
    }
  }
  return { code: "deadline_ledger_conflict" };
}

function prepareDeadlineOperation(
  d1: D1Database,
  candidate: DeadlineCandidate,
  appliedAt: string,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO run_deadline_operations (
        run_id, organization_id, operation_id, actor_id, lease_id, fence,
        deadline_at, applied_at, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      candidate.run_id,
      candidate.organization_id,
      deadlineOperationId(candidate.run_id),
      candidate.actor_id,
      candidate.current_lease_id,
      candidate.status === "leased" ? candidate.lease_generation : null,
      candidate.deadline_at,
      appliedAt,
      ENGINE_DEADLINE_REASON,
    );
}

function prepareDeadlineLeaseRevocation(
  d1: D1Database,
  candidate: DeadlineCandidate,
  appliedAt: string,
): D1PreparedStatement {
  // The immutable run_leases_detach_after_update trigger performs the single
  // leased -> queued transition and version increment inside this statement.
  return d1
    .prepare(
      `UPDATE run_leases
       SET status = 'revoked', ended_at = ?,
           ended_reason = 'deadline_exhausted', updated_at = ?
       WHERE id = ? AND organization_id = ? AND run_id = ?
         AND fence = ? AND status = 'active'
         AND EXISTS (
           SELECT 1 FROM run_deadline_operations operation
           WHERE operation.run_id = ?
             AND operation.organization_id = ?
             AND operation.lease_id = run_leases.id
             AND operation.fence = run_leases.fence
             AND operation.applied_at = ?
             AND operation.reason = ?
         )`,
    )
    .bind(
      appliedAt,
      appliedAt,
      candidate.current_lease_id,
      candidate.organization_id,
      candidate.run_id,
      candidate.lease_generation,
      candidate.run_id,
      candidate.organization_id,
      appliedAt,
      ENGINE_DEADLINE_REASON,
    );
}

function prepareDeadlineRunExpiry(
  d1: D1Database,
  candidate: DeadlineCandidate,
  appliedAt: string,
): D1PreparedStatement {
  const expectedVersion =
    candidate.status === "leased" ? candidate.version + 1 : candidate.version;
  return d1
    .prepare(
      `UPDATE runs
       SET status = 'expired', recorded_at = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ?
         AND kind = 'engine_prompt' AND status = 'queued'
         AND version = ? AND current_lease_id IS NULL
         AND lease_generation = ? AND deadline_at = ?
         AND deadline_at <= ?
         AND EXISTS (
           SELECT 1 FROM run_deadline_operations operation
           WHERE operation.run_id = runs.id
             AND operation.organization_id = runs.organization_id
             AND operation.operation_id = ?
             AND operation.actor_id = ?
             AND operation.deadline_at = runs.deadline_at
             AND operation.applied_at = ?
             AND operation.reason = ?
         )`,
    )
    .bind(
      appliedAt,
      appliedAt,
      candidate.run_id,
      candidate.organization_id,
      expectedVersion,
      candidate.lease_generation,
      candidate.deadline_at,
      appliedAt,
      deadlineOperationId(candidate.run_id),
      candidate.actor_id,
      appliedAt,
      ENGINE_DEADLINE_REASON,
    );
}

function prepareDeadlineEvent(
  d1: D1Database,
  candidate: DeadlineCandidate,
  appliedAt: string,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, fence,
        occurred_at, metadata_json
      )
      SELECT ?, ?,
        COALESCE((SELECT MAX(sequence) + 1 FROM run_events WHERE run_id = ?), 1),
        'run.expired', ?, NULL, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM runs
        WHERE id = ? AND organization_id = ?
          AND kind = 'engine_prompt' AND status = 'expired'
          AND recorded_at = ?
      )`,
    )
    .bind(
      candidate.organization_id,
      candidate.run_id,
      candidate.run_id,
      candidate.actor_id,
      appliedAt,
      canonicalDeadlineExpiryMetadata(
        candidate.run_id,
        candidate.deadline_at,
      ),
      candidate.run_id,
      candidate.organization_id,
      appliedAt,
    );
}

function prepareDeadlineLedger(
  d1: D1Database,
  entry: LedgerEntry,
  runId: string,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, intent_id, run_id, previous_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
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
      runId,
      entry.previousHash,
      entry.hash,
    );
}

async function nextLedgerEntry(
  organizationId: string,
  event: LedgerEvent,
): Promise<LedgerEntry> {
  const row = await getD1()
    .prepare(
      `SELECT
         id, organization_id, sequence, kind, actor_id, occurred_at,
         payload_hash, payload_ref, intent_id, run_id, previous_hash, hash
       FROM ledger_entries
       WHERE organization_id = ?
       ORDER BY sequence DESC
       LIMIT 1`,
    )
    .bind(organizationId)
    .first<LedgerRow>();
  return appendLedgerEntry(row ? toLedgerEntry(row) : undefined, event);
}

async function isDeadlineEffectComplete(
  candidate: DeadlineCandidate,
): Promise<boolean> {
  const row = await getD1()
    .prepare(
      `SELECT 1 AS complete
       FROM runs run
       INNER JOIN run_deadline_operations operation
         ON operation.run_id = run.id
        AND operation.organization_id = run.organization_id
       INNER JOIN run_events event
         ON event.run_id = run.id
        AND event.organization_id = run.organization_id
        AND event.kind = 'run.expired'
       INNER JOIN ledger_entries ledger
         ON ledger.run_id = run.id
        AND ledger.organization_id = run.organization_id
        AND ledger.kind = 'run.expired'
       WHERE run.id = ? AND run.organization_id = ?
         AND run.status = 'expired'
         AND operation.operation_id = ?
         AND event.occurred_at = operation.applied_at
         AND ledger.occurred_at = operation.applied_at
       LIMIT 1`,
    )
    .bind(
      candidate.run_id,
      candidate.organization_id,
      deadlineOperationId(candidate.run_id),
    )
    .first<{ complete: number }>();
  return row?.complete === 1;
}

async function deadlineRaceWasBenign(
  candidate: DeadlineCandidate,
  observedAt: string,
): Promise<boolean> {
  const row = await getD1()
    .prepare(
      `SELECT status, version, deadline_at
       FROM runs
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind(candidate.run_id, candidate.organization_id)
    .first<{
      status: string;
      version: number;
      deadline_at: string;
    }>();
  return isBenignDeadlineRace({
    candidateVersion: candidate.version,
    observedAt,
    current: row
      ? {
          status: row.status,
          version: row.version,
          deadlineAt: row.deadline_at,
        }
      : null,
  });
}

function toLedgerEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sequence: row.sequence,
    kind: row.kind as LedgerEntry["kind"],
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    payloadHash: row.payload_hash,
    ...(row.payload_ref ? { payloadRef: row.payload_ref } : {}),
    ...(row.intent_id ? { intentId: row.intent_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    previousHash: row.previous_hash,
    hash: row.hash,
  };
}

function runRef(runId: string): string {
  return `nexus://runs/${runId}`;
}

function isLedgerSequenceConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed:\s*ledger_entries\.organization_id,\s*ledger_entries\.(?:sequence|hash)|ledger_entries_org_(?:sequence|hash)_uidx/iu.test(
      error.message,
    )
  );
}

function isDeadlineOperationConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /run_deadline_operation_already_exists|UNIQUE constraint failed:\s*run_deadline_operations/iu.test(
      error.message,
    )
  );
}

function isDeadlineRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    /invalid_run_deadline_operation|invalid_run_lease_transition|invalid_run_transition|invalid_run_event|invalid_run_expired_ledger_event/iu.test(
      error.message,
    )
  );
}

async function retryJitter(): Promise<void> {
  const delayMs = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

type DeadlineCandidate = {
  run_id: string;
  organization_id: string;
  status: "queued" | "leased";
  version: number;
  lease_generation: number;
  current_lease_id: string | null;
  deadline_at: string;
  lease_fence: number | null;
  lease_status:
    | "active"
    | "superseded"
    | "released"
    | "revoked"
    | null;
  actor_id: string | null;
  actor_kind: string | null;
  actor_external_id: string | null;
  actor_status: string | null;
};

type LedgerRow = {
  id: string;
  organization_id: string;
  sequence: number;
  kind: string;
  actor_id: string;
  occurred_at: string;
  payload_hash: string;
  payload_ref: string | null;
  intent_id: string | null;
  run_id: string | null;
  previous_hash: string;
  hash: string;
};
