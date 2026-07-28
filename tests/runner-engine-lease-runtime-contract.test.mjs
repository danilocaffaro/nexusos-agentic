import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  EngineLeaseRuntimeContractError,
  createEngineLeaseRenewBody,
  createEngineLeaseRenewIntent,
  createPrestartCancelingRecord,
  createPrestartAbandonedRecord,
  createPrestartRejectedRecord,
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
  ENGINE_COMPLETION_MAX_BYTES,
} from "../runner/engine-complete-contract.mjs";
import {
  SPAWNING_QUIET_HORIZON_MS,
  attemptRecoveryDecision,
  finalizeAttemptRecord,
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
  for (const reason of [
    "cancel_requested",
    "engine_incompatible",
    "prompt_unavailable",
    "prompt_erased",
    "prompt_integrity_mismatch",
    "spawn_failed",
  ]) {
    const { claimed, starting } = attemptPrefix({
      cancelRequested: reason === "cancel_requested",
    });
    const receipt = createRuntimePrestartReceipt({
      engine: starting.engine,
      engineVersion: starting.engineVersion,
      reason,
      recordedAt: "2026-07-28T12:00:02.000Z",
    });
    assert.equal(receipt.reason, reason);
    assert.equal(receipt.startedAt, receipt.finishedAt);
    assert.equal(
      receipt.status,
      reason === "cancel_requested" ? "canceled" : "failed",
    );
    assert.equal(
      receipt.cancelRequested,
      reason === "cancel_requested",
    );
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
  const { claimed, starting } = attemptPrefix();
  assert.throws(
    () =>
      createRuntimePrestartResultRecord({
        claimed,
        createdAt: "2026-07-28T12:00:02.000Z",
        reason: "cancel_requested",
        starting,
      }),
    EngineLeaseRuntimeContractError,
  );
});

test("renew cancellation is durably witnessed before a prestart result", () => {
  const { claimed, starting } = attemptPrefix();
  const renewal = {
    ...renewalValue(),
    cancelRequested: true,
  };
  const canceling = createPrestartCancelingRecord({
    claimed,
    createdAt: "2026-07-28T12:00:02.000Z",
    observedAt: "2026-07-28T12:00:01.500Z",
    renewal,
    starting,
  });
  assert.equal(Object.isFrozen(canceling), true);
  assert.equal(Object.isFrozen(canceling.renewal), true);
  assert.deepEqual(
    attemptRecoveryDecision({ canceling, claimed, starting }),
    {
      action: "complete_prestart_cancel",
      state: "canceling",
    },
  );
  const result = createRuntimePrestartResultRecord({
    canceling,
    claimed,
    createdAt: "2026-07-28T12:00:02.500Z",
    reason: "cancel_requested",
    starting,
  });
  const records = validateAttemptRecordSet({
    canceling,
    claimed,
    result,
    starting,
  });
  assert.ok(records);
  assert.equal(records.starting.cancelRequested, false);
  assert.equal(records.result.receipt.status, "canceled");
  assert.deepEqual(attemptRecoveryDecision(records), {
    action: "persist_completion",
    state: "result",
  });
  assert.throws(
    () =>
      createRuntimePrestartResultRecord({
        canceling,
        claimed,
        createdAt: "2026-07-28T12:00:02.500Z",
        reason: "spawn_failed",
        starting,
      }),
    EngineLeaseRuntimeContractError,
  );
});

test("canceling and spawning are mutually exclusive under the journal contract", () => {
  const { claimed, starting } = attemptPrefix();
  const canceling = createPrestartCancelingRecord({
    claimed,
    createdAt: "2026-07-28T12:00:02.000Z",
    observedAt: "2026-07-28T12:00:01.500Z",
    renewal: { ...renewalValue(), cancelRequested: true },
    starting,
  });
  const spawning = createSpawningRecord({
    claimed,
    createdAt: "2026-07-28T12:00:02.000Z",
    starting,
  });
  assert.equal(
    validateAttemptRecordSet({ canceling, claimed, spawning, starting }),
    undefined,
  );
  assert.throws(
    () =>
      createRuntimePrestartResultRecord({
        canceling,
        claimed,
        createdAt: "2026-07-28T12:00:02.500Z",
        reason: "cancel_requested",
        spawning,
        starting,
      }),
    EngineLeaseRuntimeContractError,
  );
});

