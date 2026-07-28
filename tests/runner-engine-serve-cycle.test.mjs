import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  finalizeAttemptRecord,
  parseAttemptRecordText,
} from "../runner/attempt-journal-contract.mjs";
import {
  ATTEMPT_JOURNAL_DIRECTORY,
  persistAttemptRecord,
  recoverAttemptJournals,
} from "../runner/attempt-journal-store.mjs";
import {
  abortEngineAttemptRecoveryHeld,
  completeEngineAttemptRecoveryHeld,
  deriveEngineCompletionOperationId,
  finalizeEngineCompletionEffectHeld,
  prepareEngineAttemptRecoveryHeld,
} from "../runner/engine-attempt-coordinator.mjs";
import {
  createEngineServeCycleState,
  reduceEngineServeCycle,
  runEngineRecoveryCycle,
} from "../runner/engine-serve-cycle.mjs";
import {
  acquireOutboxLock,
  persistDeclarationOperation,
  recoverOutbox,
  transitionOperation,
  withOutboxLockOwnership,
} from "../runner/durable-outbox.mjs";
import {
  finalizeOutboxEntry,
  OUTBOX_V3_DIRECTORY,
} from "../runner/outbox-contract.mjs";

test("serve lifecycle models stop and one-shot release failure explicitly", () => {
  const boot = createEngineServeCycleState();
  const recover = reduceEngineServeCycle(boot, { type: "start" });
  const steady = reduceEngineServeCycle(recover, { type: "recovered" });
  const next = reduceEngineServeCycle(steady, { type: "cycle_due" });
  const draining = reduceEngineServeCycle(
    next,
    { type: "stop_requested" },
  );
  assert.equal(
    reduceEngineServeCycle(draining, { type: "stop_requested" }),
    draining,
  );
  assert.deepEqual(
    reduceEngineServeCycle(draining, { type: "release_failed" }),
    {
      phase: "STOPPED",
      releaseDisposition: "stale_possible",
      retryRelease: false,
      stopReason: "lock_release_failed",
    },
  );
  assert.deepEqual(
    reduceEngineServeCycle(
      recover,
      { type: "durable_auth_rejected" },
    ),
    {
      phase: "PERMANENT_STOP",
      releaseDisposition: "retained",
      retryRelease: false,
      stopReason: "durable_auth_rejected",
    },
  );
  assert.throws(
    () => reduceEngineServeCycle(boot, { type: "release_succeeded" }),
    /transition is invalid/u,
  );
  assert.throws(
    () => reduceEngineServeCycle(
      { ...recover, stopReason: "forged" },
      { type: "recovered" },
    ),
    /state is invalid/u,
  );
  assert.throws(
    () => reduceEngineServeCycle(
      { ...recover, [Symbol("hidden")]: true },
      { type: "recovered" },
    ),
    /state is invalid/u,
  );
});

test("completion effect receives no lock capability and finalizes after a fresh borrow", async (t) => {
  const stateDir = await temporaryState(t, "nexus-serve-effect-");
  await seedGeneratedJournal(stateDir, 1);
  const release = await acquireOutboxLock(stateDir);
  let yields = 0;
  const result = await runEngineRecoveryCycle({
    completionContext: Object.freeze({ audience: "dark" }),
    async performCompletionEffect(envelope) {
      assert.deepEqual(Object.keys(envelope), [
        "completionContext",
        "intent",
      ]);
      assert.equal("stateDir" in envelope, false);
      assert.equal("ownershipCapability" in envelope, false);
      assert.deepEqual(Object.keys(envelope.intent.request), [
        "bodyBase64Url",
        "bodySha256",
        "pathname",
        "signatureDomain",
      ]);
      const requestBody = Buffer.from(
        envelope.intent.request.bodyBase64Url,
        "base64url",
      );
      assert.equal(
        createHash("sha256").update(requestBody).digest("hex"),
        envelope.intent.request.bodySha256,
      );
      assert.equal(
        envelope.intent.request.pathname,
        `/api/runs/${envelope.intent.runId}/engine-complete`,
      );
      assert.equal(
        envelope.intent.request.signatureDomain,
        "nexus-runner-engine-complete-v1",
      );
      assert.equal(
        await withOutboxLockOwnership(
          stateDir,
          release,
          () => "free",
        ),
        "free",
      );
      const body = Buffer.from(JSON.stringify({
        late: false,
        recordedAt: "2026-07-27T12:00:10.000Z",
        runId: envelope.intent.runId,
        status: "completed",
      }));
      return {
        bodyBase64Url: body.toString("base64url"),
        httpStatus: 200,
        kind: "response",
        operationId: envelope.intent.operationId,
        replay: false,
        runId: envelope.intent.runId,
      };
    },
    stateDir,
    yieldControl() {
      yields += 1;
    },
  }, release);
  assert.equal(yields, 1);
  assert.equal(result.state.phase, "STEADY");
  assert.equal(result.outcomes[0].kind, "delivered");
  assert.equal(result.report.permanentStop, false);
  const [terminal] = await recoverOutbox(stateDir);
  const acknowledgementBody = Buffer.from(JSON.stringify({
    late: false,
    recordedAt: "2026-07-27T12:00:10.000Z",
    runId: terminal.runId,
    status: "completed",
  }));
  assert.equal(terminal.status, "acked");
  assert.equal(terminal.responseStatus, 200);
  assert.equal(
    terminal.responseSha256,
    createHash("sha256").update(acknowledgementBody).digest("hex"),
  );
  assert.equal(
    (await recoverAttemptJournals(stateDir))[0].records.settled.outcome,
    "acked",
  );
  await release();
});

