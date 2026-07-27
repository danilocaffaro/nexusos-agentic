import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import {
  ATTEMPT_RECORD_STATES,
  attemptRecoveryDecision,
  isAttemptRecord,
  parseAttemptRecordText,
  validateAttemptRecordSet,
} from "./attempt-journal-contract.mjs";

export const ATTEMPT_JOURNAL_DIRECTORY = "attempts-v1";

const PROCESS_STARTED_AT_MS = Date.now();
const STALE_TEMPORARY_AFTER_MS = 300_000;
const ATTEMPT_PATTERN = /^att_[0-9a-f]{32}$/u;
const RECORD_FILE_BY_STATE = Object.freeze({
  claimed: "claimed.json",
  outboxed: "outboxed.json",
  result: "result.json",
  started: "started.json",
  starting: "starting.json",
  supervisor: "supervisor.json",
});
const STATE_BY_RECORD_FILE = Object.freeze(
  Object.fromEntries(
    Object.entries(RECORD_FILE_BY_STATE).map(([state, file]) => [
      file,
      state,
    ]),
  ),
);
const TEMPORARY_RECORD_PATTERN =
  /^(?:claimed|starting|supervisor|started|result|outboxed)\.json\.tmp-\d+-[0-9a-f]{8}$/u;

export class AttemptJournalError extends Error {
  constructor(message, code = "attempt_journal_invalid") {
    super(message);
    this.code = code;
  }
}

export function attemptJournalPaths(stateDir) {
  const directory = join(stateDir, ATTEMPT_JOURNAL_DIRECTORY);
  return {
    corrupt: join(directory, "corrupt"),
    directory,
  };
}

export async function ensureAttemptJournal(stateDir) {
  const paths = attemptJournalPaths(stateDir);
  await ensureOwnedDirectory(paths.directory);
  await ensureOwnedDirectory(paths.corrupt);
  return paths;
}

export async function persistAttemptRecord(stateDir, record) {
  if (
    !record ||
    !ATTEMPT_RECORD_STATES.includes(record.state) ||
    !ATTEMPT_PATTERN.test(record.attemptId ?? "") ||
    !isAttemptRecord(record)
  ) {
    throw new AttemptJournalError("Attempt journal record is invalid.");
  }
  const paths = await ensureAttemptJournal(stateDir);
  const attemptDirectory = join(paths.directory, record.attemptId);
  if (record.state === "claimed") {
    try {
      await mkdir(attemptDirectory, { mode: 0o700 });
      await assertPrivateDirectory(attemptDirectory);
      await syncDirectory(paths.directory);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new AttemptJournalError("Attempt journal already exists.");
      }
      throw error;
    }
  } else {
    try {
      await assertPrivateDirectory(attemptDirectory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new AttemptJournalError("Attempt journal does not exist.");
      }
      throw error;
    }
  }
  const existing = await readAttemptRecords(attemptDirectory);
  if (existing[record.state]) {
    throw new AttemptJournalError("Attempt journal state already exists.");
  }
  const next = { ...existing, [record.state]: record };
  const validNext = validateAttemptRecordSet(next);
  if (!validNext) {
    throw new AttemptJournalError("Attempt journal transition is invalid.");
  }
  await writeRecordExclusive(
    attemptDirectory,
    RECORD_FILE_BY_STATE[record.state],
    validNext[record.state],
  );
  return validNext;
}

export async function recoverAttemptJournals(
  stateDir,
  onCorrupt = () => undefined,
  onWarning = () => undefined,
) {
  const paths = await ensureAttemptJournal(stateDir);
  const names = await readdir(paths.directory);
  const attempts = [];
  for (const name of names.filter((value) => ATTEMPT_PATTERN.test(value)).sort()) {
    const path = join(paths.directory, name);
    try {
      await assertPrivateDirectory(path);
      const records = await readAttemptRecords(path);
      if (records.claimed?.attemptId !== name) {
        throw new AttemptJournalError(
          "Attempt journal directory identity is invalid.",
        );
      }
      const valid = validateAttemptRecordSet(records);
      if (!valid) {
        throw new AttemptJournalError("Attempt journal prefix is invalid.");
      }
      try {
        await removeTemporaryFiles(path);
      } catch (error) {
        if (!(error instanceof AttemptJournalError)) throw error;
        onWarning({
          attemptId: name,
          reason: error.message,
        });
      }
      attempts.push(Object.freeze({
        attemptId: name,
        decision: attemptRecoveryDecision(valid),
        records: valid,
      }));
    } catch (error) {
      if (!(error instanceof AttemptJournalError)) throw error;
      const quarantinedAs =
        `${name}.${Date.now()}.${randomBytes(4).toString("hex")}`;
      await rename(path, join(paths.corrupt, quarantinedAs));
      await syncDirectory(paths.directory);
      await syncDirectory(paths.corrupt);
      onCorrupt({
        attemptId: name,
        quarantinedAs,
        reason:
          error instanceof Error ? error.message : "invalid attempt journal",
      });
    }
  }
  return attempts.sort(
    (left, right) =>
      left.records.claimed.createdAt.localeCompare(
        right.records.claimed.createdAt,
      ) || left.attemptId.localeCompare(right.attemptId),
  );
}

