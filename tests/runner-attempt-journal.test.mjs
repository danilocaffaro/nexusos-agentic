import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ATTEMPT_RECORD_MAX_BYTES,
  ATTEMPT_RESULT_MAX_BYTES,
  attemptRecordChecksum,
  attemptRecoveryDecision,
  finalizeAttemptRecord,
  parseAttemptRecordText,
  validateAttemptRecordSet,
} from "../runner/attempt-journal-contract.mjs";
import {
  ATTEMPT_JOURNAL_DIRECTORY,
  AttemptJournalError,
  ensureAttemptJournal,
  persistAttemptRecord,
  pruneSettledAttemptJournals,
  recoverAttemptJournals,
  SETTLED_ATTEMPT_RETENTION_MS,
} from "../runner/attempt-journal-store.mjs";
import {
  createPrestartAbandonedRecord,
  createRuntimePrestartResultRecord,
  createSpawningRecord,
} from "../runner/engine-lease-runtime-contract.mjs";

const attemptId = `att_${"a".repeat(32)}`;
const emptySha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const states = [
  "claimed",
  "starting",
  "supervisor",
  "started",
  "result",
  "outboxed",
  "settled",
];

test("checked-in journal records are canonical, checksummed and bounded", async () => {
  for (const state of states) {
    const text = await fixture(state);
    const record = parseAttemptRecordText(text, state);
    assert.ok(record, state);
    assert.deepEqual(finalizeAttemptRecord(record), record);
    assert.equal(record.attemptId, attemptId);
    const maximum =
      state === "result"
        ? ATTEMPT_RESULT_MAX_BYTES
        : ATTEMPT_RECORD_MAX_BYTES;
    assert.ok(Buffer.byteLength(text) <= maximum);
    assert.equal(parseAttemptRecordText(text.trimEnd(), state), undefined);
    assert.equal(parseAttemptRecordText(` ${text}`, state), undefined);
    assert.equal(
      parseAttemptRecordText(text, state === "claimed" ? "starting" : "claimed"),
      undefined,
    );
  }
  assert.equal(ATTEMPT_RECORD_MAX_BYTES, 4_096);
  assert.equal(ATTEMPT_RESULT_MAX_BYTES, 8_192);
});

test("the recovery table follows only valid monotonic journal prefixes", async () => {
  const records = await fixtureRecords();
  const current = {};
  for (const [state, expected] of [
    ["claimed", { action: "replay_claim", state: "claimed" }],
    [
      "starting",
      {
        action: "operator_attention",
        reason: "supervisor_identity_ambiguous",
        state: "starting",
      },
    ],
    [
      "supervisor",
      { action: "inspect_supervisor", state: "starting" },
    ],
    ["started", { action: "inspect_process", state: "started" }],
    ["result", { action: "persist_completion", state: "result" }],
    [
      "outboxed",
      { action: "deliver_completion", state: "outboxed" },
    ],
    [
      "settled",
      { action: "settled", outcome: "acked", state: "settled" },
    ],
  ]) {
    current[state] = records[state];
    const valid = validateAttemptRecordSet(current);
    assert.ok(valid, state);
    assert.deepEqual(attemptRecoveryDecision(valid), expected);
  }

  assert.equal(
    validateAttemptRecordSet({
      claimed: records.claimed,
      started: records.started,
    }),
    undefined,
  );
  assert.equal(
    validateAttemptRecordSet({
      ...records,
      starting: finalizeAttemptRecord({
        ...withoutChecksum(records.starting),
        runId: `run_${"9".repeat(32)}`,
      }),
    }),
    undefined,
  );
  const valid = validateAttemptRecordSet(records);
  assert.ok(Object.isFrozen(valid));
  assert.ok(Object.isFrozen(valid.result));
  assert.ok(Object.isFrozen(valid.result.receipt));
  assert.ok(Object.isFrozen(valid.result.receipt.stdout));
});

test("settlement is terminal, closed and bound to the outboxed operation", async () => {
  const records = await fixtureRecords();
  assert.equal(
    validateAttemptRecordSet({
      claimed: records.claimed,
      result: records.result,
      settled: records.settled,
      starting: records.starting,
      supervisor: records.supervisor,
    }),
    undefined,
  );
  assert.equal(
    validateAttemptRecordSet({
      ...records,
      settled: finalizeAttemptRecord({
        ...withoutChecksum(records.settled),
        operationId: `op_${"9".repeat(32)}`,
      }),
    }),
    undefined,
  );
  assert.equal(
    validateAttemptRecordSet({
      ...records,
      settled: finalizeAttemptRecord({
        ...withoutChecksum(records.settled),
        createdAt: "2026-07-27T12:00:04.000Z",
      }),
    }),
    undefined,
  );
  const abandoned = finalizeAttemptRecord({
    ...withoutChecksum(records.settled),
    outcome: "abandoned",
  });
  assert.equal(
    validateAttemptRecordSet({
      ...records,
      settled: abandoned,
    })?.settled.outcome,
    "abandoned",
  );
  assert.throws(
    () =>
      finalizeAttemptRecord({
        ...withoutChecksum(records.settled),
        outcome: "failed",
      }),
    /Invalid attempt journal record/u,
  );
});

