import { randomBytes } from "node:crypto";
import {
  persistAttemptRecord,
  recoverAttemptJournals,
} from "./attempt-journal-store.mjs";
import {
  createClaimedRecord,
  createEngineClaimIntent,
  createEnginePromptIntentFromStarting,
  createStartingRecord,
  evaluateDescriptorBudget,
} from "./engine-claim-contract.mjs";
import {
  createEngineLeaseRenewIntent,
  createPrestartAbandonedRecord,
  createPrestartCancelingRecord,
  createPrestartRejectedRecord,
  createRuntimePrestartResultRecord,
  createSpawningRecord,
  mergeEngineLeaseRenewal,
  nextEngineLeaseRenewAtMs,
} from "./engine-lease-runtime-contract.mjs";
import {
  withOutboxLockOwnership,
} from "./durable-outbox.mjs";
import {
  parseSupervisorStartToken,
} from "./engine-supervisor-protocol.mjs";

const EFFECT_RETRY_MAX = 8;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5_000;
const ENGINE_NAMES = new Set(["claude_code_cli", "codex_cli"]);
const RUN_PATTERN = /^run_[0-9a-f]{32}$/u;

export class EngineAttemptRuntimeError extends Error {
  constructor(message, code = "engine_attempt_runtime_invalid", exitCode = 78) {
    super(message);
    this.name = "EngineAttemptRuntimeError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function runEngineAttemptTarget(
  input,
  dependencies,
  ownershipCapability,
) {
  const target = normalizeTarget(input);
  const deps = normalizeDependencies(dependencies);
  const port = createJournalPort(
    target.stateDir,
    ownershipCapability,
  );
  let records = await port.prepareTarget(target, deps);
  if (terminalRecords(records)) return terminal(records);

  if (!records.starting) {
    const claim = await retryEffect(
      () =>
        deps.performClaimEffect({
          controlContext: target.controlContext,
          intent: createEngineClaimIntent({
            attemptId: records.claimed.attemptId,
            engine: target.engine,
            runId: target.runId,
          }),
        }),
      target.signal,
      deps,
    );
    const finalized = await port.finalizeClaim(records, claim, deps);
    records = finalized.records;
    if (finalized.fatalAuth || terminalRecords(records)) {
      return terminal(records, finalized.fatalAuth);
    }
    if (finalized.retryable) return retryable("claim");
  }

  records = await port.current(records.claimed.attemptId, target);
  if (records.canceling) {
    records = await port.completeCancellation(records, deps);
    return terminal(records);
  }
  if (records.spawning && !records.supervisor) {
    throw new EngineAttemptRuntimeError(
      "The spawning crash window requires operator attention.",
      "engine_spawning_ambiguous",
    );
  }
  if (terminalRecords(records)) return terminal(records);

  if (records.starting.cancelRequested && !records.spawning) {
    records = await port.completeClaimCancellation(records, deps);
    return terminal(records);
  }

  const prepared =
    records.supervisor && records.started
      ? {
          lease: leaseFromStarting(records.starting),
          promptBuffer: null,
          readiness: null,
          records,
        }
      : await prepareExecution(
          target,
          deps,
          port,
          records,
        );
  records = prepared.records;
  if (prepared.terminal) {
    prepared.promptBuffer?.fill(0);
    return terminal(records, prepared.fatalAuth);
  }
  if (prepared.retryable) {
    prepared.promptBuffer?.fill(0);
    return retryable(prepared.stage);
  }

  let supervisorPromise;
  const termination = new AbortController();
  if (prepared.terminationReason) {
    termination.abort(prepared.terminationReason);
  }
  try {
    if (!records.supervisor) {
      records = await port.commitSpawning(
        records,
        prepared.lease,
        deps,
      );
      if (records.result) return terminal(records);
      supervisorPromise = deps.runSupervisedAttempt({
        appendRecord: port.append,
        attempt: records,
        binaryFingerprint: prepared.readiness.fingerprintFacts,
        cancelSignal: termination.signal,
        detachSignal: target.signal,
        executableRealPath: prepared.readiness.executableRealPath,
        input: prepared.promptBuffer,
        stateDir: target.stateDir,
      });
    } else {
      supervisorPromise = deps.resumeSupervisedAttempt({
        appendRecord: port.append,
        attempt: records,
        cancelSignal: termination.signal,
        detachSignal: target.signal,
        stateDir: target.stateDir,
        ...(prepared.readiness
          ? {
              binaryFingerprint:
                prepared.readiness.fingerprintFacts,
              executableRealPath:
                prepared.readiness.executableRealPath,
            }
          : {}),
        ...(prepared.promptBuffer
          ? { input: prepared.promptBuffer }
          : {}),
      });
    }
  } finally {
    prepared.promptBuffer?.fill(0);
  }

  const supervised = await superviseWithRenewal({
    deps,
    initialLease: prepared.lease,
    records,
    signal: target.signal,
    supervisorPromise,
    target,
    termination,
  });
  records = await port.current(records.claimed.attemptId, target);
  if (!records.result && supervised.detached) {
    return Object.freeze({
      attemptId: records.claimed.attemptId,
      fatalAuth: false,
      status: "detached",
    });
  }
  if (!records.result) {
    throw new EngineAttemptRuntimeError(
      "The supervised attempt ended without a durable result.",
    );
  }
  return terminal(records, supervised.fatalAuth);
}

async function prepareExecution(target, deps, port, initialRecords) {
  let records = initialRecords;
  const firstRenew = await renewOnce(target, deps, records);
  if (firstRenew.retryable) {
    return { records, retryable: true, stage: "renew" };
  }
  if (firstRenew.denied) {
    if (records.supervisor) {
      return {
        fatalAuth: firstRenew.outcome.class === "auth",
        lease: leaseFromStarting(records.starting),
        records,
        terminationReason: renewalTerminationReason(
          firstRenew.outcome,
        ),
      };
    }
    const finalized = await port.finalizeRenewDenial(
      records,
      firstRenew.outcome,
      deps,
    );
    return {
      fatalAuth: finalized.fatalAuth,
      records: finalized.records,
      terminal: true,
    };
  }
  let lease = firstRenew.lease;
  if (lease.cancelRequested) {
    if (records.supervisor) {
      return {
        lease,
        records,
        terminationReason: "cancel_requested",
      };
    }
    records = await port.commitRenewCancellation(
      records,
      firstRenew.outcome,
      deps,
    );
    return { records, terminal: true };
  }

  const prompt = await retryPrompt(target, deps, records);
  if (prompt.retryable) {
    return { records, retryable: true, stage: "prompt" };
  }
  if (!prompt.promptBuffer) {
    if (records.supervisor) {
      return {
        fatalAuth: prompt.outcome?.class === "auth",
        lease,
        records,
        terminationReason: promptTerminationReason(
          prompt.outcome,
        ),
      };
    }
    const finalized = await port.finalizePromptFailure(
      records,
      prompt.outcome,
      deps,
    );
    return {
      fatalAuth: finalized.fatalAuth,
      records: finalized.records,
      terminal: true,
    };
  }

  let readiness;
  try {
    readiness = await deps.resolveReadiness({
      engine: target.engine,
      expectedVersion: records.starting.engineVersion,
      stateDir: target.stateDir,
    });
  } catch {
    readiness = Object.freeze({
      kind: "not_ready",
      reason: "engine_probe_failed",
    });
  }
  if (readiness?.kind !== "ready") {
    prompt.promptBuffer.fill(0);
    if (records.supervisor) {
      return {
        lease,
        records,
        terminationReason: "engine_incompatible",
      };
    }
    records = await port.completePrestart(
      records,
      "engine_incompatible",
      deps,
    );
    return { records, terminal: true };
  }

  const finalRenew = await renewOnce(target, deps, records, lease);
  if (finalRenew.retryable) {
    prompt.promptBuffer.fill(0);
    return { records, retryable: true, stage: "renew" };
  }
  if (finalRenew.denied) {
    prompt.promptBuffer.fill(0);
    if (records.supervisor) {
      return {
        fatalAuth: finalRenew.outcome.class === "auth",
        lease,
        records,
        terminationReason: renewalTerminationReason(
          finalRenew.outcome,
        ),
      };
    }
    const finalized = await port.finalizeRenewDenial(
      records,
      finalRenew.outcome,
      deps,
    );
    return {
      fatalAuth: finalized.fatalAuth,
      records: finalized.records,
      terminal: true,
    };
  }
  lease = finalRenew.lease;
  if (lease.cancelRequested) {
    prompt.promptBuffer.fill(0);
    if (records.supervisor) {
      return {
        lease,
        records,
        terminationReason: "cancel_requested",
      };
    }
    records = await port.commitRenewCancellation(
      records,
      finalRenew.outcome,
      deps,
    );
    return { records, terminal: true };
  }
  return {
    lease,
    promptBuffer: prompt.promptBuffer,
    readiness,
    records,
  };
}

async function renewOnce(target, deps, records, currentLease) {
  const outcome = await retryEffect(
    () =>
      deps.performRenewEffect({
        controlContext: target.controlContext,
        intent: createEngineLeaseRenewIntent({
          fence: records.starting.fence,
          leaseId: records.starting.leaseId,
          runId: records.starting.runId,
        }),
      }),
    target.signal,
    deps,
  );
  if (retryableOutcome(outcome)) return { retryable: true };
  if (outcome?.kind === "denied") {
    return { denied: true, outcome };
  }
  if (outcome?.kind !== "renewal") return { retryable: true };
  const base = currentLease
    ? leaseState(currentLease)
    : leaseFromStarting(records.starting);
  return {
    lease: mergeEngineLeaseRenewal({
      current: base,
      renewal: outcome.renewal,
    }),
    outcome,
  };
}

async function retryPrompt(target, deps, records) {
  for (let attempt = 1; attempt <= EFFECT_RETRY_MAX; attempt += 1) {
    if (target.signal?.aborted) return { retryable: true };
    const pair = await deps.performPromptEffect({
      controlContext: target.controlContext,
      intent: createEnginePromptIntentFromStarting(records.starting),
    });
    if (!pair || !retryableOutcome(pair.outcome)) return pair ?? {
      outcome: undefined,
      promptBuffer: null,
    };
    pair.promptBuffer?.fill(0);
    if (attempt < EFFECT_RETRY_MAX) {
      await deps.delay(retryDelay(attempt), target.signal);
    }
  }
  return { retryable: true };
}

async function superviseWithRenewal(context) {
  let lease = context.initialLease;
  let fatalAuth = false;
  let settled = false;
  const completed = Promise.resolve(context.supervisorPromise).then(
    (value) => {
      settled = true;
      return { kind: "completed", value };
    },
    (error) => {
      settled = true;
      return { error, kind: "failed" };
    },
  );
  while (!settled) {
    const nowMs = context.deps.now();
    const waitMs = Math.max(
      0,
      nextEngineLeaseRenewAtMs({
        expiresAt: lease.expiresAt,
        nowMs,
      }) - nowMs,
    );
    const wake = await waitForRenewalWake(
      completed,
      waitMs,
      context,
    );
    if (wake.kind === "completed") break;
    if (wake.kind === "failed") {
      if (
        wake.error?.code === "supervisor_detached" &&
        context.signal?.aborted
      ) {
        return { detached: true, fatalAuth: false };
      }
      throw wake.error;
    }
    if (wake.kind === "detached") {
      const outcome = await completed;
      if (
        outcome.kind === "failed" &&
        outcome.error?.code === "supervisor_detached"
      ) {
        return { detached: true, fatalAuth: false };
      }
      if (outcome.kind === "failed") throw outcome.error;
      break;
    }
    if (context.signal?.aborted) {
      const outcome = await completed;
      if (
        outcome.kind === "failed" &&
        outcome.error?.code === "supervisor_detached"
      ) {
        return { detached: true, fatalAuth: false };
      }
      if (outcome.kind === "failed") throw outcome.error;
      break;
    }
    const renewed = await renewOnce(
      context.target,
      context.deps,
      context.records,
      lease,
    );
    if (renewed.lease) {
      lease = renewed.lease;
      if (
        lease.cancelRequested &&
        !context.termination.signal.aborted
      ) {
        context.termination.abort("cancel_requested");
      }
      continue;
    }
    if (renewed.denied) {
      fatalAuth = renewed.outcome.class === "auth";
      const reason =
        renewed.outcome.class === "exhausted"
          ? "engine_deadline_exhausted"
          : "lease_lost";
      if (!context.termination.signal.aborted) {
        context.termination.abort(reason);
      }
      continue;
    }
    if (context.deps.now() >= Date.parse(lease.expiresAt)) {
      if (!context.termination.signal.aborted) {
        context.termination.abort("lease_lost");
      }
    }
  }
  const outcome = await completed;
  if (outcome.kind === "failed") {
    if (
      outcome.error?.code === "supervisor_detached" &&
      context.signal?.aborted
    ) {
      return { detached: true, fatalAuth };
    }
    throw outcome.error;
  }
  return { detached: false, fatalAuth };
}

async function waitForRenewalWake(completed, waitMs, context) {
  const controller = new AbortController();
  const signal = context.signal
    ? AbortSignal.any([controller.signal, context.signal])
    : controller.signal;
  const delayed = Promise.resolve()
    .then(() => context.deps.delay(waitMs, signal))
    .then(
      () => (
        context.signal?.aborted
          ? { kind: "detached" }
          : { kind: "renew" }
      ),
      (error) => {
        if (context.signal?.aborted) return { kind: "detached" };
        if (controller.signal.aborted) {
          return { kind: "wait_canceled" };
        }
        return { error, kind: "failed" };
      },
    );
  try {
    return await Promise.race([completed, delayed]);
  } finally {
    controller.abort("renewal_wait_completed");
  }
}

function createJournalPort(stateDir, ownershipCapability) {
  const held = (operation) =>
    withOutboxLockOwnership(
      stateDir,
      ownershipCapability,
      operation,
    );
  const current = (attemptId, target) =>
    held(() => currentTargetRecords(stateDir, attemptId, target));
  const append = (record) =>
    held(async () => {
      const records = await currentTargetRecords(
        stateDir,
        record.attemptId,
      );
      if (terminalRecords(records)) {
        throw new EngineAttemptRuntimeError(
          "The attempt is already terminal.",
        );
      }
      return persistAttemptRecord(stateDir, record);
    });
  return Object.freeze({
    append,
    current,
    async prepareTarget(target, deps) {
      return held(async () => {
        const corrupt = [];
        const attempts = await recoverAttemptJournals(
          stateDir,
          (value) => corrupt.push(value),
        );
        if (corrupt.length > 0) {
          throw new EngineAttemptRuntimeError(
            "Attempt journal corruption requires operator attention.",
          );
        }
        const matching = attempts.filter(
          (attempt) =>
            attempt.records.claimed.runId === target.runId &&
            attempt.records.claimed.engine === target.engine,
        );
        if (matching.length > 1) {
          throw new EngineAttemptRuntimeError(
            "Multiple journals exist for the explicit target.",
          );
        }
        const foreignLive = attempts.find(
          (attempt) =>
            !matching.includes(attempt) &&
            attemptMayBeActive(attempt.records),
        );
        if (foreignLive) {
          throw new EngineAttemptRuntimeError(
            "Another explicit engine attempt is active.",
            "engine_target_busy",
            75,
          );
        }
        if (matching[0]) {
          assertSupervisorVersion(matching[0].records);
          return matching[0].records;
        }
        const claimed = createClaimedRecord({
          attemptId: deps.generateAttemptId(),
          createdAt: nowIso(deps),
          engine: target.engine,
          runId: target.runId,
        });
        return persistAttemptRecord(stateDir, claimed);
      });
    },
    async finalizeClaim(previous, outcome, deps) {
      return held(async () => {
        const records = await currentTargetRecords(
          stateDir,
          previous.claimed.attemptId,
        );
        if (records.starting || terminalRecords(records)) {
          return { fatalAuth: false, records };
        }
        if (outcome?.kind === "descriptor") {
          const createdAt = nowIso(deps, records.claimed.createdAt);
          const budget = evaluateDescriptorBudget({
            descriptor: outcome.descriptor,
            nowMs: Date.parse(createdAt),
          });
          if (!budget.accepted) {
            const settled = createPrestartRejectedRecord({
              claimed: records.claimed,
              createdAt,
              descriptor: outcome.descriptor,
              observedAt: createdAt,
              reason: budget.reason,
            });
            return {
              fatalAuth: false,
              records: await persistAttemptRecord(stateDir, settled),
            };
          }
          const starting = createStartingRecord({
            claimed: records.claimed,
            createdAt,
            descriptor: outcome.descriptor,
            effectiveTimeoutMs: budget.effectiveTimeoutMs,
          });
          return {
            fatalAuth: false,
            records: await persistAttemptRecord(stateDir, starting),
          };
        }
        if (outcome?.kind === "descriptor_rejected") {
          const settled = createPrestartRejectedRecord({
            claimed: records.claimed,
            createdAt: nowIso(
              deps,
              records.claimed.createdAt,
              outcome.observedAt,
            ),
            descriptor: outcome.descriptor,
            observedAt: outcome.observedAt,
            reason: outcome.reason,
          });
          return {
            fatalAuth: false,
            records: await persistAttemptRecord(stateDir, settled),
          };
        }
        if (
          outcome?.kind === "denied" &&
          !["retryable"].includes(outcome.class)
        ) {
          const now = nowIso(deps, records.claimed.createdAt);
          const settled = createPrestartAbandonedRecord({
            claimed: records.claimed,
            createdAt: now,
            denial: denial(outcome, "claim", now),
          });
          return {
            fatalAuth: outcome.class === "auth",
            records: await persistAttemptRecord(stateDir, settled),
          };
        }
        return {
          fatalAuth: false,
          records,
          retryable: true,
        };
      });
    },
    async completeCancellation(previous, deps) {
      return held(async () => {
        const records = await currentTargetRecords(
          stateDir,
          previous.claimed.attemptId,
        );
        if (records.result) return records;
        const result = createRuntimePrestartResultRecord({
          canceling: records.canceling,
          claimed: records.claimed,
          createdAt: nowIso(
            deps,
            records.canceling.createdAt,
          ),
          reason: "cancel_requested",
          starting: records.starting,
        });
        return persistAttemptRecord(stateDir, result);
      });
    },
    async completeClaimCancellation(previous, deps) {
      return held(async () => {
        const records = await currentTargetRecords(
          stateDir,
          previous.claimed.attemptId,
        );
        const result = createRuntimePrestartResultRecord({
          claimed: records.claimed,
          createdAt: nowIso(deps, records.starting.createdAt),
          reason: "cancel_requested",
          starting: records.starting,
        });
        return persistAttemptRecord(stateDir, result);
      });
    },
    async commitRenewCancellation(previous, outcome, deps) {
      return held(async () => {
        let records = await currentTargetRecords(
          stateDir,
          previous.claimed.attemptId,
        );
        if (records.spawning || records.supervisor) return records;
        if (!records.canceling) {
          const canceling = createPrestartCancelingRecord({
            claimed: records.claimed,
            createdAt: nowIso(
              deps,
              records.starting.createdAt,
              outcome.observedAt,
            ),
            observedAt: outcome.observedAt,
            renewal: outcome.renewal,
            starting: records.starting,
          });
          records = await persistAttemptRecord(stateDir, canceling);
        }
        const result = createRuntimePrestartResultRecord({
          canceling: records.canceling,
          claimed: records.claimed,
          createdAt: nowIso(deps, records.canceling.createdAt),
          reason: "cancel_requested",
          starting: records.starting,
        });
        return persistAttemptRecord(stateDir, result);
      });
    },
    async finalizeRenewDenial(previous, outcome, deps) {
      return held(async () => {
        const records = await currentTargetRecords(
          stateDir,
          previous.claimed.attemptId,
        );
        if (records.spawning || records.supervisor) {
          return {
            fatalAuth: outcome.class === "auth",
            records,
          };
        }
        const now = nowIso(deps, records.starting.createdAt);
        if (outcome.class === "exhausted") {
          const result = createRuntimePrestartResultRecord({
            claimed: records.claimed,
            createdAt: now,
            reason: "engine_deadline_exhausted",
            starting: records.starting,
          });
          return {
            fatalAuth: false,
            records: await persistAttemptRecord(stateDir, result),
          };
        }
        const settled = createPrestartAbandonedRecord({
          claimed: records.claimed,
          createdAt: now,
          denial: denial(outcome, "renew", now),
          starting: records.starting,
        });
        return {
          fatalAuth: outcome.class === "auth",
          records: await persistAttemptRecord(stateDir, settled),
        };
      });
    },
    async finalizePromptFailure(previous, outcome, deps) {
      return held(async () => {
        const records = await currentTargetRecords(
          stateDir,
          previous.claimed.attemptId,
        );
        const now = nowIso(deps, records.starting.createdAt);
        if (outcome?.kind === "prompt_rejected") {
          const result = createRuntimePrestartResultRecord({
            claimed: records.claimed,
            createdAt: now,
            reason: "prompt_integrity_mismatch",
            starting: records.starting,
          });
          return {
            fatalAuth: false,
            records: await persistAttemptRecord(stateDir, result),
          };
        }
        if (
          outcome?.kind === "denied" &&
          ["prompt_unavailable", "prompt_erased"].includes(
            outcome.serverError,
          )
        ) {
          const result = createRuntimePrestartResultRecord({
            claimed: records.claimed,
            createdAt: now,
            reason: outcome.serverError,
            starting: records.starting,
          });
          return {
            fatalAuth: false,
            records: await persistAttemptRecord(stateDir, result),
          };
        }
        if (
          outcome?.kind === "denied" &&
          ["auth", "rejected", "superseded"].includes(outcome.class)
        ) {
          const settled = createPrestartAbandonedRecord({
            claimed: records.claimed,
            createdAt: now,
            denial: denial(outcome, "prompt", now),
            starting: records.starting,
          });
          return {
            fatalAuth: outcome.class === "auth",
            records: await persistAttemptRecord(stateDir, settled),
          };
        }
        throw new EngineAttemptRuntimeError(
          "Prompt failure classification is invalid.",
          "engine_attempt_protocol_invalid",
          76,
        );
      });
    },
    async completePrestart(previous, reason, deps) {
      return held(async () => {
        const records = await currentTargetRecords(
          stateDir,
          previous.claimed.attemptId,
        );
        const result = createRuntimePrestartResultRecord({
          claimed: records.claimed,
          createdAt: nowIso(deps, records.starting.createdAt),
          reason,
          starting: records.starting,
        });
        return persistAttemptRecord(stateDir, result);
      });
    },
    async commitSpawning(previous, lease, deps) {
      return held(async () => {
        const records = await currentTargetRecords(
          stateDir,
          previous.claimed.attemptId,
        );
        if (records.canceling || records.result || records.settled) {
          return records;
        }
        if (records.spawning) return records;
        const now = deps.now();
        if (now >= Date.parse(lease.expiresAt)) {
          const result = createRuntimePrestartResultRecord({
            claimed: records.claimed,
            createdAt: nowIso(deps, records.starting.createdAt),
            reason: "lease_lost",
            starting: records.starting,
          });
          return persistAttemptRecord(stateDir, result);
        }
        if (now >= Date.parse(records.starting.deadlineAt)) {
          const result = createRuntimePrestartResultRecord({
            claimed: records.claimed,
            createdAt: nowIso(deps, records.starting.createdAt),
            reason: "engine_deadline_exhausted",
            starting: records.starting,
          });
          return persistAttemptRecord(stateDir, result);
        }
        const spawning = createSpawningRecord({
          claimed: records.claimed,
          createdAt: nowIso(deps, records.starting.createdAt),
          starting: records.starting,
        });
        return persistAttemptRecord(stateDir, spawning);
      });
    },
  });
}

async function currentTargetRecords(
  stateDir,
  attemptId,
  target,
) {
  const corrupt = [];
  const attempts = await recoverAttemptJournals(
    stateDir,
    (value) => corrupt.push(value),
  );
  if (corrupt.length > 0) {
    throw new EngineAttemptRuntimeError(
      "Attempt journal corruption requires operator attention.",
    );
  }
  const attempt = attempts.find(
    (candidate) => candidate.attemptId === attemptId,
  );
  if (
    !attempt ||
    (
      target &&
      (
        attempt.records.claimed.runId !== target.runId ||
        attempt.records.claimed.engine !== target.engine
      )
    )
  ) {
    throw new EngineAttemptRuntimeError(
      "The explicit attempt identity changed.",
    );
  }
  assertSupervisorVersion(attempt.records);
  return attempt.records;
}

function assertSupervisorVersion(records) {
  if (
    records.supervisor &&
    !parseSupervisorStartToken(
      records.supervisor.supervisorStartToken,
    )
  ) {
    throw new EngineAttemptRuntimeError(
      "A legacy or ambiguous supervisor requires operator attention.",
      "engine_supervisor_legacy_ambiguous",
    );
  }
}

function attemptMayBeActive(records) {
  return Boolean(
    !records.result &&
    !records.outboxed &&
    !records.settled &&
    (
      records.claimed ||
      records.starting ||
      records.canceling ||
      records.spawning ||
      records.supervisor ||
      records.started
    ),
  );
}

function terminalRecords(records) {
  return Boolean(
    records.result ||
    records.outboxed ||
    records.settled
  );
}

function terminal(records, fatalAuth = false) {
  return Object.freeze({
    attemptId: records.claimed.attemptId,
    fatalAuth,
    status: "terminal",
  });
}

function retryable(stage) {
  return Object.freeze({
    fatalAuth: false,
    stage,
    status: "retryable",
  });
}

async function retryEffect(effect, signal, deps) {
  let outcome;
  for (let attempt = 1; attempt <= EFFECT_RETRY_MAX; attempt += 1) {
    if (signal?.aborted) return outcome;
    try {
      outcome = await effect();
    } catch {
      outcome = Object.freeze({ kind: "transport_error" });
    }
    if (!retryableOutcome(outcome)) return outcome;
    if (attempt < EFFECT_RETRY_MAX) {
      await deps.delay(retryDelay(attempt), signal);
    }
  }
  return outcome;
}

function retryableOutcome(outcome) {
  return Boolean(
    !outcome ||
    outcome.kind === "transport_error" ||
    outcome.kind === "response_error" ||
    (outcome.kind === "denied" && outcome.class === "retryable")
  );
}

function leaseFromStarting(starting) {
  return Object.freeze({
    cancelRequested: starting.cancelRequested,
    deadlineAt: starting.deadlineAt,
    expiresAt: starting.expiresAt,
    fence: starting.fence,
    leaseId: starting.leaseId,
    runId: starting.runId,
  });
}

function leaseState(value) {
  return Object.freeze({
    cancelRequested: value.cancelRequested,
    deadlineAt: value.deadlineAt,
    expiresAt: value.expiresAt,
    fence: value.fence,
    leaseId: value.leaseId,
    runId: value.runId,
  });
}

function denial(outcome, source, observedAt) {
  return {
    httpStatus: outcome.httpStatus,
    observedAt,
    serverError: outcome.serverError,
    source,
  };
}

function renewalTerminationReason(outcome) {
  return outcome?.class === "exhausted"
    ? "engine_deadline_exhausted"
    : "lease_lost";
}

function promptTerminationReason(outcome) {
  if (outcome?.kind === "prompt_rejected") {
    return "prompt_integrity_mismatch";
  }
  if (
    ["prompt_erased", "prompt_unavailable"].includes(
      outcome?.serverError,
    )
  ) {
    return outcome.serverError;
  }
  return "lease_lost";
}

function normalizeTarget(input) {
  if (
    !input ||
    typeof input !== "object" ||
    !RUN_PATTERN.test(input.runId ?? "") ||
    !ENGINE_NAMES.has(input.engine) ||
    typeof input.stateDir !== "string" ||
    !input.controlContext ||
    (
      input.signal !== undefined &&
      (
        typeof input.signal?.aborted !== "boolean" ||
        typeof input.signal?.addEventListener !== "function"
      )
    )
  ) {
    throw new EngineAttemptRuntimeError(
      "Explicit engine target is invalid.",
    );
  }
  return {
    controlContext: input.controlContext,
    engine: input.engine,
    runId: input.runId,
    signal: input.signal,
    stateDir: input.stateDir,
  };
}

function normalizeDependencies(input) {
  const dependencies = {
    delay: input?.delay,
    generateAttemptId:
      input?.generateAttemptId ??
      (() => `att_${randomBytes(16).toString("hex")}`),
    now: input?.now ?? Date.now,
    performClaimEffect: input?.performClaimEffect,
    performPromptEffect: input?.performPromptEffect,
    performRenewEffect: input?.performRenewEffect,
    resolveReadiness: input?.resolveReadiness,
    resumeSupervisedAttempt: input?.resumeSupervisedAttempt,
    runSupervisedAttempt: input?.runSupervisedAttempt,
  };
  if (
    !Object.values(dependencies).every(
      (value) => typeof value === "function",
    )
  ) {
    throw new EngineAttemptRuntimeError(
      "Engine attempt runtime dependencies are invalid.",
    );
  }
  return dependencies;
}

function nowIso(deps, ...minimums) {
  const nowMs = deps.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new EngineAttemptRuntimeError(
      "Engine runtime clock is invalid.",
    );
  }
  return [new Date(nowMs).toISOString(), ...minimums]
    .sort()
    .at(-1);
}

function retryDelay(attempt) {
  return Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * (2 ** Math.min(attempt - 1, 5)),
  );
}
