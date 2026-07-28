import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
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
  pruneSettledAttemptJournals,
  recoverAttemptJournals,
  SETTLED_ATTEMPT_RETENTION_MS,
} from "../runner/attempt-journal-store.mjs";
import {
  coordinateEngineAttemptRecovery,
  coordinateEngineAttemptRecoveryHeld,
  deriveEngineCompletionOperationId,
  ENGINE_COMPLETION_OPERATION_DOMAIN,
} from "../runner/engine-attempt-coordinator.mjs";
import {
  acquireOutboxLock,
  persistDeclarationOperation,
  pruneOutbox,
  recoverOutbox,
  transitionOperation,
  withOutboxLockOwnership,
} from "../runner/durable-outbox.mjs";

const attemptId = `att_${"a".repeat(32)}`;
const deterministicOperationId =
  "op_48810ff77e1ff69b7d9b070a1b643ce3";

test("completion operation identity is domain-separated and deterministic", () => {
  assert.equal(
    ENGINE_COMPLETION_OPERATION_DOMAIN,
    "nexus-runner-engine-outbox-operation-v1",
  );
  assert.equal(
    deriveEngineCompletionOperationId(attemptId),
    deterministicOperationId,
  );
  assert.equal(
    deriveEngineCompletionOperationId(attemptId),
    deterministicOperationId,
  );
  assert.throws(
    () => deriveEngineCompletionOperationId("att_invalid"),
    /Attempt identity is invalid/u,
  );
});

test("a durable completion bridges once and replays without another outbox entry", async (t) => {
  const stateDir = await temporaryState(t, "nexus-attempt-coordinate-");
  await seedJournal(stateDir, ["claimed", "starting", "supervisor", "started", "result"]);
  const calls = [];
  const first = await coordinateEngineAttemptRecovery({
    completionContext: Object.freeze({ marker: "context" }),
    drainCompletions(context, suppliedStateDir, entries) {
      calls.push({ context, entries, suppliedStateDir });
      return emptyDrain(entries.length);
    },
    stateDir,
  });
  assert.deepEqual(
    first.attempts.map(publicAttempt),
    [{
      action: "persist_completion",
      attemptId,
      operationId: deterministicOperationId,
      status: "outboxed",
    }],
  );
  assert.equal(first.permanentStop, false);
  assert.equal(first.unmatchedOutbox.length, 0);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.attempts), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].suppliedStateDir, stateDir);
  assert.equal(calls[0].entries.length, 1);
  assert.equal(calls[0].entries[0].operationId, deterministicOperationId);

  const second = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      calls.push({ entries });
      return emptyDrain(entries.length);
    },
    stateDir,
  });
  assert.deepEqual(
    second.attempts.map(publicAttempt),
    [{
      action: "deliver_completion",
      attemptId,
      operationId: deterministicOperationId,
      status: "queued",
    }],
  );
  const entries = await recoverOutbox(stateDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].operationId, deterministicOperationId);
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.equal(attempt.records.outboxed.operationId, deterministicOperationId);
});

test("a delivered completion settles once and survives outbox pruning without replay", async (t) => {
  const stateDir = await temporaryState(t, "nexus-attempt-settlement-");
  await seedJournal(
    stateDir,
    ["claimed", "starting", "supervisor", "started", "result"],
  );
  let deliveries = 0;
  const deliverAndAck = async (_context, suppliedStateDir, entries) => {
    deliveries += entries.length;
    assert.equal(entries.length, 1);
    const settled = await transitionOperation(
      suppliedStateDir,
      entries[0],
      "acked",
      { body: Buffer.from('{"ok":true}'), status: 200 },
    );
    return {
      attempted: 1,
      delivered: [{
        late: false,
        operationId: settled.operationId,
        recordedAt: settled.updatedAt,
        replay: false,
        runId: settled.runId,
      }],
      failed: [],
      halt: null,
      remainingPending: 0,
    };
  };
  const delivered = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions: deliverAndAck,
    stateDir,
  });
  assert.equal(deliveries, 1);
  assert.deepEqual(
    delivered.attempts.map(publicAttempt),
    [{
      action: "settled",
      attemptId,
      operationId: deterministicOperationId,
      outcome: "acked",
      status: "settled",
    }],
  );

  const replay = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      assert.deepEqual(entries, []);
      return emptyDrain();
    },
    stateDir,
  });
  assert.deepEqual(replay.attempts, []);
  assert.equal(replay.settledRetained, 1);
  assert.equal(deliveries, 1);

  const [terminal] = await recoverOutbox(stateDir);
  await pruneOutbox(
    stateDir,
    Date.parse(terminal.updatedAt) + 7 * 24 * 60 * 60 * 1_000,
  );
  assert.deepEqual(await recoverOutbox(stateDir), []);
  const afterPrune = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      assert.deepEqual(entries, []);
      return emptyDrain();
    },
    stateDir,
  });
  assert.deepEqual(afterPrune.attempts, []);
  assert.equal(afterPrune.settledRetained, 1);
  assert.equal(afterPrune.unmatchedOutbox.length, 0);
  assert.equal(deliveries, 1);
});