test("pre-supervisor results and proven abandonments are additive and recoverable", async (t) => {
  const records = await fixtureRecords();
  const spawning = createSpawningRecord({
    claimed: records.claimed,
    createdAt: "2026-07-27T12:00:01.500Z",
    starting: records.starting,
  });
  assert.deepEqual(
    attemptRecoveryDecision({
      claimed: records.claimed,
      spawning,
      starting: records.starting,
    }),
    {
      action: "operator_attention",
      reason: "spawning_window_ambiguous",
      state: "starting",
    },
  );
  const result = createRuntimePrestartResultRecord({
    claimed: records.claimed,
    createdAt: "2026-07-27T12:00:02.000Z",
    reason: "engine_incompatible",
    starting: records.starting,
  });
  assert.deepEqual(
    attemptRecoveryDecision({
      claimed: records.claimed,
      result,
      starting: records.starting,
    }),
    { action: "persist_completion", state: "result" },
  );

  const claimSettled = createPrestartAbandonedRecord({
    claimed: records.claimed,
    createdAt: "2026-07-27T12:00:01.000Z",
    denial: {
      httpStatus: 409,
      observedAt: "2026-07-27T12:00:01.000Z",
      serverError: "run_unavailable",
      source: "claim",
    },
  });
  assert.deepEqual(
    attemptRecoveryDecision({
      claimed: records.claimed,
      settled: claimSettled,
    }),
    {
      action: "settled",
      denial: claimSettled.denial,
      outcome: "abandoned",
      state: "settled",
    },
  );

  const renewSettled = createPrestartAbandonedRecord({
    claimed: records.claimed,
    createdAt: "2026-07-27T12:00:02.000Z",
    denial: {
      httpStatus: 410,
      observedAt: "2026-07-27T12:00:02.000Z",
      serverError: "lease_expired",
      source: "renew",
    },
    starting: records.starting,
  });
  const stateDir = await privateStateDir(t, "nexus-attempt-prestart-");
  await persistAttemptRecord(stateDir, records.claimed);
  await persistAttemptRecord(stateDir, records.starting);
  await persistAttemptRecord(stateDir, renewSettled);
  const recovered = await recoverAttemptJournals(stateDir);
  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0].decision, {
    action: "settled",
    denial: renewSettled.denial,
    outcome: "abandoned",
    state: "settled",
  });
  const pruned = await pruneSettledAttemptJournals(stateDir, {
    nowMs: Date.parse(renewSettled.createdAt) +
      SETTLED_ATTEMPT_RETENTION_MS,
  });
  assert.deepEqual(pruned.removed, [attemptId]);
});

test("the prior reader quarantines both additive prestart variants", async (t) => {
  const previous = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/s6-b4/attempt-journal-pre-prestart-reader.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(previous, {
    knowsSpawning: false,
    onInvalidRecord: "quarantine_attempt",
    readerCommit: "33ce672",
    requiresOutboxedForSettled: true,
    requiresSupervisorForResult: true,
    v: 1,
  });
  const records = await fixtureRecords();
  const result = createRuntimePrestartResultRecord({
    claimed: records.claimed,
    createdAt: "2026-07-27T12:00:02.000Z",
    reason: "prompt_unavailable",
    starting: records.starting,
  });
  const settled = createPrestartAbandonedRecord({
    claimed: records.claimed,
    createdAt: "2026-07-27T12:00:01.000Z",
    denial: {
      httpStatus: 409,
      observedAt: "2026-07-27T12:00:01.000Z",
      serverError: "run_unavailable",
      source: "claim",
    },
  });
  for (const scenario of [
    {
      name: "spawning-unknown",
      records: {
        claimed: records.claimed,
        spawning: createSpawningRecord({
          claimed: records.claimed,
          createdAt: "2026-07-27T12:00:01.500Z",
          starting: records.starting,
        }),
        starting: records.starting,
      },
    },
    {
      name: "result-without-supervisor",
      records: {
        claimed: records.claimed,
        result,
        starting: records.starting,
      },
    },
    {
      name: "settled-without-outboxed",
      records: {
        claimed: records.claimed,
        settled,
      },
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const stateDir = await privateStateDir(
        t,
        `nexus-attempt-prior-${scenario.name}-`,
      );
      for (const state of [
        "claimed",
        "starting",
        "spawning",
        "supervisor",
        "started",
        "result",
        "outboxed",
        "settled",
      ]) {
        if (scenario.records[state]) {
          await persistAttemptRecord(stateDir, scenario.records[state]);
        }
      }
      assert.equal(
        priorReaderAction(previous, scenario.records),
        "quarantine_attempt",
      );
      const journal = join(stateDir, ATTEMPT_JOURNAL_DIRECTORY);
      const corrupt = join(journal, "corrupt");
      await mkdir(corrupt, { mode: 0o700, recursive: true });
      await rename(
        join(journal, attemptId),
        join(corrupt, `${attemptId}.${scenario.name}`),
      );
      assert.deepEqual(await recoverAttemptJournals(stateDir), []);
      await assert.rejects(
        stat(join(journal, attemptId)),
        { code: "ENOENT" },
      );
      assert.equal(
        (
          await stat(
            join(corrupt, `${attemptId}.${scenario.name}`),
          )
        ).isDirectory(),
        true,
      );
    });
  }
});

