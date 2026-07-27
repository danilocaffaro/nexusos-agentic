import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const STATE_NAME = "engine-report-state.json";
const STATE_MAX_BYTES = 512;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class EngineReportStateError extends Error {
  constructor(message) {
    super(message);
    this.code = "engine_report_state_invalid";
  }
}

export function engineReportStatePath(stateDir) {
  return join(stateDir, STATE_NAME);
}

export async function readEngineReportState(stateDir) {
  let handle;
  try {
    handle = await open(
      engineReportStatePath(stateDir),
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 1 ||
      metadata.size > STATE_MAX_BYTES ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      return undefined;
    }
    const bytes = await boundedRead(handle);
    return parseState(bytes);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeEngineReportState(stateDir, state) {
  const text = encodeState(state);
  const temporary = join(
    stateDir,
    `.${STATE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, engineReportStatePath(stateDir));
    await syncDirectory(stateDir);
  } catch (error) {
    if (error instanceof EngineReportStateError) throw error;
    throw new EngineReportStateError(
      "Local engine report state could not be stored.",
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export function shouldSuppressEngineReport(
  state,
  changeFingerprint,
  now = new Date(),
) {
  if (
    !validState(state) ||
    !FINGERPRINT_PATTERN.test(changeFingerprint ?? "") ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  ) {
    return false;
  }
  return (
    state.changeFingerprint === changeFingerprint &&
    now.getTime() < Date.parse(state.nextReportBy)
  );
}

function parseState(input) {
  let text;
  let parsed;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(input);
    if (!text.endsWith("\n")) return undefined;
    text = text.slice(0, -1);
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return validState(parsed) && canonicalJson(parsed) === text
    ? parsed
    : undefined;
}

function encodeState(state) {
  if (!validState(state)) {
    throw new EngineReportStateError(
      "Local engine report state is invalid.",
    );
  }
  const text = `${canonicalJson(state)}\n`;
  if (Buffer.byteLength(text, "utf8") > STATE_MAX_BYTES) {
    throw new EngineReportStateError(
      "Local engine report state is invalid.",
    );
  }
  return text;
}

function validState(value) {
  return Boolean(
    plainRecord(value) &&
      hasExactKeys(value, [
        "changeFingerprint",
        "nextReportBy",
        "schemaVersion",
      ]) &&
      FINGERPRINT_PATTERN.test(value.changeFingerprint ?? "") &&
      canonicalTimestamp(value.nextReportBy) &&
      value.schemaVersion === 1,
  );
}

async function boundedRead(handle) {
  const bytes = Buffer.alloc(STATE_MAX_BYTES + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset < 1 || offset > STATE_MAX_BYTES) return Buffer.alloc(0);
  return bytes.subarray(0, offset);
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
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

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index])
  );
}

function plainRecord(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}