test("recovery adopts an exact pending or scrubbed deterministic entry after the crash gap", async (t) => {
  for (const terminal of [false, true]) {
    await t.test(terminal ? "scrubbed terminal" : "pending", async (t) => {
      const stateDir = await temporaryState(
        t,
        `nexus-attempt-gap-${terminal ? "terminal" : "pending"}-`,
      );
      const records = await seedJournal(
        stateDir,
        ["claimed", "starting", "supervisor", "started", "result"],
      );
      const body = completionBody(records, deterministicOperationId);
      let entry = await persistDeclarationOperation(stateDir, {
        body,
        declarationKind: "engine.complete",
        operationId: deterministicOperationId,
        runId: records.starting.runId,
      });
      if (terminal) {
        entry = await transitionOperation(
          stateDir,
          entry,
          "acked",
          { body: Buffer.from('{"ok":true}'), status: 200 },
        );
      }
      const before = entry.bodySha256;
      let delivered;
      const report = await coordinateEngineAttemptRecovery({
        completionContext: {},
        drainCompletions(_context, _stateDir, entries) {
          delivered = entries;
          return emptyDrain(entries.length);
        },
        stateDir,
      });
      assert.equal(
        report.attempts[0].status,
        terminal ? "settled" : "outboxed",
      );
      assert.equal(delivered.length, terminal ? 0 : 1);
      if (!terminal) {
        assert.equal(delivered[0].status, "pending");
        assert.equal(delivered[0].bodySha256, before);
      }
      assert.equal((await recoverOutbox(stateDir)).length, 1);
    });
  }
});

test("mismatch and orphan completion entries are attention-only and never delivered", async (t) => {
  const stateDir = await temporaryState(t, "nexus-attempt-mismatch-");
  const records = await seedJournal(
    stateDir,
    ["claimed", "starting", "supervisor", "started", "result"],
  );
  const changed = structuredClone(records.result.receipt);
  changed.finishedAt = "2026-07-27T12:00:05.000Z";
  const mismatchedBody = Buffer.from(canonicalJson({
    fence: records.starting.fence,
    leaseId: records.starting.leaseId,
    operationId: deterministicOperationId,
    receipt: changed,
  }));
  await persistDeclarationOperation(stateDir, {
    body: mismatchedBody,
    declarationKind: "engine.complete",
    operationId: deterministicOperationId,
    runId: records.starting.runId,
  });
  const orphanOperationId = `op_${"b".repeat(32)}`;
  await persistDeclarationOperation(stateDir, {
    body: completionBody(records, orphanOperationId),
    declarationKind: "engine.complete",
    operationId: orphanOperationId,
    runId: records.starting.runId,
  });
  let networkEligible = -1;
  const report = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      networkEligible = entries.length;
      return emptyDrain(entries.length);
    },
    stateDir,
  });
  assert.equal(networkEligible, 0);
  assert.deepEqual(
    report.attempts.map(publicAttempt),
    [{
      action: "operator_attention",
      attemptId,
      reason: "completion_operation_mismatch",
      status: "operator_attention",
    }],
  );
  assert.deepEqual(
    report.unmatchedOutbox.map((value) => value.operationId),
    [orphanOperationId],
  );
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.equal(attempt.records.outboxed, undefined);
});

