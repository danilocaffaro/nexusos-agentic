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
  pruneOutbox,
  recoverOutbox,
  transitionOperation,
  withOutboxLockOwnership,
} from "./durable-outbox.mjs";
import {
  classifyEngineCompleteResponse,
  parseEngineCompleteAck,
} from "./engine-complete-contract.mjs";
import {
  deriveOutboxPathname,
  outboxEntryChecksum,
} from "./outbox-contract.mjs";
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
const CORRELATABLE_OUTBOX_STATES = new Set([
  "pending",
  ...TERMINAL_OUTBOX_STATES,
  "abandoned",
]);
const SETTLEMENT_OUTBOX_STATES = new Set([
  ...TERMINAL_OUTBOX_STATES,
  "abandoned",
]);
const ENGINE_RESPONSE_MAX_BYTES = 64 * 1_024;
const ENGINE_RESPONSE_MAX_BASE64URL_CHARACTERS = Math.ceil(
  ENGINE_RESPONSE_MAX_BYTES * 4 / 3,
);
const ENGINE_COMPLETE_SERVER_ERRORS = new Set([
  "cancellation_not_requested",
  "conflict_retry",
  "engine_deadline_exhausted",
  "engine_mismatch",
  "engine_version_mismatch",
  "lease_expired",
  "lease_superseded",
  "nonce_reused",
  "operation_conflict",
  "operation_horizon_exceeded",
  "run_operation_failed",
  "run_unavailable",
  "runner_audience_unconfigured",
  "runner_rejected",
]);
const RECOVERY_PLANS = new WeakMap();
const ACTIVE_RECOVERIES = new WeakMap();

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
  const parameters = coordinatorParameters(input);
  const releaseLock = await acquireOutboxLock(parameters.stateDir);
  try {
    return await coordinateEngineAttemptRecoveryHeld(
      parameters,
      releaseLock,
    );
  } finally {
    await releaseLock();
  }
}

export async function coordinateEngineAttemptRecoveryHeld(
  input,
  ownershipCapability,
) {
  const parameters = coordinatorParameters(input);
  const plan = await prepareEngineAttemptRecoveryHeld(
    { stateDir: parameters.stateDir },
    ownershipCapability,
  );
  try {
    const rawDrain = await parameters.drainCompletions(
      parameters.completionContext,
      parameters.stateDir,
      plan.entries,
    );
    return await finalizeEngineAttemptRecoveryHeld(
      {
        drainReport: rawDrain,
        plan,
        stateDir: parameters.stateDir,
      },
      ownershipCapability,
    );
  } catch (error) {
    abortRecoveryPlan(plan, ownershipCapability);
    throw error;
  }
}

export async function prepareEngineAttemptRecoveryHeld(
  input,
  ownershipCapability,
) {
  const stateDir = recoveryStateDirectory(input);
  return withOutboxLockOwnership(
    stateDir,
    ownershipCapability,
    async () => {
      if (ACTIVE_RECOVERIES.has(ownershipCapability)) {
        throw new EngineAttemptCoordinatorError(
          "A recovery cycle is already active.",
          "engine_attempt_recovery_active",
        );
      }
      const context = await prepareEngineAttemptRecoveryCore(stateDir);
      const intents = context.selectedEntries.map((entry) => {
        const item = context.correlated.items.find(
          (candidate) =>
            candidate.records.outboxed?.operationId === entry.operationId,
        );
        if (!item) {
          throw new EngineAttemptCoordinatorError(
            "Recovery intent correlation is invalid.",
          );
        }
        return freezeCopy({
          attemptId: item.records.claimed.attemptId,
          expectedEntrySha256: outboxEntryChecksum(entry),
          operationId: entry.operationId,
          request: {
            bodyBase64Url: entry.bodyBase64,
            bodySha256: entry.bodySha256,
            pathname: deriveOutboxPathname(entry),
            signatureDomain: "nexus-runner-engine-complete-v1",
          },
          runId: entry.runId,
        });
      });
      const plan = deepFreeze({
        entries: context.selectedEntries.map((entry) =>
          freezeCopy(entry)
        ),
        intents,
      });
      const registered = {
        active: true,
        capability: ownershipCapability,
        context,
        effects: new Map(
          intents.map((intent) => [
            intent.operationId,
            { phase: "pending" },
          ]),
        ),
        halt: null,
        outcomes: [],
        stateDir,
      };
      RECOVERY_PLANS.set(plan, registered);
      ACTIVE_RECOVERIES.set(ownershipCapability, registered);
      return plan;
    },
  );
}

