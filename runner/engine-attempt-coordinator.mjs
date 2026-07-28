import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  finalizeAttemptRecord,
} from "./attempt-journal-contract.mjs";
import {
  persistAttemptRecord,
  pruneSettledAttemptJournals,
} from "./attempt-journal-store.mjs";
import {
  acquireOutboxLock,
  OutboxError,
  persistDeclarationOperation,
  recoverOutbox,
} from "./durable-outbox.mjs";
import {
  inspectSupervisedAttempt,
  resumeSupervisedAttempt,
} from "./engine-supervised-run.mjs";

export const ENGINE_COMPLETION_OPERATION_DOMAIN =
  "nexus-runner-engine-outbox-operation-v1";

const ATTEMPT_PATTERN = /^att_[0-9a-f]{32}$/u;
const OPERATION_PATTERN = /^op_[0-9a-f]{32}$/u;
const RUN_PATTERN = /^run_[0-9a-f]{32}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RECOVERY_ATTEMPT_MAX = 32;
const RECOVERY_DELIVERY_MAX = 16;
const TERMINAL_OUTBOX_STATES = new Set([
  "acked",
  "rejected",
  "superseded",
]);

export class EngineAttemptCoordinatorError extends Error {
  constructor(message, code = "engine_attempt_coordinator_invalid") {
    super(message);
    this.name = "EngineAttemptCoordinatorError";
    this.code = code;
  }
}

export function deriveEngineCompletionOperationId(attemptId) {
  if (typeof attemptId !== "string" || !ATTEMPT_PATTERN.test(attemptId)) {
    throw new EngineAttemptCoordinatorError("Attempt identity is invalid.");
  }
  const digest = createHash("sha256")
    .update(canonicalJson({
      attemptId,
      domain: ENGINE_COMPLETION_OPERATION_DOMAIN,
    }))
    .digest("hex");
  return `op_${digest.slice(0, 32)}`;
}

export async function coordinateEngineAttemptRecovery(input) {
  const {
    completionContext,
    drainCompletions,
    stateDir,
  } = input ?? {};
  assertStateDirectory(stateDir);
  if (typeof drainCompletions !== "function") {
    throw new EngineAttemptCoordinatorError(
      "Recovery dependencies are invalid.",
    );
  }
  const releaseLock = await acquireOutboxLock(stateDir);
  const attemptCorruptions = [];
  const attemptWarnings = [];
  const outboxCorruptions = [];
  try {
    const pruned = await pruneSettledAttemptJournals(
      stateDir,
      {
        onCorrupt(value) {
          attemptCorruptions.push(freezeCopy(value));
        },
        onWarning(value) {
          attemptWarnings.push(freezeCopy(value));
        },
      },
    );
    const settledRetained = pruned.attempts.filter(
      (attempt) => attempt.decision.action === "settled",
    ).length;
    const attempts = pruned.attempts
      .filter((attempt) => attempt.decision.action !== "settled")
      .sort(compareRecoveryPriority);
    const selectedAttempts = attempts.slice(0, RECOVERY_ATTEMPT_MAX);
    const allJournalOperationIds = new Set(
      pruned.attempts
        .filter((attempt) => attempt.records.result)
        .map((attempt) =>
          deriveEngineCompletionOperationId(attempt.attemptId)
        ),
    );
    const initialOutbox = await recoverOutbox(
      stateDir,
      (value) => outboxCorruptions.push(freezeCopy(value)),
    );
    const initialIndex = indexOutbox(initialOutbox);
    const reconciled = [];
    for (const attempt of selectedAttempts) {
      try {
        reconciled.push(await reconcileAttempt({
          attempt,
          initialIndex,
          outboxCorruptions,
          stateDir,
        }));
      } catch (error) {
        reconciled.push(
          internalAttempt(
            attention(
              attempt.attemptId,
              coordinatorFailureReason(error),
            ),
            attempt.records,
          ),
        );
      }
    }
    let currentOutbox = await recoverOutbox(
      stateDir,
      (value) => outboxCorruptions.push(freezeCopy(value)),
    );
    let correlated = await correlateDeliverableEntries(
      reconciled,
      currentOutbox,
      allJournalOperationIds,
      stateDir,
    );
    const selectedEntries = correlated.entries
      .slice(0, RECOVERY_DELIVERY_MAX);
    const deferredDeliveries =
      correlated.entries.length - selectedEntries.length;
    const rawDrain = await drainCompletions(
      completionContext,
      stateDir,
      selectedEntries,
    );
    const drain = normalizeDrainReport(rawDrain, selectedEntries);
    currentOutbox = await recoverOutbox(
      stateDir,
      (value) => outboxCorruptions.push(freezeCopy(value)),
    );
    correlated = await correlateDeliverableEntries(
      correlated.items,
      currentOutbox,
      allJournalOperationIds,
      stateDir,
    );
    return deepFreeze({
      attempts: correlated.attempts,
      corrupt: {
        attempts: attemptCorruptions,
        outbox: outboxCorruptions,
      },
      deferredDeliveries,
      drain,
      permanentStop: drain.halt?.exitCodeHint === 77,
      prunedAttempts: pruned.removed,
      remainingAttempts: attempts.length - selectedAttempts.length,
      settledRetained,
      unmatchedOutbox: correlated.unmatchedOutbox,
      warnings: attemptWarnings,
    });
  } finally {
    await releaseLock();
  }
}