test("settled attempt pruning waits eight days and never removes nonterminal work", async (t) => {
  await t.test("retention and removal", async (t) => {
    const stateDir = await privateStateDir(t, "nexus-attempt-settled-gc-");
    const records = await fixtureRecords();
    for (const state of states) {
      await persistAttemptRecord(stateDir, records[state]);
    }
    const settledAt = Date.parse(records.settled.createdAt);
    const retained = await pruneSettledAttemptJournals(stateDir, {
      nowMs: settledAt + SETTLED_ATTEMPT_RETENTION_MS - 1,
    });
    assert.deepEqual(retained.removed, []);
    assert.equal(retained.attempts.length, 1);
    const pruned = await pruneSettledAttemptJournals(stateDir, {
      nowMs: settledAt + SETTLED_ATTEMPT_RETENTION_MS,
    });
    assert.deepEqual(pruned.removed, [attemptId]);
    assert.deepEqual(pruned.attempts, []);
    await assert.rejects(
      stat(join(stateDir, ATTEMPT_JOURNAL_DIRECTORY, attemptId)),
      { code: "ENOENT" },
    );
  });

  await t.test("nonterminal retention", async (t) => {
    const stateDir = await privateStateDir(
      t,
      "nexus-attempt-nonterminal-gc-",
    );
    const records = await fixtureRecords();
    for (const state of states.slice(0, -1)) {
      await persistAttemptRecord(stateDir, records[state]);
    }
    const result = await pruneSettledAttemptJournals(stateDir, {
      nowMs: Date.parse(records.settled.createdAt) +
        SETTLED_ATTEMPT_RETENTION_MS * 2,
    });
    assert.deepEqual(result.removed, []);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].decision.action, "deliver_completion");
  });

  await t.test("unsafe staged cleanup is quarantined without starvation", async (t) => {
    const stateDir = await privateStateDir(
      t,
      "nexus-attempt-staged-quarantine-",
    );
    const records = await fixtureRecords();
    for (const state of states) {
      await persistAttemptRecord(stateDir, records[state]);
    }
    const root = join(stateDir, ATTEMPT_JOURNAL_DIRECTORY);
    const sentinel = join(stateDir, "staging-sentinel");
    await writeFile(sentinel, "untouched", { mode: 0o600 });
    const staged = Array.from({ length: 33 }, (_, index) => {
      const identity = index.toString(16).padStart(32, "0");
      const suffix = index.toString(16).padStart(8, "0");
      return `pruned-att_${identity}-1234567890-${suffix}`;
    });
    await writeFile(join(root, staged[0]), "not-a-directory", {
      mode: 0o600,
    });
    await symlink(sentinel, join(root, staged[1]));
    await mkdir(join(root, staged[2]), { mode: 0o755 });
    await chmod(join(root, staged[2]), 0o755);
    await mkdir(join(root, staged[3]), { mode: 0o700 });
    await chmod(join(root, staged[3]), 0o300);
    await mkdir(join(root, staged[4]), { mode: 0o700 });
    const nested = join(root, staged[4], "nested");
    await mkdir(nested, { mode: 0o700 });
    await writeFile(join(nested, "blocked"), "bounded", { mode: 0o600 });
    await chmod(nested, 0o500);
    for (const name of staged.slice(5)) {
      await writeFile(join(root, name), "bounded", { mode: 0o600 });
    }
    const corruptions = [];
    const warnings = [];
    const result = await pruneSettledAttemptJournals(stateDir, {
      nowMs: Date.parse(records.settled.createdAt) +
        SETTLED_ATTEMPT_RETENTION_MS,
      onCorrupt(value) {
        corruptions.push(value);
      },
      onWarning(value) {
        warnings.push(value);
      },
    });
    assert.deepEqual(result.removed, [attemptId]);
    assert.equal(result.attempts.length, 0);
    assert.equal(corruptions.length, 32);
    assert.deepEqual(warnings, []);
    assert.equal(await readFile(sentinel, "utf8"), "untouched");
    assert.equal(
      (await readdir(root)).filter((name) =>
        name.startsWith("pruned-")
      ).length,
      1,
    );
    const quarantined = await readdir(join(root, "corrupt"));
    assert.ok(
      staged.slice(0, 32).every((name) =>
        quarantined.some((value) => value.startsWith(`${name}.`))
      ),
    );
    const corruptDirectory = join(root, "corrupt");
    const directoryPermissionEvent = corruptions.find(
      (value) => value.attemptId === `att_${"3".padStart(32, "0")}`,
    );
    const nestedPermissionEvent = corruptions.find(
      (value) => value.attemptId === `att_${"4".padStart(32, "0")}`,
    );
    assert.match(
      nestedPermissionEvent.reason,
      /staging removal is unsafe/u,
    );
    await chmod(
      join(corruptDirectory, directoryPermissionEvent.quarantinedAs),
      0o700,
    );
    await chmod(
      join(
        corruptDirectory,
        nestedPermissionEvent.quarantinedAs,
        "nested",
      ),
      0o700,
    );
  });

  await t.test("unsafe fresh removal is quarantined after atomic rename", async (t) => {
    const stateDir = await privateStateDir(
      t,
      "nexus-attempt-fresh-quarantine-",
    );
    const records = await fixtureRecords();
    for (const state of states) {
      await persistAttemptRecord(stateDir, records[state]);
    }
    const siblingRecords = cloneSettledRecords(
      records,
      "b".repeat(32),
    );
    for (const state of states) {
      await persistAttemptRecord(stateDir, siblingRecords[state]);
    }
    const root = join(stateDir, ATTEMPT_JOURNAL_DIRECTORY);
    const temporary = join(
      root,
      attemptId,
      "settled.json.tmp-123-abcdef12",
    );
    const nested = join(temporary, "nested");
    await mkdir(temporary, { mode: 0o700 });
    await mkdir(nested, { mode: 0o700 });
    await writeFile(join(nested, "blocked"), "bounded", { mode: 0o600 });
    await chmod(nested, 0o500);
    const corruptions = [];
    const warnings = [];
    const result = await pruneSettledAttemptJournals(stateDir, {
      nowMs: Date.parse(records.settled.createdAt) +
        SETTLED_ATTEMPT_RETENTION_MS,
      onCorrupt(value) {
        corruptions.push(value);
      },
      onWarning(value) {
        warnings.push(value);
      },
    });
    assert.deepEqual(
      [...result.removed].sort(),
      [attemptId, siblingRecords.claimed.attemptId].sort(),
    );
    assert.deepEqual(result.attempts, []);
    assert.equal(warnings.length, 1);
    assert.deepEqual(
      warnings.map((value) => value.attemptId),
      [attemptId],
    );
    assert.equal(corruptions.length, 1);
    assert.equal(corruptions[0].attemptId, attemptId);
    assert.match(
      corruptions[0].reason,
      /staging removal is unsafe/u,
    );
    const corruptDirectory = join(root, "corrupt");
    const quarantined = join(
      corruptDirectory,
      corruptions[0].quarantinedAs,
    );
    await assert.rejects(stat(join(root, attemptId)), { code: "ENOENT" });
    await assert.rejects(
      stat(join(root, siblingRecords.claimed.attemptId)),
      { code: "ENOENT" },
    );
    await chmod(join(quarantined, "settled.json.tmp-123-abcdef12", "nested"), 0o700);
  });
});