export async function finalizeEngineAttemptRecoveryHeld(
  input,
  ownershipCapability,
) {
  const { drainReport, plan } = input ?? {};
  const stateDir = recoveryStateDirectory(input);
  return withOutboxLockOwnership(
    stateDir,
    ownershipCapability,
    () => {
      const registered = RECOVERY_PLANS.get(plan);
      if (
        !registered?.active ||
        registered.stateDir !== stateDir ||
        registered.capability !== ownershipCapability
      ) {
        throw new EngineAttemptCoordinatorError(
          "Recovery plan is invalid.",
        );
      }
      try {
        return finalizeEngineAttemptRecoveryCore(
          registered.context,
          drainReport,
        );
      } finally {
        finishRecoveryPlan(plan, registered);
      }
    },
  );
}

export async function finalizeEngineCompletionEffectHeld(
  input,
  ownershipCapability,
) {
  const {
    effect,
    intent,
    plan,
  } = input ?? {};
  const stateDir = recoveryStateDirectory(input);
  const normalizedEffect = normalizeCompletionEffect(effect);
  return withOutboxLockOwnership(
    stateDir,
    ownershipCapability,
    async () => {
      const registered = activeRecoveryPlan(
        plan,
        stateDir,
        ownershipCapability,
      );
      const plannedIntent = plan.intents.find(
        (candidate) =>
          candidate === intent ||
          (
            candidate.operationId === intent?.operationId &&
            candidate.expectedEntrySha256 ===
              intent?.expectedEntrySha256
          ),
      );
      const effectState = registered.effects.get(
        plannedIntent?.operationId,
      );
      if (!plannedIntent || !effectState) {
        throw new EngineAttemptCoordinatorError(
          "Recovery intent is invalid.",
        );
      }
      if (registered.halt) {
        throw new EngineAttemptCoordinatorError(
          "Recovery plan is halted.",
        );
      }
      if (effectState.phase === "finalized") {
        throw new EngineAttemptCoordinatorError(
          "Recovery intent was already finalized.",
        );
      }
      if (
        normalizedEffect.operationId !== plannedIntent.operationId ||
        normalizedEffect.runId !== plannedIntent.runId
      ) {
        throw new EngineAttemptCoordinatorError(
          "Completion effect is invalid.",
        );
      }
      if (
        effectState.phase === "captured" &&
        canonicalJson(effectState.effect) !==
          canonicalJson(normalizedEffect)
      ) {
        throw new EngineAttemptCoordinatorError(
          "Recovery effect changed during finalization.",
        );
      }
      effectState.phase = "captured";
      effectState.effect = normalizedEffect;
      const corruptionCount =
        registered.context.outboxCorruptions.length;
      let outcome;
      try {
        const currentEntry = await exactPendingIntentEntry(
          stateDir,
          plannedIntent,
          registered.context.outboxCorruptions,
        );
        outcome = await applyCompletionEffect(
          stateDir,
          registered,
          plannedIntent,
          currentEntry,
          normalizedEffect,
        );
      } catch (error) {
        const newCorruptions =
          registered.context.outboxCorruptions.slice(
            corruptionCount,
          );
        const intentWasQuarantined = newCorruptions.some(
          (value) =>
            value.file === `${plannedIntent.operationId}.json`,
        );
        if (
          !intentWasQuarantined ||
          ![
            "Completion tombstone is not durable.",
            "Recovery intent no longer matches durable state.",
          ].includes(error?.message)
        ) {
          throw error;
        }
        outcome = haltOutcome(
          plannedIntent,
          "protocol",
          null,
          null,
        );
      }
      effectState.phase = "finalized";
      effectState.outcome = outcome;
      registered.outcomes.push(outcome);
      if (outcome.kind === "halt") registered.halt = outcome;
      return outcome;
    },
  );
}