async function reconcileAttempt({
  attempt,
  initialIndex,
  outboxCorruptions,
  stateDir,
}) {
  let records = attempt.records;
  const initialAction = attempt.decision.action;
  if (initialAction === "replay_claim") {
    return internalAttempt(
      freezeCopy({
        action: "replay_claim",
        attemptId: attempt.attemptId,
        reason: "deferred_to_serve",
        status: "deferred",
      }),
      records,
    );
  }
  if (initialAction === "operator_attention") {
    return internalAttempt(
      attention(attempt.attemptId, attempt.decision.reason),
      records,
    );
  }
  if (
    initialAction === "inspect_supervisor" ||
    initialAction === "inspect_process"
  ) {
    const inspection = await inspectSupervisedAttempt(
      records.supervisor.supervisorStartToken,
      attempt.attemptId,
    );
    if (inspection.status !== "matching") {
      return internalAttempt(
        attention(
          attempt.attemptId,
          "supervisor_identity_ambiguous",
        ),
        records,
      );
    }
    if (inspection.event.state === "waiting_spawn") {
      return internalAttempt(
        attention(
          attempt.attemptId,
          records.started
            ? "supervisor_state_regressed"
            : "committed_prompt_unavailable",
        ),
        records,
      );
    }
    if (
      inspection.event.state === "waiting_input" ||
      inspection.event.state === "running"
    ) {
      return internalAttempt(
        freezeCopy({
          action: "monitor_supervisor",
          attemptId: attempt.attemptId,
          reason: "deferred_to_serve",
          status: "in_progress",
        }),
        records,
      );
    }
    if (
      inspection.event.state === "result" ||
      inspection.event.state === "fault"
    ) {
      try {
        records = await resumeSupervisedAttempt({
          attempt: records,
          stateDir,
        });
      } catch {
        return internalAttempt(
          attention(
            attempt.attemptId,
            "supervisor_recovery_ambiguous",
          ),
          records,
        );
      }
    } else {
      return internalAttempt(
        attention(
          attempt.attemptId,
          "supervisor_state_invalid",
        ),
        records,
      );
    }
    if (!records.result) {
      return internalAttempt(
        attention(
          attempt.attemptId,
          "supervisor_result_unavailable",
        ),
        records,
      );
    }
  }
  if (records.result && !records.outboxed) {
    const bridged = await bridgeCompletion({
      initialIndex,
      outboxCorruptions,
      records,
      stateDir,
    });
    if (bridged.status === "operator_attention") {
      return internalAttempt(bridged, records);
    }
    records = bridged.records;
    if (initialAction === "persist_completion") {
      await acknowledgeTerminalBestEffort(records, stateDir);
    }
    const entry = singleCompletionEntry(
      initialIndex,
      records,
      outboxCorruptions,
    );
    if (entry?.status && TERMINAL_OUTBOX_STATES.has(entry.status)) {
      records = await persistSettlement(records, entry, stateDir);
      return internalAttempt(settledOutcome(records), records);
    }
    return internalAttempt(
      freezeCopy({
        action:
          initialAction === "persist_completion"
            ? "persist_completion"
            : "resume_supervisor",
        attemptId: attempt.attemptId,
        operationId: records.outboxed.operationId,
        status: "outboxed",
      }),
      records,
      true,
    );
  }
  if (records.outboxed) {
    const verification = verifyOutboxedAttempt(
      records,
      initialIndex,
      outboxCorruptions,
    );
    if (verification.reason) {
      return internalAttempt(
        attention(attempt.attemptId, verification.reason),
        records,
      );
    }
    if (TERMINAL_OUTBOX_STATES.has(verification.entry.status)) {
      records = await persistSettlement(
        records,
        verification.entry,
        stateDir,
      );
      return internalAttempt(settledOutcome(records), records);
    }
    return internalAttempt(
      freezeCopy({
        action: "deliver_completion",
        attemptId: attempt.attemptId,
        operationId: records.outboxed.operationId,
        status: "queued",
      }),
      records,
      true,
    );
  }
  return internalAttempt(
    attention(
      attempt.attemptId,
      "attempt_recovery_incomplete",
    ),
    records,
  );
}

