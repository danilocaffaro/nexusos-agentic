import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  isOutboxEntry,
  OUTBOX_ENTRY_MAX_BYTES,
  outboxEntryChecksum,
  outboxStorageDirectory,
  parseOutboxEntryText,
} from "./outbox-contract.mjs";

const OUTBOX_WRITE_VERSION = 2;
const ACK_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const TERMINAL_STATES = new Set([
  "acked",
  "rejected",
  "superseded",
  "abandoned",
]);

export class OutboxError extends Error {
  constructor(message, code = "outbox_invalid") {
    super(message);
    this.code = code;
  }
}

export function outboxPaths(stateDir) {
  const directory = join(stateDir, outboxStorageDirectory(1));
  const futureDirectory = join(stateDir, outboxStorageDirectory(2));
  return {
    directory,
    corrupt: join(directory, "corrupt"),
    futureDirectory,
    futureCorrupt: join(futureDirectory, "corrupt"),
    lock: join(stateDir, "outbox.lock"),
  };
}

export async function ensureOutbox(stateDir) {
  const paths = outboxPaths(stateDir);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await mkdir(paths.corrupt, { recursive: true, mode: 0o700 });
  await mkdir(paths.futureDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.futureCorrupt, { recursive: true, mode: 0o700 });
  for (const path of [
    paths.directory,
    paths.corrupt,
    paths.futureDirectory,
    paths.futureCorrupt,
  ]) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new OutboxError("Runner outbox paths must be real directories.");
    }
    if (process.platform !== "win32") await chmod(path, 0o700);
  }
  return paths;
}

export async function acquireOutboxLock(stateDir) {
  const paths = await ensureOutbox(stateDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(paths.lock, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(stateDir);
      return async () => {
        await unlink(paths.lock).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        await syncDirectory(stateDir);
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const pid = await readLockPid(paths.lock);
      if (pid && processIsAlive(pid)) {
        throw new OutboxError(
          "Another runner process is using this state directory.",
          "runner_already_running",
        );
      }
      if (attempt === 0) {
        await unlink(paths.lock).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
        continue;
      }
      throw new OutboxError(
        "The runner outbox lock could not be recovered.",
        "runner_already_running",
      );
    }
  }
  throw new OutboxError(
    "The runner outbox lock could not be acquired.",
    "runner_already_running",
  );
}

export async function recoverOutbox(stateDir, onCorrupt = () => undefined) {
  const paths = await ensureOutbox(stateDir);
  const entries = [
    ...(await recoverOutboxDirectory({
      directory: paths.directory,
      corrupt: paths.corrupt,
      version: 1,
      onCorrupt,
    })),
    ...(await recoverOutboxDirectory({
      directory: paths.futureDirectory,
      corrupt: paths.futureCorrupt,
      version: 2,
      onCorrupt,
    })),
  ];
  return entries.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.operationId.localeCompare(right.operationId),
  );
}

