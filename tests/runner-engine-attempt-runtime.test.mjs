import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  finalizeAttemptRecord,
} from "../runner/attempt-journal-contract.mjs";
import {
  persistAttemptRecord,
  recoverAttemptJournals,
} from "../runner/attempt-journal-store.mjs";
import {
  createClaimedRecord,
  createStartingRecord,
} from "../runner/engine-claim-contract.mjs";
import {
  runEngineAttemptTarget,
} from "../runner/engine-attempt-runtime.mjs";
import {
  createSpawningRecord,
} from "../runner/engine-lease-runtime-contract.mjs";
import {
  acquireOutboxLock,
} from "../runner/durable-outbox.mjs";
import {
  encodeChildStartToken,
  encodeSupervisorStartToken,
} from "../runner/engine-supervisor-protocol.mjs";

const runId = `run_${"1".repeat(32)}`;
const leaseId = `lse_${"5".repeat(32)}`;
const promptRef = `prm_${"3".repeat(32)}`;
const engineVersion = "2.1.219 (Claude Code)";
const nowMs = Date.parse("2026-07-28T12:00:00.000Z");

test("explicit target reaches one durable supervised result", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-happy-");
  const release = await acquireOutboxLock(stateDir);
  const prompt = Buffer.from("analyze");
  const calls = {
    claim: 0,
    prompt: 0,
    readiness: 0,
    renew: 0,
    supervisor: 0,
  };
  const result = await runEngineAttemptTarget(
    target(stateDir),
    dependencies({
      async performClaimEffect() {
        calls.claim += 1;
        return {
          descriptor: descriptor(prompt),
          httpStatus: 200,
          kind: "descriptor",
          replay: false,
        };
      },
      async performPromptEffect() {
        calls.prompt += 1;
        return {
          outcome: {
            httpStatus: 200,
            kind: "prompt",
            promptBytes: prompt.byteLength,
            promptRef,
            promptSha256: sha256(prompt),
            replay: false,
          },
          promptBuffer: Uint8Array.from(prompt),
        };
      },
      async performRenewEffect() {
        calls.renew += 1;
        return renewal(false);
      },
      async resolveReadiness() {
        calls.readiness += 1;
        return ready();
      },
      async runSupervisedAttempt(input) {
        calls.supervisor += 1;
        assert.equal(input.attempt.spawning.state, "spawning");
        assert.deepEqual(Buffer.from(input.input), prompt);
        return appendSuccessfulSupervisor(input);
      },
    }),
    release,
  );
  assert.equal(result.status, "terminal");
  assert.equal(result.fatalAuth, false);
  assert.deepEqual(calls, {
    claim: 1,
    prompt: 1,
    readiness: 1,
    renew: 2,
    supervisor: 1,
  });
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.equal(attempt.records.result.receipt.status, "succeeded");
  assert.equal(attempt.records.result.receipt.summary, "completed");
  assert.ok(attempt.records.supervisor.supervisorStartToken.startsWith("sup3:"));
  await release();
});

test("renew cancellation is durable before any supervisor can launch", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-cancel-");
  const release = await acquireOutboxLock(stateDir);
  let promptCalls = 0;
  let supervisorCalls = 0;
  const result = await runEngineAttemptTarget(
    target(stateDir),
    dependencies({
      async performClaimEffect() {
        return {
          descriptor: descriptor(Buffer.from("cancel")),
          httpStatus: 200,
          kind: "descriptor",
          replay: false,
        };
      },
      async performPromptEffect() {
        promptCalls += 1;
        throw new Error("unreachable");
      },
      async performRenewEffect() {
        return renewal(true);
      },
      async runSupervisedAttempt() {
        supervisorCalls += 1;
        throw new Error("unreachable");
      },
    }),
    release,
  );
  assert.equal(result.status, "terminal");
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.equal(attempt.records.canceling.state, "canceling");
  assert.equal(
    attempt.records.result.receipt.reason,
    "cancel_requested",
  );
  assert.equal(promptCalls, 0);
  assert.equal(supervisorCalls, 0);
  await release();
});