export async function completeEngineAttemptRecoveryHeld(
  input,
  ownershipCapability,
) {
  const { plan, pruneNowMs } = input ?? {};
  const stateDir = recoveryStateDirectory(input);
  if (
    pruneNowMs !== undefined &&
    (
      !Number.isSafeInteger(pruneNowMs) ||
      pruneNowMs < 0 ||
      pruneNowMs > Date.now()
    )
  ) {
    throw new EngineAttemptCoordinatorError(
      "Recovery prune time is invalid.",
    );
  }
  return withOutboxLockOwnership(
    stateDir,
    ownershipCapability,
    async () => {
      const registered = activeRecoveryPlan(
        plan,
        stateDir,
        ownershipCapability,
      );
      if (
        [...registered.effects.values()].some(
          (value) => value.phase === "captured",
        )
      ) {
        throw new EngineAttemptCoordinatorError(
          "A recovery effect is not finalized.",
        );
      }
      const rawDrain = effectOutcomesDrainReport(
        registered,
        plan.intents.length,
      );
      try {
        return await finalizeEngineAttemptRecoveryCore(
          registered.context,
          rawDrain,
          pruneNowMs,
        );
      } finally {
        finishRecoveryPlan(plan, registered);
      }
    },
  );
}

export async function abortEngineAttemptRecoveryHeld(
  input,
  ownershipCapability,
) {
  const { plan } = input ?? {};
  const stateDir = recoveryStateDirectory(input);
  return withOutboxLockOwnership(
    stateDir,
    ownershipCapability,
    () => {
      const registered = activeRecoveryPlan(
        plan,
        stateDir,
        ownershipCapability,
      );
      finishRecoveryPlan(plan, registered);
    },
  );
}

function coordinatorParameters(input) {
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
  return { completionContext, drainCompletions, stateDir };
}

function recoveryStateDirectory(input) {
  const { stateDir } = input ?? {};
  assertStateDirectory(stateDir);
  return stateDir;
}

async function prepareEngineAttemptRecoveryCore(stateDir) {
  const attemptCorruptions = [];
  const attemptWarnings = [];
  const outboxCorruptions = [];
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
  return {
    allJournalOperationIds,
    attemptCorruptions,
    attemptWarnings,
    attempts,
    correlated,
    deferredDeliveries,
    outboxCorruptions,
    pruned,
    selectedAttempts,
    selectedEntries,
    settledRetained,
    stateDir,
  };
}

async function finalizeEngineAttemptRecoveryCore(
  context,
  rawDrain,
  pruneNowMs,
) {
  const {
    allJournalOperationIds,
    attemptCorruptions,
    attemptWarnings,
    attempts,
    correlated: prepared,
    deferredDeliveries,
    outboxCorruptions,
    pruned,
    selectedAttempts,
    selectedEntries,
    settledRetained,
    stateDir,
  } = context;
  const drain = normalizeDrainReport(rawDrain, selectedEntries);
  const currentOutbox = await recoverOutbox(
    stateDir,
    (value) => outboxCorruptions.push(freezeCopy(value)),
  );
  const correlated = await correlateDeliverableEntries(
    prepared.items,
    currentOutbox,
    allJournalOperationIds,
    stateDir,
  );
  const settledOperationIds = new Set([
    ...pruned.attempts
      .map((attempt) => attempt.records.settled?.operationId)
      .filter(Boolean),
    ...correlated.items
      .map((item) => item.records.settled?.operationId)
      .filter(Boolean),
  ]);
  const hasUnsettledTerminal = currentOutbox.some(
    (entry) =>
      SETTLEMENT_OUTBOX_STATES.has(entry.status) &&
      allJournalOperationIds.has(entry.operationId) &&
      !settledOperationIds.has(entry.operationId),
  );
  const prunedOutbox =
    attempts.length === selectedAttempts.length &&
    !hasUnsettledTerminal
    ? await pruneOutbox(
      stateDir,
      pruneNowMs ?? Date.now(),
    )
    : 0;
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
    prunedOutbox,
    remainingAttempts: attempts.length - selectedAttempts.length,
    settledRetained,
    unmatchedOutbox: correlated.unmatchedOutbox,
    warnings: attemptWarnings,
  });
}