test("abandoned completion is attention-only and never delivered", async (t) => {
  const stateDir = await temporaryState(t, "nexus-attempt-abandoned-");
  const records = await seedJournal(
    stateDir,
    ["claimed", "starting", "supervisor", "started", "result"],
  );
  const body = completionBody(records, deterministicOperationId);
  const pending = await persistDeclarationOperation(stateDir, {
    body,
    declarationKind: "engine.complete",
    operationId: deterministicOperationId,
    runId: records.starting.runId,
  });
  const terminal = await transitionOperation(
    stateDir,
    pending,
    "abandoned",
  );
  const networkEligible = [];
  const report = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      networkEligible.push(entries.length);
      return emptyDrain(entries.length);
    },
    stateDir,
  });
  assert.deepEqual(networkEligible, [0]);
  assert.deepEqual(report.attempts.map(publicAttempt), [{
    action: "operator_attention",
    attemptId,
    reason: "completion_operation_abandoned",
    status: "operator_attention",
  }]);
  assert.equal((await recoverOutbox(stateDir))[0]?.status, "abandoned");
  assert.equal(terminal.status, "abandoned");
  assert.equal(
    (await recoverAttemptJournals(stateDir))[0]?.records.outboxed?.operationId,
    deterministicOperationId,
  );

  await pruneOutbox(
    stateDir,
    Date.parse(terminal.updatedAt) + 7 * 24 * 60 * 60 * 1_000,
  );
  assert.deepEqual(await recoverOutbox(stateDir), []);
  const afterPrune = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      networkEligible.push(entries.length);
      return emptyDrain(entries.length);
    },
    stateDir,
  });
  assert.deepEqual(networkEligible, [0, 0]);
  assert.deepEqual(afterPrune.attempts, []);
  assert.equal(afterPrune.settledRetained, 1);
  assert.deepEqual(await recoverOutbox(stateDir), []);
  const [settledAttempt] = await recoverAttemptJournals(stateDir);
  assert.equal(
    settledAttempt?.records.outboxed?.operationId,
    deterministicOperationId,
  );
  assert.equal(settledAttempt?.records.settled?.outcome, "abandoned");
  const pruned = await pruneSettledAttemptJournals(stateDir, {
    nowMs: Date.parse(settledAttempt.records.settled.createdAt) +
      SETTLED_ATTEMPT_RETENTION_MS,
  });
  assert.deepEqual(pruned.removed, [attemptId]);
});

test("abandoned settlements cannot monopolize the actionable window", async (t) => {
  const stateDir = await temporaryState(
    t,
    "nexus-attempt-abandoned-window-",
  );
  for (let index = 0; index < 32; index += 1) {
    const records = await seedGeneratedJournal(stateDir, index);
    const operationId = deriveEngineCompletionOperationId(
      records.claimed.attemptId,
    );
    const pending = await persistDeclarationOperation(stateDir, {
      body: completionBody(records, operationId),
      declarationKind: "engine.complete",
      operationId,
      runId: records.starting.runId,
    });
    await transitionOperation(stateDir, pending, "abandoned");
  }
  const legitimate = await seedGeneratedJournal(stateDir, 32);
  const eligible = [];
  const first = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      eligible.push(entries.length);
      return emptyDrain(entries.length);
    },
    stateDir,
  });
  assert.deepEqual(eligible, [0]);
  assert.equal(first.attempts.length, 32);
  assert.ok(first.attempts.every((value) =>
    value.status === "operator_attention" &&
    value.reason === "completion_operation_abandoned"
  ));
  assert.equal(first.remainingAttempts, 1);

  const second = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      eligible.push(entries.length);
      return emptyDrain(entries.length);
    },
    stateDir,
  });
  assert.deepEqual(eligible, [0, 1]);
  assert.equal(second.settledRetained, 32);
  assert.equal(second.attempts.length, 1);
  assert.equal(second.attempts[0].attemptId, legitimate.claimed.attemptId);
  assert.equal(second.attempts[0].status, "outboxed");
});

test("a pre-settled reader quarantine cannot redeclare terminal completion", async (t) => {
  const stateDir = await temporaryState(t, "nexus-attempt-rollback-");
  await seedJournal(
    stateDir,
    ["claimed", "starting", "supervisor", "started", "result"],
  );
  let delivered = 0;
  const initial = await coordinateEngineAttemptRecovery({
    completionContext: {},
    async drainCompletions(_context, suppliedStateDir, entries) {
      delivered += entries.length;
      assert.equal(entries.length, 1);
      const terminal = await transitionOperation(
        suppliedStateDir,
        entries[0],
        "acked",
        { body: Buffer.from('{"ok":true}'), status: 200 },
      );
      return {
        attempted: 1,
        delivered: [{
          late: false,
          operationId: terminal.operationId,
          recordedAt: terminal.updatedAt,
          replay: false,
          runId: terminal.runId,
        }],
        failed: [],
        halt: null,
        remainingPending: 0,
      };
    },
    stateDir,
  });
  assert.equal(initial.attempts[0]?.status, "settled");
  await runPreSettledReaderFixture(stateDir);
  assert.deepEqual(await recoverAttemptJournals(stateDir), []);

  const afterRollback = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      delivered += entries.length;
      assert.deepEqual(entries, []);
      return emptyDrain();
    },
    stateDir,
  });
  assert.equal(delivered, 1);
  assert.deepEqual(afterRollback.attempts, []);
  assert.deepEqual(afterRollback.unmatchedOutbox, []);
  assert.equal((await recoverOutbox(stateDir))[0]?.status, "acked");
});

