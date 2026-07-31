import { getD1 } from "@/db";
import { env } from "cloudflare:workers";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import type {
  DiagnosticRun,
  DiagnosticRunDetail,
  DiagnosticRunRegistry,
  EngineRunCreationId,
  EngineRunCreationResolution,
  EngineRunRead,
  EngineRunReadDetail,
  EngineRunReceiptMetadata,
  EngineRunRegistry,
  LeaseClaim,
  LeaseRenewal,
  RunCompletion,
  RunEvent,
  RunOutcomeStatus,
} from "@/src/contracts/runs";
import type {
  LedgerEntry,
  LedgerEvent,
} from "@/src/contracts/governance";
import type { RunnerCapabilityName } from "@/src/contracts/runners";
import {
  ENGINE_RUN_DEADLINE_MS,
  ENGINE_RUN_KIND,
  ENGINE_RUN_MAX_CLAIMS,
  type EngineExecutionResult,
  type ExecutionEngineName,
} from "@/src/contracts/execution-engines";
import {
  decodeEngineExcerptBase64Url,
  frameEngineExcerpts,
  generateEngineExcerptRef,
} from "@/src/domain/runners/execution-engine";
import {
  PROMPT_CIPHER_VERSION,
  type PromptCipher,
} from "@/src/ports/prompt-cipher";
import { canonicalJson } from "@/src/domain/governance/canonical-json";
import {
  hashCanonical,
  sha256Bytes,
} from "@/src/domain/governance/crypto";
import { appendLedgerEntry } from "@/src/domain/governance/ledger";
import {
  parseAssignedRunRequest,
  type AssignedRunRequest,
} from "@/src/domain/runners/assigned-run";
import {
  buildEnginePromptReadSentinel,
  buildEngineLeaseClaimDescriptor,
  canonicalEngineLeaseClaimDescriptor,
  generatePromptRef,
  type EngineRunCreateRequest,
} from "@/src/domain/runners/engine-control-plane";
import {
  engineRunCreationRetainUntil,
  generateEngineRunNotCreatedProofId,
  hashEngineRunCreationRequest,
} from "@/src/domain/runners/engine-run-creation-resolution";
import {
  engineLeaseClaimedMetadata,
  evaluateEngineClaimAdmission,
  type EngineClaimAdmission,
} from "@/src/domain/runners/engine-claim-admission";
import {
  evaluateEnginePromptRead,
  type EnginePromptReadSnapshot,
} from "@/src/domain/runners/engine-prompt-read";
import {
  evaluateClaimAdmission,
  leaseClaimedMetadata,
  type ClaimAdmission,
} from "@/src/domain/runners/claim-admission";
import {
  generateLeaseId,
  generateRunId,
  isRunDeadlineExpired,
  LEASE_TTL_MS,
  RUN_DEADLINE_MS,
  RUN_MAX_CLAIMS,
  RUNNER_LEASE_NONCE_TTL_MS,
  RUNNER_OPERATION_RESPONSE_TTL_MS,
} from "@/src/domain/runners/lease-protocol";
import {
  requireWorkspaceMember,
  requireWorkspaceOwner,
} from "./workspace-repository";

const CLAIM_RETRY_LIMIT = 3;
const LEDGER_RETRY_LIMIT = 5;
const ENGINE_RUN_CREATION_UNIQUE_REREAD_LIMIT = 3;
const ENGINE_RUN_PAGE_DEFAULT_LIMIT = 25;
const ENGINE_RUN_PAGE_MAX_LIMIT = 50;
const ENGINE_RUN_EVENT_LIMIT = 100;

export type ActiveRunner = {
  id: string;
  organizationId: string;
  principalId: string;
  publicKey: string;
};

export type SignedRunResult = {
  status: number;
  body: string;
  replay: boolean;
};

export type EnginePromptReadResult = {
  body: Uint8Array;
  promptRef: string;
  promptSha256: string;
  promptBytes: number;
  replay: boolean;
};

export type EngineRunCreationResult = {
  resolution: EngineRunCreationResolution;
  replay: boolean;
};

export type EngineRunAtomicBinding = (
  d1: D1Database,
  facts: {
    organizationId: string;
    requestedBy: string;
    runId: string;
    createdAt: string;
  },
) => D1PreparedStatement[];

type EngineRunCreationRaceTestHook = {
  participant: "create" | "reconcile";
  winner: "create" | "reconcile";
};

type EngineRunCreationRaceTestBarrier = {
  participants: Set<"create" | "reconcile">;
  ready: Promise<void>;
  release: () => void;
  winner: "create" | "reconcile";
};

const ENGINE_RUN_CREATION_RACE_TEST_TIMEOUT_MS = 5_000;
const engineRunCreationRaceTestBarriers =
  new Map<string, EngineRunCreationRaceTestBarrier>();

type SignedRequest = {
  runner: ActiveRunner;
  runId: string;
  nonce: string;
  signedRequestHash: string;
  now: string;
};

export async function createDiagnosticRun(
  identity: RequestIdentity,
): Promise<DiagnosticRunDetail> {
  await requireWorkspaceOwner(identity);
  const runId = generateRunId();
  const createdAt = new Date().toISOString();
  const deadlineAt = new Date(
    Date.parse(createdAt) + RUN_DEADLINE_MS,
  ).toISOString();
  const event: LedgerEvent = {
    id: crypto.randomUUID(),
    organizationId: identity.organizationId,
    kind: "run.requested",
    actorId: identity.id,
    occurredAt: createdAt,
    payloadHash: await hashCanonical({
      runId,
      kind: "diagnostic",
      deadlineAt,
      maxClaims: RUN_MAX_CLAIMS,
    }),
    payloadRef: runRef(runId),
    runId,
  };

  for (let attempt = 0; attempt < LEDGER_RETRY_LIMIT; attempt += 1) {
    const entry = await nextLedgerEntry(identity.organizationId, event);
    const d1 = getD1();
    try {
      await d1.batch([
        d1
          .prepare(
            `INSERT INTO runs (
              id, organization_id, requested_by, kind, status, version,
              lease_generation, claim_count, max_claims, deadline_at,
              created_at, updated_at
            ) VALUES (?, ?, ?, 'diagnostic', 'queued', 1, 0, 0, ?, ?, ?, ?)`,
          )
          .bind(
            runId,
            identity.organizationId,
            identity.id,
            RUN_MAX_CLAIMS,
            deadlineAt,
            createdAt,
            createdAt,
          ),
        d1
          .prepare(
            `INSERT INTO run_events (
              organization_id, run_id, sequence, kind, actor_id,
              occurred_at, metadata_json
            ) VALUES (?, ?, 1, 'run.created', ?, ?, ?)`,
          )
          .bind(
            identity.organizationId,
            runId,
            identity.id,
            createdAt,
            canonicalJson({ deadlineAt, kind: "diagnostic" }),
          ),
        prepareRunLedgerInsert(d1, entry, runId),
      ]);
      return getDiagnosticRun(identity, runId);
    } catch (error) {
      if (!isLedgerSequenceConflict(error)) throw mapRunDatabaseError(error);
      await retryJitter();
    }
  }
  throw new RunRepositoryError("conflict_retry", 409);
}

export async function createAssignedDiagnosticRun(
  identity: RequestIdentity,
  input: Record<string, unknown>,
): Promise<DiagnosticRunDetail> {
  await requireWorkspaceOwner(identity);
  const assignment = parseAssignedRunRequest(input);
  if (!assignment) {
    throw new RunRepositoryError("invalid_assigned_run_request", 400);
  }
  const runId = generateRunId();
  const createdAt = new Date().toISOString();
  const deadlineAt = new Date(
    Date.parse(createdAt) + RUN_DEADLINE_MS,
  ).toISOString();
  const requestedPayload = {
    runId,
    kind: "diagnostic",
    deadlineAt,
    maxClaims: RUN_MAX_CLAIMS,
    assignedRunnerId: assignment.assignedRunnerId,
    ...(assignment.requiredCapability
      ? { requiredCapability: assignment.requiredCapability }
      : {}),
  } as const;
  const createdMetadata = {
    deadlineAt,
    kind: "diagnostic",
    assignedRunnerId: assignment.assignedRunnerId,
    ...(assignment.requiredCapability
      ? { requiredCapability: assignment.requiredCapability }
      : {}),
  } as const;
  const event: LedgerEvent = {
    id: crypto.randomUUID(),
    organizationId: identity.organizationId,
    kind: "run.requested",
    actorId: identity.id,
    occurredAt: createdAt,
    payloadHash: await hashCanonical(requestedPayload),
    payloadRef: runRef(runId),
    runId,
  };

  for (let attempt = 0; attempt < LEDGER_RETRY_LIMIT; attempt += 1) {
    await requireAssignableRunner(
      identity.organizationId,
      assignment.assignedRunnerId,
    );
    const entry = await nextLedgerEntry(identity.organizationId, event);
    const d1 = getD1();
    try {
      await d1.batch([
        d1
          .prepare(
            `INSERT INTO runs (
              id, organization_id, requested_by, kind, status, version,
              lease_generation, claim_count, max_claims, deadline_at,
              assigned_runner_id, required_capability, created_at, updated_at
            ) VALUES (
              ?, ?, ?, 'diagnostic', 'queued', 1, 0, 0, ?, ?, ?, ?, ?, ?
            )`,
          )
          .bind(
            runId,
            identity.organizationId,
            identity.id,
            RUN_MAX_CLAIMS,
            deadlineAt,
            assignment.assignedRunnerId,
            assignment.requiredCapability ?? null,
            createdAt,
            createdAt,
          ),
        d1
          .prepare(
            `INSERT INTO run_events (
              organization_id, run_id, sequence, kind, actor_id,
              occurred_at, metadata_json
            ) VALUES (?, ?, 1, 'run.created', ?, ?, ?)`,
          )
          .bind(
            identity.organizationId,
            runId,
            identity.id,
            createdAt,
            canonicalJson(createdMetadata),
          ),
        prepareRunLedgerInsert(d1, entry, runId),
      ]);
      return getDiagnosticRun(identity, runId);
    } catch (error) {
      if (isLedgerSequenceConflict(error)) {
        await retryJitter();
        continue;
      }
      if (isBareInvalidRun(error)) {
        await classifyAssignedRunInsertAbort(
          identity.organizationId,
          assignment,
        );
        await retryJitter();
        continue;
      }
      throw mapRunDatabaseError(error);
    }
  }
  throw new RunRepositoryError("conflict_retry", 409);
}