test("oversized and accessor effect envelopes become protocol halts without a borrow", async (t) => {
  const stateDir = await temporaryState(t, "nexus-serve-hostile-effect-");
  await seedGeneratedJournal(stateDir, 1);
  const release = await acquireOutboxLock(stateDir);
  let accessorReads = 0;
  const accessorResult = await runEngineRecoveryCycle({
    async performCompletionEffect({ intent }) {
      return Object.defineProperties({}, {
        bodyBase64Url: {
          enumerable: true,
          get() {
            accessorReads += 1;
            return "eA";
          },
        },
        httpStatus: { enumerable: true, value: 200 },
        kind: { enumerable: true, value: "response" },
        operationId: {
          enumerable: true,
          value: intent.operationId,
        },
        replay: { enumerable: true, value: false },
        runId: { enumerable: true, value: intent.runId },
      });
    },
    stateDir,
  }, release);
  assert.equal(accessorReads, 0);
  assert.equal(accessorResult.outcomes[0].code, "protocol");
  const oversized = await runEngineRecoveryCycle({
    async performCompletionEffect({ intent }) {
      return {
        bodyBase64Url: "A".repeat(90_000),
        httpStatus: 200,
        kind: "response",
        operationId: intent.operationId,
        replay: false,
        runId: intent.runId,
      };
    },
    stateDir,
  }, release);
  assert.equal(oversized.outcomes[0].code, "protocol");
  const recovered = await runEngineRecoveryCycle({
    performCompletionEffect() {
      throw new Error("transport unavailable");
    },
    stateDir,
  }, release);
  assert.equal(recovered.outcomes[0].code, "retryable");
  assert.equal(recovered.report.permanentStop, false);
  await release();
});

test("effect-time outbox corruption is quarantined and returned as protocol evidence", async (t) => {
  const stateDir = await temporaryState(t, "nexus-serve-corrupt-");
  await seedGeneratedJournal(stateDir, 1);
  const release = await acquireOutboxLock(stateDir);
  const result = await runEngineRecoveryCycle({
    async performCompletionEffect({ intent }) {
      await withOutboxLockOwnership(
        stateDir,
        release,
        () => writeFile(
          join(
            stateDir,
            OUTBOX_V3_DIRECTORY,
            `${intent.operationId}.json`,
          ),
          "{}\n",
          { mode: 0o600 },
        ),
      );
      return {
        kind: "transport_error",
        operationId: intent.operationId,
        runId: intent.runId,
      };
    },
    stateDir,
  }, release);
  assert.equal(result.outcomes[0].code, "protocol");
  assert.equal(result.report.corrupt.outbox.length, 1);
  assert.equal(
    result.report.attempts[0].status,
    "operator_attention",
  );
  assert.deepEqual(await recoverOutbox(stateDir), []);
  await release();
});

