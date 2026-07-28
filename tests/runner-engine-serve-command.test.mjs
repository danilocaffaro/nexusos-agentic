import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  retryDelay,
  runEngineServeCommand,
} from "../runner/engine-serve-command.mjs";
import {
  serveFailureMessage,
} from "../runner/nexus-runner.mjs";

test("serve owns one lock while heartbeat and recovery run concurrently", async () => {
  let heartbeatStarted = false;
  let recoveryStarted = false;
  let releaseCalls = 0;
  let resolveRecovery;
  let stop;
  const events = [];
  const recoveryGate = new Promise((resolve) => {
    resolveRecovery = resolve;
  });
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releaseCalls += 1;
      };
    },
    emit(value) {
      events.push(value);
    },
    async runRecoveryCycle() {
      recoveryStarted = true;
      await recoveryGate;
      return cycleResult();
    },
    async sendHeartbeat() {
      heartbeatStarted = true;
      return { status: "heartbeat" };
    },
    subscribeSignals(value) {
      stop = value;
      return () => undefined;
    },
  });
  const pending = runEngineServeCommand(options(), deps);
  await until(() => heartbeatStarted && recoveryStarted);
  assert.equal(releaseCalls, 0);
  stop();
  resolveRecovery();
  const result = await pending;
  assert.deepEqual(result, {
    exitCode: 0,
    heartbeatFailures: 0,
    reason: "stop_requested",
    recoveryFailures: 0,
    releaseDisposition: "released",
    status: "stopped",
  });
  assert.equal(releaseCalls, 1);
  assert.equal(events[0].status, "started");
  assert.deepEqual(events[0].loops, ["heartbeat", "recovery"]);
  assert.equal(events.some((event) => event.status === "heartbeat"), true);
  assert.deepEqual(events.at(-1), result);
});

test("heartbeat continues while a recovery cycle serves sixteen slow effects", async () => {
  let heartbeatCalls = 0;
  let stop;
  const effectWaiters = [];
  const deps = dependencies({
    async delay(milliseconds, signal) {
      if (signal.aborted) return;
      if (milliseconds === 10_000) {
        await new Promise((resolve) => setImmediate(resolve));
        return;
      }
      await abortOnly(signal);
    },
    async performCompletionEffect() {
      await new Promise((resolve) => effectWaiters.push(resolve));
      return Object.freeze({ kind: "transport_error" });
    },
    async runRecoveryCycle(input) {
      for (let index = 0; index < 16; index += 1) {
        await input.performCompletionEffect();
        await input.yieldControl();
      }
      stop();
      return cycleResult();
    },
    async sendHeartbeat() {
      heartbeatCalls += 1;
      effectWaiters.shift()?.();
      return { status: "heartbeat" };
    },
    subscribeSignals(value) {
      stop = value;
      return () => undefined;
    },
  });
  const result = await runEngineServeCommand(options(), deps);
  assert.equal(result.exitCode, 0);
  assert.ok(heartbeatCalls >= 16);
});

test("recovery halt uses bounded jitter and stops after eight consecutive failures", async () => {
  let recoveryCalls = 0;
  let releaseCalls = 0;
  const delays = [];
  const events = [];
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releaseCalls += 1;
      };
    },
    async delay(milliseconds, signal) {
      delays.push(milliseconds);
      if (milliseconds === 10_000) await abortOnly(signal);
    },
    emit(value) {
      events.push(value);
    },
    random() {
      return 0;
    },
    async runRecoveryCycle() {
      recoveryCalls += 1;
      return cycleResult({
        halt: {
          code: "retryable",
          exitCodeHint: 75,
          httpStatus: 503,
          operationId: `op_${"a".repeat(32)}`,
          runId: `run_${"b".repeat(32)}`,
          serverError: "run_operation_failed",
        },
      });
    },
  });
  const result = await runEngineServeCommand(options(), deps);
  assert.equal(result.exitCode, 75);
  assert.equal(result.reason, "recovery_failure_budget");
  assert.equal(result.recoveryFailures, 8);
  assert.equal(recoveryCalls, 8);
  assert.equal(releaseCalls, 1);
  assert.deepEqual(
    delays.filter((value) => value !== 10_000),
    Array(7).fill(100),
  );
  const recoveries = events.filter(
    (event) => event.status === "recovery",
  );
  assert.equal(recoveries.length, 8);
  assert.equal(recoveries.at(-1).failureStreak, 8);
  assert.equal(
    JSON.stringify(events).includes("private"),
    false,
  );
});

