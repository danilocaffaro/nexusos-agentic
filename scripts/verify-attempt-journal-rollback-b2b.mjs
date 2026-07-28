#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixturesRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "s6-b4",
);
const manifest = JSON.parse(
  await readFile(
    join(fixturesRoot, "attempt-journal-pre-b2b-reader.json"),
    "utf8",
  ),
);
const gateRoot = await mkdtemp(
  join(tmpdir(), "nexus-attempt-rollback-b2b-"),
);
const previousRoot = join(gateRoot, "previous");
let worktreeAdded = false;

try {
  await execFileAsync(
    "git",
    ["worktree", "add", "--detach", previousRoot, manifest.readerCommit],
    { cwd: repositoryRoot },
  );
  worktreeAdded = true;
  const previousStore = await import(
    pathToFileURL(
      join(previousRoot, "runner", "attempt-journal-store.mjs"),
    ).href
  );
  const currentContract = await import(
    pathToFileURL(
      join(repositoryRoot, "runner", "attempt-journal-contract.mjs"),
    ).href
  );
  const currentRuntime = await import(
    pathToFileURL(
      join(repositoryRoot, "runner", "engine-lease-runtime-contract.mjs"),
    ).href
  );
  const currentStore = await import(
    pathToFileURL(
      join(repositoryRoot, "runner", "attempt-journal-store.mjs"),
    ).href
  );
  const claimedText = await fixture("claimed");
  const startingText = await fixture("starting");
  const claimed = currentContract.parseAttemptRecordText(
    claimedText,
    "claimed",
  );
  const starting = currentContract.parseAttemptRecordText(
    startingText,
    "starting",
  );
  assert.ok(claimed);
  assert.ok(starting);
  const canceling = currentRuntime.createPrestartCancelingRecord({
    claimed,
    createdAt: "2026-07-27T12:00:02.000Z",
    observedAt: "2026-07-27T12:00:01.500Z",
    renewal: {
      cancelRequested: true,
      expiresAt: starting.expiresAt,
      fence: starting.fence,
      leaseId: starting.leaseId,
      runId: starting.runId,
    },
    starting,
  });
  const cancelingFiles = {
    "canceling.json": `${canonicalJson(canceling)}\n`,
    "claimed.json": claimedText,
    "starting.json": startingText,
  };

  const currentCancelState = join(gateRoot, "current-canceling");
  await materializeJournal(
    currentCancelState,
    currentStore.ATTEMPT_JOURNAL_DIRECTORY,
    cancelingFiles,
  );
  const currentCancel = await currentStore.recoverAttemptJournals(
    currentCancelState,
  );
  assert.equal(currentCancel.length, 1);
  assert.equal(
    currentCancel[0].decision.action,
    manifest.expectations.cancelingJournal.current,
  );

  const previousCancelState = join(gateRoot, "previous-canceling");
  await materializeJournal(
    previousCancelState,
    previousStore.ATTEMPT_JOURNAL_DIRECTORY,
    cancelingFiles,
  );
  const corruptions = [];
  assert.deepEqual(
    await previousStore.recoverAttemptJournals(
      previousCancelState,
      (corruption) => corruptions.push(corruption),
    ),
    [],
  );
  assert.equal(corruptions.length, 1);
  assert.equal(
    (await readdir(
      join(
        previousCancelState,
        previousStore.ATTEMPT_JOURNAL_DIRECTORY,
        "corrupt",
      ),
    )).length,
    1,
  );

  const startingFiles = {
    "claimed.json": claimedText,
    "starting.json": startingText,
  };
  for (const [name, store, expected] of [
    [
      "current-starting",
      currentStore,
      manifest.expectations.startingJournal.current,
    ],
    [
      "previous-starting",
      previousStore,
      manifest.expectations.startingJournal.previous,
    ],
  ]) {
    const stateDir = join(gateRoot, name);
    await materializeJournal(
      stateDir,
      store.ATTEMPT_JOURNAL_DIRECTORY,
      startingFiles,
    );
    const recovered = await store.recoverAttemptJournals(stateDir);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].decision.action, expected);
  }

  process.stdout.write(`${JSON.stringify({
    previousReader: manifest.readerCommit,
    results: [
      {
        current: currentCancel[0].decision.action,
        previous: "quarantine_attempt",
        scenario: "cancelingJournal",
      },
      {
        current: manifest.expectations.startingJournal.current,
        previous: manifest.expectations.startingJournal.previous,
        scenario: "startingJournal",
      },
    ],
    status: "GO",
  })}\n`);
} finally {
  if (worktreeAdded) {
    await execFileAsync(
      "git",
      ["worktree", "remove", "--force", previousRoot],
      { cwd: repositoryRoot },
    );
  }
  await rm(gateRoot, { force: true, recursive: true });
}

function fixture(name) {
  return readFile(
    join(fixturesRoot, `attempt-${name}-v1.json`),
    "utf8",
  );
}

async function materializeJournal(stateDir, directoryName, files) {
  const attemptDir = join(
    stateDir,
    directoryName,
    "att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  await mkdir(attemptDir, { mode: 0o700, recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(attemptDir, name), text, { mode: 0o600 });
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