async function bridgeCompletion({
  initialIndex,
  outboxCorruptions,
  records,
  stateDir,
}) {
  const attemptId = records.claimed.attemptId;
  const operationId = deriveEngineCompletionOperationId(attemptId);
  if (operationId === records.claimed.claimOperationId) {
    return attention(attemptId, "completion_operation_collision");
  }
  const body = Buffer.from(canonicalJson({
    fence: records.starting.fence,
    leaseId: records.starting.leaseId,
    operationId,
    receipt: records.result.receipt,
  }));
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  if (corruptOperationIds(outboxCorruptions).has(operationId)) {
    return attention(attemptId, "completion_operation_corrupt");
  }
  let candidates = initialIndex.get(operationId) ?? [];
  if (candidates.length === 0) {
    try {
      const entry = await persistDeclarationOperation(stateDir, {
        body,
        declarationKind: "engine.complete",
        operationId,
        runId: records.starting.runId,
      });
      candidates = [entry];
    } catch (error) {
      if (
        !(error instanceof OutboxError) ||
        !/already exists in the outbox/u.test(error.message)
      ) {
        throw error;
      }
      const replayed = await recoverOutbox(
        stateDir,
        (value) => outboxCorruptions.push(freezeCopy(value)),
      );
      candidates = indexOutbox(replayed).get(operationId) ?? [];
    }
  }
  if (
    candidates.length !== 1 ||
    !matchesCompletionEntry(
      candidates[0],
      records.claimed.runId,
      operationId,
      bodySha256,
    )
  ) {
    return attention(attemptId, "completion_operation_mismatch");
  }
  const outboxed = finalizeAttemptRecord({
    attemptId,
    bodySha256,
    createdAt: maxIso(
      new Date().toISOString(),
      candidates[0].createdAt,
      records.result.createdAt,
    ),
    operationId,
    state: "outboxed",
    v: 1,
  });
  return {
    records: await persistAttemptRecord(stateDir, outboxed),
    status: "outboxed",
  };
}

function matchesCompletionEntry(entry, runId, operationId, bodySha256) {
  return Boolean(
    entry?.v === 3 &&
      entry.operationId === operationId &&
      entry.declarationKind === "engine.complete" &&
      entry.runId === runId &&
      entry.bodySha256 === bodySha256 &&
      ["pending", "acked", "rejected", "superseded"].includes(entry.status),
  );
}