export async function createEngineRun(
  identity: RequestIdentity,
  creationId: EngineRunCreationId,
  input: EngineRunCreateRequest,
  prepareCipher: () => Promise<PromptCipher>,
  raceTestHook?: EngineRunCreationRaceTestHook,
  atomicBinding?: EngineRunAtomicBinding,
): Promise<EngineRunCreationResult> {
  await requireWorkspaceOwner(identity);
  const requestHash = await hashEngineRunCreationRequest(input);
  const existing = await getEngineRunCreation(
    identity.organizationId,
    identity.id,
    creationId,
  );
  if (existing) {
    return {
      resolution: await resolveEngineRunCreationForPost(
        existing,
        requestHash,
      ),
      replay: true,
    };
  }

  const cipher = await prepareCipher();
  await requireAssignableRunner(
    identity.organizationId,
    input.assignedRunnerId,
  );
  const runId = generateRunId();
  const promptRef = generatePromptRef();
  const createdAt = new Date().toISOString();
  const retainUntil = engineRunCreationRetainUntil(createdAt);
  const deadlineAt = new Date(
    Date.parse(createdAt) + ENGINE_RUN_DEADLINE_MS,
  ).toISOString();
  const envelope = await cipher.encrypt(input.promptBytes, {
    organizationId: identity.organizationId,
    payloadRef: promptRef,
    runId,
  });
  const createdMetadata = {
    engine: input.engine,
    promptBytes: input.promptBytes.byteLength,
    promptSha256: input.promptSha256,
  } as const;
  const event: LedgerEvent = {
    id: crypto.randomUUID(),
    organizationId: identity.organizationId,
    kind: "run.requested",
    actorId: identity.id,
    occurredAt: createdAt,
    payloadHash: await hashCanonical({
      assignedRunnerId: input.assignedRunnerId,
      deadlineAt,
      engine: input.engine,
      kind: ENGINE_RUN_KIND,
      maxClaims: ENGINE_RUN_MAX_CLAIMS,
      promptBytes: input.promptBytes.byteLength,
      promptSha256: input.promptSha256,
      runId,
    }),
    payloadRef: runRef(runId),
    runId,
  };

  let raceTestHookReached = false;
  for (let attempt = 0; attempt < LEDGER_RETRY_LIMIT; attempt += 1) {
    const resolution = await getEngineRunCreation(
      identity.organizationId,
      identity.id,
      creationId,
    );
    if (resolution) {
      return {
        resolution: await resolveEngineRunCreationForPost(
          resolution,
          requestHash,
        ),
        replay: true,
      };
    }
    if (raceTestHook && !raceTestHookReached) {
      await synchronizeEngineRunCreationRaceForTest(
        identity.organizationId,
        identity.id,
        creationId,
        raceTestHook,
      );
      raceTestHookReached = true;
    }
    await requireAssignableRunner(
      identity.organizationId,
      input.assignedRunnerId,
    );
      const entry = await nextLedgerEntry(identity.organizationId, event);
    const d1 = getD1();
    try {
      await d1.batch([
        d1
          .prepare(
            `INSERT INTO runs (
              id, organization_id, requested_by, kind, status, version,
              lease_generation, current_lease_id, claim_count, max_claims,
              deadline_at, engine, assigned_runner_id, required_capability,
              cancel_requested_at, cancel_requested_by, outcome_status,
              outcome_summary, completed_operation_id, recorded_at,
              created_at, updated_at
            ) VALUES (
              ?, ?, ?, 'engine_prompt', 'queued', 1, 0, NULL, 0, ?,
              ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?
            )`,
          )
          .bind(
            runId,
            identity.organizationId,
            identity.id,
            ENGINE_RUN_MAX_CLAIMS,
            deadlineAt,
            input.engine,
            input.assignedRunnerId,
            createdAt,
            createdAt,
          ),
        d1
          .prepare(
            `INSERT INTO run_prompts (
              run_id, organization_id, prompt_ref, cipher_version, key_id,
              iv, ciphertext, tag, prompt_sha256, prompt_bytes, created_at,
              erased_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .bind(
            runId,
            identity.organizationId,
            promptRef,
            envelope.cipherVersion,
            envelope.keyId,
            envelope.iv,
            envelope.ciphertext,
            envelope.tag,
            input.promptSha256,
            input.promptBytes.byteLength,
            createdAt,
          ),
        prepareRunEvent(d1, {
          organizationId: identity.organizationId,
          runId,
          sequence: 1,
          kind: "run.created",
          actorId: identity.id,
          occurredAt: createdAt,
          metadata: createdMetadata,
        }),
        prepareRunLedgerInsert(d1, entry, runId),
        ...(atomicBinding
          ? atomicBinding(d1, {
              organizationId: identity.organizationId,
              requestedBy: identity.id,
              runId,
              createdAt,
            })
          : []),
        d1
          .prepare(
            `INSERT INTO engine_run_creations (
              organization_id, requested_by, creation_id, request_hash,
              state, run_id, reconciliation_id, created_at, updated_at,
              retain_until
            ) VALUES (?, ?, ?, ?, 'created', ?, NULL, ?, ?, ?)`,
          )
          .bind(
            identity.organizationId,
            identity.id,
            creationId,
            requestHash,
            runId,
            createdAt,
            createdAt,
            retainUntil,
          ),
      ]);
      return {
        resolution: {
          creationId,
          state: "created",
          runId,
        },
        replay: false,
      };
    } catch (error) {
      if (isEngineRunCreationUniqueConflict(error)) {
        const raced = await rereadEngineRunCreationAfterUniqueConflict(
          identity.organizationId,
          identity.id,
          creationId,
        );
        if (!raced) throw mapRunDatabaseError(error);
        return {
          resolution: await resolveEngineRunCreationForPost(
            raced,
            requestHash,
          ),
          replay: true,
        };
      }
      if (isLedgerSequenceConflict(error)) {
        await retryJitter();
        continue;
      }
      if (isBareInvalidRun(error)) {
        await requireWorkspaceOwner(identity);
        await requireAssignableRunner(
          identity.organizationId,
          input.assignedRunnerId,
        );
      }
      throw mapRunDatabaseError(error);
    }
  }
  throw new RunRepositoryError("conflict_retry", 409);
}

export async function reconcileEngineRunCreation(
  identity: RequestIdentity,
  creationId: EngineRunCreationId,
  raceTestHook?: EngineRunCreationRaceTestHook,
): Promise<EngineRunCreationResolution> {
  await requireWorkspaceOwner(identity);
  const existing = await getEngineRunCreation(
    identity.organizationId,
    identity.id,
    creationId,
  );
  if (existing) return resolveEngineRunCreation(existing);
  if (raceTestHook) {
    await synchronizeEngineRunCreationRaceForTest(
      identity.organizationId,
      identity.id,
      creationId,
      raceTestHook,
    );
  }

  const confirmedAt = new Date().toISOString();
  const retainUntil = engineRunCreationRetainUntil(confirmedAt);
  const notCreatedProofId = generateEngineRunNotCreatedProofId();
  const d1 = getD1();
  try {
    await d1.batch([
      d1
        .prepare(
          `INSERT INTO engine_run_creations (
            organization_id, requested_by, creation_id, request_hash,
            state, run_id, reconciliation_id, created_at, updated_at,
            retain_until
          ) VALUES (
            ?, ?, ?, NULL, 'confirmed_not_created', NULL, ?, ?, ?, ?
          )`,
        )
        .bind(
          identity.organizationId,
          identity.id,
          creationId,
          notCreatedProofId,
          confirmedAt,
          confirmedAt,
          retainUntil,
        ),
    ]);
    return {
      creationId,
      state: "confirmed_not_created",
      notCreatedProofId,
      confirmedAt,
    };
  } catch (error) {
    if (!isEngineRunCreationUniqueConflict(error)) {
      throw mapRunDatabaseError(error);
    }
    const raced = await rereadEngineRunCreationAfterUniqueConflict(
      identity.organizationId,
      identity.id,
      creationId,
    );
    if (!raced) throw mapRunDatabaseError(error);
    return resolveEngineRunCreation(raced);
  }
}

export async function listEngineRuns(
  identity: RequestIdentity,
  query: {
    cursor?: string;
    limit?: string;
    valid: boolean;
  },
): Promise<EngineRunRegistry> {
  await requireWorkspaceMember(identity);
  const page = parseEngineRunPage(query);
  const cursorClause = page.cursor
    ? `AND (
         run.created_at < ?
         OR (run.created_at = ? AND run.id < ?)
       )`
    : "";
  const statement = getD1().prepare(
    `${engineRunReadSelectSql()}
     WHERE run.organization_id = ?
       AND run.kind = 'engine_prompt'
       AND run.engine IS NOT NULL
       ${cursorClause}
     ORDER BY run.created_at DESC, run.id DESC
     LIMIT ?`,
  );
  const result = page.cursor
    ? await statement
        .bind(
          identity.organizationId,
          page.cursor.createdAt,
          page.cursor.createdAt,
          page.cursor.runId,
          page.limit + 1,
        )
        .all<EngineRunReadRow>()
    : await statement
        .bind(identity.organizationId, page.limit + 1)
        .all<EngineRunReadRow>();
  const hasNextPage = result.results.length > page.limit;
  const rows = result.results.slice(0, page.limit);
  const now = new Date().toISOString();
  const last = rows.at(-1);
  return {
    runs: rows.map((row) => toEngineRunRead(row, now)),
    ...(hasNextPage && last
      ? {
          nextCursor: encodeEngineRunCursor({
            createdAt: last.created_at,
            runId: last.id,
          }),
        }
      : {}),
  };
}

export async function getEngineRun(
  identity: RequestIdentity,
  runId: string,
): Promise<EngineRunReadDetail> {
  await requireWorkspaceMember(identity);
  const d1 = getD1();
  const [runResult, eventsResult, receiptResult] = await d1.batch([
    d1
      .prepare(
        `${engineRunReadSelectSql()}
         WHERE run.id = ? AND run.organization_id = ?
           AND run.kind = 'engine_prompt'
           AND run.engine IS NOT NULL
         LIMIT 1`,
      )
      .bind(runId, identity.organizationId),
    d1
      .prepare(
        `SELECT sequence, kind, actor_id, fence, occurred_at, metadata_json
         FROM (
           SELECT
             sequence, kind, actor_id, fence, occurred_at, metadata_json
           FROM run_events
           WHERE run_id = ? AND organization_id = ?
           ORDER BY sequence DESC
           LIMIT ?
         )
         ORDER BY sequence`,
      )
      .bind(
        runId,
        identity.organizationId,
        ENGINE_RUN_EVENT_LIMIT + 1,
      ),
    d1
      .prepare(
        `SELECT
           receipt.operation_id, receipt.lease_id, receipt.fence,
           receipt.engine, receipt.engine_version, receipt.status,
           receipt.reason, receipt.exit_code, receipt.timed_out,
           receipt.cancel_requested, receipt.started_at,
           receipt.finished_at, receipt.stdout_bytes,
           receipt.stdout_sha256, receipt.stdout_truncated,
           receipt.stdout_excerpt_bytes, receipt.stderr_bytes,
           receipt.stderr_sha256, receipt.stderr_truncated,
           receipt.stderr_excerpt_bytes, receipt.receipt_sha256,
           receipt.recorded_at, excerpt.erased_at AS excerpt_erased_at
         FROM run_engine_receipts receipt
         INNER JOIN run_engine_excerpts excerpt
           ON excerpt.run_id = receipt.run_id
          AND excerpt.organization_id = receipt.organization_id
          AND excerpt.excerpt_ref = receipt.excerpt_ref
         WHERE receipt.run_id = ? AND receipt.organization_id = ?
         LIMIT 1`,
      )
      .bind(runId, identity.organizationId),
  ]);
  const run = firstResultRow<EngineRunReadRow>(runResult);
  if (!run) throw new RunRepositoryError("run_not_found", 404);
  const eventRows = resultRows<RunEventRow>(eventsResult);
  const eventsTruncated = eventRows.length > ENGINE_RUN_EVENT_LIMIT;
  const selectedEventRows = eventsTruncated ? eventRows.slice(1) : eventRows;
  const receipt = firstResultRow<EngineRunReceiptReadRow>(receiptResult);
  return {
    run: toEngineRunRead(run, new Date().toISOString()),
    events: selectedEventRows.map(toRunEvent),
    eventsTruncated,
    ...(receipt ? { receipt: toEngineRunReceiptMetadata(receipt) } : {}),
  };
}

export async function listDiagnosticRuns(
  identity: RequestIdentity,
): Promise<DiagnosticRunRegistry> {
  await requireWorkspaceMember(identity);
  const now = new Date().toISOString();
  const result = await getD1()
    .prepare(
      runSelectSql(
        "WHERE run.organization_id = ? AND run.kind = 'diagnostic' AND run.engine IS NULL",
      ),
    )
    .bind(identity.organizationId)
    .all<RunRow>();
  return { runs: result.results.map((run) => toDiagnosticRun(run, now)) };
}

export async function getDiagnosticRun(
  identity: RequestIdentity,
  runId: string,
): Promise<DiagnosticRunDetail> {
  await requireWorkspaceMember(identity);
  const now = new Date().toISOString();
  const run = await getD1()
    .prepare(
      runSelectSql(
        "WHERE run.id = ? AND run.organization_id = ? AND run.kind = 'diagnostic' AND run.engine IS NULL",
        false,
      ),
    )
    .bind(runId, identity.organizationId)
    .first<RunRow>();
  if (!run) throw new RunRepositoryError("run_not_found", 404);
  const events = await getD1()
    .prepare(
      `SELECT sequence, kind, actor_id, fence, occurred_at, metadata_json
       FROM run_events
       WHERE run_id = ? AND organization_id = ?
       ORDER BY sequence
       LIMIT 500`,
    )
    .bind(runId, identity.organizationId)
    .all<RunEventRow>();
  return {
    run: toDiagnosticRun(run, now),
    events: events.results.map(toRunEvent),
  };
}

export async function cancelDiagnosticRun(
  identity: RequestIdentity,
  runId: string,
): Promise<DiagnosticRunDetail> {
  await requireWorkspaceOwner(identity);
  for (let attempt = 0; attempt < CLAIM_RETRY_LIMIT; attempt += 1) {
    const current = await getD1()
      .prepare(
        `SELECT
           run.status, run.version, run.cancel_requested_at,
           run.cancel_requested_by, run.current_lease_id,
           run.lease_generation, run.deadline_at,
           lease.status AS lease_status,
           lease.expires_at AS lease_expires_at,
           COALESCE((SELECT MAX(sequence) FROM run_events WHERE run_id = run.id), 0)
             AS event_sequence
         FROM runs run
         LEFT JOIN run_leases lease ON lease.id = run.current_lease_id
         WHERE run.id = ? AND run.organization_id = ?
           AND run.kind = 'diagnostic' AND run.engine IS NULL
         LIMIT 1`,
      )
      .bind(runId, identity.organizationId)
      .first<{
        status: "queued" | "leased" | "completed" | "canceled";
        version: number;
        cancel_requested_at: string | null;
        cancel_requested_by: string | null;
        current_lease_id: string | null;
        lease_generation: number;
        deadline_at: string;
        lease_status:
          | "active"
          | "superseded"
          | "released"
          | "revoked"
          | null;
        lease_expires_at: string | null;
        event_sequence: number;
      }>();
    if (!current) throw new RunRepositoryError("run_not_found", 404);
    if (current.status === "completed" || current.status === "canceled") {
      return getDiagnosticRun(identity, runId);
    }
    const now = new Date().toISOString();
    const leaseExpired =
      current.status === "leased" &&
      current.current_lease_id !== null &&
      current.lease_status === "active" &&
      (current.lease_expires_at === null ||
        current.lease_expires_at <= now ||
        current.deadline_at <= now);
    if (
      current.status === "leased" &&
      current.cancel_requested_at &&
      !leaseExpired
    ) {
      return getDiagnosticRun(identity, runId);
    }
    if (leaseExpired) {
      const cancelRequestedAt = current.cancel_requested_at ?? now;
      const cancelRequestedBy = current.cancel_requested_by ?? identity.id;
      const d1 = getD1();
      try {
        await d1.batch([
          d1
            .prepare(
              `UPDATE run_leases
               SET status = 'released', ended_at = ?,
                   ended_reason = 'canceled', updated_at = ?
               WHERE id = ? AND run_id = ? AND status = 'active'
                 AND (expires_at <= ? OR ? <= ?)`,
            )
            .bind(
              now,
              now,
              current.current_lease_id,
              runId,
              now,
              current.deadline_at,
              now,
            ),
          d1
            .prepare(
              `UPDATE runs
               SET status = 'canceled', cancel_requested_at = ?,
                   cancel_requested_by = ?, recorded_at = ?,
                   version = version + 1, updated_at = ?
               WHERE id = ? AND organization_id = ?
                 AND kind = 'diagnostic' AND engine IS NULL
                 AND status = 'queued' AND version = ?`,
            )
            .bind(
              cancelRequestedAt,
              cancelRequestedBy,
              now,
              now,
              runId,
              identity.organizationId,
              current.version + 1,
            ),
          prepareGuardedCancellationEvent(d1, {
            organizationId: identity.organizationId,
            runId,
            sequence: current.event_sequence + 1,
            kind: "lease.released",
            actorId: identity.id,
            fence: current.lease_generation,
            occurredAt: now,
            metadata: { reason: "canceled_after_lease_expiry" },
          }),
          prepareGuardedCancellationEvent(d1, {
            organizationId: identity.organizationId,
            runId,
            sequence: current.event_sequence + 2,
            kind: "run.canceled",
            actorId: identity.id,
            occurredAt: now,
            metadata: { requested: true },
          }),
        ]);
        const persisted = await getDiagnosticRun(identity, runId);
        if (persisted.run.status === "canceled") return persisted;
      } catch (error) {
        if (!isRunRace(error)) throw mapRunDatabaseError(error);
      }
      await retryJitter();
      continue;
    }
    const nextStatus = current.status === "queued" ? "canceled" : "leased";
    const eventKind =
      current.status === "queued" ? "run.canceled" : "run.cancel_requested";
    const d1 = getD1();
    try {
      await d1.batch([
        d1
          .prepare(
            `UPDATE runs
             SET status = ?, cancel_requested_at = ?,
                 cancel_requested_by = ?, recorded_at = ?,
                 version = version + 1, updated_at = ?
             WHERE id = ? AND organization_id = ?
               AND kind = 'diagnostic' AND engine IS NULL
               AND status = ? AND version = ?`,
          )
          .bind(
            nextStatus,
            now,
            identity.id,
            current.status === "queued" ? now : null,
            now,
            runId,
            identity.organizationId,
            current.status,
            current.version,
          ),
        d1
          .prepare(
            `INSERT INTO run_events (
              organization_id, run_id, sequence, kind, actor_id,
              occurred_at, metadata_json
            )
            SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM runs
              WHERE id = ? AND organization_id = ?
                AND kind = 'diagnostic' AND engine IS NULL
                AND cancel_requested_at = ? AND cancel_requested_by = ?
            )`,
          )
          .bind(
            identity.organizationId,
            runId,
            current.event_sequence + 1,
            eventKind,
            identity.id,
            now,
            canonicalJson({ requested: current.status === "leased" }),
            runId,
            identity.organizationId,
            now,
            identity.id,
          ),
      ]);
      const persisted = await getDiagnosticRun(identity, runId);
      if (persisted.run.cancelRequestedAt === now) return persisted;
    } catch (error) {
      if (!isRunRace(error)) throw mapRunDatabaseError(error);
    }
    await retryJitter();
  }
  throw new RunRepositoryError("conflict_retry", 409);
}

export async function claimDiagnosticLease(
  input: SignedRequest & {
    operationId: string;
    operationRequestHash: string;
  },
): Promise<SignedRunResult> {
  const nonceReplay = await findNonceReplay(input);
  if (nonceReplay) return nonceReplay;
  const operationReplay = await replayOperation(input);
  if (operationReplay) return operationReplay;

  for (let attempt = 0; attempt < CLAIM_RETRY_LIMIT; attempt += 1) {
    const { current, foreignRunnerLease, admission } =
      await evaluateDiagnosticClaim(input);

    const leaseId = generateLeaseId();
    const fence = current.lease_generation + 1;
    const expiresAt = new Date(
      Math.min(
        Date.parse(input.now) + leaseTtlMs(),
        Date.parse(current.deadline_at),
      ),
    ).toISOString();
    const response = canonicalJson({
      cancelRequested: Boolean(current.cancel_requested_at),
      expiresAt,
      fence,
      leaseId,
      runId: input.runId,
    } satisfies LeaseClaim);
    const d1 = getD1();
    const statements: D1PreparedStatement[] = [];
    let eventSequence = current.event_sequence;
    if (foreignRunnerLease) {
      statements.push(
        prepareExpiredLeaseUpdate(d1, {
          leaseId: foreignRunnerLease.id,
          runId: foreignRunnerLease.run_id,
          runnerId: input.runner.id,
          now: input.now,
        }),
        prepareGuardedSupersededEvent(d1, {
          organizationId: input.runner.organizationId,
          runId: foreignRunnerLease.run_id,
          sequence: foreignRunnerLease.event_sequence + 1,
          actorId: input.runner.principalId,
          fence: foreignRunnerLease.fence,
          occurredAt: input.now,
          leaseId: foreignRunnerLease.id,
          runnerId: input.runner.id,
        }),
      );
    }
    if (
      current.status === "leased" &&
      current.current_lease_id &&
      current.lease_status === "active"
    ) {
      statements.push(
        prepareExpiredLeaseUpdate(d1, {
          leaseId: current.current_lease_id,
          runId: input.runId,
          runnerId: current.lease_runner_id ?? "",
          now: input.now,
        }),
      );
      eventSequence += 1;
      statements.push(
        prepareGuardedSupersededEvent(d1, {
          organizationId: input.runner.organizationId,
          runId: input.runId,
          sequence: eventSequence,
          actorId: input.runner.principalId,
          fence: current.lease_generation,
          occurredAt: input.now,
          leaseId: current.current_lease_id,
          runnerId: current.lease_runner_id ?? "",
        }),
      );
    }
    statements.push(
      d1
        .prepare(
          `INSERT INTO run_leases (
            id, organization_id, run_id, runner_id, fence, status,
            issued_at, expires_at, renew_count, admission_basis,
            admission_policy_source, admission_policy_version,
            admission_freshness_seconds, admission_required_capability,
            admission_report_id, admission_report_received_at,
            created_at, updated_at
          )
          SELECT
            ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM runs
            WHERE id = ? AND organization_id = ?
              AND kind = 'diagnostic' AND engine IS NULL
          )
            AND NOT EXISTS (
              SELECT 1 FROM run_leases
              WHERE runner_id = ? AND organization_id = ?
                AND status = 'active'
            )`,
        )
        .bind(
          leaseId,
          input.runner.organizationId,
          input.runId,
          input.runner.id,
          fence,
          input.now,
          expiresAt,
          admission.admissionBasis,
          admission.admissionPolicySource,
          admission.admissionPolicyVersion,
          admission.admissionFreshnessSeconds,
          admission.admissionRequiredCapability,
          admission.admissionReportId,
          admission.admissionReportReceivedAt,
          input.now,
          input.now,
          input.runId,
          input.runner.organizationId,
          input.runner.id,
          input.runner.organizationId,
        ),
    );
    statements.push(
      d1
        .prepare(
          `INSERT INTO runner_operations (
            run_id, operation_id, request_hash, fence, response_status,
            response_body, replay_count, applied_at
          ) VALUES (?, ?, ?, ?, 200, ?, 0, ?)`,
        )
        .bind(
          input.runId,
          input.operationId,
          input.operationRequestHash,
          fence,
          response,
          input.now,
        ),
    );
    eventSequence += 1;
    statements.push(
      prepareRunEvent(d1, {
        organizationId: input.runner.organizationId,
        runId: input.runId,
        sequence: eventSequence,
        kind: "lease.claimed",
        actorId: input.runner.principalId,
        fence,
        occurredAt: input.now,
        metadata: leaseClaimedMetadata(admission, {
          leaseId,
          operationId: input.operationId,
        }),
      }),
      prepareNonceInsert(d1, input, 200, response),
      prepareRunnerSeen(d1, input),
    );
    try {
      await d1.batch(statements);
      void cleanupRunOperationalState(
        input.runner.organizationId,
        input.now,
      ).catch(() => undefined);
      return { status: 200, body: response, replay: false };
    } catch (error) {
      const replay = await findNonceReplay(input).catch(() => undefined);
      if (replay) return replay;
      const operation = await replayOperation(input).catch((replayError) => {
        throw replayError;
      });
      if (operation) return operation;
      if (!isRunRace(error)) throw mapRunDatabaseError(error);
      await evaluateDiagnosticClaim(input);
      await retryJitter();
    }
  }
  throw new RunRepositoryError("conflict_retry", 409);
}

export async function claimEngineLease(
  input: SignedRequest & {
    engine: ExecutionEngineName;
    operationId: string;
    operationRequestHash: string;
  },
): Promise<SignedRunResult> {
  const nonceReplay = await findNonceReplay(input);
  if (nonceReplay) return nonceReplay;
  const operationReplay = await replayOperation(input);
  if (operationReplay) return operationReplay;

  for (let attempt = 0; attempt < CLAIM_RETRY_LIMIT; attempt += 1) {
    const { current, foreignRunnerLease, admission } =
      await evaluateEngineClaim(input);
    const leaseId = generateLeaseId();
    const fence = current.lease_generation + 1;
    const expiresAt = new Date(
      Math.min(
        Date.parse(input.now) + leaseTtlMs(),
        Date.parse(current.deadline_at),
      ),
    ).toISOString();
    const response = canonicalEngineLeaseClaimDescriptor(
      buildEngineLeaseClaimDescriptor({
        cancelRequested: Boolean(current.cancel_requested_at),
        deadlineAt: current.deadline_at,
        engine: admission.admissionEngine,
        engineVersion: admission.admissionEngineVersion,
        expiresAt,
        fence,
        leaseId,
        ...(current.agent_model === null
          ? {}
          : { model: current.agent_model }),
        promptBytes: current.prompt_bytes,
        promptRef: current.prompt_ref,
        promptSha256: current.prompt_sha256,
        runId: input.runId,
        timeoutMs: admission.timeoutMs,
      }),
    );
    const d1 = getD1();
    const statements: D1PreparedStatement[] = [];
    let eventSequence = current.event_sequence;
    if (foreignRunnerLease) {
      statements.push(
        prepareExpiredLeaseUpdate(d1, {
          leaseId: foreignRunnerLease.id,
          runId: foreignRunnerLease.run_id,
          runnerId: input.runner.id,
          now: input.now,
        }),
        prepareGuardedSupersededEvent(d1, {
          organizationId: input.runner.organizationId,
          runId: foreignRunnerLease.run_id,
          sequence: foreignRunnerLease.event_sequence + 1,
          actorId: input.runner.principalId,
          fence: foreignRunnerLease.fence,
          occurredAt: input.now,
          leaseId: foreignRunnerLease.id,
          runnerId: input.runner.id,
        }),
      );
    }
    if (
      current.status === "leased" &&
      current.current_lease_id &&
      current.lease_status === "active"
    ) {
      statements.push(
        prepareExpiredLeaseUpdate(d1, {
          leaseId: current.current_lease_id,
          runId: input.runId,
          runnerId: current.lease_runner_id ?? "",
          now: input.now,
        }),
      );
      eventSequence += 1;
      statements.push(
        prepareGuardedSupersededEvent(d1, {
          organizationId: input.runner.organizationId,
          runId: input.runId,
          sequence: eventSequence,
          actorId: input.runner.principalId,
          fence: current.lease_generation,
          occurredAt: input.now,
          leaseId: current.current_lease_id,
          runnerId: current.lease_runner_id ?? "",
        }),
      );
    }
    statements.push(
      d1
        .prepare(
          `INSERT INTO run_leases (
            id, organization_id, run_id, runner_id, fence, status,
            issued_at, expires_at, renew_count, admission_basis,
            admission_policy_source, admission_policy_version,
            admission_freshness_seconds, admission_required_capability,
            admission_report_id, admission_report_received_at,
            admission_engine, admission_engine_report_id,
            admission_engine_report_received_at, admission_engine_version,
            created_at, updated_at
          )
          SELECT
            ?, ?, ?, ?, ?, 'active', ?, ?, 0, 'engine_inventory',
            ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM runs
            WHERE id = ? AND organization_id = ?
              AND kind = 'engine_prompt' AND engine = ?
              AND assigned_runner_id = ?
          )
            AND NOT EXISTS (
              SELECT 1 FROM run_leases
              WHERE runner_id = ? AND organization_id = ?
                AND status = 'active'
            )`,
        )
        .bind(
          leaseId,
          input.runner.organizationId,
          input.runId,
          input.runner.id,
          fence,
          input.now,
          expiresAt,
          admission.admissionPolicySource,
          admission.admissionPolicyVersion,
          admission.admissionFreshnessSeconds,
          admission.admissionEngine,
          admission.admissionEngineReportId,
          admission.admissionEngineReportReceivedAt,
          admission.admissionEngineVersion,
          input.now,
          input.now,
          input.runId,
          input.runner.organizationId,
          input.engine,
          input.runner.id,
          input.runner.id,
          input.runner.organizationId,
        ),
      d1
        .prepare(
          `INSERT INTO runner_operations (
            run_id, operation_id, request_hash, fence, response_status,
            response_body, replay_count, applied_at
          ) VALUES (?, ?, ?, ?, 200, ?, 0, ?)`,
        )
        .bind(
          input.runId,
          input.operationId,
          input.operationRequestHash,
          fence,
          response,
          input.now,
        ),
    );
    eventSequence += 1;
    statements.push(
      prepareRunEvent(d1, {
        organizationId: input.runner.organizationId,
        runId: input.runId,
        sequence: eventSequence,
        kind: "lease.claimed",
        actorId: input.runner.principalId,
        fence,
        occurredAt: input.now,
        metadata: engineLeaseClaimedMetadata(admission, {
          leaseId,
          operationId: input.operationId,
        }),
      }),
      prepareNonceInsert(d1, input, 200, response),
      prepareRunnerSeen(d1, input),
    );
    try {
      await d1.batch(statements);
      void cleanupRunOperationalState(
        input.runner.organizationId,
        input.now,
      ).catch(() => undefined);
      return { status: 200, body: response, replay: false };
    } catch (error) {
      const replay = await findNonceReplay(input).catch(() => undefined);
      if (replay) return replay;
      const operation = await replayOperation(input).catch((replayError) => {
        throw replayError;
      });
      if (operation) return operation;
      if (!isRunRace(error)) throw mapRunDatabaseError(error);
      await evaluateEngineClaim(input);
      await retryJitter();
    }
  }
  throw new RunRepositoryError("conflict_retry", 409);
}

export async function readEnginePromptForLease(
  input: SignedRequest & {
    leaseId: string;
    fence: number;
    promptRef: string;
    cipher: PromptCipher;
  },
): Promise<EnginePromptReadResult> {
  const sentinel = canonicalJson(
    buildEnginePromptReadSentinel(input.promptRef),
  );
  const replay = await findPromptReadNonce(input, sentinel);
  if (replay) {
    const authorized = await authorizeEnginePromptRead(input);
    return decryptEnginePrompt(input, authorized, true);
  }

  for (let attempt = 0; attempt < CLAIM_RETRY_LIMIT; attempt += 1) {
    const d1 = getD1();
    try {
      const results = await d1.batch([
        prepareGuardedPromptReadNonce(d1, input, sentinel),
        prepareGuardedPromptReadRunnerSeen(d1, input, sentinel),
        prepareAuthorizedPromptRead(d1, input),
      ]);
      const prompt = firstResultRow<EnginePromptCipherRow>(results[2]);
      if (
        Number(results[0]?.meta.changes) === 1 &&
        prompt
      ) {
        void cleanupRunOperationalState(
          input.runner.organizationId,
          input.now,
        ).catch(() => undefined);
        return decryptEnginePrompt(input, prompt, false);
      }
      await authorizeEnginePromptRead(input);
      await retryJitter();
    } catch (error) {
      const racedReplay = await findPromptReadNonce(input, sentinel);
      if (racedReplay) {
        const authorized = await authorizeEnginePromptRead(input);
        return decryptEnginePrompt(input, authorized, true);
      }
      if (!isRunRace(error)) throw mapRunDatabaseError(error);
      await authorizeEnginePromptRead(input);
      await retryJitter();
    }
  }
  throw new RunRepositoryError("conflict_retry", 409);
}

async function findPromptReadNonce(
  input: SignedRequest,
  sentinel: string,
): Promise<boolean> {
  const row = await getD1()
    .prepare(
      `SELECT request_hash, response_status, response_body
       FROM runner_lease_nonces
       WHERE runner_id = ? AND nonce = ?
       LIMIT 1`,
    )
    .bind(input.runner.id, input.nonce)
    .first<{
      request_hash: string;
      response_status: number;
      response_body: string;
    }>();
  if (!row) return false;
  if (row.request_hash !== input.signedRequestHash) {
    throw new RunRepositoryError("nonce_reused", 409);
  }
  if (row.response_status !== 200 || row.response_body !== sentinel) {
    throw new RunRepositoryError("run_operation_failed", 500);
  }
  return true;
}

async function authorizeEnginePromptRead(
  input: SignedRequest & {
    leaseId: string;
    fence: number;
    promptRef: string;
  },
): Promise<EnginePromptCipherRow> {
  const d1 = getD1();
  const results = await d1.batch([
    prepareActiveRunnerRead(d1, input),
    preparePromptReadSnapshot(d1, input),
  ]);
  const runnerActive =
    firstResultRow<RunnerActivityRow>(results[0])?.active === 1;
  const current =
    firstResultRow<EnginePromptCipherRow>(results[1]) ?? null;
  const evaluation = evaluateEnginePromptRead(
    toEnginePromptReadSnapshot(input, runnerActive, current),
  );
  if (evaluation.kind === "denied") {
    throw new RunRepositoryError(evaluation.code, evaluation.status);
  }
  if (!current) {
    throw new RunRepositoryError("run_unavailable", 409);
  }
  return current;
}

function toEnginePromptReadSnapshot(
  input: SignedRequest & {
    leaseId: string;
    fence: number;
    promptRef: string;
  },
  runnerActive: boolean,
  current: EnginePromptCipherRow | null,
): EnginePromptReadSnapshot {
  return {
    runnerActive,
    runnerId: input.runner.id,
    runnerOrganizationId: input.runner.organizationId,
    now: input.now,
    leaseId: input.leaseId,
    fence: input.fence,
    promptRef: input.promptRef,
    run: current
      ? {
          organizationId: current.organization_id,
          kind: current.kind,
          engine: current.engine,
          status: current.status,
          cancelRequestedAt: current.cancel_requested_at,
          assignedRunnerId: current.assigned_runner_id,
          currentLeaseId: current.current_lease_id,
          leaseGeneration: current.lease_generation,
          leaseRunnerId: current.lease_runner_id,
          leaseStatus: current.lease_status,
          leaseExpiresAt: current.lease_expires_at,
          storedPromptRef: current.prompt_ref,
          promptErasedAt: current.prompt_erased_at,
        }
      : null,
  };
}

function prepareActiveRunnerRead(
  d1: D1Database,
  input: SignedRequest,
): D1PreparedStatement {
  return d1
    .prepare(
      `SELECT 1 AS active
       FROM runners AS runner
       INNER JOIN principals AS principal
         ON principal.id = runner.principal_id
        AND principal.organization_id = runner.organization_id
       WHERE runner.id = ? AND runner.organization_id = ?
         AND runner.principal_id = ?
         AND runner.status = 'active'
         AND principal.kind = 'runner'
         AND principal.status = 'active'
       LIMIT 1`,
    )
    .bind(
      input.runner.id,
      input.runner.organizationId,
      input.runner.principalId,
    );
}

function preparePromptReadSnapshot(
  d1: D1Database,
  input: SignedRequest,
): D1PreparedStatement {
  return d1
    .prepare(`${ENGINE_PROMPT_READ_QUERY}\nLIMIT 1`)
    .bind(input.runId, input.runner.organizationId);
}

function prepareGuardedPromptReadNonce(
  d1: D1Database,
  input: SignedRequest & {
    leaseId: string;
    fence: number;
    promptRef: string;
  },
  sentinel: string,
): D1PreparedStatement {
  const expiresAt = new Date(
    Date.parse(input.now) + RUNNER_LEASE_NONCE_TTL_MS,
  ).toISOString();
  return d1
    .prepare(
      `INSERT INTO runner_lease_nonces (
        organization_id, runner_id, nonce, request_hash, response_status,
        response_body, occurred_at, expires_at
      )
      SELECT ?, ?, ?, ?, 200, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM runners AS runner
        INNER JOIN principals AS principal
          ON principal.id = runner.principal_id
         AND principal.organization_id = runner.organization_id
        WHERE runner.id = ? AND runner.organization_id = ?
          AND runner.principal_id = ?
          AND runner.status = 'active'
          AND principal.kind = 'runner'
          AND principal.status = 'active'
      )
        AND EXISTS (
          SELECT 1
          FROM runs AS run
          INNER JOIN run_prompts AS prompt
            ON prompt.run_id = run.id
           AND prompt.organization_id = run.organization_id
          INNER JOIN run_leases AS lease
            ON lease.id = run.current_lease_id
           AND lease.organization_id = run.organization_id
           AND lease.run_id = run.id
          WHERE run.id = ? AND run.organization_id = ?
            AND run.kind = 'engine_prompt' AND run.engine IS NOT NULL
            AND run.status = 'leased'
            AND run.cancel_requested_at IS NULL
            AND run.assigned_runner_id = ?
            AND run.current_lease_id = ?
            AND run.lease_generation = ?
            AND lease.id = ? AND lease.runner_id = ?
            AND lease.fence = ? AND lease.status = 'active'
            AND lease.expires_at > ?
            AND prompt.prompt_ref = ?
            AND prompt.erased_at IS NULL
            AND prompt.key_id IS NOT NULL
            AND prompt.iv IS NOT NULL
            AND prompt.ciphertext IS NOT NULL
            AND prompt.tag IS NOT NULL
        )`,
    )
    .bind(
      input.runner.organizationId,
      input.runner.id,
      input.nonce,
      input.signedRequestHash,
      sentinel,
      input.now,
      expiresAt,
      input.runner.id,
      input.runner.organizationId,
      input.runner.principalId,
      input.runId,
      input.runner.organizationId,
      input.runner.id,
      input.leaseId,
      input.fence,
      input.leaseId,
      input.runner.id,
      input.fence,
      input.now,
      input.promptRef,
    );
}

function prepareGuardedPromptReadRunnerSeen(
  d1: D1Database,
  input: SignedRequest,
  sentinel: string,
): D1PreparedStatement {
  return d1
    .prepare(
      `UPDATE runners
       SET last_seen_at = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'active'
         AND (last_seen_at IS NULL OR last_seen_at < ?)
         AND EXISTS (
           SELECT 1
           FROM runner_lease_nonces AS nonce
           WHERE nonce.runner_id = ?
             AND nonce.nonce = ?
             AND nonce.request_hash = ?
             AND nonce.response_status = 200
             AND nonce.response_body = ?
             AND nonce.occurred_at = ?
         )`,
    )
    .bind(
      input.now,
      input.now,
      input.runner.id,
      input.runner.organizationId,
      input.now,
      input.runner.id,
      input.nonce,
      input.signedRequestHash,
      sentinel,
      input.now,
    );
}

function prepareAuthorizedPromptRead(
  d1: D1Database,
  input: SignedRequest & {
    leaseId: string;
    fence: number;
    promptRef: string;
  },
): D1PreparedStatement {
  return d1
    .prepare(
      `${ENGINE_PROMPT_READ_QUERY}
       AND run.status = 'leased'
       AND run.cancel_requested_at IS NULL
       AND run.assigned_runner_id = ?
       AND run.current_lease_id = ?
       AND run.lease_generation = ?
       AND lease.id = ? AND lease.runner_id = ?
       AND lease.fence = ? AND lease.status = 'active'
       AND lease.expires_at > ?
       AND prompt.prompt_ref = ?
       AND prompt.erased_at IS NULL
       LIMIT 1`,
    )
    .bind(
      input.runId,
      input.runner.organizationId,
      input.runner.id,
      input.leaseId,
      input.fence,
      input.leaseId,
      input.runner.id,
      input.fence,
      input.now,
      input.promptRef,
    );
}

async function decryptEnginePrompt(
  input: SignedRequest & {
    cipher: PromptCipher;
  },
  row: EnginePromptCipherRow,
  replay: boolean,
): Promise<EnginePromptReadResult> {
  let body: Uint8Array;
  try {
    if (
      row.cipher_version !== PROMPT_CIPHER_VERSION ||
      !row.key_id ||
      row.iv === null ||
      row.ciphertext === null ||
      row.tag === null
    ) {
      throw new Error("Invalid prompt cipher row.");
    }
    body = await input.cipher.decrypt(
      {
        cipherVersion: PROMPT_CIPHER_VERSION,
        keyId: row.key_id,
        iv: promptBlob(row.iv),
        ciphertext: promptBlob(row.ciphertext),
        tag: promptBlob(row.tag),
      },
      {
        organizationId: input.runner.organizationId,
        payloadRef: row.prompt_ref,
        runId: input.runId,
      },
    );
    const digest = await sha256Bytes(body);
    if (
      body.byteLength !== row.prompt_bytes ||
      digest.hex !== row.prompt_sha256
    ) {
      throw new Error("Prompt digest mismatch.");
    }
  } catch {
    throw new RunRepositoryError("prompt_cipher_key_unavailable", 503);
  }
  return {
    body,
    promptRef: row.prompt_ref,
    promptSha256: row.prompt_sha256,
    promptBytes: row.prompt_bytes,
    replay,
  };
}

function promptBlob(
  value: ArrayBuffer | ArrayBufferView | number[],
): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      ),
    );
  }
  if (
    Array.isArray(value) &&
    value.every(
      (byte) =>
        Number.isSafeInteger(byte) &&
        byte >= 0 &&
        byte <= 255,
    )
  ) {
    return Uint8Array.from(value);
  }
  throw new RunRepositoryError("prompt_cipher_key_unavailable", 503);
}

function prepareExpiredLeaseUpdate(
  d1: D1Database,
  input: {
    leaseId: string;
    runId: string;
    runnerId: string;
    now: string;
  },
): D1PreparedStatement {
  return d1
    .prepare(
      `UPDATE run_leases
       SET status = 'superseded', ended_at = ?,
           ended_reason = 'expired', updated_at = ?
       WHERE id = ? AND run_id = ? AND runner_id = ?
         AND status = 'active' AND expires_at <= ?`,
    )
    .bind(
      input.now,
      input.now,
      input.leaseId,
      input.runId,
      input.runnerId,
      input.now,
    );
}

function prepareGuardedSupersededEvent(
  d1: D1Database,
  event: {
    organizationId: string;
    runId: string;
    sequence: number;
    actorId: string;
    fence: number;
    occurredAt: string;
    leaseId: string;
    runnerId: string;
  },
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, fence,
        occurred_at, metadata_json
      )
      SELECT ?, ?, ?, 'lease.superseded', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM run_leases
        WHERE id = ? AND run_id = ? AND runner_id = ?
          AND fence = ? AND status = 'superseded'
          AND ended_at = ? AND ended_reason = 'expired'
      )`,
    )
    .bind(
      event.organizationId,
      event.runId,
      event.sequence,
      event.actorId,
      event.fence,
      event.occurredAt,
      canonicalJson({
        leaseId: event.leaseId,
        runnerId: event.runnerId,
        fence: event.fence,
        reason: "expired",
      }),
      event.leaseId,
      event.runId,
      event.runnerId,
      event.fence,
      event.occurredAt,
    );
}