test("cross-record identity, engine, time and completion commitments fail closed", async () => {
  const records = await fixtureRecords();
  const invalidSets = [
    {
      ...records,
      starting: finalizeAttemptRecord({
        ...withoutChecksum(records.starting),
        attemptId: `att_${"b".repeat(32)}`,
      }),
    },
    {
      ...records,
      starting: finalizeAttemptRecord({
        ...withoutChecksum(records.starting),
        engine: "codex_cli",
      }),
    },
    {
      ...records,
      result: finalizeAttemptRecord({
        ...withoutChecksum(records.result),
        receipt: {
          ...records.result.receipt,
          engineVersion: "9.9.9",
        },
      }),
    },
    {
      ...records,
      starting: finalizeAttemptRecord({
        ...withoutChecksum(records.starting),
        createdAt: "2026-07-27T11:59:59.000Z",
      }),
    },
    {
      ...records,
      supervisor: finalizeAttemptRecord({
        ...withoutChecksum(records.supervisor),
        createdAt: "2026-07-27T12:00:00.000Z",
      }),
    },
    {
      ...records,
      started: finalizeAttemptRecord({
        ...withoutChecksum(records.started),
        createdAt: "2026-07-27T12:00:01.000Z",
      }),
    },
    {
      ...records,
      result: finalizeAttemptRecord({
        ...withoutChecksum(records.result),
        createdAt: "2026-07-27T12:00:02.000Z",
      }),
    },
    {
      ...records,
      outboxed: finalizeAttemptRecord({
        ...withoutChecksum(records.outboxed),
        createdAt: "2026-07-27T12:00:03.000Z",
      }),
    },
    {
      ...records,
      outboxed: finalizeAttemptRecord({
        ...withoutChecksum(records.outboxed),
        bodySha256: "0".repeat(64),
      }),
    },
    {
      claimed: records.claimed,
      starting: finalizeAttemptRecord({
        ...withoutChecksum(records.starting),
        createdAt: "2026-07-27T12:01:01.000Z",
      }),
    },
    {
      claimed: records.claimed,
      starting: records.starting,
      supervisor: records.supervisor,
      started: finalizeAttemptRecord({
        ...withoutChecksum(records.started),
        startedAt: "2026-07-27T12:00:01.000Z",
      }),
    },
    {
      claimed: records.claimed,
      starting: records.starting,
      supervisor: records.supervisor,
      started: finalizeAttemptRecord({
        ...withoutChecksum(records.started),
        startedAt: "2026-07-27T12:00:04.000Z",
      }),
    },
    {
      claimed: records.claimed,
      result: finalizeAttemptRecord({
        ...withoutChecksum(records.result),
        receipt: {
          ...records.result.receipt,
          startedAt: "2026-07-27T12:00:02.000Z",
        },
      }),
      starting: records.starting,
      supervisor: records.supervisor,
    },
    {
      claimed: records.claimed,
      result: finalizeAttemptRecord({
        ...withoutChecksum(records.result),
        createdAt: "2026-07-27T12:00:03.500Z",
      }),
      started: records.started,
      starting: records.starting,
      supervisor: records.supervisor,
    },
    {
      ...records,
      outboxed: finalizeAttemptRecord({
        ...withoutChecksum(records.outboxed),
        bodySha256: completionBodySha(
          records,
          records.claimed.claimOperationId,
        ),
        operationId: records.claimed.claimOperationId,
      }),
    },
    {
      claimed: records.claimed,
      result: finalizeAttemptRecord({
        ...withoutChecksum(records.result),
        receipt: {
          ...records.result.receipt,
          engine: "codex_cli",
        },
      }),
      started: records.started,
      starting: records.starting,
      supervisor: records.supervisor,
    },
    {
      claimed: records.claimed,
      result: finalizeAttemptRecord({
        ...withoutChecksum(records.result),
        receipt: {
          ...records.result.receipt,
          startedAt: "2026-07-27T12:00:02.500Z",
        },
      }),
      started: records.started,
      starting: records.starting,
      supervisor: records.supervisor,
    },
    {
      claimed: records.claimed,
      result: finalizeAttemptRecord({
        attemptId,
        createdAt: "2026-07-27T12:00:01.500Z",
        receipt: spawnFailedReceipt(records, {
          finishedAt: "2026-07-27T12:00:02.000Z",
          startedAt: "2026-07-27T12:00:02.000Z",
        }),
        state: "result",
        v: 1,
      }),
      starting: records.starting,
      supervisor: records.supervisor,
    },
    {
      claimed: records.claimed,
      outboxed: records.outboxed,
      starting: records.starting,
      supervisor: records.supervisor,
    },
  ];
  for (const invalid of invalidSets) {
    assert.equal(validateAttemptRecordSet(invalid), undefined);
  }
});

