import { createHash } from "node:crypto";
import {
  ENGINE_COMPLETION_MAX_BYTES,
  parseEngineExecutionResult,
} from "./engine-complete-contract.mjs";

export const ATTEMPT_RECORD_MAX_BYTES = 4_096;
export const ATTEMPT_RESULT_MAX_BYTES = 8_192;
export const ATTEMPT_RECORD_STATES = Object.freeze([
  "claimed",
  "starting",
  "supervisor",
  "started",
  "result",
  "outboxed",
  "settled",
]);

const ATTEMPT_PATTERN = /^att_[0-9a-f]{32}$/u;
const ENGINE_NAMES = new Set(["claude_code_cli", "codex_cli"]);
const LEASE_PATTERN = /^lse_[0-9a-f]{32}$/u;
const OPERATION_PATTERN = /^op_[0-9a-f]{32}$/u;
const PROCESS_START_TOKEN_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROMPT_PATTERN = /^prm_[0-9a-f]{32}$/u;
const RUN_PATTERN = /^run_[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VERSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,63}$/u;
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const PRESTART_REASONS = new Set([
  "engine_incompatible",
  "prompt_unavailable",
  "prompt_erased",
  "prompt_integrity_mismatch",
  "spawn_failed",
]);
const SETTLED_OUTCOMES = new Set([
  "acked",
  "rejected",
  "superseded",
]);

export function finalizeAttemptRecord(record) {
  const withoutChecksum = { ...record };
  delete withoutChecksum.recordSha256;
  const finalized = {
    ...withoutChecksum,
    recordSha256: attemptRecordChecksum(withoutChecksum),
  };
  if (!isAttemptRecord(finalized)) {
    throw new TypeError("Invalid attempt journal record.");
  }
  return finalized;
}

export function attemptRecordChecksum(record) {
  const withoutChecksum = { ...record };
  delete withoutChecksum.recordSha256;
  return createHash("sha256")
    .update(canonicalJson(withoutChecksum))
    .digest("hex");
}

export function parseAttemptRecordText(text, expectedState) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > ATTEMPT_RESULT_MAX_BYTES
  ) {
    return undefined;
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return undefined;
  }
  const maximum =
    record?.state === "result"
      ? ATTEMPT_RESULT_MAX_BYTES
      : ATTEMPT_RECORD_MAX_BYTES;
  if (
    Buffer.byteLength(text, "utf8") > maximum ||
    !isAttemptRecord(record) ||
    (expectedState !== undefined && record.state !== expectedState) ||
    text !== `${canonicalJson(record)}\n`
  ) {
    return undefined;
  }
  return record;
}

export function isAttemptRecord(record) {
  if (
    !plainRecord(record) ||
    record.v !== 1 ||
    !ATTEMPT_RECORD_STATES.includes(record.state) ||
    typeof record.attemptId !== "string" ||
    !ATTEMPT_PATTERN.test(record.attemptId) ||
    !canonicalTimestamp(record.createdAt) ||
    typeof record.recordSha256 !== "string" ||
    !SHA256_PATTERN.test(record.recordSha256) ||
    record.recordSha256 !== attemptRecordChecksum(record)
  ) {
    return false;
  }
  if (record.state === "claimed") return isClaimedRecord(record);
  if (record.state === "starting") return isStartingRecord(record);
  if (record.state === "supervisor") return isSupervisorRecord(record);
  if (record.state === "started") return isStartedRecord(record);
  if (record.state === "result") return isResultRecord(record);
  if (record.state === "outboxed") return isOutboxedRecord(record);
  return isSettledRecord(record);
}