test("durable claim authentication denial stops with no starting record", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-auth-");
  const release = await acquireOutboxLock(stateDir);
  const result = await runEngineAttemptTarget(
    target(stateDir),
    dependencies({
      async performClaimEffect() {
        return {
          class: "auth",
          httpStatus: 403,
          kind: "denied",
          replay: false,
          serverError: "runner_rejected",
        };
      },
    }),
    release,
  );
  assert.equal(result.status, "terminal");
  assert.equal(result.fatalAuth, true);
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.equal(attempt.records.starting, undefined);
  assert.equal(attempt.records.settled.outcome, "abandoned");
  assert.equal(
    attempt.records.settled.denial.serverError,
    "runner_rejected",
  );
  await release();
});

test("a protocol response stops immediately without fabricating server truth", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-protocol-");
  const release = await acquireOutboxLock(stateDir);
  let claimCalls = 0;
  await assert.rejects(
    runEngineAttemptTarget(
      target(stateDir),
      dependencies({
        async performClaimEffect() {
          claimCalls += 1;
          return {
            code: "protocol",
            httpStatus: 200,
            kind: "response_error",
          };
        },
      }),
      release,
    ),
    (error) => {
      assert.equal(error.code, "engine_attempt_protocol_invalid");
      assert.equal(error.exitCode, 76);
      return true;
    },
  );
  assert.equal(claimCalls, 1);
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.ok(attempt.records.claimed);
  assert.equal(attempt.records.starting, undefined);
  assert.equal(attempt.records.result, undefined);
  assert.equal(attempt.records.settled, undefined);
  await release();
});

test("readiness invariant errors stay recoverable instead of fabricating a result", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-readiness-error-");
  const release = await acquireOutboxLock(stateDir);
  const prompt = Buffer.from("recoverable-readiness");
  await assert.rejects(
    runEngineAttemptTarget(
      target(stateDir),
      dependencies({
        async performClaimEffect() {
          return {
            descriptor: descriptor(prompt),
            httpStatus: 200,
            kind: "descriptor",
            replay: false,
          };
        },
        async performPromptEffect() {
          return {
            outcome: {
              httpStatus: 200,
              kind: "prompt",
              promptBytes: prompt.byteLength,
              promptRef,
              promptSha256: sha256(prompt),
              replay: false,
            },
            promptBuffer: Uint8Array.from(prompt),
          };
        },
        async performRenewEffect() {
          return renewal(false);
        },
        async resolveReadiness() {
          const error = new Error("unsafe state directory");
          error.code = "engine_readiness_invariant";
          throw error;
        },
      }),
      release,
    ),
    (error) => {
      assert.equal(error.code, "engine_readiness_invariant");
      return true;
    },
  );
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.ok(attempt.records.starting);
  assert.equal(attempt.records.spawning, undefined);
  assert.equal(attempt.records.result, undefined);
  await release();
});

test("a closed not-ready outcome becomes a durable incompatibility", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-not-ready-");
  const release = await acquireOutboxLock(stateDir);
  const prompt = Buffer.from("known-incompatibility");
  let supervisorCalls = 0;
  const result = await runEngineAttemptTarget(
    target(stateDir),
    dependencies({
      async performClaimEffect() {
        return {
          descriptor: descriptor(prompt),
          httpStatus: 200,
          kind: "descriptor",
          replay: false,
        };
      },
      async performPromptEffect() {
        return {
          outcome: {
            httpStatus: 200,
            kind: "prompt",
            promptBytes: prompt.byteLength,
            promptRef,
            promptSha256: sha256(prompt),
            replay: false,
          },
          promptBuffer: Uint8Array.from(prompt),
        };
      },
      async performRenewEffect() {
        return renewal(false);
      },
      async resolveReadiness() {
        return Object.freeze({
          kind: "not_ready",
          reason: "engine_probe_failed",
        });
      },
      async runSupervisedAttempt() {
        supervisorCalls += 1;
        throw new Error("unreachable");
      },
    }),
    release,
  );
  assert.equal(result.status, "terminal");
  assert.equal(supervisorCalls, 0);
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.equal(
    attempt.records.result.receipt.reason,
    "engine_incompatible",
  );
  await release();
});

