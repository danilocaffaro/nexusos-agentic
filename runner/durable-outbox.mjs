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

const OUTBOX_VERSION = 1;
const OPERATION_PATTERN = /^op_[0-9a-f]{32}$/u;
const RUN_PATTERN = /^run_[0-9a-f]{32}$/u;
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
  const directory = join(stateDir, "outbox");
  return {
    directory,
    corrupt: join(directory, "corrupt"),
    lock: join(stateDir, "outbox.lock"),
  };
}

export async function ensureOutbox(stateDir) {
  const paths = outboxPaths(stateDir);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await mkdir(paths.corrupt, { recursive: true, mode: 0o700 });
  for (const path of [paths.directory, paths.corrupt]) {
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
  const names = await readdir(paths.directory);
  for (const name of names.filter((value) => value.includes(".tmp-"))) {
    await unlink(join(paths.directory, name)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }

  const entries = [];
  for (const name of names
    .filter((value) => /^op_[0-9a-f]{32}\.json$/u.test(value))
    .sort()) {
    const path = join(paths.directory, name);
    try {
      entries.push(await readEntry(path));
    } catch (error) {
      const quarantineName = `${name}.${Date.now()}`;
      await rename(path, join(paths.corrupt, quarantineName));
      await syncDirectory(paths.directory);
      await syncDirectory(paths.corrupt);
      onCorrupt({
        file: name,
        quarantinedAs: quarantineName,
        reason:
          error instanceof Error ? error.message : "invalid outbox entry",
      });
    }
  }
  return entries.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.operationId.localeCompare(right.operationId),
  );
}

export async function persistOperation(stateDir, input) {
  const now = new Date().toISOString();
  const body = Buffer.from(input.body);
  const entry = finalizeEntry({
    v: OUTBOX_VERSION,
    operationId: input.operationId,
    kind: input.kind,
    createdAt: now,
    updatedAt: now,
    runId: input.runId,
    pathname: input.pathname,
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
  for (const entry of entries) {
    if (
      TERMINAL_STATES.has(entry.status) &&
      entry.status !== "abandoned" &&
      Date.parse(entry.updatedAt) <= nowMs - ACK_RETENTION_MS
    ) {
      await unlink(entryPath(stateDir, entry.operationId));
      removed += 1;
    }
  }
  if (removed > 0) await syncDirectory(outboxPaths(stateDir).directory);
  return removed;
}

export function operationBody(entry) {
  return Buffer.from(entry.bodyBase64, "base64url");
}

export function generateLocalOperationId() {
  return `op_${randomBytes(16).toString("hex")}`;
}

async function readEntry(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new OutboxError("Outbox entry is not a regular file.");
  }
  if (
    process.platform !== "win32" &&
    (metadata.mode & 0o077) !== 0
  ) {
    throw new OutboxError("Outbox entry permissions are unsafe.");
  }
  let entry;
  try {
    entry = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new OutboxError("Outbox entry is not valid JSON.");
  }
  validateEntry(entry);
  return entry;
}

async function writeEntry(stateDir, entry, exclusive) {
  const paths = await ensureOutbox(stateDir);
  const finalPath = entryPath(stateDir, entry.operationId);
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
      try {
        await lstat(finalPath);
        throw new OutboxError("The operation already exists in the outbox.");
      } catch (error) {
        if (error instanceof OutboxError || error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    await rename(temporary, finalPath);
    if (process.platform !== "win32") await chmod(finalPath, 0o600);
    await syncDirectory(paths.directory);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function validateEntry(entry) {
  if (
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    entry.v !== OUTBOX_VERSION ||
    !OPERATION_PATTERN.test(entry.operationId ?? "") ||
    !["lease.claim", "run.complete"].includes(entry.kind) ||
    !RUN_PATTERN.test(entry.runId ?? "") ||
    typeof entry.createdAt !== "string" ||
    !Number.isFinite(Date.parse(entry.createdAt)) ||
    typeof entry.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(entry.updatedAt)) ||
    typeof entry.pathname !== "string" ||
    entry.pathname.length > 512 ||
    typeof entry.bodyBase64 !== "string" ||
    typeof entry.bodySha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(entry.bodySha256) ||
    !["pending", "acked", "rejected", "superseded", "abandoned"].includes(
      entry.status,
    ) ||
    typeof entry.entrySha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(entry.entrySha256)
  ) {
    throw new OutboxError("Outbox entry schema is invalid.");
  }
  const body = Buffer.from(entry.bodyBase64, "base64url");
  if (
    body.byteLength < 1 ||
    body.byteLength > 4_096 ||
    body.toString("base64url") !== entry.bodyBase64 ||
    createHash("sha256").update(body).digest("hex") !== entry.bodySha256
  ) {
    throw new OutboxError("Outbox body integrity check failed.");
  }
  const expectedPath =
    entry.kind === "lease.claim"
      ? `/api/runs/${entry.runId}/lease/claim`
      : `/api/runs/${entry.runId}/complete`;
  if (entry.pathname !== expectedPath) {
    throw new OutboxError("Outbox path is not bound to its run and kind.");
  }
  if (
    entry.response !== null &&
    (!entry.response ||
      !Number.isInteger(entry.response.status) ||
      entry.response.status < 100 ||
      entry.response.status > 599 ||
      typeof entry.response.bodyBase64 !== "string")
  ) {
    throw new OutboxError("Outbox response is invalid.");
  }
  if (entry.response !== null) {
    const responseBody = Buffer.from(
      entry.response.bodyBase64,
      "base64url",
    );
    if (
      responseBody.byteLength > 64 * 1_024 ||
      responseBody.toString("base64url") !== entry.response.bodyBase64
    ) {
      throw new OutboxError("Outbox response integrity check failed.");
    }
  }
  const expectedChecksum = checksum(withoutChecksum(entry));
  if (entry.entrySha256 !== expectedChecksum) {
    throw new OutboxError("Outbox entry checksum failed.");
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
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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

function entryPath(stateDir, operationId) {
  return join(outboxPaths(stateDir).directory, `${operationId}.json`);
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
