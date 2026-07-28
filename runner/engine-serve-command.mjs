const FAILURE_BUDGET = 8;
const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;
const INVALID_LOCAL_CODES = new Set([
  "attempt_journal_invalid",
  "engine_attempt_coordinator_invalid",
  "engine_complete_http_effect_invalid",
  "engine_serve_command_invalid",
  "engine_serve_cycle_invalid",
  "outbox_invalid",
  "runner_lock_operation_invalid",
  "runner_lock_ownership_in_use",
  "runner_lock_ownership_invalid",
]);

export class EngineServeCommandError extends Error {
  constructor(message, exitCode = 78) {
    super(message);
    this.name = "EngineServeCommandError";
    this.code = "engine_serve_command_invalid";
    this.exitCode = exitCode;
  }
}

export async function runEngineServeCommand(input, dependencies) {
  const options = normalizeInput(input);
  const deps = normalizeDependencies(dependencies);
  const ownershipCapability = await deps.acquireStateLock(
    options.stateDir,
  );
  if (typeof ownershipCapability !== "function") {
    throw new EngineServeCommandError(
      "Runner state lock ownership is invalid.",
    );
  }

  const controller = new AbortController();
  let cleanupSignals = () => undefined;
  let exitCode = 0;
  let heartbeatFailures = 0;
  let reason = "stop_requested";
  let recoveryFailures = 0;
  let stopping = false;
  let releaseDisposition = "released";

  const requestStop = (nextReason, nextExitCode = 0) => {
    if (!stopping) {
      stopping = true;
      reason = nextReason;
      exitCode = nextExitCode;
      controller.abort();
      return;
    }
    if (
      shouldReplaceStop(
        nextExitCode,
        nextReason,
        exitCode,
        reason,
      )
    ) {
      reason = nextReason;
      exitCode = nextExitCode;
    }
  };

  try {
    cleanupSignals = deps.subscribeSignals(() =>
      requestStop("stop_requested", 0)
    );
    if (typeof cleanupSignals !== "function") {
      throw new EngineServeCommandError(
        "Runner signal subscription is invalid.",
      );
    }
    const completionContext = await deps.loadCompletionContext({
      serverOverride: options.serverOverride,
      stateDir: options.stateDir,
    });
    safeEmit(deps.emit, Object.freeze({
      intervalSeconds: options.intervalSeconds,
      loops: Object.freeze(["heartbeat", "recovery"]),
      status: "started",
    }));

    await Promise.all([
      heartbeatLoop({
        deps,
        onFailures(value) {
          heartbeatFailures = value;
        },
        options,
        requestStop,
        signal: controller.signal,
        shouldStop: () => stopping,
      }),
      recoveryLoop({
        completionContext,
        deps,
        onFailures(value) {
          recoveryFailures = value;
        },
        options,
        ownershipCapability,
        requestStop,
        signal: controller.signal,
        shouldStop: () => stopping,
      }),
    ]);
  } catch (error) {
    requestStop(
      fatalReason(error, "serve"),
      exitCodeOf(error, 1),
    );
  } finally {
    try {
      cleanupSignals();
    } catch {
      // Signal cleanup cannot trigger a second release attempt.
    }
    if (reason === "durable_auth_rejected" && exitCode === 77) {
      releaseDisposition = "retained";
    } else {
      try {
        await ownershipCapability();
      } catch {
        releaseDisposition = "stale_possible";
        requestStop("lock_release_failed", 74);
      }
    }
  }

  const summary = Object.freeze({
    exitCode,
    heartbeatFailures,
    reason,
    recoveryFailures,
    releaseDisposition,
    status: "stopped",
  });
  safeEmit(deps.emit, summary);
  return summary;
}

async function heartbeatLoop(context) {
  while (!context.shouldStop()) {
    try {
      const result = await context.deps.sendHeartbeat({
        serverOverride: context.options.serverOverride,
        stateDir: context.options.stateDir,
      });
      context.heartbeatFailures = 0;
      context.onFailures(0);
      safeEmit(context.deps.emit, result);
      if (!context.shouldStop()) {
        const continued = await waitForNext(
          context,
          context.options.intervalSeconds * 1_000,
          "heartbeat_delay_failed",
        );
        if (!continued) return;
      }
    } catch (error) {
      const fatalCode = fatalExitCode(error);
      if (fatalCode !== null) {
        context.requestStop(
          fatalReason(error, "heartbeat"),
          fatalCode,
        );
        return;
      }
      if (context.shouldStop()) return;
      const failures = incrementFailures(context, "heartbeat");
      safeEmitError(
        context.deps.emitError,
        `nexus-runner: heartbeat unavailable; failure ${failures}/${FAILURE_BUDGET}.\n`,
      );
      if (failures >= FAILURE_BUDGET) {
        context.requestStop("heartbeat_failure_budget", 75);
        return;
      }
      const continued = await waitForNext(
        context,
        retryDelay(failures, context.deps.random),
        "heartbeat_delay_failed",
      );
      if (!continued) return;
    }
  }
}

