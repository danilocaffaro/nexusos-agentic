import {
  abortEngineAttemptRecoveryHeld,
  completeEngineAttemptRecoveryHeld,
  finalizeEngineCompletionEffectHeld,
  prepareEngineAttemptRecoveryHeld,
} from "./engine-attempt-coordinator.mjs";

const PHASES = new Set([
  "BOOT",
  "RECOVER",
  "STEADY",
  "DRAINING",
  "STOPPED",
  "PERMANENT_STOP",
]);

export class EngineServeCycleError extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineServeCycleError";
    this.code = "engine_serve_cycle_invalid";
  }
}

export function createEngineServeCycleState() {
  return Object.freeze({
    phase: "BOOT",
    releaseDisposition: null,
    retryRelease: false,
    stopReason: null,
  });
}

export function reduceEngineServeCycle(state, event) {
  assertCycleState(state);
  if (
    !plainRecord(event) ||
    Object.keys(event).length !== 1 ||
    typeof event.type !== "string"
  ) {
    throw new EngineServeCycleError("Serve cycle event is invalid.");
  }
  if (
    event.type === "stop_requested" &&
    !["STOPPED", "PERMANENT_STOP", "DRAINING"].includes(state.phase)
  ) {
    return cycleState("DRAINING", "stop_requested", null);
  }
  if (
    state.phase === "DRAINING" &&
    event.type === "stop_requested"
  ) {
    return state;
  }
  if (state.phase === "BOOT" && event.type === "start") {
    return cycleState("RECOVER", null, null);
  }
  if (state.phase === "RECOVER" && event.type === "recovered") {
    return cycleState("STEADY", null, null);
  }
  if (
    state.phase === "RECOVER" &&
    event.type === "durable_auth_rejected"
  ) {
    return cycleState(
      "PERMANENT_STOP",
      "durable_auth_rejected",
      "retained",
    );
  }
  if (state.phase === "STEADY" && event.type === "cycle_due") {
    return cycleState("RECOVER", null, null);
  }
  if (
    state.phase === "DRAINING" &&
    event.type === "release_succeeded"
  ) {
    return cycleState("STOPPED", "stop_requested", "released");
  }
  if (
    state.phase === "DRAINING" &&
    event.type === "release_failed"
  ) {
    return cycleState(
      "STOPPED",
      "lock_release_failed",
      "stale_possible",
    );
  }
  throw new EngineServeCycleError("Serve cycle transition is invalid.");
}

export async function runEngineRecoveryCycle(
  input,
  ownershipCapability,
) {
  const {
    completionContext,
    performCompletionEffect,
    pruneNowMs,
    stateDir,
    yieldControl = defaultYieldControl,
  } = input ?? {};
  if (
    typeof performCompletionEffect !== "function" ||
    typeof yieldControl !== "function"
  ) {
    throw new EngineServeCycleError(
      "Serve cycle dependencies are invalid.",
    );
  }
  let state = reduceEngineServeCycle(
    createEngineServeCycleState(),
    { type: "start" },
  );
  const plan = await prepareEngineAttemptRecoveryHeld(
    { stateDir },
    ownershipCapability,
  );
  const outcomes = [];
  try {
    for (const intent of plan.intents) {
      let effect;
      try {
        effect = await performCompletionEffect(
          Object.freeze({ completionContext, intent }),
        );
      } catch {
        effect = Object.freeze({
          kind: "transport_error",
          operationId: intent.operationId,
          runId: intent.runId,
        });
      }
      let outcome;
      try {
        outcome = await finalizeEngineCompletionEffectHeld(
          {
            effect,
            intent,
            plan,
            stateDir,
          },
          ownershipCapability,
        );
      } catch (error) {
        if (
          error?.code !== "engine_attempt_coordinator_invalid" ||
          error?.message !== "Completion effect is invalid."
        ) {
          throw error;
        }
        outcome = await finalizeEngineCompletionEffectHeld(
          {
            effect: {
              code: "protocol",
              httpStatus: null,
              kind: "response_error",
              operationId: intent.operationId,
              runId: intent.runId,
            },
            intent,
            plan,
            stateDir,
          },
          ownershipCapability,
        );
      }
      outcomes.push(outcome);
      if (outcome.kind === "halt") break;
      await yieldControl();
    }
    const report = await completeEngineAttemptRecoveryHeld(
      { plan, pruneNowMs, stateDir },
      ownershipCapability,
    );
    state = reduceEngineServeCycle(
      state,
      {
        type: report.permanentStop
          ? "durable_auth_rejected"
          : "recovered",
      },
    );
    return Object.freeze({
      outcomes: Object.freeze(outcomes),
      report,
      state,
    });
  } catch (error) {
    try {
      await abortEngineAttemptRecoveryHeld(
        { plan, stateDir },
        ownershipCapability,
      );
    } catch {
      // The original failure remains authoritative. A later cycle will
      // recover from durable journal and outbox state.
    }
    throw error;
  }
}

function cycleState(phase, stopReason, releaseDisposition) {
  return Object.freeze({
    phase,
    releaseDisposition,
    retryRelease: false,
    stopReason,
  });
}

function assertCycleState(value) {
  const stateKeys = [
    "phase",
    "releaseDisposition",
    "retryRelease",
    "stopReason",
  ];
  const ownKeys = plainRecord(value) ? Reflect.ownKeys(value) : [];
  const exactDataShape =
    ownKeys.length === stateKeys.length &&
    stateKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        ownKeys.includes(key) &&
        descriptor?.enumerable &&
        Object.hasOwn(descriptor, "value")
      );
    });
  if (!plainRecord(value) || !exactDataShape) {
    throw new EngineServeCycleError("Serve cycle state is invalid.");
  }
  const phase = Object.getOwnPropertyDescriptor(
    value,
    "phase",
  ).value;
  const releaseDisposition = Object.getOwnPropertyDescriptor(
    value,
    "releaseDisposition",
  ).value;
  const retryRelease = Object.getOwnPropertyDescriptor(
    value,
    "retryRelease",
  ).value;
  const stopReason = Object.getOwnPropertyDescriptor(
    value,
    "stopReason",
  ).value;
  const expected = {
    BOOT: [null, null],
    DRAINING: ["stop_requested", null],
    PERMANENT_STOP: [
      "durable_auth_rejected",
      "retained",
    ],
    RECOVER: [null, null],
    STEADY: [null, null],
    STOPPED:
      releaseDisposition === "released"
        ? ["stop_requested", "released"]
        : ["lock_release_failed", "stale_possible"],
  };
  if (
    !PHASES.has(phase) ||
    retryRelease !== false ||
    stopReason !== expected[phase][0] ||
    releaseDisposition !== expected[phase][1]
  ) {
    throw new EngineServeCycleError("Serve cycle state is invalid.");
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

async function defaultYieldControl() {
  await new Promise((resolve) => setImmediate(resolve));
}