export async function renewRunLease(
  input: SignedRequest & {
    leaseId: string;
    fence: number;
  },
): Promise<SignedRunResult> {
  const nonceReplay = await findNonceReplay(input);
  if (nonceReplay) return nonceReplay;
  for (let attempt = 0; attempt < CLAIM_RETRY_LIMIT; attempt += 1) {
    const current = await loadSharedRunLeaseHead(input.runId);
    assertCurrentLease(input, current);
    if (
      !current?.lease_expires_at ||
      current.lease_expires_at <= input.now ||
      current.deadline_at <= input.now
    ) {
      throw new RunRepositoryError("lease_expired", 410);
    }
    const expiresAt = new Date(
      Math.min(
        Date.parse(input.now) + leaseTtlMs(),
        Date.parse(current.deadline_at),
      ),
    ).toISOString();
    if (
      current.kind === "engine_prompt" &&
      current.lease_expires_at &&
      expiresAt <= current.lease_expires_at
    ) {
      throw new RunRepositoryError(
        "engine_deadline_insufficient",
        409,
      );
    }
    const response = canonicalJson({
      cancelRequested: Boolean(current.cancel_requested_at),
      expiresAt,
      fence: input.fence,
      leaseId: input.leaseId,
      runId: input.runId,
    } satisfies LeaseRenewal);
    const d1 = getD1();
    try {
      const results = await d1.batch([
        d1
          .prepare(
            `UPDATE run_leases
             SET expires_at = ?, renewed_at = ?, renew_count = renew_count + 1,
                 updated_at = ?
             WHERE id = ? AND run_id = ? AND runner_id = ?
               AND fence = ? AND status = 'active' AND expires_at > ?
               AND EXISTS (
                 SELECT 1 FROM runs
                 WHERE runs.id = run_leases.run_id
                   AND (
                     (runs.kind = 'diagnostic' AND runs.engine IS NULL)
                     OR
                     (
                       runs.kind = 'engine_prompt'
                       AND runs.engine = run_leases.admission_engine
                       AND ? <= runs.deadline_at
                     )
                   )
               )`,
          )
          .bind(
            expiresAt,
            input.now,
            input.now,
            input.leaseId,
            input.runId,
            input.runner.id,
            input.fence,
            input.now,
            expiresAt,
          ),
        prepareGuardedRenewalEvent(d1, {
          organizationId: input.runner.organizationId,
          runId: input.runId,
          sequence: current.event_sequence + 1,
          actorId: input.runner.principalId,
          fence: input.fence,
          occurredAt: input.now,
          expiresAt,
          leaseId: input.leaseId,
          runnerId: input.runner.id,
          renewCount: current.lease_renew_count + 1,
        }),
        prepareGuardedRenewalNonceInsert(d1, {
          ...input,
          eventSequence: current.event_sequence + 1,
          status: 200,
          body: response,
        }),
        prepareRunnerSeen(d1, input),
      ]);
      if (
        Number(results[0]?.meta.changes) === 1 &&
        Number(results[1]?.meta.changes) === 1 &&
        Number(results[2]?.meta.changes) === 1
      ) {
        void cleanupRunOperationalState(
          input.runner.organizationId,
          input.now,
        ).catch(() => undefined);
        return { status: 200, body: response, replay: false };
      }
      await retryJitter();
    } catch (error) {
      const replay = await findNonceReplay(input).catch(() => undefined);
      if (replay) return replay;
      if (!isRunRace(error)) throw mapRunDatabaseError(error);
      await retryJitter();
    }
  }
  throw new RunRepositoryError("conflict_retry", 409);
}