test("a pre-child closed failure may reach result without inventing started", async () => {
  const records = await fixtureRecords();
  const receipt = {
    ...records.result.receipt,
    exitCode: null,
    finishedAt: "2026-07-27T12:00:03.000Z",
    reason: "spawn_failed",
    startedAt: "2026-07-27T12:00:02.000Z",
    status: "failed",
    stderr: {
      bytes: 0,
      excerptBase64Url: "",
      sha256: emptySha256,
      truncated: false,
    },
    stdout: {
      bytes: 0,
      excerptBase64Url: "",
      sha256: emptySha256,
      truncated: false,
    },
    summary: "spawn_failed",
  };
  const prestart = finalizeAttemptRecord({
    attemptId,
    createdAt: "2026-07-27T12:00:03.000Z",
    receipt,
    state: "result",
    v: 1,
  });
  const valid = validateAttemptRecordSet({
    claimed: records.claimed,
    result: prestart,
    starting: records.starting,
    supervisor: records.supervisor,
  });
  assert.ok(valid);
  assert.deepEqual(attemptRecoveryDecision(valid), {
    action: "persist_completion",
    state: "result",
  });
  assert.equal(
    validateAttemptRecordSet({
      claimed: records.claimed,
      result: records.result,
      starting: records.starting,
      supervisor: records.supervisor,
    }),
    undefined,
  );
  const postChildReason = finalizeAttemptRecord({
    ...withoutChecksum(prestart),
    receipt: {
      ...prestart.receipt,
      reason: "protocol_invalid",
      summary: "protocol_invalid",
    },
  });
  assert.equal(
    validateAttemptRecordSet({
      claimed: records.claimed,
      result: postChildReason,
      starting: records.starting,
      supervisor: records.supervisor,
    }),
    undefined,
  );
  for (const flags of [
    { timedOut: true },
    { cancelRequested: true },
  ]) {
    const inconsistent = finalizeAttemptRecord({
      ...withoutChecksum(prestart),
      receipt: {
        ...prestart.receipt,
        ...flags,
      },
    });
    assert.equal(
      validateAttemptRecordSet({
        claimed: records.claimed,
        result: inconsistent,
        starting: records.starting,
        supervisor: records.supervisor,
      }),
      undefined,
    );
  }
});

