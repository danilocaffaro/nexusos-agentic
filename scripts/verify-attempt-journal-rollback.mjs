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
    join(fixturesRoot, "attempt-journal-pre-b2a-reader.json"),
    "utf8",
  ),
);
const gateRoot = await mkdtemp(
  join(tmpdir(), "nexus-attempt-rollback-gate-"),
);
const previousRoot = join(gateRoot, "previous");
let worktreeAdded = false;

try {
  await execFileAsync(
    "git",
    [
      "worktree",
      "add",
      "--detach",
      previousRoot,
      manifest.readerCommit,
    ],
    { cwd: repositoryRoot },
  );
  worktreeAdded = true;
  const previousContract = await import(
    pathToFileURL(
      join(previousRoot, "runner", "attempt-journal-contract.mjs"),
    ).href
  );
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
  const currentStore = await import(
    pathToFileURL(
      join(repositoryRoot, "runner", "attempt-journal-store.mjs"),
    ).href
  );
  const baseline = {
    claimed: await fixture("claimed"),
    legacyStarting: await fixture("legacy-starting"),
    starting: await fixture("starting"),
    supervisor: await fixture("supervisor"),
  };
  const scenarios = [
    {
      files: {
        "claimed.json": baseline.claimed,
        "settled.json": await fixture("prestart-rejection"),
      },
      key: "prestartRejection",
    },
    {
      files: {
        "claimed.json": baseline.claimed,
        "result.json": await fixture("prestart-canceled-result"),
        "starting.json": await fixture(
          "prestart-canceled-starting",
        ),
      },
      key: "prestartCanceledResult",
    },
    {
      files: {
        "claimed.json": baseline.claimed,
        "settled.json": await fixture("prompt-denial"),
        "starting.json": baseline.starting,
      },
      key: "promptDenial",
    },
    {
      files: {
        "claimed.json": baseline.claimed,
        "starting.json": baseline.starting,
      },
      key: "startingWithCancelFlag",
    },
  ];
  const results = [];
  for (const scenario of scenarios) {
    const currentRecords = {};
    const previousRecords = {};
    for (const [name, text] of Object.entries(scenario.files)) {
      const state = name.slice(0, -".json".length);
      currentRecords[state] =
        currentContract.parseAttemptRecordText(text, state);
      previousRecords[state] =
        previousContract.parseAttemptRecordText(text, state);
    }
    assert.ok(
      currentContract.validateAttemptRecordSet(currentRecords),
      `${scenario.key}: current reader must recover`,
    );
    assert.equal(
      previousContract.validateAttemptRecordSet(previousRecords),
      undefined,
      `${scenario.key}: previous reader must quarantine`,
    );
    const stateDir = join(gateRoot, scenario.key);
    const attemptDir = join(
      stateDir,
      previousStore.ATTEMPT_JOURNAL_DIRECTORY,
      "att_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    await mkdir(attemptDir, { mode: 0o700, recursive: true });
    for (const [name, text] of Object.entries(scenario.files)) {
      await writeFile(join(attemptDir, name), text, { mode: 0o600 });
    }
    const corruptions = [];
    const recovered = await previousStore.recoverAttemptJournals(
      stateDir,
      (corruption) => corruptions.push(corruption),
    );
    assert.deepEqual(recovered, []);
    assert.equal(corruptions.length, 1);
    assert.equal(
      (await readdir(
        join(
          stateDir,
          previousStore.ATTEMPT_JOURNAL_DIRECTORY,
          "corrupt",
        ),
      )).length,
      1,
    );
    results.push({
      current: "recover",
      previous: "quarantine_attempt",
      scenario: scenario.key,
    });
  }

  const legacyFiles = {
    "claimed.json": baseline.claimed,
    "starting.json": baseline.legacyStarting,
    "supervisor.json": baseline.supervisor,
  };
  const previousLegacy = previousContract.validateAttemptRecordSet({
    claimed: previousContract.parseAttemptRecordText(
      baseline.claimed,
      "claimed",
    ),
    starting: previousContract.parseAttemptRecordText(
      baseline.legacyStarting,
      "starting",
    ),
    supervisor: previousContract.parseAttemptRecordText(
      baseline.supervisor,
      "supervisor",
    ),
  });
  assert.ok(previousLegacy);
  const previousLegacyState = join(gateRoot, "previous-legacy");
  await materializeJournal(
    previousLegacyState,
    previousStore.ATTEMPT_JOURNAL_DIRECTORY,
    legacyFiles,
  );
  assert.equal(
    (await previousStore.recoverAttemptJournals(
      previousLegacyState,
    )).length,
    1,
  );
  assert.equal(
    currentContract.validateAttemptRecordSet({
      claimed: currentContract.parseAttemptRecordText(
        baseline.claimed,
        "claimed",
      ),
      starting: currentContract.parseAttemptRecordText(
        baseline.legacyStarting,
        "starting",
      ),
      supervisor: currentContract.parseAttemptRecordText(
        baseline.supervisor,
        "supervisor",
      ),
    }),
    undefined,
  );
  const currentLegacyState = join(gateRoot, "current-legacy");
  await materializeJournal(
    currentLegacyState,
    currentStore.ATTEMPT_JOURNAL_DIRECTORY,
    legacyFiles,
  );
  const currentCorruptions = [];
  assert.deepEqual(
    await currentStore.recoverAttemptJournals(
      currentLegacyState,
      (corruption) => currentCorruptions.push(corruption),
    ),
    [],
  );
  assert.equal(currentCorruptions.length, 1);
  assert.equal(
    (await readdir(
      join(
        currentLegacyState,
        currentStore.ATTEMPT_JOURNAL_DIRECTORY,
        "corrupt",
      ),
    )).length,
    1,
  );
  results.push({
    current: "quarantine_attempt",
    previous: "recover",
    scenario: "legacySupervisorWithoutSpawning",
  });

  for (const result of results) {
    assert.deepEqual(
      {
        current: manifest.expectations[result.scenario].current,
        previous: manifest.expectations[result.scenario].previous,
      },
      {
        current: result.current,
        previous: result.previous,
      },
    );
  }
  assert.deepEqual(
    Object.keys(manifest.expectations).sort(),
    results.map((result) => result.scenario).sort(),
  );
  process.stdout.write(`${JSON.stringify({
    previousReader: manifest.readerCommit,
    results,
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