function verifyOutboxedAttempt(records, outboxIndex, outboxCorruptions) {
  const operationId = deriveEngineCompletionOperationId(
    records.claimed.attemptId,
  );
  if (
    operationId === records.claimed.claimOperationId ||
    records.outboxed.operationId !== operationId
  ) {
    return { reason: "completion_operation_mismatch" };
  }
  if (corruptOperationIds(outboxCorruptions).has(operationId)) {
    return { reason: "completion_operation_corrupt" };
  }
  const candidates = outboxIndex.get(operationId) ?? [];
  if (
    candidates.length !== 1 ||
    !matchesCompletionEntry(
      candidates[0],
      records.starting.runId,
      operationId,
      records.outboxed.bodySha256,
    )
  ) {
    return { reason: "completion_operation_mismatch" };
  }
  return { entry: candidates[0] };
}

function singleCompletionEntry(
  outboxIndex,
  records,
  outboxCorruptions,
) {
  return verifyOutboxedAttempt(
    records,
    outboxIndex,
    outboxCorruptions,
  ).entry;
}

async function correlateDeliverableEntries(
  reconciled,
  outboxEntries,
  recoveredJournalOperationIds,
  stateDir,
) {
  const index = indexOutbox(outboxEntries);
  const operationOwners = new Map();
  const journalOperationIds = new Set(recoveredJournalOperationIds);
  for (const item of reconciled) {
    if (item.records.result) {
      journalOperationIds.add(
        deriveEngineCompletionOperationId(
          item.records.claimed.attemptId,
        ),
      );
    }
    if (!item.deliverable) continue;
    const operationId = item.records.outboxed.operationId;
    const owners = operationOwners.get(operationId) ?? [];
    owners.push(item.records.claimed.attemptId);
    operationOwners.set(operationId, owners);
  }
  const entries = [];
  const items = [];
  const deliverableIds = new Set();
  for (const item of reconciled) {
    if (!item.deliverable) {
      items.push(item);
      continue;
    }
    const operationId = item.records.outboxed.operationId;
    const candidates = index.get(operationId) ?? [];
    const owners = operationOwners.get(operationId) ?? [];
    if (
      owners.length !== 1 ||
      candidates.length !== 1 ||
      !matchesCompletionEntry(
        candidates[0],
        item.records.starting.runId,
        operationId,
        item.records.outboxed.bodySha256,
      )
    ) {
      items.push(
        internalAttempt(
          attention(
            item.records.claimed.attemptId,
            owners.length === 1
              ? "completion_operation_mismatch"
              : "completion_operation_ambiguous",
          ),
          item.records,
        ),
      );
      continue;
    }
    const entry = candidates[0];
    if (TERMINAL_OUTBOX_STATES.has(entry.status)) {
      try {
        const records = await persistSettlement(
          item.records,
          entry,
          stateDir,
        );
        items.push(internalAttempt(settledOutcome(records), records));
      } catch {
        items.push(
          internalAttempt(
            attention(
              item.records.claimed.attemptId,
              "settlement_persist_failed",
            ),
            item.records,
          ),
        );
      }
      continue;
    }
    if (entry.status !== "pending") {
      items.push(
        internalAttempt(
          attention(
            item.records.claimed.attemptId,
            "completion_operation_mismatch",
          ),
          item.records,
        ),
      );
      continue;
    }
    items.push(item);
    entries.push(entry);
    deliverableIds.add(operationId);
  }
  const unmatchedOutbox = outboxEntries
    .filter((entry) =>
      entry?.v === 3 &&
      entry.declarationKind === "engine.complete" &&
      entry.status === "pending" &&
      !deliverableIds.has(entry.operationId) &&
      !journalOperationIds.has(entry.operationId)
    )
    .map((entry) => freezeCopy({
      operationId: entry.operationId,
      reason: "journal_correlation_missing",
      status: "operator_attention",
    }))
    .sort((left, right) =>
      left.operationId.localeCompare(right.operationId)
    );
  return {
    attempts: items.map((item) => item.outcome),
    entries,
    items,
    unmatchedOutbox,
  };
}