test("recovery protocol halt exits 76 immediately without retry", async () => {
  let recoveryCalls = 0;
  let releaseCalls = 0;
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releaseCalls += 1;
      };
    },
    async delay(_milliseconds, signal) {
      await abortOnly(signal);
    },
    async runRecoveryCycle() {
      recoveryCalls += 1;
      return cycleResult({
        halt: {
          code: "protocol",
          exitCodeHint: 76,
          httpStatus: 200,
          operationId: `op_${"a".repeat(32)}`,
          runId: `run_${"b".repeat(32)}`,
          serverError: null,
        },
      });
    },
  });
  const result = await runEngineServeCommand(options(), deps);
  assert.equal(result.exitCode, 76);
  assert.equal(result.reason, "recovery_protocol_invalid");
  assert.equal(result.recoveryFailures, 1);
  assert.equal(recoveryCalls, 1);
  assert.equal(result.releaseDisposition, "released");
  assert.equal(releaseCalls, 1);
});

test("a successful heartbeat resets its consecutive failure budget", async () => {
  let calls = 0;
  let stop;
  const deps = dependencies({
    async delay(_milliseconds, signal) {
      if (!signal.aborted) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    async runRecoveryCycle() {
      await new Promise((resolve) => setImmediate(resolve));
      return cycleResult();
    },
    async sendHeartbeat() {
      calls += 1;
      if (calls === 2 || calls === 10) {
        if (calls === 10) stop();
        return { status: "heartbeat" };
      }
      throw new Error("retryable");
    },
    subscribeSignals(value) {
      stop = value;
      return () => undefined;
    },
  });
  const result = await runEngineServeCommand(options(), deps);
  assert.equal(calls, 10);
  assert.equal(result.exitCode, 0);
  assert.equal(result.heartbeatFailures, 0);
});

test("durable auth rejection drains both loops and retains ownership for exit 77", async () => {
  let releases = 0;
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releases += 1;
      };
    },
    async delay(_milliseconds, signal) {
      await abortOnly(signal);
    },
    async runRecoveryCycle() {
      return cycleResult({
        halt: {
          code: "auth",
          exitCodeHint: 77,
          httpStatus: 403,
          operationId: `op_${"a".repeat(32)}`,
          runId: `run_${"b".repeat(32)}`,
          serverError: "runner_rejected",
        },
        permanentStop: true,
      });
    },
  });
  const result = await runEngineServeCommand(options(), deps);
  assert.equal(result.exitCode, 77);
  assert.equal(result.reason, "durable_auth_rejected");
  assert.equal(result.releaseDisposition, "retained");
  assert.equal(releases, 0);
});

test("durable auth returned in flight overrides a heartbeat failure budget", async () => {
  let errorEvents = 0;
  let releaseRecovery;
  let releases = 0;
  let resolveBudget;
  const budgetReached = new Promise((resolve) => {
    resolveBudget = resolve;
  });
  const recoveryGate = new Promise((resolve) => {
    releaseRecovery = resolve;
  });
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releases += 1;
      };
    },
    async delay() {
      await new Promise((resolve) => setImmediate(resolve));
    },
    emitError() {
      errorEvents += 1;
      if (errorEvents === 8) resolveBudget();
    },
    async runRecoveryCycle() {
      await recoveryGate;
      return cycleResult({
        halt: {
          code: "auth",
          exitCodeHint: 77,
          httpStatus: 403,
          operationId: `op_${"a".repeat(32)}`,
          runId: `run_${"b".repeat(32)}`,
          serverError: "runner_rejected",
        },
        permanentStop: true,
      });
    },
    async sendHeartbeat() {
      throw new Error("retry");
    },
  });
  const pending = runEngineServeCommand(options(), deps);
  await budgetReached;
  releaseRecovery();
  const result = await pending;
  assert.equal(result.exitCode, 77);
  assert.equal(result.reason, "durable_auth_rejected");
  assert.equal(result.releaseDisposition, "retained");
  assert.equal(result.heartbeatFailures, 8);
  assert.equal(releases, 0);
});