export async function completeDiagnosticRun(
  input: SignedRequest & {
    leaseId: string;
    fence: number;
    operationId: string;
    operationRequestHash: string;
    outcomeStatus: RunOutcomeStatus;
    outcomeSummary: string;
  },
): Promise<SignedRunResult> {
  const nonceReplay = await findNonceReplay(input);
  if (nonceReplay) return nonceReplay;
  const operationReplay = await replayOperation(input);
  if (operationReplay) return operationReplay;

  for (let attempt = 0; attempt < LEDGER_RETRY_LIMIT; attempt += 1) {
    const current = await loadRunLeaseHead(input.runId);
    assertCurrentLease(input, current);
    if (
      current?.cancel_requested_at &&
      input.outcomeStatus !== "canceled"
    ) {
      throw new RunRepositoryError("cancellation_required", 409);
    }
    const late = Boolean(
      current?.lease_expires_at &&
        current.lease_expires_at <= input.now,
    );
    const response = canonicalJson({
      late,
      recordedAt: input.now,
      runId: input.runId,
      status: "completed",
    } satisfies RunCompletion);
    const ledgerEvent: LedgerEvent = {
      id: crypto.randomUUID(),
      organizationId: input.runner.organizationId,
      kind: "run.completed",
      actorId: input.runner.principalId,
      occurredAt: input.now,
      payloadHash: await hashCanonical({
        fence: input.fence,
        late,
        operationId: input.operationId,
        outcomeStatus: input.outcomeStatus,
        runId: input.runId,
      }),
      payloadRef: runRef(input.runId),
      runId: input.runId,
    };
    const ledgerEntry = await nextLedgerEntry(
      input.runner.organizationId,
      ledgerEvent,
    );
    const d1 = getD1();
    try {
      await d1.batch([
        d1
          .prepare(
            `INSERT INTO runner_operations (
              run_id, operation_id, request_hash, fence, response_status,
              response_body, replay_count, applied_at
            ) VALUES (?, ?, ?, ?, 200, ?, 0, ?)`,
          )
          .bind(
            input.runId,
            input.operationId,
            input.operationRequestHash,
            input.fence,
            response,
            input.now,
          ),
        d1
          .prepare(
            `UPDATE runs
             SET status = 'completed', outcome_status = ?,
                 outcome_summary = ?, completed_operation_id = ?,
                 recorded_at = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND organization_id = ?
               AND kind = 'diagnostic' AND engine IS NULL
               AND status = 'leased'
               AND current_lease_id = ? AND lease_generation = ?`,
          )
          .bind(
            input.outcomeStatus,
            input.outcomeSummary,
            input.operationId,
            input.now,
            input.now,
            input.runId,
            input.runner.organizationId,
            input.leaseId,
            input.fence,
          ),
        d1
          .prepare(
            `UPDATE run_leases
             SET status = 'released', ended_at = ?,
                 ended_reason = 'diagnostic_complete', updated_at = ?
             WHERE id = ? AND run_id = ? AND runner_id = ?
               AND fence = ? AND status = 'active'`,
          )
          .bind(
            input.now,
            input.now,
            input.leaseId,
            input.runId,
            input.runner.id,
            input.fence,
          ),
        prepareRunEvent(d1, {
          organizationId: input.runner.organizationId,
          runId: input.runId,
          sequence: (current?.event_sequence ?? 0) + 1,
          kind: "lease.released",
          actorId: input.runner.principalId,
          fence: input.fence,
          occurredAt: input.now,
          metadata: {
            reason: "diagnostic_complete",
          },
        }),
        prepareRunEvent(d1, {
          organizationId: input.runner.organizationId,
          runId: input.runId,
          sequence: (current?.event_sequence ?? 0) + 2,
          kind: "run.completed",
          actorId: input.runner.principalId,
          fence: input.fence,
          occurredAt: input.now,
          metadata: {
            late,
            operationId: input.operationId,
            outcomeStatus: input.outcomeStatus,
          },
        }),
        prepareNonceInsert(d1, input, 200, response),
        prepareRunnerSeen(d1, input),
        prepareRunLedgerInsert(d1, ledgerEntry, input.runId),
      ]);
      void cleanupRunOperationalState(
        input.runner.organizationId,
        input.now,
      ).catch(() => undefined);
      return { status: 200, body: response, replay: false };
    } catch (error) {
      const replay = await findNonceReplay(input).catch(() => undefined);
      if (replay) return replay;
      const operation = await replayOperation(input).catch((replayError) => {
        throw replayError;
      });
      if (operation) return operation;
      if (!isRunRace(error) && !isLedgerSequenceConflict(error)) {
        throw mapRunDatabaseError(error);
      }
      await retryJitter();
    }
  }
  throw new RunRepositoryError("conflict_retry", 409);
}