test("claim records commit to the exact replay body and reject drift", async () => {
  const claimed = JSON.parse(await fixture("claimed"));
  for (const mutation of [
    { claimOperationId: `op_${"9".repeat(32)}` },
    { engine: "codex_cli" },
    { claimBodySha256: "0".repeat(64) },
  ]) {
    assert.throws(
      () =>
        finalizeAttemptRecord({
          ...withoutChecksum(claimed),
          ...mutation,
        }),
      /Invalid attempt journal record/u,
    );
  }
  const source = await readFile(
    new URL("./runs-api.integration.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /operationReplay\.headers\.get\("x-nexus-replay"\)/u);
  assert.match(source, /await operationReplay\.text\(\), claimText/u);
});

test("the store appends immutable state files and recovers the final decision", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-attempt-journal-");
  const records = await fixtureRecords();
  let persisted;
  for (const state of states) {
    persisted = await persistAttemptRecord(stateDir, records[state]);
  }
  assert.ok(Object.isFrozen(persisted));
  assert.ok(Object.isFrozen(persisted.result.receipt.stdout));
  const directory = join(
    stateDir,
    ATTEMPT_JOURNAL_DIRECTORY,
    attemptId,
  );
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const state of states) {
    const path = join(directory, `${state}.json`);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readFile(path, "utf8"), await fixture(state));
  }
  const before = await readFile(join(directory, "outboxed.json"), "utf8");
  await assert.rejects(
    persistAttemptRecord(stateDir, records.outboxed),
    (error) =>
      error instanceof AttemptJournalError &&
      /already exists/u.test(error.message),
  );
  assert.equal(
    await readFile(join(directory, "outboxed.json"), "utf8"),
    before,
  );
  const staleTemporary = join(
    directory,
    "result.json.tmp-123-aaaaaaaa",
  );
  await writeFile(
    staleTemporary,
    "partial",
    { mode: 0o600 },
  );
  await utimes(staleTemporary, new Date(0), new Date(0));
  const activeTemporary = join(
    directory,
    "result.json.tmp-123-bbbbbbbb",
  );
  await writeFile(activeTemporary, "active", { mode: 0o600 });
  const recentOlderTemporary = join(
    directory,
    "result.json.tmp-123-cccccccc",
  );
  await writeFile(recentOlderTemporary, "recent", { mode: 0o600 });
  const recent = new Date(Date.now() - 60_000);
  await utimes(recentOlderTemporary, recent, recent);
  const recovered = await recoverAttemptJournals(stateDir);
  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0].decision, {
    action: "settled",
    outcome: "acked",
    state: "settled",
  });
  await assert.rejects(
    stat(staleTemporary),
    { code: "ENOENT" },
  );
  assert.equal(await readFile(activeTemporary, "utf8"), "active");
  assert.equal(
    await readFile(recentOlderTemporary, "utf8"),
    "recent",
  );
});

test("unsafe temp cleanup warns without discarding a valid attempt", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-attempt-temp-warning-");
  const records = await fixtureRecords();
  for (const state of states) {
    await persistAttemptRecord(stateDir, records[state]);
  }
  const directory = join(
    stateDir,
    ATTEMPT_JOURNAL_DIRECTORY,
    attemptId,
  );
  const unsafeTemporary = join(
    directory,
    "result.json.tmp-124-cccccccc",
  );
  await writeFile(unsafeTemporary, "unsafe", { mode: 0o600 });
  await chmod(unsafeTemporary, 0o644);
  const staleTemporary = join(
    directory,
    "result.json.tmp-124-dddddddd",
  );
  await writeFile(staleTemporary, "stale", { mode: 0o600 });
  await utimes(staleTemporary, new Date(0), new Date(0));
  const corrupt = [];
  const warnings = [];
  const recovered = await recoverAttemptJournals(
    stateDir,
    (event) => corrupt.push(event),
    (event) => warnings.push(event),
  );
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].decision.action, "settled");
  assert.deepEqual(corrupt, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].reason, /temporary file is unsafe/u);
  assert.equal((await stat(directory)).isDirectory(), true);
  await assert.rejects(stat(staleTemporary), { code: "ENOENT" });
});