test("fatal heartbeat returned in flight overrides a recovery failure budget", async () => {
  let releaseHeartbeat;
  let releases = 0;
  let resolveBudget;
  const budgetReached = new Promise((resolve) => {
    resolveBudget = resolve;
  });
  const heartbeatGate = new Promise((resolve) => {
    releaseHeartbeat = resolve;
  });
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releases += 1;
      };
    },
    async delay(milliseconds, signal) {
      if (milliseconds === 10_000) await abortOnly(signal);
    },
    emit(value) {
      if (value.status === "recovery" && value.failureStreak === 8) {
        resolveBudget();
      }
    },
    async runRecoveryCycle() {
      return cycleResult({
        halt: {
          code: "retryable",
          exitCodeHint: 75,
          httpStatus: 503,
          operationId: `op_${"a".repeat(32)}`,
          runId: `run_${"b".repeat(32)}`,
          serverError: "run_operation_failed",
        },
      });
    },
    async sendHeartbeat() {
      await heartbeatGate;
      throw Object.assign(new Error("private auth"), {
        code: "heartbeat_auth",
        exitCode: 77,
      });
    },
  });
  const pending = runEngineServeCommand(options(), deps);
  await budgetReached;
  releaseHeartbeat();
  const result = await pending;
  assert.equal(result.exitCode, 77);
  assert.equal(result.reason, "heartbeat_auth_rejected");
  assert.equal(result.releaseDisposition, "released");
  assert.equal(result.recoveryFailures, 8);
  assert.equal(releases, 1);
});

test("durable auth outranks heartbeat auth at the same exit code", async () => {
  let releaseRecovery;
  let releases = 0;
  let resolveHeartbeatAuth;
  const heartbeatAuthObserved = new Promise((resolve) => {
    resolveHeartbeatAuth = resolve;
  });
  const recoveryGate = new Promise((resolve) => {
    releaseRecovery = resolve;
  });
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releases += 1;
      };
    },
    async runRecoveryCycle() {
      await recoveryGate;
      return cycleResult({
        halt: {
          code: "auth",
          exitCodeHint: 77,
          httpStatus: 403,
          operationId: `op_${"a".repeat(32)}`,
          runId: `run_${"b".repeat(32)}`,
          serverError: "runner_rejected",
        },
        permanentStop: true,
      });
    },
    async sendHeartbeat() {
      resolveHeartbeatAuth();
      throw Object.assign(new Error("private auth"), {
        code: "heartbeat_auth",
        exitCode: 77,
      });
    },
  });
  const pending = runEngineServeCommand(options(), deps);
  await heartbeatAuthObserved;
  await new Promise((resolve) => setImmediate(resolve));
  releaseRecovery();
  const result = await pending;
  assert.equal(result.exitCode, 77);
  assert.equal(result.reason, "durable_auth_rejected");
  assert.equal(result.releaseDisposition, "retained");
  assert.equal(releases, 0);
});

test("heartbeat fatal errors stop recovery without consuming retry budget", async () => {
  let releases = 0;
  const error = Object.assign(new Error("private auth detail"), {
    code: "heartbeat_auth",
    exitCode: 77,
  });
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releases += 1;
      };
    },
    async delay(_milliseconds, signal) {
      await abortOnly(signal);
    },
    async runRecoveryCycle() {
      await new Promise((resolve) => setImmediate(resolve));
      return cycleResult();
    },
    async sendHeartbeat() {
      throw error;
    },
  });
  const result = await runEngineServeCommand(options(), deps);
  assert.equal(result.exitCode, 77);
  assert.equal(result.reason, "heartbeat_auth_rejected");
  assert.equal(result.heartbeatFailures, 0);
  assert.equal(releases, 1);
});

test("deterministic local recovery errors exit 78 without retry", async () => {
  let calls = 0;
  const deps = dependencies({
    async delay(_milliseconds, signal) {
      await abortOnly(signal);
    },
    async runRecoveryCycle() {
      calls += 1;
      throw Object.assign(new Error("private state detail"), {
        code: "engine_attempt_coordinator_invalid",
      });
    },
  });
  const result = await runEngineServeCommand(options(), deps);
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 78);
  assert.equal(result.reason, "engine_attempt_coordinator_invalid");
  assert.equal(result.recoveryFailures, 0);
});

test("signal observed at a recovery yield aborts the plan and releases once", async () => {
  let releases = 0;
  let stop;
  let yieldEntered = false;
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releases += 1;
      };
    },
    async runRecoveryCycle(input) {
      yieldEntered = true;
      stop();
      await input.yieldControl();
      throw new Error("yield must stop");
    },
    subscribeSignals(value) {
      stop = value;
      return () => undefined;
    },
  });
  const result = await runEngineServeCommand(options(), deps);
  assert.equal(yieldEntered, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, "stop_requested");
  assert.equal(releases, 1);
});