test("legacy supervisor identities block without any provider or HTTP effect", async (t) => {
  for (const version of [1, 2]) {
    const stateDir = await privateStateDir(
      t,
      `nexus-runtime-legacy-v${version}-`,
    );
    const release = await acquireOutboxLock(stateDir);
    const records = await persistAttemptPrefix(stateDir, {
      supervisorStartToken:
        `sup${version}:41000:${"a".repeat(32)}`,
    });
    let effects = 0;
    await assert.rejects(
      runEngineAttemptTarget(
        target(stateDir),
        dependencies({
          async performClaimEffect() {
            effects += 1;
            throw new Error("unreachable");
          },
          async resumeSupervisedAttempt() {
            effects += 1;
            throw new Error("unreachable");
          },
        }),
        release,
      ),
      (error) => {
        assert.equal(error.code, "engine_supervisor_legacy_ambiguous");
        assert.equal(error.exitCode, 78);
        return true;
      },
    );
    assert.equal(effects, 0);
    assert.equal(
      records.supervisor.supervisorStartToken.startsWith(
        `sup${version}:`,
      ),
      true,
    );
    await release();
  }
});

test("spawning crash gap blocks instead of launching a second provider", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-gap-");
  const release = await acquireOutboxLock(stateDir);
  await persistAttemptPrefix(stateDir);
  let supervisorCalls = 0;
  await assert.rejects(
    runEngineAttemptTarget(
      target(stateDir),
      dependencies({
        async runSupervisedAttempt() {
          supervisorCalls += 1;
          throw new Error("unreachable");
        },
      }),
      release,
    ),
    (error) => {
      assert.equal(error.code, "engine_spawning_ambiguous");
      assert.equal(error.exitCode, 78);
      return true;
    },
  );
  assert.equal(supervisorCalls, 0);
  await release();
});

test("a foreign prestart attempt excludes another explicit target", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-busy-");
  const release = await acquireOutboxLock(stateDir);
  await persistAttemptPrefix(stateDir, {
    includeSpawning: false,
    persistedRunId: `run_${"2".repeat(32)}`,
  });
  await assert.rejects(
    runEngineAttemptTarget(
      target(stateDir),
      dependencies(),
      release,
    ),
    (error) => {
      assert.equal(error.code, "engine_target_busy");
      assert.equal(error.exitCode, 75);
      return true;
    },
  );
  const attempts = await recoverAttemptJournals(stateDir);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].records.claimed.runId, `run_${"2".repeat(32)}`);
  await release();
});

test("an unrenewable prestart lease becomes durable and cannot starve targets", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-unrenewable-");
  const release = await acquireOutboxLock(stateDir);
  await persistAttemptPrefix(stateDir, { includeSpawning: false });
  let renewCalls = 0;
  const clockMs = Date.parse("2026-07-28T12:00:50.001Z");
  const result = await runEngineAttemptTarget(
    target(stateDir),
    dependencies({
      now: () => clockMs,
      async performRenewEffect() {
        renewCalls += 1;
        throw new Error("renew must not start outside its lease window");
      },
    }),
    release,
  );
  assert.equal(result.status, "terminal");
  assert.equal(renewCalls, 0);
  let attempts = await recoverAttemptJournals(stateDir);
  assert.equal(attempts[0].records.result.receipt.reason, "lease_lost");

  const replay = await runEngineAttemptTarget(
    target(stateDir),
    dependencies({
      async performClaimEffect() {
        assert.fail("terminal replay must not claim");
      },
    }),
    release,
  );
  assert.equal(replay.status, "terminal");

  const foreign = await runEngineAttemptTarget(
    {
      ...target(stateDir),
      runId: `run_${"2".repeat(32)}`,
    },
    dependencies({
      async performClaimEffect() {
        return {
          class: "auth",
          httpStatus: 403,
          kind: "denied",
          replay: false,
          serverError: "runner_rejected",
        };
      },
    }),
    release,
  );
  assert.equal(foreign.status, "terminal");
  attempts = await recoverAttemptJournals(stateDir);
  assert.equal(attempts.length, 2);
  await release();
});

