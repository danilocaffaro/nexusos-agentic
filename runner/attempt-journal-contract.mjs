import { createHash } from "node:crypto";
import {
  ENGINE_COMPLETION_MAX_BYTES,
  parseEngineExecutionResult,
} from "./engine-complete-contract.mjs";
import {
  ENGINE_LEASE_LIMITS,
} from "./engine-lease-limits.mjs";

export const ATTEMPT_RECORD_MAX_BYTES = 4_096;
export const ATTEMPT_RESULT_MAX_BYTES = 8_192;
export const SPAWNING_QUIET_HORIZON_MS = 1_860_000;
export const ATTEMPT_RECORD_STATES = Object.freeze([
  "claimed",
  "starting",
  "canceling",
  "spawning",
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
  "cancel_requested",
  "engine_deadline_exhausted",
  "engine_incompatible",
  "lease_lost",
  "prompt_unavailable",
  "prompt_erased",
  "prompt_integrity_mismatch",
  "spawn_failed",
]);
const PRESTART_REJECTION_REASONS = new Set([
  "engine_deadline_insufficient",
  "lease_expired",
]);
const SETTLED_OUTCOMES = new Set([
  "acked",
  "abandoned",
  "rejected",
  "superseded",
]);
const PRESTART_DENIAL_PAIRS = new Map([
  ["claim", new Set([
    "403:runner_rejected",
    "409:engine_deadline_insufficient",
    "409:engine_inventory_mismatch",
    "409:engine_mismatch",
    "409:operation_conflict",
    "409:run_assignment_mismatch",
    "409:run_unavailable",
    "409:runner_conflict",
    "410:operation_horizon_exceeded",
  ])],
  ["renew", new Set([
    "403:runner_rejected",
    "409:lease_superseded",
    "409:run_unavailable",
    "410:lease_expired",
  ])],
  ["prompt", new Set([
    "403:runner_rejected",
    "409:lease_superseded",
    "409:run_unavailable",
    "410:lease_expired",
  ])],
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
  if (record.state === "canceling") return isCancelingRecord(record);
  if (record.state === "spawning") return isSpawningRecord(record);
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
    ((records.canceling ||
      records.spawning ||
      records.supervisor ||
      records.started ||
      records.result ||
      records.outboxed) &&
      !records.starting) ||
    (records.canceling &&
      (records.spawning || records.supervisor || records.started)) ||
    (records.spawning && !records.starting) ||
    (records.supervisor && !records.spawning) ||
    (records.started && !records.supervisor) ||
    (records.result &&
      !records.supervisor &&
      !validPrestartReceipt(records.result.receipt)) ||
    (records.outboxed && !records.result) ||
    (records.settled &&
      !records.outboxed &&
      !validPrestartSettlement(records))
  ) {
    return undefined;
  }
  if (
    records.starting &&
    (records.starting.runId !== records.claimed.runId ||
      records.starting.engine !== records.claimed.engine ||
      records.starting.createdAt < records.claimed.createdAt ||
      records.starting.createdAt >= records.starting.expiresAt ||
      records.starting.timeoutMs >
        Date.parse(records.starting.deadlineAt) -
          Date.parse(records.starting.createdAt) -
          ENGINE_LEASE_LIMITS.deadlineReserveMs)
  ) {
    return undefined;
  }
  if (
    records.canceling &&
    (
      records.canceling.createdAt < records.canceling.observedAt ||
      records.canceling.observedAt < records.starting.createdAt ||
      records.canceling.renewal.runId !== records.starting.runId ||
      records.canceling.renewal.leaseId !== records.starting.leaseId ||
      records.canceling.renewal.fence !== records.starting.fence ||
      records.canceling.renewal.expiresAt >
        records.starting.deadlineAt
    )
  ) {
    return undefined;
  }
  if (
    records.spawning &&
    records.spawning.createdAt < records.starting.createdAt
  ) {
    return undefined;
  }
  if (
    records.supervisor &&
    (records.supervisor.createdAt < records.starting.createdAt ||
      (records.spawning &&
        records.supervisor.createdAt < records.spawning.createdAt))
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
    const resultAnchor =
      records.canceling?.createdAt ??
      records.supervisor?.createdAt ??
      records.spawning?.createdAt ??
      records.starting.createdAt;
    if (
      records.result.createdAt < resultAnchor ||
      (records.started &&
        records.result.createdAt < records.started.createdAt) ||
      receipt.engine !== records.starting.engine ||
      receipt.engineVersion !== records.starting.engineVersion ||
      receipt.startedAt < resultAnchor ||
      records.result.createdAt < receipt.finishedAt ||
      (records.started
        ? receipt.startedAt !== records.started.startedAt
        : !validPrestartReceipt(receipt) ||
          (
            receipt.reason === "cancel_requested" &&
            records.starting.cancelRequested !== true &&
            !records.canceling &&
            !records.supervisor
          ) ||
          (
            records.canceling &&
            receipt.reason !== "cancel_requested"
          ))
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
    records.outboxed &&
    (records.settled.createdAt < records.outboxed.createdAt ||
      records.settled.operationId !== records.outboxed.operationId ||
      records.settled.denial !== undefined ||
      records.settled.rejection !== undefined)
  ) {
    return undefined;
  }
  return cloneAndFreeze(records);
}

export function attemptRecoveryDecision(records) {
  const valid = validateAttemptRecordSet(records);
  if (!valid) throw new TypeError("Invalid attempt journal.");
  if (valid.settled) {
    if (valid.settled.denial) {
      return Object.freeze({
        action: "settled",
        denial: valid.settled.denial,
        outcome: valid.settled.outcome,
        state: "settled",
      });
    }
    if (valid.settled.rejection) {
      return Object.freeze({
        action: "settled",
        outcome: valid.settled.outcome,
        rejection: valid.settled.rejection,
        state: "settled",
      });
    }
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
  if (valid.canceling) {
    return Object.freeze({
      action: "complete_prestart_cancel",
      state: "canceling",
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
  if (valid.spawning) {
    return Object.freeze({
      action: "operator_attention",
      reason: "spawning_window_ambiguous",
      state: "starting",
    });
  }
  if (valid.starting) {
    return Object.freeze({
      action: "resume_prestart",
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
      "cancelRequested",
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
      typeof record.cancelRequested === "boolean" &&
      typeof record.runId === "string" &&
      RUN_PATTERN.test(record.runId) &&
      typeof record.leaseId === "string" &&
      LEASE_PATTERN.test(record.leaseId) &&
      Number.isSafeInteger(record.fence) &&
      record.fence >= 1 &&
      record.fence <= ENGINE_LEASE_LIMITS.fenceMax &&
      canonicalTimestamp(record.expiresAt) &&
      canonicalTimestamp(record.deadlineAt) &&
      record.expiresAt <= record.deadlineAt &&
      Number.isSafeInteger(record.timeoutMs) &&
      record.timeoutMs >= ENGINE_LEASE_LIMITS.timeoutMinMs &&
      record.timeoutMs <= ENGINE_LEASE_LIMITS.timeoutMaxMs &&
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
      record.promptBytes <= ENGINE_LEASE_LIMITS.promptBytes,
  );
}

function isCancelingRecord(record) {
  const renewal = record.renewal;
  return Boolean(
    hasExactKeys(record, [
      "attemptId",
      "createdAt",
      "observedAt",
      "recordSha256",
      "renewal",
      "source",
      "state",
      "v",
    ]) &&
      canonicalTimestamp(record.observedAt) &&
      record.source === "renew" &&
      plainRecord(renewal) &&
      hasExactKeys(renewal, [
        "cancelRequested",
        "expiresAt",
        "fence",
        "leaseId",
        "runId",
      ]) &&
      renewal.cancelRequested === true &&
      canonicalTimestamp(renewal.expiresAt) &&
      Number.isSafeInteger(renewal.fence) &&
      renewal.fence >= 1 &&
      renewal.fence <= ENGINE_LEASE_LIMITS.fenceMax &&
      typeof renewal.leaseId === "string" &&
      LEASE_PATTERN.test(renewal.leaseId) &&
      typeof renewal.runId === "string" &&
      RUN_PATTERN.test(renewal.runId),
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

function isSpawningRecord(record) {
  return Boolean(
    hasExactKeys(record, [
      "attemptId",
      "createdAt",
      "recordSha256",
      "state",
      "v",
    ]),
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
  const common =
    typeof record.operationId === "string" &&
    OPERATION_PATTERN.test(record.operationId) &&
    typeof record.outcome === "string" &&
    SETTLED_OUTCOMES.has(record.outcome);
  return Boolean(
    common &&
      (hasExactKeys(record, [
        "attemptId",
        "createdAt",
        "operationId",
        "outcome",
        "recordSha256",
        "state",
        "v",
      ]) ||
        (hasExactKeys(record, [
          "attemptId",
          "createdAt",
          "denial",
          "operationId",
          "outcome",
          "recordSha256",
          "state",
          "v",
        ]) &&
          record.outcome === "abandoned" &&
          validPrestartDenial(record.denial)) ||
        (hasExactKeys(record, [
          "attemptId",
          "createdAt",
          "operationId",
          "outcome",
          "recordSha256",
          "rejection",
          "state",
          "v",
        ]) &&
          record.outcome === "abandoned" &&
          validPrestartRejection(record.rejection))),
  );
}

function validPrestartSettlement(records) {
  const denial = records.settled?.denial;
  const rejection = records.settled?.rejection;
  if (rejection) {
    return Boolean(
      validPrestartRejection(rejection) &&
        rejection.descriptor.runId === records.claimed.runId &&
        rejection.descriptor.job.engine === records.claimed.engine &&
        records.settled.outcome === "abandoned" &&
        records.settled.operationId === records.claimed.claimOperationId &&
        records.settled.createdAt >= records.claimed.createdAt &&
        rejection.observedAt >= records.claimed.createdAt &&
        rejection.observedAt <= records.settled.createdAt &&
        !records.starting &&
        !records.canceling &&
        !records.spawning &&
        !records.supervisor &&
        !records.started &&
        !records.result &&
        !records.outboxed,
    );
  }
  const source = denial?.source;
  const anchor = records.starting?.createdAt ??
    records.claimed.createdAt;
  const observedAt = denial?.observedAt;
  const spawningQuiet =
    !records.spawning ||
    Date.parse(records.settled.createdAt) -
      Date.parse(records.spawning.createdAt) >=
      SPAWNING_QUIET_HORIZON_MS;
  return Boolean(
    validPrestartDenial(denial) &&
      records.settled.outcome === "abandoned" &&
      records.settled.operationId === records.claimed.claimOperationId &&
      records.settled.createdAt >= anchor &&
      observedAt >= records.claimed.createdAt &&
      observedAt >= anchor &&
      observedAt <= records.settled.createdAt &&
      spawningQuiet &&
      !records.supervisor &&
      !records.started &&
      !records.result &&
      !records.outboxed &&
      !records.canceling &&
      ((source === "claim" && !records.starting) ||
        (source === "renew" && Boolean(records.starting)) ||
        (
          source === "prompt" &&
          Boolean(records.starting) &&
          !records.spawning
        )),
  );
}

function validPrestartDenial(denial) {
  if (
    !plainRecord(denial) ||
    !hasExactKeys(denial, [
      "httpStatus",
      "observedAt",
      "serverError",
      "source",
    ]) ||
    !Number.isInteger(denial.httpStatus) ||
    denial.httpStatus < 100 ||
    denial.httpStatus > 599 ||
    !canonicalTimestamp(denial.observedAt) ||
    typeof denial.serverError !== "string" ||
    typeof denial.source !== "string"
  ) {
    return false;
  }
  return Boolean(
    PRESTART_DENIAL_PAIRS.get(denial.source)?.has(
      `${denial.httpStatus}:${denial.serverError}`,
    ),
  );
}

function validPrestartRejection(rejection) {
  if (
    !plainRecord(rejection) ||
    !hasExactKeys(rejection, [
      "descriptor",
      "observedAt",
      "reason",
    ]) ||
    !validRejectionDescriptor(rejection.descriptor) ||
    !canonicalTimestamp(rejection.observedAt) ||
    !PRESTART_REJECTION_REASONS.has(rejection.reason)
  ) {
    return false;
  }
  return rejection.reason === descriptorRejectionReason(
    rejection.descriptor,
    rejection.observedAt,
  );
}

function validRejectionDescriptor(descriptor) {
  if (
    !plainRecord(descriptor) ||
    !hasExactKeys(descriptor, [
      "cancelRequested",
      "expiresAt",
      "fence",
      "job",
      "leaseId",
      "runId",
    ]) ||
    typeof descriptor.cancelRequested !== "boolean" ||
    !canonicalTimestamp(descriptor.expiresAt) ||
    !Number.isSafeInteger(descriptor.fence) ||
    descriptor.fence < 1 ||
    descriptor.fence > ENGINE_LEASE_LIMITS.fenceMax ||
    typeof descriptor.leaseId !== "string" ||
    !LEASE_PATTERN.test(descriptor.leaseId) ||
    typeof descriptor.runId !== "string" ||
    !RUN_PATTERN.test(descriptor.runId) ||
    !plainRecord(descriptor.job) ||
    !hasExactKeys(descriptor.job, [
      "deadlineAt",
      "engine",
      "engineVersion",
      "outputBounds",
      "promptBytes",
      "promptRef",
      "promptSha256",
      "timeoutMs",
    ])
  ) {
    return false;
  }
  const job = descriptor.job;
  return Boolean(
    canonicalTimestamp(job.deadlineAt) &&
      descriptor.expiresAt <= job.deadlineAt &&
      ENGINE_NAMES.has(job.engine) &&
      typeof job.engineVersion === "string" &&
      Buffer.byteLength(job.engineVersion, "utf8") <= 64 &&
      VERSION_PATTERN.test(job.engineVersion) &&
      exactOutputBounds(job.outputBounds) &&
      Number.isSafeInteger(job.promptBytes) &&
      job.promptBytes >= 1 &&
      job.promptBytes <= ENGINE_LEASE_LIMITS.promptBytes &&
      typeof job.promptRef === "string" &&
      PROMPT_PATTERN.test(job.promptRef) &&
      typeof job.promptSha256 === "string" &&
      SHA256_PATTERN.test(job.promptSha256) &&
      Number.isSafeInteger(job.timeoutMs) &&
      job.timeoutMs >= ENGINE_LEASE_LIMITS.timeoutMinMs &&
      job.timeoutMs <= ENGINE_LEASE_LIMITS.timeoutMaxMs
  );
}

function descriptorRejectionReason(descriptor, observedAt) {
  const observedAtMs = Date.parse(observedAt);
  if (Date.parse(descriptor.expiresAt) <= observedAtMs) {
    return "lease_expired";
  }
  const effectiveTimeoutMs = Math.min(
    descriptor.job.timeoutMs,
    Date.parse(descriptor.job.deadlineAt) -
      observedAtMs -
      ENGINE_LEASE_LIMITS.deadlineReserveMs,
  );
  if (
    effectiveTimeoutMs <
      ENGINE_LEASE_LIMITS.effectiveTimeoutMinMs
  ) {
    return "engine_deadline_insufficient";
  }
  return undefined;
}

function validPrestartReceipt(receipt) {
  return Boolean(
    PRESTART_REASONS.has(receipt.reason) &&
      receipt.exitCode === null &&
      receipt.timedOut === false &&
      (
        receipt.reason === "cancel_requested"
          ? receipt.status === "canceled" &&
            receipt.cancelRequested === true
          : receipt.status === "failed" &&
            receipt.cancelRequested === false
      ) &&
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