test("one-shot plans reject duplicate, forged, crossed, captured and post-halt use", async (t) => {
  await t.test("duplicate finalize", async (t) => {
    const stateDir = await temporaryState(t, "nexus-plan-duplicate-");
    await seedGeneratedJournal(stateDir, 1);
    const release = await acquireOutboxLock(stateDir);
    const plan = await prepareEngineAttemptRecoveryHeld(
      { stateDir },
      release,
    );
    const effect = successfulEffect(plan.intents[0]);
    await finalizeEngineCompletionEffectHeld(
      {
        effect,
        intent: plan.intents[0],
        plan,
        stateDir,
      },
      release,
    );
    await assert.rejects(
      finalizeEngineCompletionEffectHeld(
        {
          effect,
          intent: plan.intents[0],
          plan,
          stateDir,
        },
        release,
      ),
      /already finalized/u,
    );
    await completeEngineAttemptRecoveryHeld(
      { plan, stateDir },
      release,
    );
    assert.equal((await recoverOutbox(stateDir)).length, 1);
    await release();
  });

  await t.test("forged intent", async (t) => {
    const stateDir = await temporaryState(t, "nexus-plan-forged-");
    await seedGeneratedJournal(stateDir, 1);
    const release = await acquireOutboxLock(stateDir);
    const plan = await prepareEngineAttemptRecoveryHeld(
      { stateDir },
      release,
    );
    const forged = Object.freeze({
      ...plan.intents[0],
      expectedEntrySha256: "0".repeat(64),
    });
    await assert.rejects(
      finalizeEngineCompletionEffectHeld(
        {
          effect: successfulEffect(plan.intents[0]),
          intent: forged,
          plan,
          stateDir,
        },
        release,
      ),
      /Recovery intent is invalid/u,
    );
    await abortEngineAttemptRecoveryHeld(
      { plan, stateDir },
      release,
    );
    await release();
  });

  await t.test("crossed state and capability", async (t) => {
    const stateDir = await temporaryState(t, "nexus-plan-origin-");
    const otherStateDir = await temporaryState(t, "nexus-plan-cross-");
    await seedGeneratedJournal(stateDir, 1);
    const release = await acquireOutboxLock(stateDir);
    const otherRelease = await acquireOutboxLock(otherStateDir);
    const plan = await prepareEngineAttemptRecoveryHeld(
      { stateDir },
      release,
    );
    await assert.rejects(
      completeEngineAttemptRecoveryHeld(
        { plan, stateDir: otherStateDir },
        otherRelease,
      ),
      /Recovery plan is invalid/u,
    );
    await abortEngineAttemptRecoveryHeld(
      { plan, stateDir },
      release,
    );
    await otherRelease();
    await release();
  });

  await t.test("future prune time", async (t) => {
    const stateDir = await temporaryState(t, "nexus-plan-clock-");
    const release = await acquireOutboxLock(stateDir);
    const plan = await prepareEngineAttemptRecoveryHeld(
      { stateDir },
      release,
    );
    await assert.rejects(
      completeEngineAttemptRecoveryHeld(
        {
          plan,
          pruneNowMs: Date.now() + 60_000,
          stateDir,
        },
        release,
      ),
      /prune time is invalid/u,
    );
    await abortEngineAttemptRecoveryHeld(
      { plan, stateDir },
      release,
    );
    await release();
  });

  await t.test("captured but not finalized", async (t) => {
    const stateDir = await temporaryState(t, "nexus-plan-captured-");
    await seedGeneratedJournal(stateDir, 1);
    const release = await acquireOutboxLock(stateDir);
    const plan = await prepareEngineAttemptRecoveryHeld(
      { stateDir },
      release,
    );
    await withOutboxLockOwnership(
      stateDir,
      release,
      async () => {
        const [entry] = await recoverOutbox(stateDir);
        await transitionOperation(stateDir, entry, "abandoned");
      },
    );
    await assert.rejects(
      finalizeEngineCompletionEffectHeld(
        {
          effect: {
            kind: "transport_error",
            operationId: plan.intents[0].operationId,
            runId: plan.intents[0].runId,
          },
          intent: plan.intents[0],
          plan,
          stateDir,
        },
        release,
      ),
      /no longer matches durable state/u,
    );
    await assert.rejects(
      completeEngineAttemptRecoveryHeld(
        { plan, stateDir },
        release,
      ),
      /effect is not finalized/u,
    );
    await abortEngineAttemptRecoveryHeld(
      { plan, stateDir },
      release,
    );
    await release();
  });

  await t.test("post-halt finalize", async (t) => {
    const stateDir = await temporaryState(t, "nexus-plan-halt-");
    await seedGeneratedJournal(stateDir, 1);
    const release = await acquireOutboxLock(stateDir);
    const plan = await prepareEngineAttemptRecoveryHeld(
      { stateDir },
      release,
    );
    const effect = {
      kind: "transport_error",
      operationId: plan.intents[0].operationId,
      runId: plan.intents[0].runId,
    };
    await finalizeEngineCompletionEffectHeld(
      {
        effect,
        intent: plan.intents[0],
        plan,
        stateDir,
      },
      release,
    );
    await assert.rejects(
      finalizeEngineCompletionEffectHeld(
        {
          effect,
          intent: plan.intents[0],
          plan,
          stateDir,
        },
        release,
      ),
      /Recovery plan is halted/u,
    );
    await completeEngineAttemptRecoveryHeld(
      { plan, stateDir },
      release,
    );
    await release();
  });
});