test("a pre-abandoned reader quarantine cannot redeclare abandoned settlement", async (t) => {
  const stateDir = await temporaryState(
    t,
    "nexus-attempt-abandoned-rollback-",
  );
  const records = await seedJournal(
    stateDir,
    ["claimed", "starting", "supervisor", "started", "result"],
  );
  const pending = await persistDeclarationOperation(stateDir, {
    body: completionBody(records, deterministicOperationId),
    declarationKind: "engine.complete",
    operationId: deterministicOperationId,
    runId: records.starting.runId,
  });
  const terminal = await transitionOperation(
    stateDir,
    pending,
    "abandoned",
  );
  let delivered = 0;
  const settled = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      delivered += entries.length;
      assert.deepEqual(entries, []);
      return emptyDrain();
    },
    stateDir,
  });
  assert.equal(settled.attempts[0]?.reason, "completion_operation_abandoned");
  assert.equal(
    (await recoverAttemptJournals(stateDir))[0]?.records.settled?.outcome,
    "abandoned",
  );

  await runPreAbandonedReaderFixture(stateDir);
  assert.deepEqual(await recoverAttemptJournals(stateDir), []);
  const afterRollback = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      delivered += entries.length;
      assert.deepEqual(entries, []);
      return emptyDrain();
    },
    stateDir,
  });
  assert.equal(delivered, 0);
  assert.deepEqual(afterRollback.attempts, []);
  assert.deepEqual(afterRollback.unmatchedOutbox, []);
  assert.equal((await recoverOutbox(stateDir))[0]?.status, "abandoned");

  await pruneOutbox(
    stateDir,
    Date.parse(terminal.updatedAt) + 7 * 24 * 60 * 60 * 1_000,
  );
  const afterPrune = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      delivered += entries.length;
      assert.deepEqual(entries, []);
      return emptyDrain();
    },
    stateDir,
  });
  assert.equal(delivered, 0);
  assert.deepEqual(afterPrune.attempts, []);
  assert.deepEqual(afterPrune.unmatchedOutbox, []);
  assert.deepEqual(await recoverOutbox(stateDir), []);
});

test("a quarantined journal cannot make a pending completion network-eligible", async (t) => {
  const stateDir = await temporaryState(
    t,
    "nexus-attempt-rollback-pending-",
  );
  const records = await seedJournal(stateDir, [
    "claimed",
    "starting",
    "supervisor",
    "started",
    "result",
    "outboxed",
    "settled",
  ]);
  await persistDeclarationOperation(stateDir, {
    body: completionBody(records, deterministicOperationId),
    declarationKind: "engine.complete",
    operationId: deterministicOperationId,
    runId: records.starting.runId,
  });
  await runPreSettledReaderFixture(stateDir);
  let networkEligible = -1;
  const report = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      networkEligible = entries.length;
      return emptyDrain(entries.length);
    },
    stateDir,
  });
  assert.equal(networkEligible, 0);
  assert.deepEqual(report.attempts, []);
  assert.deepEqual(report.unmatchedOutbox, [{
    operationId: deterministicOperationId,
    reason: "journal_correlation_missing",
    status: "operator_attention",
  }]);
  assert.equal((await recoverOutbox(stateDir))[0]?.status, "pending");
});

test("claimed attempts are deterministic, deferred and sorted by recovery age", async (t) => {
  const stateDir = await temporaryState(t, "nexus-attempt-order-");
  await persistAttemptRecord(stateDir, claimedRecord("f", "2026-07-27T12:00:00.000Z"));
  await persistAttemptRecord(stateDir, claimedRecord("1", "2026-07-27T12:00:01.000Z"));
  const report = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      assert.deepEqual(entries, []);
      return emptyDrain(entries.length);
    },
    stateDir,
  });
  assert.deepEqual(
    report.attempts.map((value) => value.attemptId),
    [`att_${"f".repeat(32)}`, `att_${"1".repeat(32)}`],
  );
  assert.ok(report.attempts.every((value) =>
    value.status === "deferred" &&
    value.reason === "deferred_to_serve"
  ));
});