async function recoveryLoop(context) {
  while (!context.shouldStop()) {
    try {
      const result = await context.deps.runRecoveryCycle(
        {
          completionContext: context.completionContext,
          async performCompletionEffect(envelope) {
            if (context.shouldStop()) throw new StopRequestedError();
            return context.deps.performCompletionEffect(envelope);
          },
          stateDir: context.options.stateDir,
          async yieldControl() {
            if (context.shouldStop()) throw new StopRequestedError();
            await context.deps.yieldControl();
            if (context.shouldStop()) throw new StopRequestedError();
          },
        },
        context.ownershipCapability,
      );
      if (result?.report?.permanentStop === true) {
        context.requestStop("durable_auth_rejected", 77);
      }
      if (context.shouldStop()) return;
      const halt = result?.report?.drain?.halt ?? null;
      const failures = halt
        ? incrementFailures(context, "recovery")
        : resetFailures(context);
      safeEmit(
        context.deps.emit,
        recoveryEvent(result, failures),
      );
      if (failures >= FAILURE_BUDGET) {
        context.requestStop("recovery_failure_budget", 75);
        return;
      }
      const delayMs = halt
        ? retryDelay(failures, context.deps.random)
        : context.options.intervalSeconds * 1_000;
      const continued = await waitForNext(
        context,
        delayMs,
        "recovery_delay_failed",
      );
      if (!continued) return;
    } catch (error) {
      if (context.shouldStop() && error instanceof StopRequestedError) return;
      const fatalCode = fatalExitCode(error);
      if (fatalCode !== null) {
        context.requestStop(
          fatalReason(error, "recovery"),
          fatalCode,
        );
        return;
      }
      if (context.shouldStop()) return;
      const failures = incrementFailures(context, "recovery");
      safeEmitError(
        context.deps.emitError,
        `nexus-runner: recovery unavailable; failure ${failures}/${FAILURE_BUDGET}.\n`,
      );
      if (failures >= FAILURE_BUDGET) {
        context.requestStop("recovery_failure_budget", 75);
        return;
      }
      const continued = await waitForNext(
        context,
        retryDelay(failures, context.deps.random),
        "recovery_delay_failed",
      );
      if (!continued) return;
    }
  }
}

async function waitForNext(context, milliseconds, failureReason) {
  try {
    await context.deps.delay(milliseconds, context.signal);
  } catch {
    context.requestStop(failureReason, 1);
    return false;
  }
  return !context.shouldStop();
}

function recoveryEvent(result, failureStreak) {
  const drain = result?.report?.drain;
  const halt = drain?.halt;
  return Object.freeze({
    attempted: integerOrZero(drain?.attempted),
    delivered: Array.isArray(drain?.delivered)
      ? drain.delivered.length
      : 0,
    failed: Array.isArray(drain?.failed) ? drain.failed.length : 0,
    failureStreak,
    halt: halt
      ? Object.freeze({
          code: stringOrNull(halt.code),
          httpStatus: integerOrNull(halt.httpStatus),
          operationId: stringOrNull(halt.operationId),
          runId: stringOrNull(halt.runId),
          serverError: stringOrNull(halt.serverError),
        })
      : null,
    permanentStop: result?.report?.permanentStop === true,
    remainingPending: integerOrZero(drain?.remainingPending),
    status: "recovery",
  });
}

export function retryDelay(failureStreak, random = Math.random) {
  if (
    !Number.isInteger(failureStreak) ||
    failureStreak < 1 ||
    typeof random !== "function"
  ) {
    throw new EngineServeCommandError(
      "Runner retry state is invalid.",
    );
  }
  const cap = Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * (2 ** Math.min(failureStreak - 1, 6)),
  );
  let sample;
  try {
    sample = random();
  } catch {
    sample = 0;
  }
  if (typeof sample !== "number" || !Number.isFinite(sample)) sample = 0;
  const bounded = Math.min(Math.max(sample, 0), 0.999999999999);
  return Math.max(100, Math.floor(bounded * cap));
}