async function persistSettlement(records, entry, stateDir) {
  if (!TERMINAL_OUTBOX_STATES.has(entry.status)) {
    throw new EngineAttemptCoordinatorError(
      "Completion settlement is invalid.",
    );
  }
  const settled = finalizeAttemptRecord({
    attemptId: records.claimed.attemptId,
    createdAt: maxIso(
      new Date().toISOString(),
      entry.updatedAt,
      records.outboxed.createdAt,
    ),
    operationId: records.outboxed.operationId,
    outcome: entry.status,
    state: "settled",
    v: 1,
  });
  return persistAttemptRecord(stateDir, settled);
}

function settledOutcome(records) {
  return freezeCopy({
    action: "settled",
    attemptId: records.claimed.attemptId,
    operationId: records.settled.operationId,
    outcome: records.settled.outcome,
    status: "settled",
  });
}

function internalAttempt(outcome, records, deliverable = false) {
  return {
    deliverable,
    outcome,
    records,
  };
}

function compareRecoveryPriority(left, right) {
  const priorities = {
    deliver_completion: 0,
    persist_completion: 1,
    inspect_process: 2,
    inspect_supervisor: 3,
    replay_claim: 4,
    operator_attention: 5,
  };
  return (
    priorities[left.decision.action] -
      priorities[right.decision.action] ||
    left.records.claimed.createdAt.localeCompare(
      right.records.claimed.createdAt,
    ) ||
    left.attemptId.localeCompare(right.attemptId)
  );
}

function coordinatorFailureReason(error) {
  return [
    "EIO",
    "ENOSPC",
    "EROFS",
    "EDQUOT",
  ].includes(error?.code)
    ? "attempt_storage_error"
    : "attempt_recovery_error";
}

async function acknowledgeTerminalBestEffort(records, stateDir) {
  try {
    await resumeSupervisedAttempt({
      attempt: records,
      stateDir,
    });
  } catch {
    // Completion and its journal marker are already durable. A refused local
    // endpoint is ambiguous, so cleanup remains best-effort and never signals
    // the journaled PID.
  }
}

function attention(attemptId, reason) {
  return freezeCopy({
    action: "operator_attention",
    attemptId,
    reason,
    status: "operator_attention",
  });
}

function indexOutbox(entries) {
  const index = new Map();
  for (const entry of entries) {
    const values = index.get(entry.operationId) ?? [];
    values.push(entry);
    index.set(entry.operationId, values);
  }
  return index;
}

function corruptOperationIds(corruptions) {
  const values = new Set();
  for (const corruption of corruptions) {
    const match =
      /^(op_[0-9a-f]{32})\.json$/u.exec(corruption.file ?? "");
    if (match) values.add(match[1]);
  }
  return values;
}

function normalizeDrainReport(value, entries) {
  try {
    if (
      !plainRecord(value) ||
      !hasExactKeys(value, [
        "attempted",
        "delivered",
        "failed",
        "halt",
        "remainingPending",
      ]) ||
      !Number.isSafeInteger(value.attempted) ||
      value.attempted < 0 ||
      value.attempted > entries.length ||
      !Number.isSafeInteger(value.remainingPending) ||
      value.remainingPending < 0 ||
      value.remainingPending > entries.length ||
      !Array.isArray(value.delivered) ||
      !Array.isArray(value.failed)
    ) {
      throw new EngineAttemptCoordinatorError(
        "Completion drain report is invalid.",
      );
    }
    const allowed = new Set(entries.map((entry) => entry.operationId));
    const observed = new Set();
    const delivered = value.delivered.map((item) =>
      normalizeDelivered(item, allowed, observed)
    );
    const failed = value.failed.map((item) =>
      normalizeFailure(item, allowed, observed, false)
    );
    const halt = value.halt === null
      ? null
      : normalizeFailure(value.halt, allowed, observed, true);
    const outcomeCount =
      delivered.length + failed.length + (halt ? 1 : 0);
    const settledHalt = halt?.code === "auth" ? 1 : 0;
    if (
      outcomeCount > value.attempted ||
      entries.length -
        delivered.length -
        failed.length -
        settledHalt !== value.remainingPending
    ) {
      throw new EngineAttemptCoordinatorError(
        "Completion drain report is inconsistent.",
      );
    }
    return deepFreeze({
      attempted: value.attempted,
      delivered,
      failed,
      halt,
      remainingPending: value.remainingPending,
    });
  } catch (error) {
    if (error instanceof EngineAttemptCoordinatorError) throw error;
    throw new EngineAttemptCoordinatorError(
      "Completion drain report is invalid.",
    );
  }
}