export function validateAttemptRecordSet(records) {
  if (!plainRecord(records)) return undefined;
  const keys = Object.keys(records).sort();
  if (
    keys.length < 1 ||
    !keys.every((key) => ATTEMPT_RECORD_STATES.includes(key)) ||
    !records.claimed
  ) {
    return undefined;
  }
  for (const [state, record] of Object.entries(records)) {
    if (!isAttemptRecord(record) || record.state !== state) return undefined;
  }
  const attemptId = records.claimed.attemptId;
  if (
    !Object.values(records).every(
      (record) => record.attemptId === attemptId,
    ) ||
    ((records.supervisor ||
      records.started ||
      records.result ||
      records.outboxed) &&
      !records.starting) ||
    (records.started && !records.supervisor) ||
    (records.result && !records.supervisor) ||
    (records.outboxed && !records.result) ||
    (records.settled && !records.outboxed)
  ) {
    return undefined;
  }
  if (
    records.starting &&
    (records.starting.runId !== records.claimed.runId ||
      records.starting.engine !== records.claimed.engine ||
      records.starting.createdAt < records.claimed.createdAt ||
      records.starting.createdAt > records.starting.expiresAt)
  ) {
    return undefined;
  }
  if (
    records.supervisor &&
    records.supervisor.createdAt < records.starting.createdAt
  ) {
    return undefined;
  }
  if (
    records.started &&
    (records.started.createdAt < records.supervisor.createdAt ||
      records.started.startedAt < records.supervisor.createdAt ||
      records.started.startedAt > records.started.createdAt)
  ) {
    return undefined;
  }
  if (records.result) {
    const receipt = records.result.receipt;
    if (
      records.result.createdAt < records.supervisor.createdAt ||
      (records.started &&
        records.result.createdAt < records.started.createdAt) ||
      receipt.engine !== records.starting.engine ||
      receipt.engineVersion !== records.starting.engineVersion ||
      receipt.startedAt < records.supervisor.createdAt ||
      records.result.createdAt < receipt.finishedAt ||
      (records.started
        ? receipt.startedAt !== records.started.startedAt
        : !validPrestartReceipt(receipt))
    ) {
      return undefined;
    }
  }
  if (
    records.outboxed
  ) {
    const completionBody = canonicalJson({
      fence: records.starting.fence,
      leaseId: records.starting.leaseId,
      operationId: records.outboxed.operationId,
      receipt: records.result.receipt,
    });
    if (
      records.outboxed.createdAt < records.result.createdAt ||
      records.outboxed.operationId ===
        records.claimed.claimOperationId ||
      Buffer.byteLength(completionBody, "utf8") >
        ENGINE_COMPLETION_MAX_BYTES ||
      records.outboxed.bodySha256 !==
        createHash("sha256").update(completionBody).digest("hex")
    ) {
      return undefined;
    }
  }
  if (
    records.settled &&
    (
      records.settled.createdAt < records.outboxed.createdAt ||
      records.settled.operationId !== records.outboxed.operationId
    )
  ) {
    return undefined;
  }
  return cloneAndFreeze(records);
}

export function attemptRecoveryDecision(records) {
  const valid = validateAttemptRecordSet(records);
  if (!valid) throw new TypeError("Invalid attempt journal.");
  if (valid.settled) {
    return Object.freeze({
      action: "settled",
      outcome: valid.settled.outcome,
      state: "settled",
    });
  }
  if (valid.outboxed) {
    return Object.freeze({
      action: "deliver_completion",
      state: "outboxed",
    });
  }
  if (valid.result) {
    return Object.freeze({
      action: "persist_completion",
      state: "result",
    });
  }
  if (valid.started) {
    return Object.freeze({
      action: "inspect_process",
      state: "started",
    });
  }
  if (valid.supervisor) {
    return Object.freeze({
      action: "inspect_supervisor",
      state: "starting",
    });
  }
  if (valid.starting) {
    return Object.freeze({
      action: "operator_attention",
      reason: "supervisor_identity_ambiguous",
      state: "starting",
    });
  }
  return Object.freeze({
    action: "replay_claim",
    state: "claimed",
  });
}

function isClaimedRecord(record) {
  return Boolean(
    hasExactKeys(record, [
      "attemptId",
      "claimBodySha256",
      "claimOperationId",
      "createdAt",
      "engine",
      "recordSha256",
      "runId",
      "state",
      "v",
    ]) &&
      typeof record.runId === "string" &&
      RUN_PATTERN.test(record.runId) &&
      typeof record.claimOperationId === "string" &&
      OPERATION_PATTERN.test(record.claimOperationId) &&
      typeof record.claimBodySha256 === "string" &&
      SHA256_PATTERN.test(record.claimBodySha256) &&
      ENGINE_NAMES.has(record.engine) &&
      record.claimBodySha256 ===
        createHash("sha256")
          .update(
            canonicalJson({
              engine: record.engine,
              operationId: record.claimOperationId,
            }),
          )
          .digest("hex"),
  );
}