function incrementFailures(context, loop) {
  const current = loop === "heartbeat"
    ? context.heartbeatFailures ?? 0
    : context.recoveryFailures ?? 0;
  const next = current + 1;
  if (loop === "heartbeat") {
    context.heartbeatFailures = next;
  } else {
    context.recoveryFailures = next;
  }
  context.onFailures(next);
  return next;
}

function resetFailures(context) {
  context.recoveryFailures = 0;
  context.onFailures(0);
  return 0;
}

function fatalExitCode(error) {
  const exitCode = exitCodeOf(error, null);
  if ([64, 66, 77, 78].includes(exitCode)) return exitCode;
  try {
    return INVALID_LOCAL_CODES.has(error?.code) ? 78 : null;
  } catch {
    return null;
  }
}

function stopPriority(exitCode, reason) {
  if (exitCode === 77 && reason === "durable_auth_rejected") return 120;
  if (exitCode === 77) return 110;
  if (exitCode === 78) return 103;
  if (exitCode === 66) return 102;
  if (exitCode === 64) return 101;
  if (exitCode === 1) return 90;
  if (exitCode === 75) return 81;
  if (exitCode === 74) return 80;
  return 0;
}

function shouldReplaceStop(
  nextExitCode,
  nextReason,
  currentExitCode,
  currentReason,
) {
  const nextPriority = stopPriority(nextExitCode, nextReason);
  const currentPriority = stopPriority(currentExitCode, currentReason);
  if (nextPriority !== currentPriority) {
    return nextPriority > currentPriority;
  }
  return nextReason < currentReason;
}

function exitCodeOf(error, fallback) {
  try {
    return Number.isInteger(error?.exitCode) ? error.exitCode : fallback;
  } catch {
    return fallback;
  }
}

function exitReason(error, fallback) {
  try {
    return typeof error?.code === "string" ? error.code : fallback;
  } catch {
    return fallback;
  }
}

function fatalReason(error, surface) {
  const exitCode = exitCodeOf(error, 1);
  const code = exitReason(error, null);
  if (code !== null && INVALID_LOCAL_CODES.has(code)) return code;
  if (exitCode === 77) return `${surface}_auth_rejected`;
  if (exitCode === 78) return `${surface}_state_invalid`;
  if (exitCode === 66) return `${surface}_state_missing`;
  if (exitCode === 64) return `${surface}_configuration_invalid`;
  return `${surface}_failed`;
}

function normalizeInput(value) {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "intervalSeconds",
      "serverOverride",
      "stateDir",
    ]) ||
    typeof value.stateDir !== "string" ||
    value.stateDir.length < 1 ||
    !Number.isInteger(value.intervalSeconds) ||
    value.intervalSeconds < 10 ||
    value.intervalSeconds > 300 ||
    !(
      value.serverOverride === undefined ||
      typeof value.serverOverride === "string"
    )
  ) {
    throw new EngineServeCommandError(
      "Runner serve options are invalid.",
      64,
    );
  }
  return value;
}

function normalizeDependencies(value) {
  const keys = [
    "acquireStateLock",
    "delay",
    "emit",
    "emitError",
    "loadCompletionContext",
    "performCompletionEffect",
    "random",
    "runRecoveryCycle",
    "sendHeartbeat",
    "subscribeSignals",
    "yieldControl",
  ];
  if (
    !plainRecord(value) ||
    !exactKeys(value, keys) ||
    keys.some((key) => typeof value[key] !== "function")
  ) {
    throw new EngineServeCommandError(
      "Runner serve dependencies are invalid.",
    );
  }
  return value;
}

function exactKeys(value, keys) {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        ownKeys.includes(key) &&
        descriptor?.enumerable === true &&
        Object.hasOwn(descriptor, "value")
      );
    })
  );
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function integerOrZero(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function safeEmit(emit, value) {
  try {
    emit(value);
  } catch {
    // Observability cannot widen runner authority or skip lock release.
  }
}

function safeEmitError(emitError, value) {
  try {
    emitError(value);
  } catch {
    // Observability cannot widen runner authority or skip lock release.
  }
}

function plainRecord(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

class StopRequestedError extends Error {}