test("a cycle serves at most sixteen effects fairly and leaves the sibling pending", async (t) => {
  const stateDir = await temporaryState(t, "nexus-serve-bounded-");
  for (let index = 1; index <= 17; index += 1) {
    await seedGeneratedJournal(stateDir, index);
  }
  const release = await acquireOutboxLock(stateDir);
  const observed = [];
  let yields = 0;
  const result = await runEngineRecoveryCycle({
    async performCompletionEffect({ intent }) {
      observed.push(intent.operationId);
      const body = Buffer.from(
        '{"error":"engine_deadline_exhausted"}',
      );
      return {
        bodyBase64Url: body.toString("base64url"),
        httpStatus: 409,
        kind: "response",
        operationId: intent.operationId,
        replay: false,
        runId: intent.runId,
      };
    },
    stateDir,
    yieldControl() {
      yields += 1;
    },
  }, release);
  assert.equal(observed.length, 16);
  assert.equal(new Set(observed).size, 16);
  assert.equal(yields, 16);
  assert.equal(result.report.deferredDeliveries, 1);
  assert.equal(
    (await recoverOutbox(stateDir)).filter(
      (entry) => entry.status === "pending",
    ).length,
    1,
  );
  await release();
});

test("only a durably adopted authentication rejection stops permanently", async (t) => {
  const stateDir = await temporaryState(t, "nexus-serve-auth-");
  await seedGeneratedJournal(stateDir, 1);
  const release = await acquireOutboxLock(stateDir);
  const result = await runEngineRecoveryCycle({
    async performCompletionEffect({ intent }) {
      const body = Buffer.from('{"error":"runner_rejected"}');
      return {
        bodyBase64Url: body.toString("base64url"),
        httpStatus: 403,
        kind: "response",
        operationId: intent.operationId,
        replay: false,
        runId: intent.runId,
      };
    },
    stateDir,
  }, release);
  assert.equal(result.state.phase, "PERMANENT_STOP");
  assert.equal(result.report.permanentStop, true);
  const [terminal] = await recoverOutbox(stateDir);
  assert.equal(terminal.status, "rejected");
  assert.equal(terminal.responseStatus, 403);
  assert.equal(
    terminal.responseSha256,
    createHash("sha256")
      .update(Buffer.from('{"error":"runner_rejected"}'))
      .digest("hex"),
  );
  assert.equal(
    (await recoverAttemptJournals(stateDir))[0].records.settled.outcome,
    "rejected",
  );
  await release();
});

test("protocol and retryable responses halt without creating terminal truth", async (t) => {
  for (const scenario of [
    {
      body: "{}",
      code: "protocol",
      httpStatus: 200,
      prefix: "protocol",
    },
    {
      body: '{"error":"runner_rejected"}',
      code: "retryable",
      httpStatus: 500,
      prefix: "retryable",
    },
  ]) {
    await t.test(scenario.prefix, async (t) => {
      const stateDir = await temporaryState(
        t,
        `nexus-serve-${scenario.prefix}-`,
      );
      await seedGeneratedJournal(stateDir, 1);
      const release = await acquireOutboxLock(stateDir);
      const result = await runEngineRecoveryCycle({
        async performCompletionEffect({ intent }) {
          return {
            bodyBase64Url: Buffer.from(scenario.body).toString(
              "base64url",
            ),
            httpStatus: scenario.httpStatus,
            kind: "response",
            operationId: intent.operationId,
            replay: false,
            runId: intent.runId,
          };
        },
        stateDir,
      }, release);
      assert.equal(result.outcomes[0].code, scenario.code);
      assert.equal(result.report.permanentStop, false);
      assert.equal((await recoverOutbox(stateDir))[0].status, "pending");
      assert.equal(
        (await recoverAttemptJournals(stateDir))[0].records.settled,
        undefined,
      );
      await release();
    });
  }
});

