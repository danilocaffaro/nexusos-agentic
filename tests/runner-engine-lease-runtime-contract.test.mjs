import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EngineLeaseRuntimeContractError,
  createEngineLeaseRenewBody,
  createEngineLeaseRenewIntent,
  createPrestartAbandonedRecord,
  createRuntimePrestartReceipt,
  createRuntimePrestartResultRecord,
  createSpawningRecord,
  engineLeaseLossHorizonMs,
  mergeEngineLeaseRenewal,
  nextEngineLeaseRenewAtMs,
  parseEngineLeaseRenewal,
  shouldPropagateEngineCancel,
} from "../runner/engine-lease-runtime-contract.mjs";
import {
  createClaimedRecord,
  createStartingRecord,
} from "../runner/engine-claim-contract.mjs";
import {
  SPAWNING_QUIET_HORIZON_MS,
  attemptRecoveryDecision,
  validateAttemptRecordSet,
} from "../runner/attempt-journal-contract.mjs";

const attemptId = `att_${"a".repeat(32)}`;
const leaseId = `lse_${"5".repeat(32)}`;
const runId = `run_${"1".repeat(32)}`;

test("renew body and signed intent are canonical and exact", () => {
  const body = createEngineLeaseRenewBody({
    fence: 7,
    leaseId,
  });
  assert.deepEqual(body, { fence: 7, leaseId });
  assert.equal(Object.isFrozen(body), true);
  const intent = createEngineLeaseRenewIntent({
    fence: 7,
    leaseId,
    runId,
  });
  assert.deepEqual(intent, {
    expected: { fence: 7, leaseId, runId },
    request: {
      bodyBase64Url: Buffer.from(
        `{"fence":7,"leaseId":"${leaseId}"}`,
      ).toString("base64url"),
      bodySha256:
        "d874c4ac6feb0f8ab05e5f105d7f3d6c1c90e5be7ae0dde48ad20892e024bb08",
      pathname: `/api/runs/${runId}/lease/renew`,
      signatureDomain: "nexus-runner-lease-renew-v1",
    },
    runId,
  });
  assert.equal(Object.isFrozen(intent.expected), true);
  assert.equal(Object.isFrozen(intent.request), true);
});

test("renewal parser requires canonical bytes and exact fence identity", () => {
  const expected = { fence: 7, leaseId, runId };
  const renewal = renewalValue();
  const text = JSON.stringify(renewal);
  assert.deepEqual(parseEngineLeaseRenewal(text, expected), renewal);
  assert.equal(
    Object.isFrozen(parseEngineLeaseRenewal(text, expected)),
    true,
  );
  for (const invalid of [
    `${text}\n`,
    JSON.stringify({ ...renewal, fence: 8 }),
    JSON.stringify({ ...renewal, leaseId: `lse_${"6".repeat(32)}` }),
    JSON.stringify({ ...renewal, runId: `run_${"6".repeat(32)}` }),
    JSON.stringify({ ...renewal, expiresAt: "2026-07-28T12:01:00Z" }),
    `{"runId":"${runId}","leaseId":"${leaseId}","fence":7,"expiresAt":"2026-07-28T12:01:00.000Z","cancelRequested":false}`,
    JSON.stringify({ ...renewal, extra: true }),
    "{",
    "x".repeat(4_097),
  ]) {
    assert.equal(parseEngineLeaseRenewal(invalid, expected), undefined);
  }
});

test("renewal merge never shortens expiry or clears observed cancellation", () => {
  const currentExpiresAt = "2026-07-28T12:01:00.000Z";
  const earlier = mergeEngineLeaseRenewal({
    current: currentLeaseState({
      cancelRequested: true,
      expiresAt: currentExpiresAt,
    }),
    renewal: {
      ...renewalValue(),
      expiresAt: "2026-07-28T12:00:59.999Z",
    },
  });
  assert.deepEqual(earlier, {
    cancelRequested: true,
    deadlineAt: "2026-07-28T12:10:00.000Z",
    expiresAt: currentExpiresAt,
    extended: false,
    fence: 7,
    leaseId,
    runId,
  });
  const later = mergeEngineLeaseRenewal({
    current: currentLeaseState({ expiresAt: currentExpiresAt }),
    renewal: {
      ...renewalValue(),
      cancelRequested: true,
      expiresAt: "2026-07-28T12:01:20.000Z",
    },
  });
  assert.equal(later.extended, true);
  assert.equal(later.cancelRequested, true);
  assert.equal(later.expiresAt, "2026-07-28T12:01:20.000Z");
});