test("prestart cancel evidence rejects forged identity, time and authority", () => {
  const { claimed, starting } = attemptPrefix();
  const valid = {
    claimed,
    createdAt: "2026-07-28T12:00:02.000Z",
    observedAt: "2026-07-28T12:00:01.500Z",
    renewal: { ...renewalValue(), cancelRequested: true },
    starting,
  };
  for (const forged of [
    {
      ...valid,
      renewal: { ...valid.renewal, cancelRequested: false },
    },
    {
      ...valid,
      renewal: { ...valid.renewal, fence: 8 },
    },
    {
      ...valid,
      renewal: {
        ...valid.renewal,
        leaseId: `lse_${"6".repeat(32)}`,
      },
    },
    {
      ...valid,
      renewal: {
        ...valid.renewal,
        runId: `run_${"6".repeat(32)}`,
      },
    },
    {
      ...valid,
      renewal: {
        ...valid.renewal,
        expiresAt: "2026-07-28T12:10:00.001Z",
      },
    },
    {
      ...valid,
      observedAt: "2026-07-28T12:00:00.999Z",
    },
    {
      ...valid,
      createdAt: "2026-07-28T12:00:01.499Z",
    },
  ]) {
    assert.throws(
      () => createPrestartCancelingRecord(forged),
      EngineLeaseRuntimeContractError,
    );
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

  for (const [httpStatus, serverError] of [
    [409, "lease_superseded"],
    [409, "run_unavailable"],
    [410, "lease_expired"],
  ]) {
    const promptSettled = createPrestartAbandonedRecord({
      claimed,
      createdAt: "2026-07-28T12:00:02.000Z",
      denial: {
        httpStatus,
        observedAt: "2026-07-28T12:00:02.000Z",
        serverError,
        source: "prompt",
      },
      starting,
    });
    assert.ok(validateAttemptRecordSet({
      claimed,
      settled: promptSettled,
      starting,
    }));
  }
});

test("local descriptor rejection is terminal, bound and frozen", () => {
  const { claimed } = attemptPrefix();
  const expired = descriptorValue({
    expiresAt: "2026-07-28T12:00:00.999Z",
  });
  const settled = createPrestartRejectedRecord({
    claimed,
    createdAt: "2026-07-28T12:00:01.000Z",
    descriptor: expired,
    observedAt: "2026-07-28T12:00:01.000Z",
    reason: "lease_expired",
  });
  const records = validateAttemptRecordSet({ claimed, settled });
  assert.ok(records);
  assert.equal(Object.isFrozen(records.settled.rejection), true);
  assert.equal(
    Object.isFrozen(records.settled.rejection.descriptor),
    true,
  );
  assert.equal(records.settled.rejection.reason, "lease_expired");
  assert.deepEqual(records.settled.rejection.descriptor, expired);
  assert.deepEqual(attemptRecoveryDecision(records), {
    action: "settled",
    outcome: "abandoned",
    rejection: records.settled.rejection,
    state: "settled",
  });

  for (const value of [
    {
      descriptor: expired,
      reason: "cancel_requested",
    },
    {
      descriptor: descriptorValue(),
      reason: "engine_deadline_insufficient",
    },
    {
      descriptor: descriptorValue({
        runId: `run_${"9".repeat(32)}`,
      }),
      reason: "lease_expired",
    },
    {
      descriptor: descriptorValue({ cancelRequested: true }),
      reason: "cancel_requested",
    },
  ]) {
    assert.throws(
      () =>
        createPrestartRejectedRecord({
          claimed,
          createdAt: "2026-07-28T12:00:01.000Z",
          observedAt: "2026-07-28T12:00:01.000Z",
          ...value,
        }),
      EngineLeaseRuntimeContractError,
    );
  }
});

test("local rejection precedence is closed across expiry, cancel and budget", () => {
  const { claimed } = attemptPrefix();
  const createdAt = "2026-07-28T12:00:01.000Z";
  const insufficientJob = {
    deadlineAt: "2026-07-28T12:04:30.999Z",
  };
  const scenarios = [
    {
      cancelRequested: false,
      expiresAt: "2026-07-28T12:00:01.000Z",
      expected: "lease_expired",
      job: {},
    },
    {
      cancelRequested: true,
      expiresAt: "2026-07-28T12:00:01.000Z",
      expected: "lease_expired",
      job: {},
    },
    {
      cancelRequested: false,
      expiresAt: "2026-07-28T12:00:01.000Z",
      expected: "lease_expired",
      job: insufficientJob,
    },
    {
      cancelRequested: true,
      expiresAt: "2026-07-28T12:00:01.000Z",
      expected: "lease_expired",
      job: insufficientJob,
    },
    {
      cancelRequested: false,
      expiresAt: "2026-07-28T12:01:00.000Z",
      expected: "engine_deadline_insufficient",
      job: insufficientJob,
    },
    {
      cancelRequested: true,
      expiresAt: "2026-07-28T12:01:00.000Z",
      expected: "engine_deadline_insufficient",
      job: insufficientJob,
    },
    {
      cancelRequested: false,
      expiresAt: "2026-07-28T12:01:00.000Z",
      expected: undefined,
      job: {},
    },
    {
      cancelRequested: true,
      expiresAt: "2026-07-28T12:01:00.000Z",
      expected: undefined,
      job: {},
    },
  ];
  for (const scenario of scenarios) {
    const descriptor = descriptorValue({
      cancelRequested: scenario.cancelRequested,
      expiresAt: scenario.expiresAt,
      job: scenario.job,
    });
    if (scenario.expected) {
      const settled = createPrestartRejectedRecord({
        claimed,
        createdAt,
        descriptor,
        observedAt: createdAt,
        reason: scenario.expected,
      });
      assert.equal(
        settled.rejection.reason,
        scenario.expected,
      );
      continue;
    }
    for (const reason of [
      "lease_expired",
      "engine_deadline_insufficient",
      "cancel_requested",
    ]) {
      assert.throws(
        () =>
          createPrestartRejectedRecord({
            claimed,
            createdAt,
            descriptor,
            observedAt: createdAt,
            reason,
          }),
        EngineLeaseRuntimeContractError,
      );
    }
  }
});

test("prestart rejection is bound to observation across persistence delay", () => {
  const { claimed } = attemptPrefix();
  const observedAt = "2026-07-28T12:00:01.000Z";
  const createdAt = "2026-07-28T12:01:00.001Z";
  const insufficient = descriptorValue({
    expiresAt: "2026-07-28T12:01:00.000Z",
    job: {
      deadlineAt: "2026-07-28T12:04:30.999Z",
    },
  });
  const settled = createPrestartRejectedRecord({
    claimed,
    createdAt,
    descriptor: insufficient,
    observedAt,
    reason: "engine_deadline_insufficient",
  });
  assert.equal(
    settled.rejection.reason,
    "engine_deadline_insufficient",
  );
  assert.equal(settled.rejection.observedAt, observedAt);
  assert.throws(
    () =>
      createPrestartRejectedRecord({
        claimed,
        createdAt,
        descriptor: insufficient,
        observedAt,
        reason: "lease_expired",
      }),
    EngineLeaseRuntimeContractError,
  );

  const acceptedAtObservation = descriptorValue({
    expiresAt: "2026-07-28T12:01:00.000Z",
  });
  for (const reason of [
    "lease_expired",
    "engine_deadline_insufficient",
  ]) {
    assert.throws(
      () =>
        createPrestartRejectedRecord({
          claimed,
          createdAt,
          descriptor: acceptedAtObservation,
          observedAt,
          reason,
        }),
      EngineLeaseRuntimeContractError,
    );
  }
});

test("forged local rejection evidence fails semantic and claim correlation", () => {
  const { claimed } = attemptPrefix();
  const createdAt = "2026-07-28T12:00:01.000Z";
  const valid = createPrestartRejectedRecord({
    claimed,
    createdAt,
    descriptor: descriptorValue({
      expiresAt: "2026-07-28T12:00:01.000Z",
    }),
    observedAt: createdAt,
    reason: "lease_expired",
  });
  const rejection = valid.rejection;
  const forgeries = [
    {
      ...rejection,
      descriptor: descriptorValue({
        expiresAt: "2026-07-28T12:01:00.000Z",
      }),
    },
    {
      ...rejection,
      descriptor: descriptorValue({
        expiresAt: "2026-07-28T12:01:00.000Z",
        job: {
          deadlineAt: "2026-07-28T12:04:30.999Z",
        },
      }),
      reason: "lease_expired",
    },
    {
      ...rejection,
      descriptor: descriptorValue({
        expiresAt: "2026-07-28T12:00:01.000Z",
        runId: `run_${"9".repeat(32)}`,
      }),
    },
    {
      ...rejection,
      descriptor: descriptorValue({
        expiresAt: "2026-07-28T12:00:01.000Z",
        job: { engine: "codex_cli" },
      }),
    },
  ];
  for (const forged of forgeries) {
    let settled;
    try {
      const unsigned = { ...valid, rejection: forged };
      delete unsigned.recordSha256;
      settled = finalizeAttemptRecord(unsigned);
    } catch {
      continue;
    }
    assert.equal(
      validateAttemptRecordSet({
        claimed,
        settled,
      }),
      undefined,
    );
  }
});

test("accepted cancellation converges through result and bounded completion", () => {
  const claimed = createClaimedRecord({
    attemptId,
    createdAt: "2026-07-28T12:00:00.000Z",
    engine: "claude_code_cli",
    runId,
  });
  const descriptor = descriptorValue({ cancelRequested: true });
  const starting = createStartingRecord({
    claimed,
    createdAt: "2026-07-28T12:00:01.000Z",
    descriptor,
    effectiveTimeoutMs: 569_000,
  });
  const result = createRuntimePrestartResultRecord({
    claimed,
    createdAt: "2026-07-28T12:00:02.000Z",
    reason: "cancel_requested",
    starting,
  });
  const records = validateAttemptRecordSet({
    claimed,
    result,
    starting,
  });
  assert.ok(records);
  assert.equal(records.starting.cancelRequested, true);
  assert.equal(records.result.receipt.status, "canceled");
  assert.equal(records.result.receipt.cancelRequested, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify({
      fence: starting.fence,
      leaseId: starting.leaseId,
      operationId: `op_${"8".repeat(32)}`,
      receipt: result.receipt,
    })) <= ENGINE_COMPLETION_MAX_BYTES,
  );

  const insufficient = descriptorValue({
    cancelRequested: true,
    job: {
      deadlineAt: "2026-07-28T12:04:30.999Z",
    },
  });
  assert.throws(
    () =>
      createStartingRecord({
        claimed,
        createdAt: "2026-07-28T12:00:01.000Z",
        descriptor: insufficient,
        effectiveTimeoutMs: 270_000,
      }),
    /Claim and lease descriptor do not correlate/u,
  );
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
        httpStatus: 404,
        observedAt: "2026-07-28T12:00:02.000Z",
        serverError: "prompt_unavailable",
        source: "prompt",
      },
      starting,
    },
    {
      claimed,
      createdAt: "2026-07-28T12:31:02.000Z",
      denial: {
        httpStatus: 410,
        observedAt: "2026-07-28T12:31:02.000Z",
        serverError: "lease_expired",
        source: "prompt",
      },
      spawning: createSpawningRecord({
        claimed,
        createdAt: "2026-07-28T12:00:02.000Z",
        starting,
      }),
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

function attemptPrefix(descriptorOverrides = {}) {
  const claimed = createClaimedRecord({
    attemptId,
    createdAt: "2026-07-28T12:00:00.000Z",
    engine: "claude_code_cli",
    runId,
  });
  const starting = createStartingRecord({
    claimed,
    createdAt: "2026-07-28T12:00:01.000Z",
    descriptor: descriptorValue(descriptorOverrides),
    effectiveTimeoutMs: 569_000,
  });
  return { claimed, starting };
}

function descriptorValue(overrides = {}) {
  const base = {
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
  };
  return {
    ...base,
    ...overrides,
    job: { ...base.job, ...(overrides.job ?? {}) },
  };
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