test("fresh-borrow revalidation rejects a stale prepared entry", async (t) => {
  const stateDir = await temporaryState(t, "nexus-serve-stale-");
  await seedGeneratedJournal(stateDir, 1);
  const release = await acquireOutboxLock(stateDir);
  await assert.rejects(
    runEngineRecoveryCycle({
      async performCompletionEffect({ intent }) {
        await withOutboxLockOwnership(
          stateDir,
          release,
          async () => {
            const [entry] = (await recoverOutbox(stateDir)).filter(
              (candidate) =>
                candidate.operationId === intent.operationId,
            );
            await transitionOperation(
              stateDir,
              entry,
              "abandoned",
            );
          },
        );
        return {
          kind: "transport_error",
          operationId: intent.operationId,
          runId: intent.runId,
        };
      },
      stateDir,
    }, release),
    /no longer matches durable state/u,
  );
  let effects = 0;
  const recovered = await runEngineRecoveryCycle({
    performCompletionEffect() {
      effects += 1;
    },
    stateDir,
  }, release);
  assert.equal(effects, 0);
  assert.equal(recovered.report.attempts[0].status, "operator_attention");
  assert.equal(
    (await recoverAttemptJournals(stateDir))[0].records.settled.outcome,
    "abandoned",
  );
  await release();
});

test("terminal pruning waits until every recovered attempt has entered the bounded window", async (t) => {
  const stateDir = await temporaryState(t, "nexus-serve-prune-backlog-");
  let deferredRecords;
  for (let index = 1; index <= 33; index += 1) {
    const records = await seedGeneratedJournal(stateDir, index);
    if (index === 33) deferredRecords = records;
  }
  const deferredOperationId = await seedTerminalCompletion(
    stateDir,
    deferredRecords,
  );
  await ageTerminalOutbox(stateDir, deferredOperationId);
  const release = await acquireOutboxLock(stateDir);
  const result = await runEngineRecoveryCycle({
    performCompletionEffect() {
      throw new Error("retry later");
    },
    pruneNowMs: Date.now(),
    stateDir,
  }, release);
  assert.equal(result.report.remainingAttempts, 1);
  assert.equal(result.report.prunedOutbox, 0);
  assert.equal(
    (await recoverOutbox(stateDir)).find(
      (entry) => entry.operationId === deferredOperationId,
    ).status,
    "acked",
  );
  assert.equal(
    (await recoverAttemptJournals(stateDir)).find(
      (attempt) =>
        attempt.attemptId === deferredRecords.claimed.attemptId,
    ).records.settled,
    undefined,
  );
  await release();
});

test("a failed terminal settlement suppresses pruning until a later recovery", async (t) => {
  const stateDir = await temporaryState(t, "nexus-serve-settle-fail-");
  const records = await seedGeneratedJournal(stateDir, 1);
  const release = await acquireOutboxLock(stateDir);
  const plan = await prepareEngineAttemptRecoveryHeld(
    { stateDir },
    release,
  );
  await withOutboxLockOwnership(
    stateDir,
    release,
    async () => {
      const [entry] = await recoverOutbox(stateDir);
      await transitionOperation(
        stateDir,
        entry,
        "acked",
        {
          body: Buffer.from(JSON.stringify({
            late: false,
            recordedAt: "2026-07-27T12:00:10.000Z",
            runId: entry.runId,
            status: "completed",
          })),
          status: 200,
        },
      );
    },
  );
  const operationId = plan.intents[0].operationId;
  await ageTerminalOutbox(stateDir, operationId);
  const journalDirectory = join(
    stateDir,
    ATTEMPT_JOURNAL_DIRECTORY,
    records.claimed.attemptId,
  );
  await chmod(journalDirectory, 0o500);
  let report;
  try {
    report = await completeEngineAttemptRecoveryHeld(
      { plan, pruneNowMs: Date.now(), stateDir },
      release,
    );
  } finally {
    await chmod(journalDirectory, 0o700);
  }
  assert.equal(report.prunedOutbox, 0);
  assert.equal(
    report.attempts[0].reason,
    "settlement_persist_failed",
  );
  assert.equal((await recoverOutbox(stateDir))[0].status, "acked");
  await release();
});