test("lock release failure is one-shot and returns stale_possible", async () => {
  let releases = 0;
  let stop;
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releases += 1;
        throw new Error("storage failure");
      };
    },
    async loadCompletionContext() {
      stop();
      return Object.freeze({ opaque: true });
    },
    subscribeSignals(value) {
      stop = value;
      return () => undefined;
    },
  });
  const result = await runEngineServeCommand(options(), deps);
  assert.equal(releases, 1);
  assert.equal(result.exitCode, 74);
  assert.equal(result.reason, "lock_release_failed");
  assert.equal(result.releaseDisposition, "stale_possible");
});

test("release failure cannot downgrade a deterministic fatal stop", async () => {
  let releases = 0;
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releases += 1;
        throw new Error("storage failure");
      };
    },
    async delay(_milliseconds, signal) {
      await abortOnly(signal);
    },
    async runRecoveryCycle() {
      throw Object.assign(new Error("private state detail"), {
        code: "engine_attempt_coordinator_invalid",
      });
    },
  });
  const result = await runEngineServeCommand(options(), deps);
  assert.equal(releases, 1);
  assert.equal(result.exitCode, 78);
  assert.equal(result.reason, "engine_attempt_coordinator_invalid");
  assert.equal(result.releaseDisposition, "stale_possible");
});

test("a rejected loop delay stops both loops before releasing ownership", async () => {
  let releases = 0;
  let delayCalls = 0;
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releases += 1;
      };
    },
    async delay() {
      delayCalls += 1;
      throw new Error("timer unavailable");
    },
    async runRecoveryCycle() {
      await new Promise((resolve) => setImmediate(resolve));
      return cycleResult();
    },
  });
  const result = await runEngineServeCommand(options(), deps);
  assert.ok(delayCalls >= 1);
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, "heartbeat_delay_failed");
  assert.equal(result.releaseDisposition, "released");
  assert.equal(releases, 1);
});

test("a pending stop prevents the next completion effect from starting", async () => {
  let effectCalls = 0;
  let stop;
  const deps = dependencies({
    async performCompletionEffect() {
      effectCalls += 1;
      return Object.freeze({ kind: "transport_error" });
    },
    async runRecoveryCycle(input) {
      stop();
      await input.performCompletionEffect(Object.freeze({}));
      assert.fail("A stopped recovery cycle must not continue.");
    },
    subscribeSignals(value) {
      stop = value;
      return () => undefined;
    },
  });
  const result = await runEngineServeCommand(options(), deps);
  assert.equal(effectCalls, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, "stop_requested");
  assert.equal(result.releaseDisposition, "released");
});

test("one explicit target runs beside heartbeat and wakes recovery immediately", async () => {
  let capability;
  let recoveryCalls = 0;
  let releaseCalls = 0;
  let stop;
  let targetInput;
  let targetOwnership;
  const events = [];
  const completionContext = Object.freeze({ opaque: true });
  const deps = dependencies({
    async acquireStateLock() {
      capability = async () => {
        releaseCalls += 1;
      };
      return capability;
    },
    async delay(milliseconds, signal) {
      if (milliseconds === 10_000) await abortOnly(signal);
    },
    emit(value) {
      events.push(value);
    },
    async loadCompletionContext() {
      return completionContext;
    },
    async runAttemptTarget(input, ownership) {
      targetInput = input;
      targetOwnership = ownership;
      return Object.freeze({
        attemptId: `att_${"a".repeat(32)}`,
        fatalAuth: false,
        status: "terminal",
      });
    },
    async runRecoveryCycle() {
      recoveryCalls += 1;
      if (recoveryCalls === 2) stop();
      return cycleResult();
    },
    subscribeSignals(value) {
      stop = value;
      return () => undefined;
    },
  });
  const result = await runEngineServeCommand(targetOptions(), deps);
  assert.equal(result.exitCode, 0);
  assert.equal(recoveryCalls, 2);
  assert.equal(releaseCalls, 1);
  assert.equal(targetOwnership, capability);
  assert.equal(targetInput.controlContext, completionContext);
  assert.equal(targetInput.engine, "claude_code_cli");
  assert.equal(targetInput.runId, `run_${"b".repeat(32)}`);
  assert.equal(targetInput.stateDir, "/tmp/nexus-serve-test");
  assert.equal(targetInput.signal.aborted, true);
  assert.deepEqual(events[0].loops, [
    "heartbeat",
    "recovery",
    "execution",
  ]);
  assert.equal(
    events.some(
      (event) =>
        event.status === "execution" &&
        event.outcome === "terminal",
    ),
    true,
  );
});