export async function completeEngineRun(
  input: SignedRequest & {
    leaseId: string;
    fence: number;
    operationId: string;
    operationRequestHash: string;
    receipt: EngineExecutionResult;
    resolveCipher: () => PromptCipher;
  },
): Promise<SignedRunResult> {
  const nonceReplay = await findNonceReplay(input);
  if (nonceReplay) return nonceReplay;
  const operationReplay = await replayOperation(input);
  if (operationReplay) return operationReplay;

  for (let attempt = 0; attempt < LEDGER_RETRY_LIMIT; attempt += 1) {
    const current = await loadEngineCompletionHead(input);
    assertCurrentEngineCompletionLease(input, current);
    if (input.now >= current.lease_expires_at) {
      throw new RunRepositoryError("lease_expired", 409);
    }
    if (
      input.now > current.deadline_at ||
      current.deadline_operation_exists === 1
    ) {
      throw new RunRepositoryError("engine_deadline_exhausted", 409);
    }
    if (input.receipt.engine !== current.engine) {
      throw new RunRepositoryError("engine_mismatch", 409);
    }
    if (
      input.receipt.engineVersion !== current.admission_engine_version
    ) {
      throw new RunRepositoryError("engine_version_mismatch", 409);
    }
    if (
      input.receipt.cancelRequested &&
      current.cancel_requested_at === null
    ) {
      throw new RunRepositoryError("cancellation_not_requested", 409);
    }

    const stdout = decodeEngineExcerptBase64Url(
      input.receipt.stdout.excerptBase64Url,
    );
    const stderr = decodeEngineExcerptBase64Url(
      input.receipt.stderr.excerptBase64Url,
    );
    const framedExcerpts = frameEngineExcerpts(stdout, stderr);
    const excerptRef = generateEngineExcerptRef();
    const excerptSha256 = (await sha256Bytes(framedExcerpts)).hex;
    const receiptSha256 = await hashCanonical({
      cancelRequested: input.receipt.cancelRequested,
      engine: input.receipt.engine,
      engineVersion: input.receipt.engineVersion,
      excerptRef,
      excerptSha256,
      exitCode: input.receipt.exitCode,
      fence: input.fence,
      finishedAt: input.receipt.finishedAt,
      leaseId: input.leaseId,
      operationId: input.operationId,
      organizationId: input.runner.organizationId,
      reason: input.receipt.reason,
      recordedAt: input.now,
      runId: input.runId,
      startedAt: input.receipt.startedAt,
      status: input.receipt.status,
      stderrBytes: input.receipt.stderr.bytes,
      stderrExcerptBytes: stderr.byteLength,
      stderrSha256: input.receipt.stderr.sha256,
      stderrTruncated: input.receipt.stderr.truncated,
      stdoutBytes: input.receipt.stdout.bytes,
      stdoutExcerptBytes: stdout.byteLength,
      stdoutSha256: input.receipt.stdout.sha256,
      stdoutTruncated: input.receipt.stdout.truncated,
      timedOut: input.receipt.timedOut,
    });
    let envelope;
    try {
      envelope = await input.resolveCipher().encrypt(framedExcerpts, {
        organizationId: input.runner.organizationId,
        payloadRef: excerptRef,
        runId: input.runId,
      });
    } catch {
      throw new RunRepositoryError(
        "prompt_cipher_key_unavailable",
        503,
      );
    }
    const response = canonicalJson({
      late: false,
      recordedAt: input.now,
      runId: input.runId,
      status: "completed",
    } satisfies RunCompletion);
    const outcomeSummary =
      input.receipt.status === "succeeded"
        ? "completed"
        : input.receipt.reason;
    const eventMetadata = {
      engine: input.receipt.engine,
      engineVersion: input.receipt.engineVersion,
      operationId: input.operationId,
      outcomeStatus: input.receipt.status,
      reason: input.receipt.reason,
      receiptSha256,
      stderrBytes: input.receipt.stderr.bytes,
      stdoutBytes: input.receipt.stdout.bytes,
    } as const;
    const ledgerEvent: LedgerEvent = {
      id: crypto.randomUUID(),
      organizationId: input.runner.organizationId,
      kind: "run.completed",
      actorId: input.runner.principalId,
      occurredAt: input.now,
      payloadHash: await hashCanonical({
        engine: input.receipt.engine,
        engineVersion: input.receipt.engineVersion,
        fence: input.fence,
        operationId: input.operationId,
        outcomeStatus: input.receipt.status,
        reason: input.receipt.reason,
        receiptSha256,
        runId: input.runId,
        stderrBytes: input.receipt.stderr.bytes,
        stdoutBytes: input.receipt.stdout.bytes,
      }),
      payloadRef: runRef(input.runId),
      runId: input.runId,
    };
    const ledgerEntry = await nextLedgerEntry(
      input.runner.organizationId,
      ledgerEvent,
    );
    const d1 = getD1();
    try {
      await d1.batch([
        d1
          .prepare(
            `INSERT INTO runner_operations (
              run_id, operation_id, request_hash, fence, response_status,
              response_body, replay_count, applied_at
            ) VALUES (?, ?, ?, ?, 200, ?, 0, ?)`,
          )
          .bind(
            input.runId,
            input.operationId,
            input.operationRequestHash,
            input.fence,
            response,
            input.now,
          ),
        d1
          .prepare(
            `INSERT INTO run_engine_excerpts (
              run_id, organization_id, excerpt_ref, cipher_version, key_id,
              iv, ciphertext, tag, stdout_excerpt_bytes,
              stderr_excerpt_bytes, excerpt_sha256, created_at, erased_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .bind(
            input.runId,
            input.runner.organizationId,
            excerptRef,
            envelope.cipherVersion,
            envelope.keyId,
            envelope.iv,
            envelope.ciphertext,
            envelope.tag,
            stdout.byteLength,
            stderr.byteLength,
            excerptSha256,
            input.now,
          ),
        d1
          .prepare(
            `INSERT INTO run_engine_receipts (
              run_id, organization_id, operation_id, excerpt_ref,
              excerpt_sha256, lease_id, fence, engine, engine_version,
              status, reason, exit_code, timed_out, cancel_requested,
              started_at, finished_at, stdout_bytes, stdout_sha256,
              stdout_truncated, stdout_excerpt_bytes, stderr_bytes,
              stderr_sha256, stderr_truncated, stderr_excerpt_bytes,
              receipt_sha256, recorded_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?
            )`,
          )
          .bind(
            input.runId,
            input.runner.organizationId,
            input.operationId,
            excerptRef,
            excerptSha256,
            input.leaseId,
            input.fence,
            input.receipt.engine,
            input.receipt.engineVersion,
            input.receipt.status,
            input.receipt.reason,
            input.receipt.exitCode,
            input.receipt.timedOut ? 1 : 0,
            input.receipt.cancelRequested ? 1 : 0,
            input.receipt.startedAt,
            input.receipt.finishedAt,
            input.receipt.stdout.bytes,
            input.receipt.stdout.sha256,
            input.receipt.stdout.truncated ? 1 : 0,
            stdout.byteLength,
            input.receipt.stderr.bytes,
            input.receipt.stderr.sha256,
            input.receipt.stderr.truncated ? 1 : 0,
            stderr.byteLength,
            receiptSha256,
            input.now,
          ),
        d1
          .prepare(
            `UPDATE runs
             SET status = 'completed', outcome_status = ?,
                 outcome_summary = ?, completed_operation_id = ?,
                 recorded_at = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND organization_id = ?
               AND kind = 'engine_prompt' AND engine = ?
               AND status = 'leased'
               AND current_lease_id = ? AND lease_generation = ?`,
          )
          .bind(
            input.receipt.status,
            outcomeSummary,
            input.operationId,
            input.now,
            input.now,
            input.runId,
            input.runner.organizationId,
            input.receipt.engine,
            input.leaseId,
            input.fence,
          ),
        d1
          .prepare(
            `UPDATE run_leases
             SET status = 'released', ended_at = ?,
                 ended_reason = 'engine_complete', updated_at = ?
             WHERE id = ? AND organization_id = ? AND run_id = ?
               AND runner_id = ? AND fence = ? AND status = 'active'`,
          )
          .bind(
            input.now,
            input.now,
            input.leaseId,
            input.runner.organizationId,
            input.runId,
            input.runner.id,
            input.fence,
          ),
        prepareRunEvent(d1, {
          organizationId: input.runner.organizationId,
          runId: input.runId,
          sequence: current.event_sequence + 1,
          kind: "lease.released",
          actorId: input.runner.principalId,
          fence: input.fence,
          occurredAt: input.now,
          metadata: { reason: "engine_complete" },
        }),
        prepareRunEvent(d1, {
          organizationId: input.runner.organizationId,
          runId: input.runId,
          sequence: current.event_sequence + 2,
          kind: "run.completed",
          actorId: input.runner.principalId,
          fence: input.fence,
          occurredAt: input.now,
          metadata: eventMetadata,
        }),
        prepareNonceInsert(d1, input, 200, response),
        prepareRunnerSeen(d1, input),
        prepareRunLedgerInsert(d1, ledgerEntry, input.runId),
      ]);
      void cleanupRunOperationalState(
        input.runner.organizationId,
        input.now,
      ).catch(() => undefined);
      return { status: 200, body: response, replay: false };
    } catch (error) {
      const replay = await findNonceReplay(input).catch(() => undefined);
      if (replay) return replay;
      const operation = await replayOperation(input).catch(
        (replayError) => {
          throw replayError;
        },
      );
      if (operation) return operation;
      if (!isRunRace(error) && !isLedgerSequenceConflict(error)) {
        throw mapRunDatabaseError(error);
      }
      await retryJitter();
    }
  }
  throw new RunRepositoryError("conflict_retry", 409);
}

async function findNonceReplay(
  input: SignedRequest,
): Promise<SignedRunResult | undefined> {
  const row = await getD1()
    .prepare(
      `SELECT request_hash, response_status, response_body
       FROM runner_lease_nonces
       WHERE runner_id = ? AND nonce = ?
       LIMIT 1`,
    )
    .bind(input.runner.id, input.nonce)
    .first<{
      request_hash: string;
      response_status: number;
      response_body: string;
    }>();
  if (!row) return undefined;
  if (row.request_hash !== input.signedRequestHash) {
    throw new RunRepositoryError("nonce_reused", 409);
  }
  return {
    status: row.response_status,
    body: row.response_body,
    replay: true,
  };
}

async function replayOperation(
  input: SignedRequest & {
    operationId?: string;
    operationRequestHash?: string;
  },
): Promise<SignedRunResult | undefined> {
  if (!input.operationId || !input.operationRequestHash) return undefined;
  const operation = await getD1()
    .prepare(
      `SELECT
         operation.request_hash, operation.response_status,
         operation.response_body, operation.compacted_at,
         lease.runner_id
       FROM runner_operations operation
       INNER JOIN run_leases lease
         ON lease.run_id = operation.run_id
        AND lease.fence = operation.fence
       WHERE operation.run_id = ? AND operation.operation_id = ?
       LIMIT 1`,
    )
    .bind(input.runId, input.operationId)
    .first<{
      request_hash: string;
      response_status: number;
      response_body: string | null;
      compacted_at: string | null;
      runner_id: string;
    }>();
  if (!operation) return undefined;
  if (
    operation.request_hash !== input.operationRequestHash ||
    operation.runner_id !== input.runner.id
  ) {
    throw new RunRepositoryError("operation_conflict", 409);
  }
  if (operation.compacted_at || operation.response_body === null) {
    throw new RunRepositoryError("operation_horizon_exceeded", 410);
  }

  const d1 = getD1();
  try {
    await d1.batch([
      d1
        .prepare(
          `UPDATE runner_operations
           SET replay_count = replay_count + 1
           WHERE run_id = ? AND operation_id = ?
             AND request_hash = ? AND compacted_at IS NULL`,
        )
        .bind(
          input.runId,
          input.operationId,
          input.operationRequestHash,
        ),
      prepareNonceInsert(
        d1,
        input,
        operation.response_status,
        operation.response_body,
      ),
      prepareRunnerSeen(d1, input),
    ]);
  } catch (error) {
    const nonce = await findNonceReplay(input);
    if (nonce) return nonce;
    throw mapRunDatabaseError(error);
  }
  return {
    status: operation.response_status,
    body: operation.response_body,
    replay: true,
  };
}

function assertCurrentLease(
  input: SignedRequest & { leaseId: string; fence: number },
  current: RunLeaseHead | SharedRunLeaseHead | null,
): asserts current is RunLeaseHead | SharedRunLeaseHead {
  if (!current || current.organization_id !== input.runner.organizationId) {
    throw new RunRepositoryError("run_unavailable", 409);
  }
  if (
    current.status !== "leased" ||
    current.current_lease_id !== input.leaseId ||
    current.lease_generation !== input.fence ||
    current.lease_runner_id !== input.runner.id ||
    current.lease_status !== "active"
  ) {
    throw new RunRepositoryError("lease_superseded", 409);
  }
}

function assertCurrentEngineCompletionLease(
  input: SignedRequest & { leaseId: string; fence: number },
  current: EngineCompletionHead | null,
): asserts current is EngineCompletionHead & { lease_expires_at: string } {
  if (!current) {
    throw new RunRepositoryError("run_unavailable", 409);
  }
  if (
    current.status !== "leased" ||
    current.current_lease_id !== input.leaseId ||
    current.lease_generation !== input.fence ||
    current.lease_runner_id !== input.runner.id ||
    current.lease_status !== "active" ||
    current.lease_expires_at === null
  ) {
    throw new RunRepositoryError("lease_superseded", 409);
  }
}

const RUN_LEASE_HEAD_QUERY = `SELECT
  run.id AS run_id, run.organization_id, run.status, run.version,
  run.lease_generation, run.current_lease_id, run.claim_count,
  run.max_claims, run.deadline_at, run.cancel_requested_at,
  run.assigned_runner_id, run.required_capability,
  lease.runner_id AS lease_runner_id,
  lease.status AS lease_status, lease.expires_at AS lease_expires_at,
  lease.renew_count AS lease_renew_count,
  COALESCE((
    SELECT MAX(sequence) FROM run_events WHERE run_id = run.id
  ), 0) AS event_sequence
FROM runs run
LEFT JOIN run_leases lease ON lease.id = run.current_lease_id
WHERE run.id = ? AND run.kind = 'diagnostic' AND run.engine IS NULL
LIMIT 1`;

const ENGINE_RUN_LEASE_HEAD_QUERY = `SELECT
  run.id AS run_id, run.organization_id, run.status, run.version,
  run.lease_generation, run.current_lease_id, run.claim_count,
  run.max_claims, run.deadline_at, run.cancel_requested_at,
  run.assigned_runner_id, run.engine,
  lease.runner_id AS lease_runner_id,
  lease.status AS lease_status, lease.expires_at AS lease_expires_at,
  prompt.prompt_ref, prompt.prompt_sha256, prompt.prompt_bytes,
  operation.agent_model,
  prompt.erased_at AS prompt_erased_at,
  COALESCE((
    SELECT MAX(sequence) FROM run_events WHERE run_id = run.id
  ), 0) AS event_sequence
FROM runs run
INNER JOIN run_prompts prompt
  ON prompt.run_id = run.id
 AND prompt.organization_id = run.organization_id
LEFT JOIN run_leases lease ON lease.id = run.current_lease_id
LEFT JOIN operations operation
  ON operation.run_id = run.id
 AND operation.organization_id = run.organization_id
WHERE run.id = ? AND run.organization_id = ?
  AND run.kind = 'engine_prompt' AND run.engine IS NOT NULL
LIMIT 1`;

const ENGINE_COMPLETION_HEAD_QUERY = `SELECT
  run.id AS run_id, run.organization_id, run.status, run.version,
  run.lease_generation, run.current_lease_id, run.deadline_at,
  run.cancel_requested_at, run.engine,
  lease.runner_id AS lease_runner_id, lease.status AS lease_status,
  lease.expires_at AS lease_expires_at,
  lease.admission_engine_version,
  CASE WHEN EXISTS (
    SELECT 1
    FROM run_deadline_operations deadline
    WHERE deadline.run_id = run.id
      AND deadline.organization_id = run.organization_id
  ) THEN 1 ELSE 0 END AS deadline_operation_exists,
  COALESCE((
    SELECT MAX(sequence) FROM run_events WHERE run_id = run.id
  ), 0) AS event_sequence
FROM runs run
LEFT JOIN run_leases lease
  ON lease.id = run.current_lease_id
 AND lease.organization_id = run.organization_id
 AND lease.run_id = run.id
WHERE run.id = ? AND run.organization_id = ?
  AND run.kind = 'engine_prompt' AND run.engine IS NOT NULL
LIMIT 1`;

const ENGINE_PROMPT_READ_QUERY = `SELECT
  run.id AS run_id, run.organization_id, run.kind, run.engine, run.status,
  run.lease_generation, run.current_lease_id, run.cancel_requested_at,
  run.assigned_runner_id,
  lease.runner_id AS lease_runner_id,
  lease.status AS lease_status, lease.expires_at AS lease_expires_at,
  prompt.prompt_ref, prompt.cipher_version, prompt.key_id,
  prompt.iv, prompt.ciphertext, prompt.tag,
  prompt.prompt_sha256, prompt.prompt_bytes,
  prompt.erased_at AS prompt_erased_at
FROM runs AS run
INNER JOIN run_prompts AS prompt
  ON prompt.run_id = run.id
 AND prompt.organization_id = run.organization_id
LEFT JOIN run_leases AS lease
  ON lease.id = run.current_lease_id
 AND lease.organization_id = run.organization_id
 AND lease.run_id = run.id
WHERE run.id = ? AND run.organization_id = ?
  AND run.kind = 'engine_prompt' AND run.engine IS NOT NULL`;

const SHARED_RUN_LEASE_HEAD_QUERY = `SELECT
  run.id AS run_id, run.organization_id, run.kind, run.engine,
  run.status, run.version, run.lease_generation, run.current_lease_id,
  run.claim_count, run.max_claims, run.deadline_at,
  run.cancel_requested_at, run.assigned_runner_id,
  run.required_capability, lease.runner_id AS lease_runner_id,
  lease.status AS lease_status, lease.expires_at AS lease_expires_at,
  lease.renew_count AS lease_renew_count,
  COALESCE((
    SELECT MAX(sequence) FROM run_events WHERE run_id = run.id
  ), 0) AS event_sequence
FROM runs run
LEFT JOIN run_leases lease ON lease.id = run.current_lease_id
WHERE run.id = ?
  AND (
    (run.kind = 'diagnostic' AND run.engine IS NULL)
    OR
    (run.kind = 'engine_prompt' AND run.engine IS NOT NULL)
  )
LIMIT 1`;

const RUNNER_ACTIVE_LEASES_QUERY = `SELECT
  lease.id, lease.run_id, lease.fence, lease.expires_at,
  COALESCE((
    SELECT MAX(event.sequence)
    FROM run_events AS event
    WHERE event.run_id = lease.run_id
  ), 0) AS event_sequence
FROM run_leases AS lease
WHERE lease.runner_id = ? AND lease.organization_id = ?
  AND lease.status = 'active'
ORDER BY lease.run_id, lease.id
LIMIT 2`;

async function loadRunLeaseHead(runId: string): Promise<RunLeaseHead | null> {
  return getD1()
    .prepare(RUN_LEASE_HEAD_QUERY)
    .bind(runId)
    .first<RunLeaseHead>();
}

async function loadEngineCompletionHead(
  input: SignedRequest,
): Promise<EngineCompletionHead | null> {
  return getD1()
    .prepare(ENGINE_COMPLETION_HEAD_QUERY)
    .bind(input.runId, input.runner.organizationId)
    .first<EngineCompletionHead>();
}

async function loadSharedRunLeaseHead(
  runId: string,
): Promise<SharedRunLeaseHead | null> {
  return getD1()
    .prepare(SHARED_RUN_LEASE_HEAD_QUERY)
    .bind(runId)
    .first<SharedRunLeaseHead>();
}

async function evaluateDiagnosticClaim(
  input: SignedRequest,
): Promise<ClaimEvaluationContext> {
  const loaded = await loadClaimSnapshot(input);
  const evaluation = evaluateClaimAdmission({
    runnerId: input.runner.id,
    runnerOrganizationId: input.runner.organizationId,
    runnerActive: loaded.runnerActive,
    now: input.now,
    run: loaded.current
      ? {
          id: loaded.current.run_id,
          organizationId: loaded.current.organization_id,
          status: loaded.current.status,
          claimCount: loaded.current.claim_count,
          maxClaims: loaded.current.max_claims,
          deadlineAt: loaded.current.deadline_at,
          assignedRunnerId: loaded.current.assigned_runner_id,
          requiredCapability: loaded.current.required_capability,
          leaseStatus: loaded.current.lease_status,
          leaseExpiresAt: loaded.current.lease_expires_at,
        }
      : null,
    runnerLeases: loaded.runnerLeases.map((lease) => ({
      runId: lease.run_id,
      expiresAt: lease.expires_at,
    })),
    configuredPolicy: loaded.policy
      ? {
          version: loaded.policy.version,
          capabilityFreshnessSeconds:
            loaded.policy.capability_freshness_seconds,
          allowedCapabilities: loaded.allowedCapabilities,
          versionRecorded: loaded.policy.version_recorded === 1,
        }
      : null,
    capabilityReports: loaded.capabilityReports.map((report) => ({
      reportId: report.report_id,
      receivedAt: report.received_at,
      requiredCapabilityStatus: report.required_capability_status,
    })),
  });
  if (evaluation.kind === "denied") {
    throw new RunRepositoryError(evaluation.code, evaluation.status);
  }
  if (!loaded.current) {
    throw new RunRepositoryError("run_unavailable", 409);
  }
  return {
    current: loaded.current,
    foreignRunnerLease: loaded.runnerLeases.find(
      (lease) => lease.run_id !== input.runId,
    ),
    admission: evaluation.admission,
  };
}

async function loadClaimSnapshot(
  input: SignedRequest,
): Promise<LoadedClaimSnapshot> {
  const d1 = getD1();
  const results = await d1.batch([
    d1
      .prepare(
        `SELECT 1 AS active
         FROM runners AS runner
         INNER JOIN principals AS principal
           ON principal.id = runner.principal_id
          AND principal.organization_id = runner.organization_id
         WHERE runner.id = ? AND runner.organization_id = ?
           AND runner.principal_id = ?
           AND runner.status = 'active'
           AND principal.kind = 'runner'
           AND principal.status = 'active'
         LIMIT 1`,
      )
      .bind(
        input.runner.id,
        input.runner.organizationId,
        input.runner.principalId,
      ),
    d1.prepare(RUN_LEASE_HEAD_QUERY).bind(input.runId),
    d1
      .prepare(RUNNER_ACTIVE_LEASES_QUERY)
      .bind(input.runner.id, input.runner.organizationId),
    d1
      .prepare(
        `SELECT
           policy.version, policy.capability_freshness_seconds,
           CASE WHEN EXISTS (
             SELECT 1
             FROM runner_admission_policy_versions AS recorded
             WHERE recorded.organization_id = policy.organization_id
               AND recorded.version = policy.version
               AND recorded.capability_freshness_seconds =
                 policy.capability_freshness_seconds
           ) THEN 1 ELSE 0 END AS version_recorded
         FROM runner_admission_policies AS policy
         WHERE policy.organization_id = ?
         LIMIT 1`,
      )
      .bind(input.runner.organizationId),
    d1
      .prepare(
        `SELECT allowed.capability
         FROM runner_admission_policies AS policy
         INNER JOIN runner_admission_policy_versions AS recorded
           ON recorded.organization_id = policy.organization_id
          AND recorded.version = policy.version
          AND recorded.capability_freshness_seconds =
            policy.capability_freshness_seconds
         INNER JOIN runner_admission_policy_capabilities AS allowed
           ON allowed.organization_id = recorded.organization_id
          AND allowed.version = recorded.version
         WHERE policy.organization_id = ?
         ORDER BY CASE allowed.capability
           WHEN 'node_permission_model' THEN 1
           WHEN 'bubblewrap' THEN 2
           WHEN 'landlock' THEN 3
           WHEN 'seccomp' THEN 4
           WHEN 'user_namespace' THEN 5
           WHEN 'docker' THEN 6
           WHEN 'podman' THEN 7
           ELSE 8
         END`,
      )
      .bind(input.runner.organizationId),
    d1
      .prepare(
        `WITH target_run AS (
           SELECT assigned_runner_id, required_capability
           FROM runs
           WHERE id = ? AND organization_id = ?
           LIMIT 1
         )
         SELECT
           report.report_id, report.received_at,
           evidence.status AS required_capability_status
         FROM target_run AS target
         INNER JOIN runner_capability_reports AS report
           ON report.organization_id = ?
          AND report.runner_id = target.assigned_runner_id
         LEFT JOIN runner_capability_evidence AS evidence
           ON evidence.runner_id = report.runner_id
          AND evidence.report_id = report.report_id
          AND evidence.capability = target.required_capability
         ORDER BY report.received_at DESC, report.report_id DESC
         LIMIT 1`,
      )
      .bind(
        input.runId,
        input.runner.organizationId,
        input.runner.organizationId,
      ),
  ]);
  return {
    runnerActive: firstResultRow<RunnerActivityRow>(results[0])?.active === 1,
    current: firstResultRow<RunLeaseHead>(results[1]) ?? null,
    runnerLeases: resultRows<RunnerActiveLease>(results[2]),
    policy: firstResultRow<AdmissionPolicySnapshotRow>(results[3]) ?? null,
    allowedCapabilities: resultRows<AdmissionPolicyCapabilityRow>(
      results[4],
    ).map((row) => row.capability),
    capabilityReports: resultRows<CapabilityAdmissionReportRow>(results[5]),
  };
}

async function evaluateEngineClaim(
  input: SignedRequest & { engine: ExecutionEngineName },
): Promise<EngineClaimEvaluationContext> {
  const loaded = await loadEngineClaimSnapshot(input);
  const current =
    loaded.current?.prompt_erased_at === null ? loaded.current : null;
  const evaluation = evaluateEngineClaimAdmission({
    runnerId: input.runner.id,
    runnerOrganizationId: input.runner.organizationId,
    runnerActive: loaded.runnerActive,
    requestedEngine: input.engine,
    now: input.now,
    run: current
      ? {
          id: current.run_id,
          organizationId: current.organization_id,
          engine: current.engine,
          status: current.status,
          claimCount: current.claim_count,
          maxClaims: current.max_claims,
          deadlineAt: current.deadline_at,
          assignedRunnerId: current.assigned_runner_id,
          cancelRequestedAt: current.cancel_requested_at,
          leaseStatus: current.lease_status,
          leaseExpiresAt: current.lease_expires_at,
        }
      : null,
    runnerLeases: loaded.runnerLeases.map((lease) => ({
      runId: lease.run_id,
      expiresAt: lease.expires_at,
    })),
    configuredPolicy: loaded.policy
      ? {
          version: loaded.policy.version,
          engineFreshnessSeconds: loaded.policy.engine_freshness_seconds,
          versionRecorded: loaded.policy.version_recorded === 1,
        }
      : null,
    engineReports: loaded.engineReports.map((report) => ({
      reportId: report.report_id,
      receivedAt: report.received_at,
      evidenceCount: report.evidence_count,
      engine: report.engine,
      status: report.status,
      readiness: report.readiness,
      reason: report.reason,
      version: report.engine_version,
    })),
  });
  if (evaluation.kind === "denied") {
    throw new RunRepositoryError(evaluation.code, evaluation.status);
  }
  if (!current) throw new RunRepositoryError("run_unavailable", 409);
  return {
    current,
    foreignRunnerLease: loaded.runnerLeases.find(
      (lease) => lease.run_id !== input.runId,
    ),
    admission: evaluation.admission,
  };
}

async function loadEngineClaimSnapshot(
  input: SignedRequest,
): Promise<LoadedEngineClaimSnapshot> {
  const d1 = getD1();
  const results = await d1.batch([
    d1
      .prepare(
        `SELECT 1 AS active
         FROM runners AS runner
         INNER JOIN principals AS principal
           ON principal.id = runner.principal_id
          AND principal.organization_id = runner.organization_id
         WHERE runner.id = ? AND runner.organization_id = ?
           AND runner.principal_id = ?
           AND runner.status = 'active'
           AND principal.kind = 'runner'
           AND principal.status = 'active'
         LIMIT 1`,
      )
      .bind(
        input.runner.id,
        input.runner.organizationId,
        input.runner.principalId,
      ),
    d1
      .prepare(ENGINE_RUN_LEASE_HEAD_QUERY)
      .bind(input.runId, input.runner.organizationId),
    d1
      .prepare(RUNNER_ACTIVE_LEASES_QUERY)
      .bind(input.runner.id, input.runner.organizationId),
    d1
      .prepare(
        `SELECT
           policy.version, policy.engine_freshness_seconds,
           CASE WHEN EXISTS (
             SELECT 1
             FROM runner_admission_policy_versions AS recorded
             WHERE recorded.organization_id = policy.organization_id
               AND recorded.version = policy.version
               AND recorded.engine_freshness_seconds =
                 policy.engine_freshness_seconds
           ) THEN 1 ELSE 0 END AS version_recorded
         FROM runner_admission_policies AS policy
         WHERE policy.organization_id = ?
         LIMIT 1`,
      )
      .bind(input.runner.organizationId),
    d1
      .prepare(
        `WITH target_run AS (
           SELECT assigned_runner_id, engine
           FROM runs
           WHERE id = ? AND organization_id = ?
             AND kind = 'engine_prompt' AND engine IS NOT NULL
           LIMIT 1
         )
         SELECT
           report.report_id, report.received_at,
           evidence.engine AS engine,
           evidence.status, evidence.readiness, evidence.reason,
           evidence.version AS engine_version,
           (
             SELECT COUNT(*)
             FROM runner_engine_evidence AS complete
             WHERE complete.runner_id = report.runner_id
               AND complete.report_id = report.report_id
           ) AS evidence_count
         FROM target_run AS target
         INNER JOIN runner_engine_reports AS report
           ON report.organization_id = ?
          AND report.runner_id = target.assigned_runner_id
         LEFT JOIN runner_engine_evidence AS evidence
           ON evidence.runner_id = report.runner_id
          AND evidence.report_id = report.report_id
          AND evidence.engine = target.engine
         ORDER BY report.received_at DESC, report.report_id DESC
         LIMIT 1`,
      )
      .bind(
        input.runId,
        input.runner.organizationId,
        input.runner.organizationId,
      ),
  ]);
  return {
    runnerActive: firstResultRow<RunnerActivityRow>(results[0])?.active === 1,
    current: firstResultRow<EngineRunLeaseHead>(results[1]) ?? null,
    runnerLeases: resultRows<RunnerActiveLease>(results[2]),
    policy: firstResultRow<EngineAdmissionPolicyRow>(results[3]) ?? null,
    engineReports: resultRows<EngineAdmissionReportRow>(results[4]),
  };
}

function resultRows<T>(result: D1Result<unknown> | undefined): T[] {
  return (result?.results ?? []) as T[];
}

function firstResultRow<T>(
  result: D1Result<unknown> | undefined,
): T | undefined {
  return resultRows<T>(result)[0];
}

function prepareRunEvent(
  d1: D1Database,
  event: {
    organizationId: string;
    runId: string;
    sequence: number;
    kind: RunEvent["kind"];
    actorId: string;
    fence?: number;
    occurredAt: string;
    metadata: Record<string, unknown>;
  },
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, fence,
        occurred_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.organizationId,
      event.runId,
      event.sequence,
      event.kind,
      event.actorId,
      event.fence ?? null,
      event.occurredAt,
      canonicalJson(event.metadata),
    );
}

function prepareGuardedRenewalEvent(
  d1: D1Database,
  event: {
    organizationId: string;
    runId: string;
    sequence: number;
    actorId: string;
    fence: number;
    occurredAt: string;
    expiresAt: string;
    leaseId: string;
    runnerId: string;
    renewCount: number;
  },
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, fence,
        occurred_at, metadata_json
      )
      SELECT ?, ?, ?, 'lease.renewed', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM run_leases
        WHERE id = ? AND organization_id = ? AND run_id = ?
          AND runner_id = ? AND fence = ? AND status = 'active'
          AND expires_at = ? AND renewed_at = ? AND updated_at = ?
          AND renew_count = ?
      )`,
    )
    .bind(
      event.organizationId,
      event.runId,
      event.sequence,
      event.actorId,
      event.fence,
      event.occurredAt,
      canonicalJson({ expiresAt: event.expiresAt }),
      event.leaseId,
      event.organizationId,
      event.runId,
      event.runnerId,
      event.fence,
      event.expiresAt,
      event.occurredAt,
      event.occurredAt,
      event.renewCount,
    );
}

function prepareGuardedRenewalNonceInsert(
  d1: D1Database,
  input: SignedRequest & {
    eventSequence: number;
    fence: number;
    status: number;
    body: string;
  },
): D1PreparedStatement {
  const expiresAt = new Date(
    Date.parse(input.now) + RUNNER_LEASE_NONCE_TTL_MS,
  ).toISOString();
  return d1
    .prepare(
      `INSERT INTO runner_lease_nonces (
        organization_id, runner_id, nonce, request_hash, response_status,
        response_body, occurred_at, expires_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM run_events
        WHERE organization_id = ? AND run_id = ? AND sequence = ?
          AND kind = 'lease.renewed' AND actor_id = ?
          AND fence = ? AND occurred_at = ?
      )`,
    )
    .bind(
      input.runner.organizationId,
      input.runner.id,
      input.nonce,
      input.signedRequestHash,
      input.status,
      input.body,
      input.now,
      expiresAt,
      input.runner.organizationId,
      input.runId,
      input.eventSequence,
      input.runner.principalId,
      input.fence,
      input.now,
    );
}

function prepareGuardedCancellationEvent(
  d1: D1Database,
  event: {
    organizationId: string;
    runId: string;
    sequence: number;
    kind: "lease.released" | "run.canceled";
    actorId: string;
    fence?: number;
    occurredAt: string;
    metadata: Record<string, unknown>;
  },
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO run_events (
        organization_id, run_id, sequence, kind, actor_id, fence,
        occurred_at, metadata_json
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM runs
        WHERE id = ? AND organization_id = ?
          AND status = 'canceled' AND recorded_at = ?
      )`,
    )
    .bind(
      event.organizationId,
      event.runId,
      event.sequence,
      event.kind,
      event.actorId,
      event.fence ?? null,
      event.occurredAt,
      canonicalJson(event.metadata),
      event.runId,
      event.organizationId,
      event.occurredAt,
    );
}

function prepareNonceInsert(
  d1: D1Database,
  input: SignedRequest,
  status: number,
  body: string,
): D1PreparedStatement {
  const expiresAt = new Date(
    Date.parse(input.now) + RUNNER_LEASE_NONCE_TTL_MS,
  ).toISOString();
  return d1
    .prepare(
      `INSERT INTO runner_lease_nonces (
        organization_id, runner_id, nonce, request_hash, response_status,
        response_body, occurred_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.runner.organizationId,
      input.runner.id,
      input.nonce,
      input.signedRequestHash,
      status,
      body,
      input.now,
      expiresAt,
    );
}

function prepareRunnerSeen(
  d1: D1Database,
  input: SignedRequest,
): D1PreparedStatement {
  return d1
    .prepare(
      `UPDATE runners
       SET last_seen_at = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'active'
         AND (last_seen_at IS NULL OR last_seen_at < ?)`,
    )
    .bind(
      input.now,
      input.now,
      input.runner.id,
      input.runner.organizationId,
      input.now,
    );
}

async function cleanupRunOperationalState(
  organizationId: string,
  now: string,
): Promise<void> {
  const compactBefore = new Date(
    Date.parse(now) - RUNNER_OPERATION_RESPONSE_TTL_MS,
  ).toISOString();
  const d1 = getD1();
  await d1.batch([
    d1
      .prepare(
        `DELETE FROM runner_lease_nonces
         WHERE rowid IN (
           SELECT nonce.rowid
           FROM runner_lease_nonces nonce
           WHERE nonce.organization_id = ? AND nonce.expires_at <= ?
           ORDER BY nonce.expires_at
           LIMIT 100
         )`,
      )
      .bind(organizationId, now),
    d1
      .prepare(
        `UPDATE runner_operations
         SET response_body = NULL, compacted_at = ?
         WHERE rowid IN (
           SELECT operation.rowid
           FROM runner_operations operation
           INNER JOIN runs run ON run.id = operation.run_id
           WHERE run.organization_id = ?
             AND operation.compacted_at IS NULL
             AND operation.applied_at <= ?
           ORDER BY operation.applied_at
           LIMIT 100
         )`,
      )
      .bind(now, organizationId, compactBefore),
  ]);
}

function engineRunReadSelectSql(): string {
  return `SELECT
    run.id, run.organization_id, run.requested_by, run.kind, run.engine,
    run.status, run.version, run.lease_generation, run.current_lease_id,
    run.claim_count, run.max_claims, run.deadline_at,
    run.assigned_runner_id, run.cancel_requested_at, run.outcome_status,
    run.outcome_summary, run.completed_operation_id, run.recorded_at,
    run.created_at, run.updated_at,
    lease.id AS lease_id, lease.runner_id AS lease_runner_id,
    lease.fence AS lease_fence, lease.status AS lease_status,
    lease.issued_at AS lease_issued_at,
    lease.expires_at AS lease_expires_at,
    lease.renewed_at AS lease_renewed_at,
    lease.renew_count AS lease_renew_count,
    lease.ended_at AS lease_ended_at,
    lease.ended_reason AS lease_ended_reason
  FROM runs run
  LEFT JOIN run_leases lease
    ON lease.id = run.current_lease_id
   AND lease.run_id = run.id
   AND lease.organization_id = run.organization_id`;
}

function parseEngineRunPage(query: {
  cursor?: string;
  limit?: string;
  valid: boolean;
}): {
  cursor?: EngineRunCursor;
  limit: number;
} {
  if (!query.valid) {
    throw new RunRepositoryError("invalid_engine_run_page", 400);
  }
  const limit =
    query.limit === undefined
      ? ENGINE_RUN_PAGE_DEFAULT_LIMIT
      : Number(query.limit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ENGINE_RUN_PAGE_MAX_LIMIT ||
    (query.limit !== undefined && String(limit) !== query.limit)
  ) {
    throw new RunRepositoryError("invalid_engine_run_page", 400);
  }
  if (query.cursor === undefined) return { limit };
  const cursor = decodeEngineRunCursor(query.cursor);
  if (!cursor) {
    throw new RunRepositoryError("invalid_engine_run_page", 400);
  }
  return { cursor, limit };
}

function encodeEngineRunCursor(cursor: EngineRunCursor): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify([1, cursor.createdAt, cursor.runId]),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeEngineRunCursor(value: string): EngineRunCursor | undefined {
  if (
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    return undefined;
  }
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      parsed[0] !== 1 ||
      typeof parsed[1] !== "string" ||
      typeof parsed[2] !== "string" ||
      !isCanonicalTimestamp(parsed[1]) ||
      !/^run_[0-9a-f]{32}$/u.test(parsed[2])
    ) {
      return undefined;
    }
    const cursor = { createdAt: parsed[1], runId: parsed[2] };
    return encodeEngineRunCursor(cursor) === value ? cursor : undefined;
  } catch {
    return undefined;
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function toEngineRunRead(row: EngineRunReadRow, now: string): EngineRunRead {
  const overdue =
    (row.status === "queued" || row.status === "leased") &&
    row.deadline_at <= now;
  const deadlineState = overdue
    ? "overdue_awaiting_reconciliation"
    : row.status === "queued" || row.status === "leased"
      ? "pending"
      : "settled";
  return {
    id: row.id,
    organizationId: row.organization_id,
    requestedBy: row.requested_by,
    kind: "engine_prompt",
    engine: row.engine,
    assignedRunnerId: row.assigned_runner_id,
    status: row.status,
    overdue,
    deadlineState,
    version: row.version,
    leaseGeneration: row.lease_generation,
    claimCount: row.claim_count,
    maxClaims: row.max_claims,
    deadlineAt: row.deadline_at,
    ...(row.cancel_requested_at
      ? { cancelRequestedAt: row.cancel_requested_at }
      : {}),
    ...(row.outcome_status ? { outcomeStatus: row.outcome_status } : {}),
    ...(row.outcome_summary ? { outcomeSummary: row.outcome_summary } : {}),
    ...(row.completed_operation_id
      ? { completedOperationId: row.completed_operation_id }
      : {}),
    ...(row.recorded_at ? { recordedAt: row.recorded_at } : {}),
    ...(row.lease_id &&
    row.lease_runner_id &&
    row.lease_fence !== null &&
    row.lease_status &&
    row.lease_issued_at &&
    row.lease_expires_at &&
    row.lease_renew_count !== null
      ? {
          currentLease: {
            id: row.lease_id,
            runnerId: row.lease_runner_id,
            fence: row.lease_fence,
            status: row.lease_status,
            issuedAt: row.lease_issued_at,
            expiresAt: row.lease_expires_at,
            expired: row.lease_expires_at <= now,
            ...(row.lease_renewed_at
              ? { renewedAt: row.lease_renewed_at }
              : {}),
            renewCount: row.lease_renew_count,
            ...(row.lease_ended_at ? { endedAt: row.lease_ended_at } : {}),
            ...(row.lease_ended_reason
              ? { endedReason: row.lease_ended_reason }
              : {}),
          },
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEngineRunReceiptMetadata(
  row: EngineRunReceiptReadRow,
): EngineRunReceiptMetadata {
  return {
    operationId: row.operation_id,
    leaseId: row.lease_id,
    fence: row.fence,
    engine: row.engine,
    engineVersion: row.engine_version,
    status: row.status,
    reason: row.reason,
    exitCode: row.exit_code,
    timedOut: row.timed_out === 1,
    cancelRequested: row.cancel_requested === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stdout: {
      bytes: row.stdout_bytes,
      sha256: row.stdout_sha256,
      truncated: row.stdout_truncated === 1,
      excerptBytes: row.stdout_excerpt_bytes,
    },
    stderr: {
      bytes: row.stderr_bytes,
      sha256: row.stderr_sha256,
      truncated: row.stderr_truncated === 1,
      excerptBytes: row.stderr_excerpt_bytes,
    },
    receiptSha256: row.receipt_sha256,
    recordedAt: row.recorded_at,
    ...(row.excerpt_erased_at
      ? {
          excerptStorageState: "erased" as const,
          erasedAt: row.excerpt_erased_at,
        }
      : { excerptStorageState: "stored_encrypted" as const }),
  };
}

function runSelectSql(where: string, list = true): string {
  return `SELECT
    run.id, run.organization_id, run.requested_by, run.kind, run.status,
    run.version, run.lease_generation, run.current_lease_id,
    run.claim_count, run.max_claims, run.deadline_at,
    run.assigned_runner_id, run.required_capability,
    run.cancel_requested_at, run.outcome_status, run.outcome_summary,
    run.completed_operation_id, run.recorded_at, run.created_at, run.updated_at,
    lease.runner_id AS current_runner_id,
    lease.expires_at AS lease_expires_at,
    COALESCE(operation.replay_count, 0) AS replay_count
  FROM runs run
  LEFT JOIN run_leases lease ON lease.id = run.current_lease_id
  LEFT JOIN runner_operations operation
    ON operation.run_id = run.id
   AND operation.operation_id = run.completed_operation_id
  ${where}
  ${list ? "ORDER BY run.created_at DESC, run.id DESC LIMIT 100" : "LIMIT 1"}`;
}

function toDiagnosticRun(row: RunRow, now: string): DiagnosticRun {
  return {
    id: row.id,
    organizationId: row.organization_id,
    requestedBy: row.requested_by,
    kind: "diagnostic",
    status: row.status,
    version: row.version,
    leaseGeneration: row.lease_generation,
    ...(row.current_lease_id
      ? { currentLeaseId: row.current_lease_id }
      : {}),
    ...(row.current_runner_id
      ? { currentRunnerId: row.current_runner_id }
      : {}),
    ...(row.lease_expires_at
      ? { leaseExpiresAt: row.lease_expires_at }
      : {}),
    claimCount: row.claim_count,
    maxClaims: row.max_claims,
    deadlineAt: row.deadline_at,
    ...(row.assigned_runner_id
      ? { assignedRunnerId: row.assigned_runner_id }
      : {}),
    ...(row.required_capability
      ? { requiredCapability: row.required_capability }
      : {}),
    ...(isRunDeadlineExpired({
      status: row.status,
      deadlineAt: row.deadline_at,
      now,
    })
      ? { expired: true as const }
      : {}),
    ...(row.cancel_requested_at
      ? { cancelRequestedAt: row.cancel_requested_at }
      : {}),
    ...(row.outcome_status ? { outcomeStatus: row.outcome_status } : {}),
    ...(row.outcome_summary ? { outcomeSummary: row.outcome_summary } : {}),
    ...(row.completed_operation_id
      ? { completedOperationId: row.completed_operation_id }
      : {}),
    ...(row.recorded_at ? { recordedAt: row.recorded_at } : {}),
    replayCount: row.replay_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRunEvent(row: RunEventRow): RunEvent {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metadata_json);
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = { integrity: "invalid_metadata" };
  }
  return {
    sequence: row.sequence,
    kind: row.kind,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    ...(row.fence === null ? {} : { fence: row.fence }),
    metadata,
  };
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

function prepareRunLedgerInsert(
  d1: D1Database,
  entry: LedgerEntry,
  runId: string,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, payload_ref, intent_id, run_id, previous_hash, hash
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM runs
        WHERE id = ? AND organization_id = ?
      )
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries
          WHERE organization_id = ? AND payload_ref = ? AND kind = ?
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
      runId,
      entry.previousHash,
      entry.hash,
      runId,
      entry.organizationId,
      entry.organizationId,
      entry.payloadRef ?? null,
      entry.kind,
    );
}

function toLedgerEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    organizationId: row.organization_id,
    sequence: row.sequence,
    kind: row.kind,
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

async function getEngineRunCreation(
  organizationId: string,
  requestedBy: string,
  creationId: EngineRunCreationId,
): Promise<EngineRunCreationRow | null> {
  return getD1()
    .prepare(
      `SELECT
         creation_id, request_hash, state, run_id, reconciliation_id,
         created_at
       FROM engine_run_creations
       WHERE organization_id = ? AND requested_by = ? AND creation_id = ?
       LIMIT 1`,
    )
    .bind(organizationId, requestedBy, creationId)
    .first<EngineRunCreationRow>();
}

async function rereadEngineRunCreationAfterUniqueConflict(
  organizationId: string,
  requestedBy: string,
  creationId: EngineRunCreationId,
): Promise<EngineRunCreationRow | null> {
  for (
    let attempt = 0;
    attempt < ENGINE_RUN_CREATION_UNIQUE_REREAD_LIMIT;
    attempt += 1
  ) {
    const resolution = await getEngineRunCreation(
      organizationId,
      requestedBy,
      creationId,
    );
    if (resolution) return resolution;
    if (attempt + 1 < ENGINE_RUN_CREATION_UNIQUE_REREAD_LIMIT) {
      await retryJitter();
    }
  }
  return null;
}

async function synchronizeEngineRunCreationRaceForTest(
  organizationId: string,
  requestedBy: string,
  creationId: EngineRunCreationId,
  hook: EngineRunCreationRaceTestHook,
): Promise<void> {
  if (env.NEXUS_ALLOW_TEST_IDENTITIES !== "1") return;
  const key = `${organizationId}\u0000${requestedBy}\u0000${creationId}`;
  let barrier = engineRunCreationRaceTestBarriers.get(key);
  if (!barrier) {
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    barrier = {
      participants: new Set(),
      ready,
      release,
      winner: hook.winner,
    };
    engineRunCreationRaceTestBarriers.set(key, barrier);
  }
  if (
    barrier.winner !== hook.winner ||
    barrier.participants.has(hook.participant)
  ) {
    engineRunCreationRaceTestBarriers.delete(key);
    throw new Error("Invalid engine creation race test barrier");
  }
  barrier.participants.add(hook.participant);
  if (barrier.participants.size === 2) barrier.release();

  try {
    await raceTestTimeout(barrier.ready);
    if (hook.participant === hook.winner) return;
    const deadline =
      Date.now() + ENGINE_RUN_CREATION_RACE_TEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (
        await getEngineRunCreation(
          organizationId,
          requestedBy,
          creationId,
        )
      ) {
        engineRunCreationRaceTestBarriers.delete(key);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Engine creation race winner did not commit");
  } catch (error) {
    engineRunCreationRaceTestBarriers.delete(key);
    throw error;
  }
}

async function raceTestTimeout(promise: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Engine creation race test timed out")),
          ENGINE_RUN_CREATION_RACE_TEST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function resolveEngineRunCreation(
  row: EngineRunCreationRow,
): Promise<EngineRunCreationResolution> {
  if (row.state === "confirmed_not_created") {
    if (!row.reconciliation_id) {
      throw new Error("Invalid not-created resolution");
    }
    return {
      creationId: row.creation_id,
      state: "confirmed_not_created",
      notCreatedProofId: row.reconciliation_id as `ncp_${string}`,
      confirmedAt: row.created_at,
    };
  }
  if (!row.run_id) throw new Error("Invalid created resolution");
  return {
    creationId: row.creation_id,
    state: "created",
    runId: row.run_id,
  };
}

async function resolveEngineRunCreationForPost(
  row: EngineRunCreationRow,
  requestHash: string,
): Promise<EngineRunCreationResolution> {
  if (row.state === "confirmed_not_created") {
    return resolveEngineRunCreation(row);
  }
  if (row.request_hash !== requestHash) {
    throw new RunRepositoryError("engine_run_creation_key_reused", 422);
  }
  return resolveEngineRunCreation(row);
}

function runRef(runId: string): string {
  return `nexus://runs/${runId}`;
}

function isEngineRunCreationUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed:[^\n]*engine_run_creations\.|engine_run_creations_org_(?:requester_creation|run|reconciliation)_uidx/iu.test(
      error.message,
    )
  );
}

function isLedgerSequenceConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed:\s*ledger_entries\.organization_id,\s*ledger_entries\.sequence|ledger_entries_org_sequence_uidx/iu.test(
      error.message,
    )
  );
}

function isBareInvalidRun(error: unknown): boolean {
  return error instanceof Error && /\binvalid_run\b/iu.test(error.message);
}

async function requireAssignableRunner(
  organizationId: string,
  runnerId: string,
): Promise<void> {
  const runner = await getD1()
    .prepare(
      `SELECT
         runner.status AS runner_status,
         principal.kind AS principal_kind,
         principal.status AS principal_status
       FROM runners runner
       LEFT JOIN principals principal
         ON principal.id = runner.principal_id
        AND principal.organization_id = runner.organization_id
       WHERE runner.id = ? AND runner.organization_id = ?
       LIMIT 1`,
    )
    .bind(runnerId, organizationId)
    .first<AssignableRunnerRow>();
  if (!runner) {
    throw new RunRepositoryError("runner_not_found", 404);
  }
  if (
    runner.runner_status !== "active" ||
    runner.principal_kind !== "runner" ||
    runner.principal_status !== "active"
  ) {
    throw new RunRepositoryError("runner_not_active", 409);
  }
}

async function classifyAssignedRunInsertAbort(
  organizationId: string,
  assignment: AssignedRunRequest,
): Promise<void> {
  await requireAssignableRunner(organizationId, assignment.assignedRunnerId);
}

function isRunRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed|invalid_run_(?:lease|event|transition|ledger_event)|invalid_run_engine_(?:receipt|excerpt)|run_engine_(?:receipt|excerpt)_already_exists|invalid_runner_operation/iu.test(
      error.message,
    )
  );
}

function mapRunDatabaseError(error: unknown): Error {
  if (error instanceof RunRepositoryError) return error;
  return error instanceof Error ? error : new Error("Run operation failed");
}

async function retryJitter(): Promise<void> {
  const delayMs = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function leaseTtlMs(): number {
  if (env.NEXUS_ALLOW_TEST_IDENTITIES === "1") {
    const configured = Number(env.NEXUS_RUNNER_TEST_LEASE_TTL_SECONDS);
    if (Number.isFinite(configured) && configured >= 2 && configured <= 60) {
      return configured * 1000;
    }
  }
  return LEASE_TTL_MS;
}

export class RunRepositoryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "RunRepositoryError";
  }
}

type RunLeaseHead = {
  run_id: string;
  organization_id: string;
  status: "queued" | "leased" | "completed" | "canceled";
  version: number;
  lease_generation: number;
  current_lease_id: string | null;
  claim_count: number;
  max_claims: number;
  deadline_at: string;
  assigned_runner_id: string | null;
  required_capability: RunnerCapabilityName | null;
  cancel_requested_at: string | null;
  lease_runner_id: string | null;
  lease_status: "active" | "superseded" | "released" | "revoked" | null;
  lease_expires_at: string | null;
  lease_renew_count: number;
  event_sequence: number;
};

type SharedRunLeaseHead = Omit<RunLeaseHead, "status"> & {
  kind: "diagnostic" | "engine_prompt";
  engine: ExecutionEngineName | null;
  status: "queued" | "leased" | "completed" | "canceled" | "expired";
};

type EngineRunLeaseHead = {
  run_id: string;
  organization_id: string;
  status: "queued" | "leased" | "canceled" | "expired";
  version: number;
  lease_generation: number;
  current_lease_id: string | null;
  claim_count: number;
  max_claims: number;
  deadline_at: string;
  cancel_requested_at: string | null;
  assigned_runner_id: string;
  engine: ExecutionEngineName;
  lease_runner_id: string | null;
  lease_status: "active" | "superseded" | "released" | "revoked" | null;
  lease_expires_at: string | null;
  prompt_ref: string;
  prompt_sha256: string;
  prompt_bytes: number;
  prompt_erased_at: string | null;
  agent_model: string | null;
  event_sequence: number;
};

type EngineCompletionHead = {
  run_id: string;
  organization_id: string;
  status: "queued" | "leased" | "completed" | "canceled" | "expired";
  version: number;
  lease_generation: number;
  current_lease_id: string | null;
  deadline_at: string;
  cancel_requested_at: string | null;
  engine: ExecutionEngineName;
  lease_runner_id: string | null;
  lease_status: "active" | "superseded" | "released" | "revoked" | null;
  lease_expires_at: string | null;
  admission_engine_version: string | null;
  deadline_operation_exists: number;
  event_sequence: number;
};

type EnginePromptCipherRow = {
  run_id: string;
  organization_id: string;
  kind: "engine_prompt";
  engine: ExecutionEngineName;
  status: "queued" | "leased" | "completed" | "canceled" | "expired";
  lease_generation: number;
  current_lease_id: string | null;
  cancel_requested_at: string | null;
  assigned_runner_id: string | null;
  lease_runner_id: string | null;
  lease_status: "active" | "superseded" | "released" | "revoked" | null;
  lease_expires_at: string | null;
  prompt_ref: string;
  cipher_version: number;
  key_id: string | null;
  iv: ArrayBuffer | ArrayBufferView | number[] | null;
  ciphertext: ArrayBuffer | ArrayBufferView | number[] | null;
  tag: ArrayBuffer | ArrayBufferView | number[] | null;
  prompt_sha256: string;
  prompt_bytes: number;
  prompt_erased_at: string | null;
};

type EngineRunCursor = {
  createdAt: string;
  runId: string;
};

type EngineRunCreationRow = {
  creation_id: EngineRunCreationId;
  request_hash: string | null;
  state: "created" | "confirmed_not_created";
  run_id: string | null;
  reconciliation_id: string | null;
  created_at: string;
};

type EngineRunReadRow = {
  id: string;
  organization_id: string;
  requested_by: string;
  kind: "engine_prompt";
  engine: ExecutionEngineName;
  status: "queued" | "leased" | "completed" | "canceled" | "expired";
  version: number;
  lease_generation: number;
  current_lease_id: string | null;
  claim_count: number;
  max_claims: number;
  deadline_at: string;
  assigned_runner_id: string;
  cancel_requested_at: string | null;
  outcome_status: RunOutcomeStatus | null;
  outcome_summary: string | null;
  completed_operation_id: string | null;
  recorded_at: string | null;
  created_at: string;
  updated_at: string;
  lease_id: string | null;
  lease_runner_id: string | null;
  lease_fence: number | null;
  lease_status: "active" | "superseded" | "released" | "revoked" | null;
  lease_issued_at: string | null;
  lease_expires_at: string | null;
  lease_renewed_at: string | null;
  lease_renew_count: number | null;
  lease_ended_at: string | null;
  lease_ended_reason:
    | "canceled"
    | "expired"
    | "runner_revoked"
    | "diagnostic_complete"
    | "engine_complete"
    | "deadline_exhausted"
    | null;
};

type EngineRunReceiptReadRow = {
  operation_id: string;
  lease_id: string;
  fence: number;
  engine: ExecutionEngineName;
  engine_version: string;
  status: "succeeded" | "failed" | "canceled";
  reason:
    | "none"
    | "engine_incompatible"
    | "prompt_unavailable"
    | "prompt_erased"
    | "prompt_integrity_mismatch"
    | "spawn_failed"
    | "timed_out"
    | "cancel_requested"
    | "lease_lost"
    | "output_limit_reached"
    | "interrupted_after_start"
    | "orphan_identity_ambiguous"
    | "engine_exit_nonzero"
    | "protocol_invalid";
  exit_code: number | null;
  timed_out: 0 | 1;
  cancel_requested: 0 | 1;
  started_at: string;
  finished_at: string;
  stdout_bytes: number;
  stdout_sha256: string;
  stdout_truncated: 0 | 1;
  stdout_excerpt_bytes: number;
  stderr_bytes: number;
  stderr_sha256: string;
  stderr_truncated: 0 | 1;
  stderr_excerpt_bytes: number;
  receipt_sha256: string;
  recorded_at: string;
  excerpt_erased_at: string | null;
};

type RunnerActiveLease = {
  id: string;
  run_id: string;
  fence: number;
  expires_at: string;
  event_sequence: number;
};

type RunnerActivityRow = {
  active: number;
};

type AdmissionPolicySnapshotRow = {
  version: number;
  capability_freshness_seconds: number;
  version_recorded: number;
};

type AdmissionPolicyCapabilityRow = {
  capability: RunnerCapabilityName;
};

type CapabilityAdmissionReportRow = {
  report_id: string;
  received_at: string;
  required_capability_status:
    | "available"
    | "unavailable"
    | "unknown"
    | null;
};

type LoadedClaimSnapshot = {
  runnerActive: boolean;
  current: RunLeaseHead | null;
  runnerLeases: RunnerActiveLease[];
  policy: AdmissionPolicySnapshotRow | null;
  allowedCapabilities: RunnerCapabilityName[];
  capabilityReports: CapabilityAdmissionReportRow[];
};

type EngineAdmissionPolicyRow = {
  version: number;
  engine_freshness_seconds: number;
  version_recorded: number;
};

type EngineAdmissionReportRow = {
  report_id: string;
  received_at: string;
  evidence_count: number;
  engine: ExecutionEngineName | null;
  status: "available" | "unavailable" | "unknown" | null;
  readiness: "ready" | "attention_required" | "unknown" | null;
  reason: string | null;
  engine_version: string | null;
};

type LoadedEngineClaimSnapshot = {
  runnerActive: boolean;
  current: EngineRunLeaseHead | null;
  runnerLeases: RunnerActiveLease[];
  policy: EngineAdmissionPolicyRow | null;
  engineReports: EngineAdmissionReportRow[];
};

type ClaimEvaluationContext = {
  current: RunLeaseHead;
  foreignRunnerLease: RunnerActiveLease | undefined;
  admission: ClaimAdmission;
};

type EngineClaimEvaluationContext = {
  current: EngineRunLeaseHead;
  foreignRunnerLease: RunnerActiveLease | undefined;
  admission: EngineClaimAdmission;
};

type RunRow = {
  id: string;
  organization_id: string;
  requested_by: string;
  kind: "diagnostic";
  status: "queued" | "leased" | "completed" | "canceled";
  version: number;
  lease_generation: number;
  current_lease_id: string | null;
  claim_count: number;
  max_claims: number;
  deadline_at: string;
  assigned_runner_id: string | null;
  required_capability: RunnerCapabilityName | null;
  cancel_requested_at: string | null;
  outcome_status: RunOutcomeStatus | null;
  outcome_summary: string | null;
  completed_operation_id: string | null;
  recorded_at: string | null;
  created_at: string;
  updated_at: string;
  current_runner_id: string | null;
  lease_expires_at: string | null;
  replay_count: number;
};

type AssignableRunnerRow = {
  runner_status: "active" | "revoked";
  principal_kind: string | null;
  principal_status: "active" | "disabled" | "archived" | null;
};

type RunEventRow = {
  sequence: number;
  kind: RunEvent["kind"];
  actor_id: string;
  fence: number | null;
  occurred_at: string;
  metadata_json: string;
};

type LedgerRow = {
  id: string;
  organization_id: string;
  sequence: number;
  kind: LedgerEvent["kind"];
  actor_id: string;
  occurred_at: string;
  payload_hash: string;
  payload_ref: string | null;
  intent_id: string | null;
  run_id: string | null;
  previous_hash: string;
  hash: string;
};