test("prompt retries stop before crossing the active lease horizon", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-prompt-horizon-");
  const release = await acquireOutboxLock(stateDir);
  const prompt = Buffer.from("lease-bounded-prompt");
  let clockMs = Date.parse("2026-07-28T12:00:49.900Z");
  let promptCalls = 0;
  let supervisorCalls = 0;
  const result = await runEngineAttemptTarget(
    target(stateDir),
    dependencies({
      async delay(milliseconds) {
        clockMs += milliseconds;
      },
      now: () => clockMs,
      async performClaimEffect() {
        return {
          descriptor: descriptor(prompt),
          httpStatus: 200,
          kind: "descriptor",
          replay: false,
        };
      },
      async performPromptEffect() {
        promptCalls += 1;
        return {
          outcome: { kind: "transport_error" },
          promptBuffer: null,
        };
      },
      async performRenewEffect() {
        return {
          httpStatus: 200,
          kind: "renewal",
          observedAt: "2026-07-28T12:00:49.900Z",
          renewal: {
            cancelRequested: false,
            expiresAt: "2026-07-28T12:01:00.000Z",
            fence: 7,
            leaseId,
            runId,
          },
          replay: false,
        };
      },
      async runSupervisedAttempt() {
        supervisorCalls += 1;
      },
    }),
    release,
  );
  assert.equal(result.status, "terminal");
  assert.equal(promptCalls, 1);
  assert.equal(supervisorCalls, 0);
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.equal(attempt.records.result.receipt.reason, "lease_lost");
  await release();
});

test("lease loss reaches the supervised provider as the durable reason", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-lease-loss-");
  const release = await acquireOutboxLock(stateDir);
  const prompt = Buffer.from("analyze");
  let renewCalls = 0;
  const result = await runEngineAttemptTarget(
    target(stateDir),
    dependencies({
      async delay() {
        await new Promise((resolveDelay) => setImmediate(resolveDelay));
      },
      async performClaimEffect() {
        return {
          descriptor: descriptor(prompt),
          httpStatus: 200,
          kind: "descriptor",
          replay: false,
        };
      },
      async performPromptEffect() {
        return {
          outcome: {
            httpStatus: 200,
            kind: "prompt",
            promptBytes: prompt.byteLength,
            promptRef,
            promptSha256: sha256(prompt),
            replay: false,
          },
          promptBuffer: Uint8Array.from(prompt),
        };
      },
      async performRenewEffect() {
        renewCalls += 1;
        if (renewCalls <= 2) return renewal(false);
        return {
          class: "superseded",
          httpStatus: 409,
          kind: "denied",
          replay: false,
          serverError: "lease_superseded",
        };
      },
      async runSupervisedAttempt(input) {
        return appendTerminatedSupervisor(input);
      },
    }),
    release,
  );
  assert.equal(result.status, "terminal");
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.equal(attempt.records.result.receipt.reason, "lease_lost");
  assert.equal(attempt.records.result.receipt.status, "failed");
  assert.ok(renewCalls >= 3);
  await release();
});

test("a pending renewal cannot keep the provider past the lease horizon", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-lease-horizon-");
  const release = await acquireOutboxLock(stateDir);
  const prompt = Buffer.from("bounded-authority");
  let clockMs = nowMs;
  let renewCalls = 0;
  const result = await runEngineAttemptTarget(
    target(stateDir),
    dependencies({
      async delay(milliseconds, signal) {
        await new Promise((resolveDelay) => setImmediate(resolveDelay));
        if (!signal?.aborted) clockMs += milliseconds;
      },
      now: () => clockMs,
      async performClaimEffect() {
        return {
          descriptor: descriptor(prompt),
          httpStatus: 200,
          kind: "descriptor",
          replay: false,
        };
      },
      async performPromptEffect() {
        return {
          outcome: {
            httpStatus: 200,
            kind: "prompt",
            promptBytes: prompt.byteLength,
            promptRef,
            promptSha256: sha256(prompt),
            replay: false,
          },
          promptBuffer: Uint8Array.from(prompt),
        };
      },
      async performRenewEffect() {
        renewCalls += 1;
        if (renewCalls <= 2) return renewal(false);
        return new Promise(() => undefined);
      },
      async runSupervisedAttempt(input) {
        return appendTerminatedSupervisor(input);
      },
    }),
    release,
  );
  assert.equal(result.status, "terminal");
  assert.equal(renewCalls, 3);
  assert.equal(
    clockMs,
    Date.parse("2026-07-28T12:02:00.000Z"),
  );
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.equal(attempt.records.result.receipt.reason, "lease_lost");
  await release();
});