function activeRecoveryPlan(plan, stateDir, ownershipCapability) {
  const registered = RECOVERY_PLANS.get(plan);
  if (
    !registered?.active ||
    registered.stateDir !== stateDir ||
    registered.capability !== ownershipCapability ||
    ACTIVE_RECOVERIES.get(ownershipCapability) !== registered
  ) {
    throw new EngineAttemptCoordinatorError(
      "Recovery plan is invalid.",
    );
  }
  return registered;
}

function finishRecoveryPlan(plan, registered) {
  registered.active = false;
  RECOVERY_PLANS.delete(plan);
  if (ACTIVE_RECOVERIES.get(registered.capability) === registered) {
    ACTIVE_RECOVERIES.delete(registered.capability);
  }
}

function abortRecoveryPlan(plan, ownershipCapability) {
  const registered = RECOVERY_PLANS.get(plan);
  if (
    registered?.active &&
    registered.capability === ownershipCapability
  ) {
    finishRecoveryPlan(plan, registered);
  }
}

async function exactPendingIntentEntry(
  stateDir,
  intent,
  outboxCorruptions,
) {
  const candidates = (await recoverOutbox(
    stateDir,
    (value) => outboxCorruptions.push(freezeCopy(value)),
  )).filter(
    (entry) => entry.operationId === intent.operationId,
  );
  if (
    candidates.length !== 1 ||
    candidates[0].v !== 3 ||
    candidates[0].declarationKind !== "engine.complete" ||
    candidates[0].runId !== intent.runId ||
    candidates[0].status !== "pending" ||
    candidates[0].entrySha256 !== intent.expectedEntrySha256 ||
    outboxEntryChecksum(candidates[0]) !== intent.expectedEntrySha256
  ) {
    throw new EngineAttemptCoordinatorError(
      "Recovery intent no longer matches durable state.",
    );
  }
  return candidates[0];
}

function normalizeCompletionEffect(value) {
  const kindDescriptor = plainRecord(value)
    ? Object.getOwnPropertyDescriptor(value, "kind")
    : undefined;
  if (
    !kindDescriptor?.enumerable ||
    !Object.hasOwn(kindDescriptor, "value") ||
    typeof kindDescriptor.value !== "string"
  ) {
    throw new EngineAttemptCoordinatorError(
      "Completion effect is invalid.",
    );
  }
  const expected = kindDescriptor.value === "transport_error"
    ? ["kind", "operationId", "runId"]
    : kindDescriptor.value === "response_error"
      ? [
        "code",
        "httpStatus",
        "kind",
        "operationId",
        "runId",
      ]
      : kindDescriptor.value === "response"
        ? [
          "bodyBase64Url",
          "httpStatus",
          "kind",
          "operationId",
          "replay",
          "runId",
        ]
        : [];
  const snapshot = snapshotExactDataRecord(value, expected);
  if (
    !snapshot ||
    !OPERATION_PATTERN.test(snapshot.operationId ?? "") ||
    !RUN_PATTERN.test(snapshot.runId ?? "")
  ) {
    throw new EngineAttemptCoordinatorError(
      "Completion effect is invalid.",
    );
  }
  if (
    snapshot.kind === "transport_error"
  ) {
    return freezeCopy(snapshot);
  }
  if (
    snapshot.kind === "response_error" &&
    ["protocol", "retryable"].includes(snapshot.code) &&
    validHttpStatus(snapshot.httpStatus)
  ) {
    return freezeCopy(snapshot);
  }
  if (
    snapshot.kind === "response" &&
    validHttpStatus(snapshot.httpStatus) &&
    snapshot.httpStatus !== null &&
    typeof snapshot.replay === "boolean" &&
    typeof snapshot.bodyBase64Url === "string" &&
    snapshot.bodyBase64Url.length <=
      ENGINE_RESPONSE_MAX_BASE64URL_CHARACTERS
  ) {
    const body = decodeCanonicalBase64Url(snapshot.bodyBase64Url);
    if (!body || body.byteLength > ENGINE_RESPONSE_MAX_BYTES) {
      throw new EngineAttemptCoordinatorError(
        "Completion effect is invalid.",
      );
    }
    return freezeCopy(snapshot);
  }
  throw new EngineAttemptCoordinatorError(
    "Completion effect is invalid.",
  );
}