test("a terminal tombstone is reconciled into the journal before pruning", async (t) => {
  const stateDir = await temporaryState(t, "nexus-serve-prune-order-");
  const records = await seedGeneratedJournal(stateDir, 1);
  const operationId = await seedTerminalCompletion(stateDir, records);
  await ageTerminalOutbox(stateDir, operationId);
  const release = await acquireOutboxLock(stateDir);
  let effects = 0;
  const result = await runEngineRecoveryCycle({
    performCompletionEffect() {
      effects += 1;
      throw new Error("terminal entries are never effects");
    },
    pruneNowMs: Date.now(),
    stateDir,
  }, release);
  assert.equal(effects, 0);
  assert.equal(result.report.prunedOutbox, 1);
  assert.deepEqual(await recoverOutbox(stateDir), []);
  assert.equal(
    (await recoverAttemptJournals(stateDir))[0].records.settled.outcome,
    "acked",
  );
  await release();
});

async function seedGeneratedJournal(stateDir, index) {
  const identity = index.toString(16).padStart(32, "0");
  const attemptId = `att_${identity}`;
  const runId = `run_${identity}`;
  const engine = "claude_code_cli";
  const claimOperationId = `op_${identity}`;
  const records = {
    claimed: finalizeAttemptRecord({
      attemptId,
      claimBodySha256: createHash("sha256")
        .update(canonicalJson({ engine, operationId: claimOperationId }))
        .digest("hex"),
      claimOperationId,
      createdAt: "2026-07-27T12:00:00.000Z",
      engine,
      runId,
      state: "claimed",
      v: 1,
    }),
  };
  for (const state of ["starting", "supervisor", "started", "result"]) {
    const source = parseAttemptRecordText(await fixture(state), state);
    const value = { ...source };
    delete value.recordSha256;
    records[state] = finalizeAttemptRecord({
      ...value,
      attemptId,
      ...(state === "starting" ? { runId } : {}),
    });
  }
  for (const state of [
    "claimed",
    "starting",
    "supervisor",
    "started",
    "result",
  ]) {
    await persistAttemptRecord(stateDir, records[state]);
  }
  assert.match(
    deriveEngineCompletionOperationId(attemptId),
    /^op_[0-9a-f]{32}$/u,
  );
  return records;
}

function successfulEffect(intent) {
  const body = Buffer.from(JSON.stringify({
    late: false,
    recordedAt: "2026-07-27T12:00:10.000Z",
    runId: intent.runId,
    status: "completed",
  }));
  return Object.freeze({
    bodyBase64Url: body.toString("base64url"),
    httpStatus: 200,
    kind: "response",
    operationId: intent.operationId,
    replay: false,
    runId: intent.runId,
  });
}

async function seedTerminalCompletion(stateDir, records) {
  const operationId = deriveEngineCompletionOperationId(
    records.claimed.attemptId,
  );
  const body = Buffer.from(canonicalJson({
    fence: records.starting.fence,
    leaseId: records.starting.leaseId,
    operationId,
    receipt: records.result.receipt,
  }));
  const pending = await persistDeclarationOperation(stateDir, {
    body,
    declarationKind: "engine.complete",
    operationId,
    runId: records.starting.runId,
  });
  await transitionOperation(
    stateDir,
    pending,
    "acked",
    {
      body: Buffer.from(JSON.stringify({
        late: false,
        recordedAt: "2026-07-27T12:00:10.000Z",
        runId: records.starting.runId,
        status: "completed",
      })),
      status: 200,
    },
  );
  return operationId;
}

async function ageTerminalOutbox(stateDir, operationId) {
  const terminal = (await recoverOutbox(stateDir)).find(
    (entry) => entry.operationId === operationId,
  );
  const oldTimestamp = new Date(
    Date.now() - 8 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const oldTerminal = finalizeOutboxEntry({
    ...terminal,
    createdAt: oldTimestamp,
    settledAt: oldTimestamp,
    updatedAt: oldTimestamp,
  });
  await writeFile(
    join(
      stateDir,
      OUTBOX_V3_DIRECTORY,
      `${operationId}.json`,
    ),
    `${canonicalJson(oldTerminal)}\n`,
    { mode: 0o600 },
  );
}

async function fixture(state) {
  return readFile(
    new URL(
      `./fixtures/s6-b4/attempt-${state}-v1.json`,
      import.meta.url,
    ),
    "utf8",
  );
}

async function temporaryState(t, prefix) {
  const stateDir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
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