test("spawn gate rejects a durable timeout that no longer fits the deadline", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-runtime-budget-");
  const release = await acquireOutboxLock(stateDir);
  const prompt = Buffer.from("analyze");
  let clockMs = nowMs;
  let supervisorCalls = 0;
  const result = await runEngineAttemptTarget(
    target(stateDir),
    dependencies({
      now: () => clockMs,
      async performClaimEffect() {
        return {
          descriptor: descriptor(prompt),
          httpStatus: 200,
          kind: "descriptor",
          replay: false,
        };
      },
      async performPromptEffect() {
        return {
          outcome: {
            httpStatus: 200,
            kind: "prompt",
            promptBytes: prompt.byteLength,
            promptRef,
            promptSha256: sha256(prompt),
            replay: false,
          },
          promptBuffer: Uint8Array.from(prompt),
        };
      },
      async performRenewEffect() {
        return renewal(false);
      },
      async resolveReadiness() {
        clockMs += 1;
        return ready();
      },
      async runSupervisedAttempt() {
        supervisorCalls += 1;
        throw new Error("unreachable");
      },
    }),
    release,
  );
  assert.equal(result.status, "terminal");
  assert.equal(supervisorCalls, 0);
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.equal(
    attempt.records.result.receipt.reason,
    "engine_deadline_exhausted",
  );
  assert.equal(attempt.records.spawning, undefined);
  await release();
});

async function appendSuccessfulSupervisor(input) {
  const token = "a".repeat(32);
  let records = await input.appendRecord(finalizeAttemptRecord({
    attemptId: input.attempt.claimed.attemptId,
    createdAt: "2026-07-28T12:00:00.000Z",
    state: "supervisor",
    supervisorPid: 42,
    supervisorStartToken: encodeSupervisorStartToken(41_000, token),
    v: 1,
  }));
  const startedAt = "2026-07-28T12:00:00.000Z";
  records = await input.appendRecord(finalizeAttemptRecord({
    attemptId: records.claimed.attemptId,
    childPid: 43,
    childStartToken: encodeChildStartToken(token, 1),
    createdAt: startedAt,
    startedAt,
    state: "started",
    v: 1,
  }));
  return input.appendRecord(finalizeAttemptRecord({
    attemptId: records.claimed.attemptId,
    createdAt: startedAt,
    receipt: {
      cancelRequested: false,
      engine: "claude_code_cli",
      engineVersion,
      exitCode: 0,
      finishedAt: startedAt,
      reason: "none",
      startedAt,
      status: "succeeded",
      stderr: emptyStream(),
      stdout: emptyStream(),
      summary: "completed",
      timedOut: false,
    },
    state: "result",
    v: 1,
  }));
}

async function appendTerminatedSupervisor(input) {
  input.publishLeaseUpdater(async () => undefined);
  const token = "b".repeat(32);
  let records = await input.appendRecord(finalizeAttemptRecord({
    attemptId: input.attempt.claimed.attemptId,
    createdAt: "2026-07-28T12:00:00.000Z",
    state: "supervisor",
    supervisorPid: 52,
    supervisorStartToken: encodeSupervisorStartToken(41_001, token),
    v: 1,
  }));
  const startedAt = "2026-07-28T12:00:00.000Z";
  records = await input.appendRecord(finalizeAttemptRecord({
    attemptId: records.claimed.attemptId,
    childPid: 53,
    childStartToken: encodeChildStartToken(token, 1),
    createdAt: startedAt,
    startedAt,
    state: "started",
    v: 1,
  }));
  if (!input.cancelSignal.aborted) {
    await new Promise((resolveAbort) =>
      input.cancelSignal.addEventListener("abort", resolveAbort, {
        once: true,
      })
    );
  }
  assert.equal(input.cancelSignal.reason, "lease_lost");
  return input.appendRecord(finalizeAttemptRecord({
    attemptId: records.claimed.attemptId,
    createdAt: startedAt,
    receipt: {
      cancelRequested: false,
      engine: "claude_code_cli",
      engineVersion,
      exitCode: null,
      finishedAt: startedAt,
      reason: "lease_lost",
      startedAt,
      status: "failed",
      stderr: emptyStream(),
      stdout: emptyStream(),
      summary: "lease_lost",
      timedOut: false,
    },
    state: "result",
    v: 1,
  }));
}