function isStartingRecord(record) {
  return Boolean(
    hasExactKeys(record, [
      "attemptId",
      "deadlineAt",
      "engine",
      "engineVersion",
      "expiresAt",
      "fence",
      "leaseId",
      "outputBounds",
      "promptBytes",
      "promptRef",
      "promptSha256",
      "recordSha256",
      "runId",
      "state",
      "timeoutMs",
      "v",
      "createdAt",
    ]) &&
      typeof record.runId === "string" &&
      RUN_PATTERN.test(record.runId) &&
      typeof record.leaseId === "string" &&
      LEASE_PATTERN.test(record.leaseId) &&
      Number.isSafeInteger(record.fence) &&
      record.fence >= 1 &&
      record.fence <= 2_147_483_647 &&
      canonicalTimestamp(record.expiresAt) &&
      canonicalTimestamp(record.deadlineAt) &&
      record.expiresAt <= record.deadlineAt &&
      Number.isSafeInteger(record.timeoutMs) &&
      record.timeoutMs >= 270_000 &&
      record.timeoutMs <= 600_000 &&
      exactOutputBounds(record.outputBounds) &&
      ENGINE_NAMES.has(record.engine) &&
      typeof record.engineVersion === "string" &&
      Buffer.byteLength(record.engineVersion, "utf8") <= 64 &&
      VERSION_PATTERN.test(record.engineVersion) &&
      typeof record.promptRef === "string" &&
      PROMPT_PATTERN.test(record.promptRef) &&
      typeof record.promptSha256 === "string" &&
      SHA256_PATTERN.test(record.promptSha256) &&
      Number.isSafeInteger(record.promptBytes) &&
      record.promptBytes >= 1 &&
      record.promptBytes <= 8_192,
  );
}

function isSupervisorRecord(record) {
  return Boolean(
    hasExactKeys(record, [
      "attemptId",
      "createdAt",
      "recordSha256",
      "state",
      "supervisorPid",
      "supervisorStartToken",
      "v",
    ]) &&
      validPid(record.supervisorPid) &&
      typeof record.supervisorStartToken === "string" &&
      PROCESS_START_TOKEN_PATTERN.test(record.supervisorStartToken),
  );
}

function isStartedRecord(record) {
  return Boolean(
    hasExactKeys(record, [
      "attemptId",
      "childPid",
      "childStartToken",
      "createdAt",
      "recordSha256",
      "startedAt",
      "state",
      "v",
    ]) &&
      validPid(record.childPid) &&
      typeof record.childStartToken === "string" &&
      PROCESS_START_TOKEN_PATTERN.test(record.childStartToken) &&
      canonicalTimestamp(record.startedAt),
  );
}

function isResultRecord(record) {
  return Boolean(
    hasExactKeys(record, [
      "attemptId",
      "createdAt",
      "receipt",
      "recordSha256",
      "state",
      "v",
    ]) && parseEngineExecutionResult(record.receipt),
  );
}

function isOutboxedRecord(record) {
  return Boolean(
    hasExactKeys(record, [
      "attemptId",
      "bodySha256",
      "createdAt",
      "operationId",
      "recordSha256",
      "state",
      "v",
    ]) &&
      typeof record.operationId === "string" &&
      OPERATION_PATTERN.test(record.operationId) &&
      typeof record.bodySha256 === "string" &&
      SHA256_PATTERN.test(record.bodySha256),
  );
}

function isSettledRecord(record) {
  return Boolean(
    hasExactKeys(record, [
      "attemptId",
      "createdAt",
      "operationId",
      "outcome",
      "recordSha256",
      "state",
      "v",
    ]) &&
      typeof record.operationId === "string" &&
      OPERATION_PATTERN.test(record.operationId) &&
      typeof record.outcome === "string" &&
      SETTLED_OUTCOMES.has(record.outcome),
  );
}

function validPrestartReceipt(receipt) {
  return Boolean(
    PRESTART_REASONS.has(receipt.reason) &&
      receipt.status === "failed" &&
      receipt.exitCode === null &&
      receipt.timedOut === false &&
      receipt.cancelRequested === false &&
      receipt.stdout.bytes === 0 &&
      receipt.stdout.excerptBase64Url === "" &&
      receipt.stdout.sha256 === EMPTY_SHA256 &&
      receipt.stdout.truncated === false &&
      receipt.stderr.bytes === 0 &&
      receipt.stderr.excerptBase64Url === "" &&
      receipt.stderr.sha256 === EMPTY_SHA256 &&
      receipt.stderr.truncated === false,
  );
}

function exactOutputBounds(value) {
  return Boolean(
    plainRecord(value) &&
      hasExactKeys(value, ["stderrBytes", "stdoutBytes"]) &&
      value.stderrBytes === 65_536 &&
      value.stdoutBytes === 262_144,
  );
}

function validPid(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 2_147_483_647
  );
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
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

function cloneAndFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreeze(item)));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          cloneAndFreeze(nested),
        ]),
      ),
    );
  }
  return value;
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