test("invalid transitions fail before a state file is created", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-attempt-transition-");
  const records = await fixtureRecords();
  await persistAttemptRecord(stateDir, records.claimed);
  await assert.rejects(
    persistAttemptRecord(stateDir, records.started),
    /transition is invalid/u,
  );
  await assert.rejects(
    stat(
      join(
        stateDir,
        ATTEMPT_JOURNAL_DIRECTORY,
        attemptId,
        "started.json",
      ),
    ),
    { code: "ENOENT" },
  );
});

test("persisting a non-claim state without an attempt is a typed error", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-attempt-missing-");
  const records = await fixtureRecords();
  await assert.rejects(
    persistAttemptRecord(stateDir, records.starting),
    (error) =>
      error instanceof AttemptJournalError &&
      error.code === "attempt_journal_invalid" &&
      /does not exist/u.test(error.message),
  );
});

test("corrupt, unsafe and unknown attempt contents quarantine the whole attempt", async (t) => {
  for (const scenario of [
    "checksum",
    "permissions",
    "directory_permissions",
    "symlink",
    "unknown",
  ]) {
    await t.test(scenario, async (t) => {
      const stateDir = await privateStateDir(
        t,
        `nexus-attempt-${scenario}-`,
      );
      const claimed = JSON.parse(await fixture("claimed"));
      await persistAttemptRecord(stateDir, claimed);
      const directory = join(
        stateDir,
        ATTEMPT_JOURNAL_DIRECTORY,
        attemptId,
      );
      if (scenario === "checksum") {
        await writeFile(join(directory, "claimed.json"), "{}\n", {
          mode: 0o600,
        });
      } else if (scenario === "permissions") {
        await chmod(join(directory, "claimed.json"), 0o644);
      } else if (scenario === "directory_permissions") {
        await chmod(directory, 0o300);
      } else if (scenario === "symlink") {
        await symlink("claimed.json", join(directory, "starting.json"));
      } else {
        await writeFile(join(directory, "unknown.tmp-marker"), "x", {
          mode: 0o600,
        });
      }
      const events = [];
      assert.deepEqual(
        await recoverAttemptJournals(
          stateDir,
          (event) => events.push(event),
        ),
        [],
      );
      assert.equal(events.length, 1);
      await assert.rejects(stat(directory), { code: "ENOENT" });
      const corruptDirectory = join(
        stateDir,
        ATTEMPT_JOURNAL_DIRECTORY,
        "corrupt",
      );
      const corruptNames = await readdir(corruptDirectory);
      assert.equal(corruptNames.length, 1);
      if (scenario === "directory_permissions") {
        await chmod(join(corruptDirectory, corruptNames[0]), 0o700);
      }
    });
  }
});

test("prototype-named denial sources quarantine instead of aborting recovery", async (t) => {
  const stateDir = await privateStateDir(
    t,
    "nexus-attempt-denial-prototype-",
  );
  const claimed = JSON.parse(await fixture("claimed"));
  await persistAttemptRecord(stateDir, claimed);
  const body = {
    attemptId,
    createdAt: "2026-07-27T12:00:01.000Z",
    denial: {
      httpStatus: 409,
      observedAt: "2026-07-27T12:00:01.000Z",
      serverError: "run_unavailable",
      source: "toString",
    },
    operationId: claimed.claimOperationId,
    outcome: "abandoned",
    state: "settled",
    v: 1,
  };
  const record = {
    ...body,
    recordSha256: attemptRecordChecksum(body),
  };
  const directory = join(
    stateDir,
    ATTEMPT_JOURNAL_DIRECTORY,
    attemptId,
  );
  await writeFile(
    join(directory, "settled.json"),
    `${canonicalJson(record)}\n`,
    { mode: 0o600 },
  );
  const events = [];
  assert.deepEqual(
    await recoverAttemptJournals(
      stateDir,
      (event) => events.push(event),
    ),
    [],
  );
  assert.equal(events.length, 1);
  assert.match(events[0].reason, /journal record is invalid/u);
  await assert.rejects(stat(directory), { code: "ENOENT" });
});

test("recovery quarantines an attempt whose directory identity drifted", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-attempt-dir-id-");
  const claimed = JSON.parse(await fixture("claimed"));
  await persistAttemptRecord(stateDir, claimed);
  const journal = join(stateDir, ATTEMPT_JOURNAL_DIRECTORY);
  const driftedId = `att_${"b".repeat(32)}`;
  await rename(join(journal, attemptId), join(journal, driftedId));
  const events = [];
  assert.deepEqual(
    await recoverAttemptJournals(
      stateDir,
      (event) => events.push(event),
    ),
    [],
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].attemptId, driftedId);
  assert.match(events[0].reason, /directory identity/u);
});

test("journal root symlinks fail without chmodding their target", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-attempt-root-link-");
  const target = join(stateDir, "target");
  await mkdir(target, { mode: 0o755 });
  await symlink(target, join(stateDir, ATTEMPT_JOURNAL_DIRECTORY));
  await assert.rejects(
    ensureAttemptJournal(stateDir),
    /real private directories/u,
  );
  assert.equal((await lstat(target)).mode & 0o777, 0o755);
  await assert.rejects(stat(join(target, "corrupt")), { code: "ENOENT" });
});