async function recoverOutboxDirectory({
  directory,
  corrupt,
  version,
  onCorrupt,
}) {
  const names = await readdir(directory);
  for (const name of names.filter((value) => value.includes(".tmp-"))) {
    await unlink(join(directory, name)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }

  const entries = [];
  for (const name of names
    .filter((value) => /^op_[0-9a-f]{32}\.json$/u.test(value))
    .sort()) {
    const path = join(directory, name);
    try {
      entries.push(await readEntry(path, version));
    } catch (error) {
      const quarantineName = `${name}.${Date.now()}`;
      await rename(path, join(corrupt, quarantineName));
      await syncDirectory(directory);
      await syncDirectory(corrupt);
      onCorrupt({
        file: name,
        quarantinedAs: quarantineName,
        reason:
          error instanceof Error ? error.message : "invalid outbox entry",
      });
    }
  }
  return entries;
}

export async function persistOperation(stateDir, input) {
  const now = new Date().toISOString();
  const body = Buffer.from(input.body);
  const identity =
    input.kind === "capability.report"
      ? { runnerId: input.runnerId, reportId: input.reportId }
      : { runId: input.runId };
  const entry = finalizeEntry({
    v: OUTBOX_WRITE_VERSION,
    operationId: input.operationId,
    kind: input.kind,
    createdAt: now,
    updatedAt: now,
    ...identity,
    bodyBase64: body.toString("base64url"),
    bodySha256: createHash("sha256").update(body).digest("hex"),
    status: "pending",
    response: null,
  });
  validateEntry(entry);
  await writeEntry(stateDir, entry, true);
  return entry;
}

export async function transitionOperation(
  stateDir,
  entry,
  status,
  response = null,
) {
  if (
    !["pending", "acked", "rejected", "superseded", "abandoned"].includes(
      status,
    )
  ) {
    throw new OutboxError("Invalid outbox transition state.");
  }
  if (entry.status !== "pending" && entry.status !== status) {
    throw new OutboxError("A terminal outbox operation cannot transition.");
  }
  const next = finalizeEntry({
    ...withoutChecksum(entry),
    status,
    updatedAt: new Date().toISOString(),
    response: response
      ? {
          status: response.status,
          bodyBase64: Buffer.from(response.body).toString("base64url"),
        }
      : null,
  });
  validateEntry(next);
  await writeEntry(stateDir, next, false);
  return next;
}

export async function pruneOutbox(stateDir, nowMs = Date.now()) {
  const entries = await recoverOutbox(stateDir);
  let removed = 0;
  const changedDirectories = new Set();
  for (const entry of entries) {
    if (
      TERMINAL_STATES.has(entry.status) &&
      entry.status !== "abandoned" &&
      Date.parse(entry.updatedAt) <= nowMs - ACK_RETENTION_MS
    ) {
      const path = entryPath(stateDir, entry);
      await unlink(path);
      changedDirectories.add(
        join(stateDir, outboxStorageDirectory(entry.v)),
      );
      removed += 1;
    }
  }
  for (const directory of changedDirectories) {
    await syncDirectory(directory);
  }
  return removed;
}

export function operationBody(entry) {
  return Buffer.from(entry.bodyBase64, "base64url");
}

export function generateLocalOperationId() {
  return `op_${randomBytes(16).toString("hex")}`;
}

async function readEntry(path, expectedVersion) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > OUTBOX_ENTRY_MAX_BYTES
  ) {
    throw new OutboxError("Outbox entry is not a regular file.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new OutboxError("Outbox entry permissions are unsafe.");
  }
  const entry = parseOutboxEntryText(await readFile(path, "utf8"));
  if (!entry || entry.v !== expectedVersion) {
    throw new OutboxError("Outbox entry is not valid JSON.");
  }
  return entry;
}

async function writeEntry(stateDir, entry, exclusive) {
  await ensureOutbox(stateDir);
  const finalPath = entryPath(stateDir, entry);
  const directory = join(stateDir, outboxStorageDirectory(entry.v));
  const temporary = `${finalPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalJson(entry)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (exclusive) {
      for (const version of [1, 2]) {
        try {
          await lstat(
            join(
              stateDir,
              outboxStorageDirectory(version),
              `${entry.operationId}.json`,
            ),
          );
          throw new OutboxError(
            "The operation already exists in the outbox.",
          );
        } catch (error) {
          if (error instanceof OutboxError || error?.code !== "ENOENT") {
            throw error;
          }
        }
      }
    }
    await rename(temporary, finalPath);
    if (process.platform !== "win32") await chmod(finalPath, 0o600);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function validateEntry(entry) {
  if (![1, 2].includes(entry?.v) || !isOutboxEntry(entry)) {
    throw new OutboxError("Outbox entry schema is invalid.");
  }
}

function finalizeEntry(entry) {
  return {
    ...entry,
    entrySha256: checksum(entry),
  };
}

function withoutChecksum(entry) {
  const rest = { ...entry };
  delete rest.entrySha256;
  return rest;
}

function checksum(value) {
  return outboxEntryChecksum(value);
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

function entryPath(stateDir, entry) {
  return join(
    stateDir,
    outboxStorageDirectory(entry.v),
    `${entry.operationId}.json`,
  );
}

async function readLockPid(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Number.isSafeInteger(parsed?.pid) && parsed.pid > 0
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}