async function persistAttemptPrefix(
  stateDir,
  {
    includeSpawning = true,
    persistedRunId = runId,
    supervisorStartToken,
  } = {},
) {
  const prompt = Buffer.from("persisted");
  const claimed = createClaimedRecord({
    attemptId: `att_${"c".repeat(32)}`,
    createdAt: "2026-07-28T12:00:00.000Z",
    engine: "claude_code_cli",
    runId: persistedRunId,
  });
  await persistAttemptRecord(stateDir, claimed);
  const starting = createStartingRecord({
    claimed,
    createdAt: "2026-07-28T12:00:00.000Z",
    descriptor: {
      ...descriptor(prompt),
      runId: persistedRunId,
    },
    effectiveTimeoutMs: 570_000,
  });
  await persistAttemptRecord(stateDir, starting);
  if (!includeSpawning && !supervisorStartToken) {
    return { claimed, starting };
  }
  const spawning = createSpawningRecord({
    claimed,
    createdAt: "2026-07-28T12:00:00.000Z",
    starting,
  });
  await persistAttemptRecord(stateDir, spawning);
  if (!supervisorStartToken) {
    return { claimed, spawning, starting };
  }
  const supervisor = finalizeAttemptRecord({
    attemptId: claimed.attemptId,
    createdAt: "2026-07-28T12:00:00.000Z",
    state: "supervisor",
    supervisorPid: 61,
    supervisorStartToken,
    v: 1,
  });
  await persistAttemptRecord(stateDir, supervisor);
  return { claimed, spawning, starting, supervisor };
}

function target(stateDir) {
  return {
    controlContext: Object.freeze({ opaque: true }),
    engine: "claude_code_cli",
    runId,
    stateDir,
  };
}

function dependencies(overrides = {}) {
  return {
    async delay() {
      await new Promise(() => undefined);
    },
    generateAttemptId: () => `att_${"a".repeat(32)}`,
    now: () => nowMs,
    async performClaimEffect() {
      throw new Error("unconfigured");
    },
    async performPromptEffect() {
      throw new Error("unconfigured");
    },
    async performRenewEffect() {
      throw new Error("unconfigured");
    },
    async resolveReadiness() {
      return ready();
    },
    async resumeSupervisedAttempt() {
      throw new Error("unconfigured");
    },
    async runSupervisedAttempt() {
      throw new Error("unconfigured");
    },
    ...overrides,
  };
}

function descriptor(prompt) {
  return {
    cancelRequested: false,
    expiresAt: "2026-07-28T12:01:00.000Z",
    fence: 7,
    job: {
      deadlineAt: "2026-07-28T12:10:00.000Z",
      engine: "claude_code_cli",
      engineVersion,
      outputBounds: {
        stderrBytes: 65_536,
        stdoutBytes: 262_144,
      },
      promptBytes: prompt.byteLength,
      promptRef,
      promptSha256: sha256(prompt),
      timeoutMs: 600_000,
    },
    leaseId,
    runId,
  };
}

function renewal(cancelRequested) {
  return {
    httpStatus: 200,
    kind: "renewal",
    observedAt: "2026-07-28T12:00:00.000Z",
    renewal: {
      cancelRequested,
      expiresAt: "2026-07-28T12:02:00.000Z",
      fence: 7,
      leaseId,
      runId,
    },
    replay: false,
  };
}

function ready() {
  return {
    engine: "claude_code_cli",
    engineVersion,
    executableRealPath: "/private/nexus/bin/claude",
    fingerprintFacts: {
      dev: "1",
      ino: "2",
      mode: 0o100700,
      mtimeMs: 3,
      size: 4,
      uid: 501,
    },
    kind: "ready",
  };
}

function emptyStream() {
  return {
    bytes: 0,
    excerptBase64Url: "",
    sha256:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    truncated: false,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function privateStateDir(t, prefix) {
  const created = await mkdtemp(join(tmpdir(), prefix));
  const stateDir = await realpath(created);
  await chmod(stateDir, 0o700);
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  return stateDir;
}