test("pre-existing owner-restricted roots fail without widening permissions", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-attempt-root-mode-");
  const journal = join(stateDir, ATTEMPT_JOURNAL_DIRECTORY);
  await mkdir(journal, { mode: 0o500 });
  await chmod(journal, 0o500);
  await assert.rejects(
    ensureAttemptJournal(stateDir),
    /owner rwx permissions/u,
  );
  assert.equal((await lstat(journal)).mode & 0o777, 0o500);
});

test("the dark journal modules import no network or process-spawn surface", async () => {
  for (const relative of [
    "../runner/attempt-journal-contract.mjs",
    "../runner/attempt-journal-store.mjs",
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /node:child_process|\bspawn\s*\(|\bfork\s*\(|\bfetch\s*\(/u,
    );
  }
  const storeSource = await readFile(
    new URL("../runner/attempt-journal-store.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    storeSource,
    /if \(!\(error instanceof AttemptJournalError\)\) throw error;/u,
  );
  assert.match(storeSource, /O_NOFOLLOW/u);
  assert.match(storeSource, /O_DIRECTORY/u);
  assert.doesNotMatch(storeSource, /\bchmod\(path/u);
  assert.match(
    storeSource,
    /if \(error\?\.code === "ENOENT"\) continue;/u,
  );
  const contractSource = await readFile(
    new URL("../runner/attempt-journal-contract.mjs", import.meta.url),
    "utf8",
  );
  assert.match(contractSource, /ENGINE_COMPLETION_MAX_BYTES/u);
  assert.match(
    contractSource,
    /Buffer\.byteLength\(completionBody, "utf8"\)/u,
  );
});

async function fixtureRecords() {
  return Object.fromEntries(
    await Promise.all(
      states.map(async (state) => [
        state,
        JSON.parse(await fixture(state)),
      ]),
    ),
  );
}

function fixture(state) {
  return readFile(
    new URL(
      `./fixtures/s6-b4/attempt-${state}-v1.json`,
      import.meta.url,
    ),
    "utf8",
  );
}

function withoutChecksum(record) {
  const value = { ...record };
  delete value.recordSha256;
  return value;
}

function priorReaderAction(reader, records) {
  if (
    (!reader.knowsSpawning && records.spawning) ||
    (reader.requiresSupervisorForResult &&
      records.result &&
      !records.supervisor) ||
    (reader.requiresOutboxedForSettled &&
      records.settled &&
      !records.outboxed)
  ) {
    return reader.onInvalidRecord;
  }
  return "recover";
}

function cloneSettledRecords(records, identity) {
  const attemptId = `att_${identity}`;
  const claimOperationId = `op_${identity}`;
  const runId = `run_${identity}`;
  const copy = {};
  copy.claimed = finalizeAttemptRecord({
    ...withoutChecksum(records.claimed),
    attemptId,
    claimBodySha256: createHash("sha256")
      .update(canonicalJson({
        engine: records.claimed.engine,
        operationId: claimOperationId,
      }))
      .digest("hex"),
    claimOperationId,
    runId,
  });
  for (const state of ["starting", "supervisor", "started", "result"]) {
    copy[state] = finalizeAttemptRecord({
      ...withoutChecksum(records[state]),
      attemptId,
      ...(state === "starting" ? { runId } : {}),
    });
  }
  const operationId = `op_${createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 32)}`;
  copy.outboxed = finalizeAttemptRecord({
    ...withoutChecksum(records.outboxed),
    attemptId,
    bodySha256: completionBodySha(copy, operationId),
    operationId,
  });
  copy.settled = finalizeAttemptRecord({
    ...withoutChecksum(records.settled),
    attemptId,
    operationId,
  });
  return copy;
}

function completionBodySha(records, operationId) {
  return createHash("sha256")
    .update(
      canonicalJson({
        fence: records.starting.fence,
        leaseId: records.starting.leaseId,
        operationId,
        receipt: records.result.receipt,
      }),
    )
    .digest("hex");
}

function spawnFailedReceipt(records, overrides = {}) {
  return {
    ...records.result.receipt,
    exitCode: null,
    reason: "spawn_failed",
    status: "failed",
    stderr: {
      bytes: 0,
      excerptBase64Url: "",
      sha256: emptySha256,
      truncated: false,
    },
    stdout: {
      bytes: 0,
      excerptBase64Url: "",
      sha256: emptySha256,
      truncated: false,
    },
    summary: "spawn_failed",
    ...overrides,
  };
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

async function privateStateDir(t, prefix) {
  const stateDir = await mkdtemp(join(tmpdir(), prefix));
  await chmod(stateDir, 0o700);
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}