test("explicit target authentication failure stops and releases safely", async () => {
  let releases = 0;
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releases += 1;
      };
    },
    async delay(_milliseconds, signal) {
      await abortOnly(signal);
    },
    async runAttemptTarget() {
      return Object.freeze({
        attemptId: `att_${"a".repeat(32)}`,
        fatalAuth: true,
        status: "terminal",
      });
    },
  });
  const result = await runEngineServeCommand(targetOptions(), deps);
  assert.equal(result.exitCode, 77);
  assert.equal(result.reason, "execution_auth_rejected");
  assert.equal(result.releaseDisposition, "released");
  assert.equal(releases, 1);
});

test("explicit target protocol failure exits 76 without retry", async () => {
  let releases = 0;
  let targetCalls = 0;
  const deps = dependencies({
    async acquireStateLock() {
      return async () => {
        releases += 1;
      };
    },
    async delay(_milliseconds, signal) {
      await abortOnly(signal);
    },
    async runAttemptTarget() {
      targetCalls += 1;
      throw Object.assign(new Error("private protocol detail"), {
        code: "engine_attempt_protocol_invalid",
        exitCode: 76,
      });
    },
  });
  const result = await runEngineServeCommand(targetOptions(), deps);
  assert.equal(targetCalls, 1);
  assert.equal(result.exitCode, 76);
  assert.equal(result.reason, "execution_protocol_invalid");
  assert.equal(result.releaseDisposition, "released");
  assert.equal(releases, 1);
  assert.match(
    serveFailureMessage(result),
    /execution control service returned an invalid protocol response/u,
  );
});

test("explicit target schema is all-or-nothing and requires its executor", async () => {
  await assert.rejects(
    runEngineServeCommand(
      {
        ...options(),
        target: { runId: `run_${"b".repeat(32)}` },
      },
      dependencies(),
    ),
    (error) => error.exitCode === 64,
  );
  await assert.rejects(
    runEngineServeCommand(targetOptions(), dependencies()),
    /dependencies are invalid/u,
  );
});

test("retry delay is full-jitter exponential, capped and bounded away from zero", () => {
  assert.equal(retryDelay(1, () => 0), 100);
  assert.equal(retryDelay(1, () => 0.5), 500);
  assert.equal(retryDelay(2, () => 0.5), 1_000);
  assert.equal(retryDelay(7, () => 0.999999), 59_999);
  assert.equal(retryDelay(50, () => 2), 59_999);
  assert.equal(retryDelay(3, () => Number.NaN), 100);
  assert.throws(() => retryDelay(0), /retry state is invalid/u);
});

test("serve modules keep provider execution behind the injected target port", async () => {
  const [commandSource, effectSource] = await Promise.all([
    readFile(
      new URL("../runner/engine-serve-command.mjs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../runner/engine-complete-http-effect.mjs",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  for (const source of [commandSource, effectSource]) {
    assert.doesNotMatch(
      source,
      /nexus-runner\.mjs|node:child_process|spawn\s*\(|execFile|engine-supervised-run|engine-adapters/u,
    );
  }
  assert.doesNotMatch(
    commandSource,
    /lease\/claim|\/prompt/u,
  );
});

function options() {
  return {
    intervalSeconds: 10,
    serverOverride: undefined,
    stateDir: "/tmp/nexus-serve-test",
  };
}

function targetOptions() {
  return {
    ...options(),
    target: {
      engine: "claude_code_cli",
      runId: `run_${"b".repeat(32)}`,
    },
  };
}

function dependencies(overrides = {}) {
  return {
    async acquireStateLock() {
      return async () => undefined;
    },
    async delay(_milliseconds, signal) {
      await abortOnly(signal);
    },
    emit() {},
    emitError() {},
    async loadCompletionContext() {
      return Object.freeze({ opaque: true });
    },
    async performCompletionEffect() {
      return Object.freeze({ kind: "transport_error" });
    },
    random() {
      return 0.5;
    },
    async runRecoveryCycle() {
      return cycleResult();
    },
    async sendHeartbeat() {
      return Object.freeze({ status: "heartbeat" });
    },
    subscribeSignals() {
      return () => undefined;
    },
    async yieldControl() {},
    ...overrides,
  };
}

function cycleResult({ halt = null, permanentStop = false } = {}) {
  return {
    report: {
      drain: {
        attempted: halt ? 1 : 0,
        delivered: [],
        failed: [],
        halt,
        remainingPending: 0,
      },
      permanentStop,
    },
  };
}

async function abortOnly(signal) {
  if (signal.aborted) return;
  await new Promise((resolve) =>
    signal.addEventListener("abort", resolve, { once: true })
  );
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Condition was not reached.");
}