function snapshotExactDataRecord(value, expectedKeys) {
  if (
    !plainRecord(value) ||
    expectedKeys.length < 1
  ) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string") ||
    !expectedKeys.every((key) => keys.includes(key))
  ) {
    return undefined;
  }
  const snapshot = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      return undefined;
    }
    Object.defineProperty(snapshot, key, {
      enumerable: true,
      value: descriptor.value,
    });
  }
  return snapshot;
}

async function applyCompletionEffect(
  stateDir,
  registered,
  intent,
  entry,
  effect,
) {
  if (effect.kind === "transport_error") {
    return haltOutcome(intent, "retryable", null, null);
  }
  if (effect.kind === "response_error") {
    return haltOutcome(
      intent,
      effect.code,
      effect.httpStatus,
      null,
    );
  }
  const body = decodeCanonicalBase64Url(effect.bodyBase64Url);
  let payload;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(body);
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  const classification = classifyEngineCompleteResponse(
    effect.httpStatus,
    payload,
    intent.runId,
  );
  const serverError = classifiedEngineCompleteServerError(payload);
  if (classification.classification === "success") {
    const acknowledgement = parseEngineCompleteAck(
      payload,
      intent.runId,
    );
    await transitionAndAdopt(
      stateDir,
      registered,
      intent,
      entry,
      "acked",
      effect.httpStatus,
      body,
    );
    return freezeCopy({
      kind: "delivered",
      late: acknowledgement.late,
      operationId: intent.operationId,
      recordedAt: acknowledgement.recordedAt,
      replay: effect.replay,
      runId: intent.runId,
    });
  }
  if (classification.outboxStatus === "pending") {
    return haltOutcome(
      intent,
      classification.classification === "protocol_error"
        ? "protocol"
        : "retryable",
      effect.httpStatus,
      serverError,
    );
  }
  if (serverError === null) {
    return haltOutcome(
      intent,
      "protocol",
      effect.httpStatus,
      null,
    );
  }
  await transitionAndAdopt(
    stateDir,
    registered,
    intent,
    entry,
    classification.outboxStatus,
    effect.httpStatus,
    body,
  );
  if (effect.httpStatus === 401 || effect.httpStatus === 403) {
    return haltOutcome(
      intent,
      "auth",
      effect.httpStatus,
      serverError,
    );
  }
  return freezeCopy({
    code: classification.outboxStatus,
    httpStatus: effect.httpStatus,
    kind: "failed",
    operationId: intent.operationId,
    runId: intent.runId,
    serverError,
  });
}

async function transitionAndAdopt(
  stateDir,
  registered,
  intent,
  entry,
  status,
  httpStatus,
  body,
) {
  await transitionOperation(
    stateDir,
    entry,
    status,
    { status: httpStatus, body },
  );
  const candidates = (await recoverOutbox(
    stateDir,
    (value) =>
      registered.context.outboxCorruptions.push(freezeCopy(value)),
  )).filter(
    (candidate) => candidate.operationId === intent.operationId,
  );
  const responseSha256 = createHash("sha256")
    .update(body)
    .digest("hex");
  if (
    candidates.length !== 1 ||
    candidates[0].v !== 3 ||
    candidates[0].declarationKind !== "engine.complete" ||
    candidates[0].operationId !== intent.operationId ||
    candidates[0].runId !== intent.runId ||
    candidates[0].status !== status ||
    candidates[0].responseStatus !== httpStatus ||
    candidates[0].responseSha256 !== responseSha256 ||
    outboxEntryChecksum(candidates[0]) !==
      candidates[0].entrySha256
  ) {
    throw new EngineAttemptCoordinatorError(
      "Completion tombstone is not durable.",
    );
  }
  const index = registered.context.correlated.items.findIndex(
    (item) =>
      item.records.claimed.attemptId === intent.attemptId &&
      item.records.outboxed?.operationId === intent.operationId,
  );
  if (index < 0) {
    throw new EngineAttemptCoordinatorError(
      "Completion journal correlation is invalid.",
    );
  }
  const item = registered.context.correlated.items[index];
  const records = await persistSettlement(
    item.records,
    candidates[0],
    stateDir,
  );
  registered.context.correlated.items[index] = internalAttempt(
    terminalAttemptOutcome(records, status),
    records,
  );
}