test("renewal merge rejects identity switching and deadline extension", () => {
  for (const renewal of [
    { ...renewalValue(), fence: 8 },
    { ...renewalValue(), leaseId: `lse_${"6".repeat(32)}` },
    { ...renewalValue(), runId: `run_${"6".repeat(32)}` },
    {
      ...renewalValue(),
      expiresAt: "2026-07-28T12:10:00.001Z",
    },
  ]) {
    assert.throws(
      () =>
        mergeEngineLeaseRenewal({
          current: currentLeaseState(),
          renewal,
        }),
      EngineLeaseRuntimeContractError,
    );
  }
});

test("renew schedule and cancellation propagation are closed", () => {
  const nowMs = Date.parse("2026-07-28T12:00:00.000Z");
  assert.equal(
    nextEngineLeaseRenewAtMs({
      expiresAt: "2026-07-28T12:01:00.000Z",
      nowMs,
    }),
    nowMs + 20_000,
  );
  assert.equal(
    nextEngineLeaseRenewAtMs({
      expiresAt: "2026-07-28T12:00:10.000Z",
      nowMs,
    }),
    nowMs,
  );
  assert.equal(
    engineLeaseLossHorizonMs("2026-07-28T12:01:00.000Z"),
    nowMs + 60_000,
  );
  assert.equal(
    shouldPropagateEngineCancel({
      cancelSent: false,
      renewal: { ...renewalValue(), cancelRequested: true },
    }),
    true,
  );
  assert.equal(
    shouldPropagateEngineCancel({
      cancelSent: true,
      renewal: { ...renewalValue(), cancelRequested: true },
    }),
    false,
  );
});

test("runtime prestart result is durable without inventing a supervisor", () => {
  const { claimed, starting } = attemptPrefix();
  for (const reason of [
    "engine_incompatible",
    "prompt_unavailable",
    "prompt_erased",
    "prompt_integrity_mismatch",
    "spawn_failed",
  ]) {
    const receipt = createRuntimePrestartReceipt({
      engine: starting.engine,
      engineVersion: starting.engineVersion,
      reason,
      recordedAt: "2026-07-28T12:00:02.000Z",
    });
    assert.equal(receipt.reason, reason);
    assert.equal(receipt.startedAt, receipt.finishedAt);
    const result = createRuntimePrestartResultRecord({
      claimed,
      createdAt: "2026-07-28T12:00:02.000Z",
      reason,
      starting,
    });
    const records = validateAttemptRecordSet({
      claimed,
      result,
      starting,
    });
    assert.ok(records);
    assert.equal(records.supervisor, undefined);
    assert.equal(records.result.receipt.reason, reason);
  }
});

test("spawning is a durable write-ahead boundary before supervisor launch", () => {
  const { claimed, starting } = attemptPrefix();
  const spawning = createSpawningRecord({
    claimed,
    createdAt: "2026-07-28T12:00:02.000Z",
    starting,
  });
  const records = validateAttemptRecordSet({
    claimed,
    spawning,
    starting,
  });
  assert.ok(records);
  assert.deepEqual(attemptRecoveryDecision(records), {
    action: "operator_attention",
    reason: "spawning_window_ambiguous",
    state: "starting",
  });
  assert.equal(SPAWNING_QUIET_HORIZON_MS, 1_860_000);
});

test("spawning blocks abandonment until the enforced quiet horizon", () => {
  const { claimed, starting } = attemptPrefix();
  const spawning = createSpawningRecord({
    claimed,
    createdAt: "2026-07-28T12:00:02.000Z",
    starting,
  });
  const denial = {
    httpStatus: 410,
    observedAt: "2026-07-28T12:31:02.000Z",
    serverError: "lease_expired",
    source: "renew",
  };
  assert.throws(
    () =>
      createPrestartAbandonedRecord({
        claimed,
        createdAt: "2026-07-28T12:31:01.999Z",
        denial: {
          ...denial,
          observedAt: "2026-07-28T12:31:01.999Z",
        },
        spawning,
        starting,
      }),
    EngineLeaseRuntimeContractError,
  );
  const settled = createPrestartAbandonedRecord({
    claimed,
    createdAt: "2026-07-28T12:31:02.000Z",
    denial,
    spawning,
    starting,
  });
  assert.ok(validateAttemptRecordSet({
    claimed,
    settled,
    spawning,
    starting,
  }));
});