test("one pass caps recovered attempts and correlated deliveries", async (t) => {
  await t.test("attempt cap", async (t) => {
    const stateDir = await temporaryState(t, "nexus-attempt-cap-");
    for (let index = 0; index < 33; index += 1) {
      const identity = index.toString(16).padStart(32, "0");
      await persistAttemptRecord(
        stateDir,
        claimedRecordIdentity(
          identity,
          "2026-07-27T12:00:00.000Z",
        ),
      );
    }
    const report = await coordinateEngineAttemptRecovery({
      completionContext: {},
      drainCompletions(_context, _stateDir, entries) {
        assert.deepEqual(entries, []);
        return emptyDrain();
      },
      stateDir,
    });
    assert.equal(report.attempts.length, 32);
    assert.equal(report.remainingAttempts, 1);
  });

  await t.test("delivery cap", async (t) => {
    const stateDir = await temporaryState(t, "nexus-delivery-cap-");
    for (let index = 0; index < 17; index += 1) {
      await seedGeneratedJournal(stateDir, index);
    }
    let supplied = 0;
    const report = await coordinateEngineAttemptRecovery({
      completionContext: {},
      drainCompletions(_context, _stateDir, entries) {
        supplied = entries.length;
        return emptyDrain(entries.length);
      },
      stateDir,
    });
    assert.equal(supplied, 16);
    assert.equal(report.deferredDeliveries, 1);
    assert.equal(report.remainingAttempts, 0);
    assert.equal(report.attempts.length, 17);
    assert.equal((await recoverOutbox(stateDir)).length, 17);
  });
});

test("recent settled attempts never monopolize the actionable recovery window", async (t) => {
  const stateDir = await temporaryState(t, "nexus-settled-priority-");
  for (let index = 0; index < 35; index += 1) {
    await seedGeneratedJournal(stateDir, index, { settled: true });
  }
  for (let index = 35; index < 40; index += 1) {
    await seedGeneratedJournal(stateDir, index);
  }
  let supplied = 0;
  const report = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      supplied = entries.length;
      return emptyDrain(entries.length);
    },
    stateDir,
  });
  assert.equal(supplied, 5);
  assert.equal(report.attempts.length, 5);
  assert.equal(report.settledRetained, 35);
  assert.equal(report.remainingAttempts, 0);
  assert.equal(report.unmatchedOutbox.length, 0);
});

test("deferred delivery count is frozen before a successful bounded drain", async (t) => {
  const stateDir = await temporaryState(t, "nexus-delivery-deferred-");
  for (let index = 0; index < 20; index += 1) {
    await seedGeneratedJournal(stateDir, index);
  }
  const report = await coordinateEngineAttemptRecovery({
    completionContext: {},
    async drainCompletions(_context, suppliedStateDir, entries) {
      assert.equal(entries.length, 16);
      const delivered = [];
      for (const entry of entries) {
        const terminal = await transitionOperation(
          suppliedStateDir,
          entry,
          "acked",
          { body: Buffer.from('{"ok":true}'), status: 200 },
        );
        delivered.push({
          late: false,
          operationId: terminal.operationId,
          recordedAt: terminal.updatedAt,
          replay: false,
          runId: terminal.runId,
        });
      }
      return {
        attempted: 16,
        delivered,
        failed: [],
        halt: null,
        remainingPending: 0,
      };
    },
    stateDir,
  });
  assert.equal(report.deferredDeliveries, 4);
  assert.equal(
    report.attempts.filter((value) => value.status === "settled").length,
    16,
  );
  assert.equal(
    report.attempts.filter((value) => value.status === "outboxed").length,
    4,
  );
});

test("settled garbage collection removes at most 32 attempts atomically per pass", async (t) => {
  const stateDir = await temporaryState(t, "nexus-settled-gc-cap-");
  for (let index = 0; index < 40; index += 1) {
    await seedGeneratedJournal(stateDir, index, { settled: true });
  }
  const result = await pruneSettledAttemptJournals(stateDir, {
    nowMs:
      Date.parse("2026-07-27T12:00:06.000Z") +
      SETTLED_ATTEMPT_RETENTION_MS,
  });
  assert.equal(result.removed.length, 32);
  assert.equal(result.attempts.length, 8);
  assert.equal((await recoverAttemptJournals(stateDir)).length, 8);
});

test("ambiguous supervisor identity never creates completion work", async (t) => {
  const stateDir = await temporaryState(t, "nexus-attempt-ambiguous-");
  await seedJournal(stateDir, ["claimed", "starting", "supervisor"]);
  let eligible = -1;
  const report = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions(_context, _stateDir, entries) {
      eligible = entries.length;
      return emptyDrain(entries.length);
    },
    stateDir,
  });
  assert.equal(eligible, 0);
  assert.deepEqual(
    report.attempts.map(publicAttempt),
    [{
      action: "operator_attention",
      attemptId,
      reason: "supervisor_identity_ambiguous",
      status: "operator_attention",
    }],
  );
  assert.equal((await recoverOutbox(stateDir)).length, 0);
});