function classifiedEngineCompleteServerError(payload) {
  return (
    plainRecord(payload) &&
    typeof payload.error === "string" &&
    ENGINE_COMPLETE_SERVER_ERRORS.has(payload.error)
  )
    ? payload.error
    : null;
}

function haltOutcome(intent, code, httpStatus, serverError) {
  return freezeCopy({
    code,
    exitCodeHint:
      code === "auth" ? 77 : code === "protocol" ? 76 : 75,
    httpStatus,
    kind: "halt",
    operationId: intent.operationId,
    runId: intent.runId,
    serverError,
  });
}

function effectOutcomesDrainReport(registered, total) {
  const delivered = registered.outcomes
    .filter((outcome) => outcome.kind === "delivered")
    .map(withoutOutcomeKind);
  const failed = registered.outcomes
    .filter((outcome) => outcome.kind === "failed")
    .map(withoutOutcomeKind);
  const halt = registered.halt
    ? Object.fromEntries(
      Object.entries(registered.halt).filter(([key]) => key !== "kind"),
    )
    : null;
  const terminalHalt = halt?.code === "auth" ? 1 : 0;
  return {
    attempted: registered.outcomes.length,
    delivered,
    failed,
    halt,
    remainingPending:
      total - delivered.length - failed.length - terminalHalt,
  };
}

function withoutOutcomeKind(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "kind"),
  );
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
  if (initialAction === "complete_prestart_cancel") {
    return internalAttempt(
      freezeCopy({
        action: "complete_prestart_cancel",
        attemptId: attempt.attemptId,
        reason: "deferred_to_serve",
        status: "deferred",
      }),
      records,
    );
  }
  if (initialAction === "resume_prestart") {
    return internalAttempt(
      freezeCopy({
        action: "resume_prestart",
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
    if (entry?.status && SETTLEMENT_OUTBOX_STATES.has(entry.status)) {
      records = await persistSettlement(records, entry, stateDir);
      return internalAttempt(
        terminalAttemptOutcome(records, entry.status),
        records,
      );
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
    if (SETTLEMENT_OUTBOX_STATES.has(verification.entry.status)) {
      records = await persistSettlement(
        records,
        verification.entry,
        stateDir,
      );
      return internalAttempt(
        terminalAttemptOutcome(records, verification.entry.status),
        records,
      );
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
      CORRELATABLE_OUTBOX_STATES.has(entry.status),
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
    if (SETTLEMENT_OUTBOX_STATES.has(entry.status)) {
      try {
        const records = await persistSettlement(
          item.records,
          entry,
          stateDir,
        );
        items.push(
          internalAttempt(
            terminalAttemptOutcome(records, entry.status),
            records,
          ),
        );
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
  if (!SETTLEMENT_OUTBOX_STATES.has(entry.status)) {
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

function terminalAttemptOutcome(records, outboxStatus) {
  return outboxStatus === "abandoned"
    ? attention(
      records.claimed.attemptId,
      "completion_operation_abandoned",
    )
    : settledOutcome(records);
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
    complete_prestart_cancel: 4,
    resume_prestart: 5,
    replay_claim: 6,
    operator_attention: 7,
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

function decodeCanonicalBase64Url(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]*$/u.test(value) ||
    value.length % 4 === 1
  ) {
    return undefined;
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
  return decoded.toString("base64url") === value
    ? decoded
    : undefined;
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