test("quiet horizon remains above the frozen supervisor hold maximum", async () => {
  const source = await readFile(
    new URL(
      "../runner/engine-supervisor-child.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    source,
    /const TERMINAL_HOLD_MAX_MS = 1_800_000;/u,
  );
  assert.equal(SPAWNING_QUIET_HORIZON_MS, 1_800_000 + 60_000);
});

test("prestart abandonment persists a closed server-denial attestation", () => {
  const { claimed, starting } = attemptPrefix();
  const claimSettled = createPrestartAbandonedRecord({
    claimed,
    createdAt: "2026-07-28T12:00:01.000Z",
    denial: {
      httpStatus: 409,
      observedAt: "2026-07-28T12:00:01.000Z",
      serverError: "run_unavailable",
      source: "claim",
    },
  });
  const claimedOnly = validateAttemptRecordSet({
    claimed,
    settled: claimSettled,
  });
  assert.ok(claimedOnly);
  assert.equal(Object.isFrozen(claimedOnly.settled.denial), true);
  assert.equal(claimedOnly.settled.operationId, claimed.claimOperationId);

  const renewSettled = createPrestartAbandonedRecord({
    claimed,
    createdAt: "2026-07-28T12:00:02.000Z",
    denial: {
      httpStatus: 410,
      observedAt: "2026-07-28T12:00:02.000Z",
      serverError: "lease_expired",
      source: "renew",
    },
    starting,
  });
  assert.ok(validateAttemptRecordSet({
    claimed,
    settled: renewSettled,
    starting,
  }));
});

test("prestart settlement cannot be fabricated from clock or wrong source", () => {
  const { claimed, starting } = attemptPrefix();
  for (const value of [
    {
      claimed,
      createdAt: "2026-07-28T12:00:02.000Z",
      denial: {
        httpStatus: 410,
        observedAt: "2026-07-28T12:00:02.000Z",
        serverError: "lease_expired",
        source: "claim",
      },
    },
    {
      claimed,
      createdAt: "2026-07-28T12:00:02.000Z",
      denial: {
        httpStatus: 409,
        observedAt: "2026-07-28T12:00:02.000Z",
        serverError: "engine_deadline_insufficient",
        source: "renew",
      },
      starting,
    },
    {
      claimed,
      createdAt: "2026-07-28T12:00:02.000Z",
      denial: {
        httpStatus: 403,
        observedAt: "2026-07-28T12:00:02.000Z",
        serverError: "runner_rejected",
        source: "renew",
      },
      starting,
    },
    {
      claimed,
      createdAt: "2026-07-28T12:00:02.000Z",
      denial: {
        httpStatus: 409,
        observedAt: "2026-07-28T12:00:02.000Z",
        serverError: "run_unavailable",
        source: "toString",
      },
    },
    {
      claimed,
      createdAt: "2026-07-28T12:00:02.000Z",
      denial: {
        httpStatus: 409,
        observedAt: "2026-07-28T11:59:59.999Z",
        serverError: "run_unavailable",
        source: "claim",
      },
    },
    {
      claimed,
      createdAt: "2026-07-28T12:00:02.000Z",
      denial: {
        httpStatus: 409,
        observedAt: "2026-07-28T12:00:02.001Z",
        serverError: "run_unavailable",
        source: "claim",
      },
    },
  ]) {
    assert.throws(
      () => createPrestartAbandonedRecord(value),
      EngineLeaseRuntimeContractError,
    );
  }
});

test("hostile records fail through the closed contract error", () => {
  const hostile = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("private");
    },
  });
  assert.throws(
    () => createEngineLeaseRenewIntent(hostile),
    EngineLeaseRuntimeContractError,
  );
  assert.throws(
    () => createRuntimePrestartReceipt({
      engine: "claude_code_cli",
      engineVersion: "1.0.0",
      get reason() {
        throw new Error("private");
      },
      recordedAt: "2026-07-28T12:00:02.000Z",
    }),
    EngineLeaseRuntimeContractError,
  );
});

function attemptPrefix() {
  const claimed = createClaimedRecord({
    attemptId,
    createdAt: "2026-07-28T12:00:00.000Z",
    engine: "claude_code_cli",
    runId,
  });
  const starting = createStartingRecord({
    claimed,
    createdAt: "2026-07-28T12:00:01.000Z",
    descriptor: {
      cancelRequested: false,
      expiresAt: "2026-07-28T12:01:00.000Z",
      fence: 7,
      job: {
        deadlineAt: "2026-07-28T12:10:00.000Z",
        engine: "claude_code_cli",
        engineVersion: "1.0.0",
        outputBounds: {
          stderrBytes: 65_536,
          stdoutBytes: 262_144,
        },
        promptBytes: 7,
        promptRef: `prm_${"3".repeat(32)}`,
        promptSha256: "4".repeat(64),
        timeoutMs: 600_000,
      },
      leaseId,
      runId,
    },
  });
  return { claimed, starting };
}

function renewalValue() {
  return {
    cancelRequested: false,
    expiresAt: "2026-07-28T12:01:00.000Z",
    fence: 7,
    leaseId,
    runId,
  };
}

function currentLeaseState(overrides = {}) {
  return {
    cancelRequested: false,
    deadlineAt: "2026-07-28T12:10:00.000Z",
    expiresAt: "2026-07-28T12:01:00.000Z",
    fence: 7,
    leaseId,
    runId,
    ...overrides,
  };
}