async function readAttemptRecords(directory) {
  const names = await readdir(directory);
  const records = {};
  for (const name of names) {
    if (TEMPORARY_RECORD_PATTERN.test(name)) continue;
    const state = STATE_BY_RECORD_FILE[name];
    if (!state) {
      throw new AttemptJournalError("Attempt journal file is unknown.");
    }
    const path = join(directory, name);
    let handle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY |
          (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
    } catch (error) {
      if (error?.code === "ELOOP") {
        throw new AttemptJournalError("Attempt journal file is unsafe.");
      }
      throw error;
    }
    let metadata;
    let text;
    try {
      metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.size < 1 ||
        metadata.size > 8_192 ||
        !privateOwner(metadata) ||
        (process.platform !== "win32" &&
          (metadata.mode & 0o777) !== 0o600)
      ) {
        throw new AttemptJournalError("Attempt journal file is unsafe.");
      }
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const record = parseAttemptRecordText(text, state);
    if (!record) {
      throw new AttemptJournalError("Attempt journal record is invalid.");
    }
    records[state] = record;
  }
  return records;
}

async function writeRecordExclusive(directory, name, record) {
  const finalPath = join(directory, name);
  const temporary =
    `${finalPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.writeFile(`${canonicalJson(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, finalPath);
    await syncDirectory(directory);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new AttemptJournalError("Attempt journal state already exists.");
    }
    throw error;
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function removeTemporaryFiles(directory) {
  const names = await readdir(directory);
  const unsafe = [];
  for (const name of names.filter((value) =>
    TEMPORARY_RECORD_PATTERN.test(value),
  )) {
    const path = join(directory, name);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      !privateOwner(metadata) ||
      (process.platform !== "win32" &&
        (metadata.mode & 0o777) !== 0o600)
    ) {
      unsafe.push(name);
      continue;
    }
    if (
      PROCESS_STARTED_AT_MS - metadata.mtimeMs <
      STALE_TEMPORARY_AFTER_MS
    ) {
      continue;
    }
    await unlink(path).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  await syncDirectory(directory);
  if (unsafe.length > 0) {
    throw new AttemptJournalError(
      `Attempt journal temporary file is unsafe (${unsafe.length}).`,
    );
  }
}

async function assertPrivateDirectory(path) {
  await inspectPrivateDirectory(path, false);
}

async function hardenPrivateDirectory(path) {
  await inspectPrivateDirectory(path, true);
}

async function inspectPrivateDirectory(path, harden) {
  if (process.platform === "win32") {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || !privateOwner(metadata)) {
      throw new AttemptJournalError(
        "Attempt journal paths must be real private directories.",
      );
    }
    return;
  }
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw new AttemptJournalError(
        "Attempt journal paths must be real private directories.",
      );
    }
    throw error;
  }
  try {
    let metadata = await handle.stat();
    if (!metadata.isDirectory() || !privateOwner(metadata)) {
      throw new AttemptJournalError(
        "Attempt journal paths must be real private directories.",
      );
    }
    if ((metadata.mode & 0o700) !== 0o700) {
      throw new AttemptJournalError(
        "Attempt journal directories require owner rwx permissions.",
      );
    }
    if ((metadata.mode & 0o077) !== 0) {
      if (!harden) {
        throw new AttemptJournalError(
          "Attempt journal paths must be real private directories.",
        );
      }
      await handle.chmod(0o700);
      metadata = await handle.stat();
    }
    if ((metadata.mode & 0o777) !== 0o700) {
      throw new AttemptJournalError(
        "Attempt journal paths must be real private directories.",
      );
    }
  } finally {
    await handle.close();
  }
}

async function ensureOwnedDirectory(path) {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (created) {
    await syncDirectory(dirname(path));
  }
  await hardenPrivateDirectory(path);
}

function privateOwner(metadata) {
  return (
    process.platform === "win32" ||
    typeof process.geteuid !== "function" ||
    metadata.uid === process.geteuid()
  );
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