test("the coordinator can own or reuse the production state lock", async (t) => {
  const stateDir = await temporaryState(t, "nexus-attempt-lock-");
  const otherStateDir = await temporaryState(
    t,
    "nexus-attempt-other-lock-",
  );
  const release = await acquireOutboxLock(stateDir);
  await assert.rejects(
    withOutboxLockOwnership(stateDir, release, null),
    (error) => error?.code === "runner_lock_operation_invalid",
  );
  const held = await coordinateEngineAttemptRecoveryHeld({
    completionContext: {},
    drainCompletions: () => emptyDrain(),
    stateDir,
  }, release);
  assert.equal(held.attempts.length, 0);
  for (const forged of [
    true,
    "held",
    1,
    null,
    undefined,
    async () => undefined,
  ]) {
    await assert.rejects(
      coordinateEngineAttemptRecoveryHeld({
        completionContext: {},
        drainCompletions: () => emptyDrain(),
        stateDir,
      }, forged),
      (error) => error?.code === "runner_lock_ownership_invalid",
    );
  }
  await assert.rejects(
    coordinateEngineAttemptRecoveryHeld({
      completionContext: {},
      drainCompletions: () => emptyDrain(),
      stateDir: otherStateDir,
    }, release),
    (error) => error?.code === "runner_lock_ownership_invalid",
  );
  await assert.rejects(
    coordinateEngineAttemptRecovery({
      completionContext: {},
      drainCompletions: () => emptyDrain(),
      stateDir,
    }),
    (error) => error?.code === "runner_already_running",
  );
  await release();
  await assert.rejects(
    coordinateEngineAttemptRecoveryHeld({
      completionContext: {},
      drainCompletions: () => emptyDrain(),
      stateDir,
    }, release),
    (error) => error?.code === "runner_lock_ownership_invalid",
  );

  await assert.rejects(
    coordinateEngineAttemptRecovery({
      completionContext: {},
      drainCompletions() {
        throw new Error("injected drain failure");
      },
      stateDir,
    }),
    /injected drain failure/u,
  );
  const releaseAfterFailure = await acquireOutboxLock(stateDir);
  await releaseAfterFailure();

  await writeFile(
    join(stateDir, "outbox.lock"),
    `${JSON.stringify({
      pid: 2_147_483_647,
      startedAt: "2026-07-27T12:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
  const recovered = await coordinateEngineAttemptRecovery({
    completionContext: {},
    drainCompletions: () => emptyDrain(),
    stateDir,
  });
  assert.equal(recovered.attempts.length, 0);
});

test("effects release the borrow while recovery remains serialized", async (t) => {
  const stateDir = await temporaryState(t, "nexus-attempt-borrow-");
  const release = await acquireOutboxLock(stateDir);
  let enterDrain;
  let resumeDrain;
  const drainEntered = new Promise((resolve) => {
    enterDrain = resolve;
  });
  const drainResume = new Promise((resolve) => {
    resumeDrain = resolve;
  });
  const held = coordinateEngineAttemptRecoveryHeld({
    completionContext: {},
    async drainCompletions() {
      enterDrain();
      await drainResume;
      return emptyDrain();
    },
    stateDir,
  }, release);
  await drainEntered;
  assert.equal(
    await withOutboxLockOwnership(
      stateDir,
      release,
      () => "borrowed-between-effects",
    ),
    "borrowed-between-effects",
  );
  await assert.rejects(
    coordinateEngineAttemptRecoveryHeld({
      completionContext: {},
      drainCompletions: () => emptyDrain(),
      stateDir,
    }, release),
    (error) =>
      error?.code === "engine_attempt_recovery_active",
  );
  await assert.rejects(
    coordinateEngineAttemptRecovery({
      completionContext: {},
      drainCompletions: () => emptyDrain(),
      stateDir,
    }),
    (error) => error?.code === "runner_already_running",
  );
  resumeDrain();
  await held;
  await release();

  const currentRelease = await acquireOutboxLock(stateDir);
  await assert.rejects(
    release(),
    (error) => error?.code === "runner_lock_release_invalid",
  );
  await assert.rejects(
    coordinateEngineAttemptRecovery({
      completionContext: {},
      drainCompletions: () => emptyDrain(),
      stateDir,
    }),
    (error) => error?.code === "runner_already_running",
  );
  await currentRelease();
});

test("invalid drain reports fail closed with a typed error and release the lock", async (t) => {
  for (const invalid of [
    undefined,
    { ...emptyDrain(), unexpected: Buffer.from("private") },
  ]) {
    await t.test(String(invalid === undefined ? "undefined" : "noncanonical"), async (t) => {
      const stateDir = await temporaryState(t, "nexus-drain-invalid-");
      await assert.rejects(
        coordinateEngineAttemptRecovery({
          completionContext: {},
          drainCompletions() {
            return invalid;
          },
          stateDir,
        }),
        (error) =>
          error?.code === "engine_attempt_coordinator_invalid" &&
          /drain report/u.test(error.message),
      );
      const release = await acquireOutboxLock(stateDir);
      await release();
    });
  }
});

test("only exit hint 77 becomes a permanent stop", async (t) => {
  for (const exitCodeHint of [75, 76, 77]) {
    await t.test(String(exitCodeHint), async (t) => {
      const stateDir = await temporaryState(
        t,
        `nexus-attempt-halt-${exitCodeHint}-`,
      );
      await seedJournal(
        stateDir,
        ["claimed", "starting", "supervisor", "started", "result"],
      );
      const report = await coordinateEngineAttemptRecovery({
        completionContext: {},
        async drainCompletions(_context, suppliedStateDir, entries) {
          assert.equal(entries.length, 1);
          const code = exitCodeHint === 77
            ? "auth"
            : exitCodeHint === 76
              ? "protocol"
              : "retryable";
          if (exitCodeHint === 77) {
            await transitionOperation(
              suppliedStateDir,
              entries[0],
              "rejected",
              {
                body: Buffer.from('{"error":"runner_rejected"}'),
                status: 403,
              },
            );
          }
          return {
            attempted: 1,
            delivered: [],
            failed: [],
            halt: {
              code,
              exitCodeHint,
              httpStatus: exitCodeHint === 77 ? 403 : 500,
              operationId: entries[0].operationId,
              runId: entries[0].runId,
              serverError:
                exitCodeHint === 77 ? "runner_rejected" : null,
            },
            remainingPending: exitCodeHint === 77 ? 0 : 1,
          };
        },
        stateDir,
      });
      assert.equal(report.permanentStop, exitCodeHint === 77);
      assert.equal(
        report.attempts[0].status,
        exitCodeHint === 77 ? "settled" : "outboxed",
      );
      if (exitCodeHint === 77) {
        assert.equal(report.attempts[0].outcome, "rejected");
      }
    });
  }
});

test("the legacy coordinator stays inert while serve consumes only the effect cycle", async () => {
  const coordinator = await readFile(
    new URL("../runner/engine-attempt-coordinator.mjs", import.meta.url),
    "utf8",
  );
  const runner = await readFile(
    new URL("../runner/nexus-runner.mjs", import.meta.url),
    "utf8",
  );
  const serve = await readFile(
    new URL("../runner/engine-serve-command.mjs", import.meta.url),
    "utf8",
  );
  const commandStart = runner.indexOf('const command = process.argv[2]');
  const commandEnd = runner.indexOf("async function engines");
  assert.ok(commandStart >= 0);
  assert.ok(commandEnd > commandStart);
  assert.doesNotMatch(coordinator, /nexus-runner\.mjs/u);
  assert.doesNotMatch(runner, /engine-attempt-coordinator/u);
  assert.doesNotMatch(
    `${runner}\n${serve}`,
    /coordinateEngineAttemptRecovery(?:Held)?/u,
  );
  assert.match(runner, /runRecoveryCycle:\s*runEngineRecoveryCycle/u);
  assert.doesNotMatch(serve, /engine-attempt-coordinator/u);
  assert.match(
    runner.slice(commandStart, commandEnd),
    /command === "serve"/u,
  );
  assert.doesNotMatch(
    runner.slice(commandStart, commandEnd),
    /coordinateEngineAttemptRecovery/u,
  );
});

async function seedJournal(stateDir, states) {
  let records;
  for (const state of states) {
    const record = parseAttemptRecordText(await fixture(state), state);
    assert.ok(record, state);
    records = await persistAttemptRecord(stateDir, record);
  }
  return records;
}

function claimedRecord(character, createdAt) {
  return claimedRecordIdentity(character.repeat(32), createdAt);
}

function claimedRecordIdentity(identity, createdAt) {
  const engine = "claude_code_cli";
  const operationId = `op_${identity}`;
  return finalizeAttemptRecord({
    attemptId: `att_${identity}`,
    claimBodySha256: createHash("sha256")
      .update(canonicalJson({ engine, operationId }))
      .digest("hex"),
    claimOperationId: operationId,
    createdAt,
    engine,
    runId: `run_${identity}`,
    state: "claimed",
    v: 1,
  });
}

async function seedGeneratedJournal(
  stateDir,
  index,
  options = {},
) {
  const identity = index.toString(16).padStart(32, "0");
  const attempt = `att_${identity}`;
  const runId = `run_${identity}`;
  const records = {};
  records.claimed = claimedRecordIdentity(
    identity,
    "2026-07-27T12:00:00.000Z",
  );
  for (const state of ["starting", "supervisor", "started", "result"]) {
    const source = parseAttemptRecordText(await fixture(state), state);
    assert.ok(source, state);
    records[state] = finalizeAttemptRecord({
      ...withoutChecksum(source),
      attemptId: attempt,
      ...(state === "starting" ? { runId } : {}),
    });
  }
  if (options.settled) {
    const operationId = deriveEngineCompletionOperationId(attempt);
    records.outboxed = finalizeAttemptRecord({
      attemptId: attempt,
      bodySha256: createHash("sha256")
        .update(completionBody(records, operationId))
        .digest("hex"),
      createdAt: "2026-07-27T12:00:05.000Z",
      operationId,
      state: "outboxed",
      v: 1,
    });
    records.settled = finalizeAttemptRecord({
      attemptId: attempt,
      createdAt: "2026-07-27T12:00:06.000Z",
      operationId,
      outcome: "acked",
      state: "settled",
      v: 1,
    });
  }
  const states = [
    "claimed",
    "starting",
    "supervisor",
    "started",
    "result",
    ...(options.settled ? ["outboxed", "settled"] : []),
  ];
  for (const state of states) {
    await persistAttemptRecord(stateDir, records[state]);
  }
  return records;
}

function withoutChecksum(record) {
  const copy = { ...record };
  delete copy.recordSha256;
  return copy;
}

function completionBody(records, operationId) {
  return Buffer.from(canonicalJson({
    fence: records.starting.fence,
    leaseId: records.starting.leaseId,
    operationId,
    receipt: records.result.receipt,
  }));
}

function emptyDrain(remainingPending = 0) {
  return {
    attempted: 0,
    delivered: [],
    failed: [],
    halt: null,
    remainingPending,
  };
}

async function runPreSettledReaderFixture(stateDir) {
  const fixtureText = await readFile(
    new URL(
      "./fixtures/s6-b4/attempt-journal-pre-settled-reader.json",
      import.meta.url,
    ),
    "utf8",
  );
  const fixture = JSON.parse(fixtureText);
  assert.deepEqual(Object.keys(fixture), [
    "onUnknownRecord",
    "recordFiles",
    "v",
  ]);
  assert.equal(fixture.onUnknownRecord, "quarantine_attempt");
  assert.equal(fixture.v, 1);
  const root = join(stateDir, ATTEMPT_JOURNAL_DIRECTORY);
  const corrupt = join(root, "corrupt");
  for (const name of (await readdir(root)).filter((value) =>
    /^att_[0-9a-f]{32}$/u.test(value)
  )) {
    const directory = join(root, name);
    const unknown = (await readdir(directory)).filter(
      (file) => !fixture.recordFiles.includes(file),
    );
    if (unknown.length > 0) {
      await rename(directory, join(corrupt, `${name}.pre-settled`));
    }
  }
}

async function runPreAbandonedReaderFixture(stateDir) {
  const fixtureText = await readFile(
    new URL(
      "./fixtures/s6-b4/attempt-journal-pre-abandoned-reader.json",
      import.meta.url,
    ),
    "utf8",
  );
  const fixture = JSON.parse(fixtureText);
  assert.deepEqual(Object.keys(fixture), [
    "onInvalidRecord",
    "readerCommit",
    "recordFiles",
    "settledOutcomes",
    "v",
  ]);
  assert.equal(fixture.onInvalidRecord, "quarantine_attempt");
  assert.equal(fixture.readerCommit, "2682913");
  assert.equal(fixture.v, 1);
  assert.equal(fixture.recordFiles.includes("settled.json"), true);
  const root = join(stateDir, ATTEMPT_JOURNAL_DIRECTORY);
  const corrupt = join(root, "corrupt");
  for (const name of (await readdir(root)).filter((value) =>
    /^att_[0-9a-f]{32}$/u.test(value)
  )) {
    const directory = join(root, name);
    const settled = JSON.parse(
      await readFile(join(directory, "settled.json"), "utf8"),
    );
    if (!fixture.settledOutcomes.includes(settled.outcome)) {
      await rename(directory, join(corrupt, `${name}.pre-abandoned`));
    }
  }
}

function publicAttempt(value) {
  return { ...value };
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
