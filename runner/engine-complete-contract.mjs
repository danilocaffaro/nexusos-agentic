import { ENGINE_COMPLETE_LIMITS } from "./engine-complete-limits.mjs";

export const ENGINE_COMPLETION_MAX_BYTES =
  ENGINE_COMPLETE_LIMITS.completionMaxBytes;

const ENGINE_EXCERPT_MAX_BYTES = 1_024;
const ENGINE_STDERR_MAX_BYTES = 65_536;
const ENGINE_STDOUT_MAX_BYTES = 262_144;
const ENGINE_SUMMARY_MAX_BYTES = 64;
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ENGINE_NAMES = new Set(["claude_code_cli", "codex_cli"]);
const EXECUTION_STATUSES = new Set(["succeeded", "failed", "canceled"]);
const EXECUTION_REASONS = new Set([
  "none",
  "engine_incompatible",
  "engine_deadline_exhausted",
  "prompt_unavailable",
  "prompt_erased",
  "prompt_integrity_mismatch",
  "spawn_failed",
  "timed_out",
  "cancel_requested",
  "lease_lost",
  "output_limit_reached",
  "interrupted_after_start",
  "orphan_identity_ambiguous",
  "engine_exit_nonzero",
  "protocol_invalid",
]);
const LEASE_PATTERN = /^lse_[0-9a-f]{32}$/u;
const OPERATION_PATTERN = /^op_[0-9a-f]{32}$/u;
const RUN_PATTERN = /^run_[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VERSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,63}$/u;
const SUPERSEDED_ERRORS = new Set([
  "engine_deadline_exhausted",
  "lease_expired",
  "lease_superseded",
  "run_unavailable",
]);
const RETRYABLE_CONFLICT_ERRORS = new Set([
  "conflict_retry",
  "nonce_reused",
]);

export function parseEngineCompleteBody(input) {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    return undefined;
  }
  const raw = typeof input === "string"
    ? Buffer.from(input, "utf8")
    : Buffer.from(input);
  if (raw.byteLength < 1 || raw.byteLength > ENGINE_COMPLETION_MAX_BYTES) {
    return undefined;
  }
  let text;
  let parsed;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(raw);
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !plainRecord(parsed) ||
    !hasExactKeys(parsed, ["fence", "leaseId", "operationId", "receipt"]) ||
    !Number.isSafeInteger(parsed.fence) ||
    parsed.fence < 1 ||
    parsed.fence > 2_147_483_647 ||
    typeof parsed.leaseId !== "string" ||
    !LEASE_PATTERN.test(parsed.leaseId) ||
    typeof parsed.operationId !== "string" ||
    !OPERATION_PATTERN.test(parsed.operationId) ||
    !parseEngineExecutionResult(parsed.receipt) ||
    canonicalJson(parsed) !== text
  ) {
    return undefined;
  }
  return parsed;
}

export function parseEngineCompleteAck(input, runId) {
  if (
    !plainRecord(input) ||
    !hasExactKeys(input, ["late", "recordedAt", "runId", "status"]) ||
    input.runId !== runId ||
    !RUN_PATTERN.test(input.runId ?? "") ||
    input.status !== "completed" ||
    typeof input.late !== "boolean" ||
    !canonicalTimestamp(input.recordedAt)
  ) {
    return undefined;
  }
  return input;
}

export function classifyEngineCompleteResponse(
  status,
  payload,
  expectedRunId,
) {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError("Invalid engine completion response status.");
  }
  if (status === 200) {
    if (!parseEngineCompleteAck(payload, expectedRunId)) {
      return Object.freeze({
        classification: "protocol_error",
        outboxStatus: "pending",
      });
    }
    return Object.freeze({
      classification: "success",
      outboxStatus: "acked",
    });
  }
  if (status >= 200 && status < 300) {
    return Object.freeze({
      classification: "protocol_error",
      outboxStatus: "pending",
    });
  }
  const error = plainRecord(payload) && typeof payload.error === "string"
    ? payload.error
    : undefined;
  if (
    status >= 500 ||
    status === 429 ||
    (status === 409 && RETRYABLE_CONFLICT_ERRORS.has(error))
  ) {
    return Object.freeze({
      classification: "retryable",
      outboxStatus: "pending",
    });
  }
  if (status === 409 && SUPERSEDED_ERRORS.has(error)) {
    return Object.freeze({
      classification: "terminal",
      outboxStatus: "superseded",
    });
  }
  return Object.freeze({
    classification: "terminal",
    outboxStatus: "rejected",
  });
}