function normalizeDelivered(item, allowed, observed) {
  if (
    !plainRecord(item) ||
    !hasExactKeys(item, [
      "late",
      "operationId",
      "recordedAt",
      "replay",
      "runId",
    ]) ||
    typeof item.late !== "boolean" ||
    typeof item.replay !== "boolean" ||
    !canonicalTimestamp(item.recordedAt) ||
    !RUN_PATTERN.test(item.runId ?? "") ||
    !takeOperation(item.operationId, allowed, observed)
  ) {
    throw new EngineAttemptCoordinatorError(
      "Completion drain delivery is invalid.",
    );
  }
  return {
    late: item.late,
    operationId: item.operationId,
    recordedAt: item.recordedAt,
    replay: item.replay,
    runId: item.runId,
  };
}

function normalizeFailure(item, allowed, observed, halt) {
  const keys = [
    "code",
    "httpStatus",
    "operationId",
    "runId",
    "serverError",
  ];
  if (halt) keys.push("exitCodeHint");
  const allowedCodes = halt
    ? new Set(["auth", "protocol", "retryable"])
    : new Set(["rejected", "superseded"]);
  if (
    !plainRecord(item) ||
    !hasExactKeys(item, keys) ||
    !allowedCodes.has(item.code) ||
    !RUN_PATTERN.test(item.runId ?? "") ||
    !takeOperation(item.operationId, allowed, observed) ||
    !validHttpStatus(item.httpStatus) ||
    !validServerError(item.serverError) ||
    (
      halt &&
      item.exitCodeHint !==
        (item.code === "auth" ? 77 : item.code === "protocol" ? 76 : 75)
    )
  ) {
    throw new EngineAttemptCoordinatorError(
      "Completion drain failure is invalid.",
    );
  }
  return {
    code: item.code,
    httpStatus: item.httpStatus,
    operationId: item.operationId,
    runId: item.runId,
    serverError: item.serverError,
    ...(halt ? { exitCodeHint: item.exitCodeHint } : {}),
  };
}

function takeOperation(operationId, allowed, observed) {
  if (
    !OPERATION_PATTERN.test(operationId ?? "") ||
    !allowed.has(operationId) ||
    observed.has(operationId)
  ) {
    return false;
  }
  observed.add(operationId);
  return true;
}

function validHttpStatus(value) {
  return (
    value === null ||
    (
      Number.isSafeInteger(value) &&
      value >= 100 &&
      value <= 599
    )
  );
}

function validServerError(value) {
  return (
    value === null ||
    (
      typeof value === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    )
  );
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index])
  );
}

function plainRecord(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

function assertStateDirectory(stateDir) {
  if (
    typeof stateDir !== "string" ||
    !isAbsolute(stateDir) ||
    stateDir.length < 2
  ) {
    throw new EngineAttemptCoordinatorError(
      "State directory is invalid.",
    );
  }
}

function maxIso(...timestamps) {
  return timestamps.filter(Boolean).sort().at(-1);
}

function freezeCopy(value) {
  return deepFreeze({ ...value });
}

function deepFreeze(value, seen = new WeakSet(), depth = 0) {
  if (depth > 16) {
    throw new EngineAttemptCoordinatorError(
      "Recovery report nesting is invalid.",
    );
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new EngineAttemptCoordinatorError(
        "Recovery report cycle is invalid.",
      );
    }
    seen.add(value);
    return Object.freeze(
      value.map((item) => deepFreeze(item, seen, depth + 1)),
    );
  }
  if (value !== null && typeof value === "object") {
    if (!plainRecord(value) || seen.has(value)) {
      throw new EngineAttemptCoordinatorError(
        "Recovery report value is invalid.",
      );
    }
    seen.add(value);
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          deepFreeze(item, seen, depth + 1),
        ]),
      ),
    );
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