export function parseEngineExecutionResult(input) {
  if (
    !plainRecord(input) ||
    !hasExactKeys(input, [
      "cancelRequested",
      "engine",
      "engineVersion",
      "exitCode",
      "finishedAt",
      "reason",
      "startedAt",
      "status",
      "stderr",
      "stdout",
      "summary",
      "timedOut",
    ]) ||
    !ENGINE_NAMES.has(input.engine) ||
    typeof input.engineVersion !== "string" ||
    Buffer.byteLength(input.engineVersion, "utf8") > 64 ||
    !VERSION_PATTERN.test(input.engineVersion) ||
    !EXECUTION_STATUSES.has(input.status) ||
    !EXECUTION_REASONS.has(input.reason) ||
    typeof input.cancelRequested !== "boolean" ||
    typeof input.timedOut !== "boolean" ||
    !canonicalTimestamp(input.startedAt) ||
    !canonicalTimestamp(input.finishedAt) ||
    input.startedAt > input.finishedAt ||
    !validSummary(input.summary)
  ) {
    return undefined;
  }
  const stdout = parseStreamReceipt(input.stdout, ENGINE_STDOUT_MAX_BYTES);
  const stderr = parseStreamReceipt(input.stderr, ENGINE_STDERR_MAX_BYTES);
  if (
    !stdout ||
    !stderr ||
    stdout.excerptBytes + stderr.excerptBytes >
      ENGINE_EXCERPT_MAX_BYTES ||
    !consistentOutcome(input, stdout.value, stderr.value)
  ) {
    return undefined;
  }
  return input;
}

function parseStreamReceipt(input, maxBytes) {
  if (
    !plainRecord(input) ||
    !hasExactKeys(input, [
      "bytes",
      "excerptBase64Url",
      "sha256",
      "truncated",
    ]) ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 0 ||
    input.bytes > maxBytes ||
    typeof input.sha256 !== "string" ||
    !SHA256_PATTERN.test(input.sha256) ||
    typeof input.truncated !== "boolean"
  ) {
    return undefined;
  }
  const excerpt = decodeCanonicalBase64Url(input.excerptBase64Url);
  if (
    !excerpt ||
    excerpt.byteLength > input.bytes ||
    input.truncated !== (input.bytes > excerpt.byteLength) ||
    (input.bytes === 0 && input.sha256 !== EMPTY_SHA256) ||
    (input.bytes > 0 && input.sha256 === EMPTY_SHA256)
  ) {
    return undefined;
  }
  return { excerptBytes: excerpt.byteLength, value: input };
}

function consistentOutcome(value, stdout, stderr) {
  if (
    value.exitCode !== null &&
    (!Number.isInteger(value.exitCode) ||
      value.exitCode < 0 ||
      value.exitCode > 255)
  ) {
    return false;
  }
  if (value.status === "succeeded") {
    return (
      value.reason === "none" &&
      value.exitCode === 0 &&
      value.timedOut === false &&
      value.cancelRequested === false &&
      value.summary === "completed"
    );
  }
  if (value.status === "canceled") {
    return (
      value.reason === "cancel_requested" &&
      value.exitCode === null &&
      value.cancelRequested === true &&
      value.summary === "cancel_requested"
    );
  }
  return (
    value.status === "failed" &&
    value.reason !== "none" &&
    value.reason !== "cancel_requested" &&
    (value.reason !== "timed_out" || value.timedOut === true) &&
    value.summary === value.reason &&
    (value.reason === "engine_exit_nonzero"
      ? Number.isInteger(value.exitCode) && value.exitCode >= 1
      : value.exitCode === null) &&
    (value.reason !== "output_limit_reached" ||
      (stdout.bytes === ENGINE_STDOUT_MAX_BYTES && stdout.truncated) ||
      (stderr.bytes === ENGINE_STDERR_MAX_BYTES && stderr.truncated))
  );
}

function validSummary(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") >= 1 &&
    Buffer.byteLength(value, "utf8") <= ENGINE_SUMMARY_MAX_BYTES &&
    (value === "completed" ||
      (EXECUTION_REASONS.has(value) && value !== "none"))
  );
}

function decodeCanonicalBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : undefined;
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
