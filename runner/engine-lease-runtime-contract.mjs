import { createHash } from "node:crypto";
import {
  finalizeAttemptRecord,
  validateAttemptRecordSet,
} from "./attempt-journal-contract.mjs";
import {
  parseEngineExecutionResult,
} from "./engine-complete-contract.mjs";
import {
  evaluateDescriptorBudget,
  parseEngineLeaseDescriptor,
} from "./engine-claim-contract.mjs";
import {
  ENGINE_LEASE_LIMITS,
} from "./engine-lease-limits.mjs";

export const ENGINE_LEASE_RUNTIME_LIMITS = Object.freeze({
  responseMaxBytes: 4_096,
  renewIntervalMs: 20_000,
});

const ENGINE_NAMES = new Set(["claude_code_cli", "codex_cli"]);
const LEASE_PATTERN = /^lse_[0-9a-f]{32}$/u;
const RUN_PATTERN = /^run_[0-9a-f]{32}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
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
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export class EngineLeaseRuntimeContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineLeaseRuntimeContractError";
    this.code = "engine_lease_runtime_contract_invalid";
  }
}

export function createEngineLeaseRenewBody(input) {
  if (
    !exactRecord(input, ["fence", "leaseId"]) ||
    !validFence(dataValue(input, "fence")) ||
    !LEASE_PATTERN.test(dataValue(input, "leaseId") ?? "")
  ) {
    throw invalidContract("Invalid engine lease renew body.");
  }
  return cloneAndFreeze({
    fence: dataValue(input, "fence"),
    leaseId: dataValue(input, "leaseId"),
  });
}

export function createEngineLeaseRenewIntent(input) {
  if (
    !exactRecord(input, ["fence", "leaseId", "runId"]) ||
    !RUN_PATTERN.test(dataValue(input, "runId") ?? "")
  ) {
    throw invalidContract("Invalid engine lease renew intent.");
  }
  const body = createEngineLeaseRenewBody({
    fence: dataValue(input, "fence"),
    leaseId: dataValue(input, "leaseId"),
  });
  const bodyBytes = Buffer.from(canonicalJson(body), "utf8");
  const runId = dataValue(input, "runId");
  return cloneAndFreeze({
    expected: {
      fence: body.fence,
      leaseId: body.leaseId,
      runId,
    },
    request: {
      bodyBase64Url: bodyBytes.toString("base64url"),
      bodySha256: sha256(bodyBytes),
      pathname: `/api/runs/${runId}/lease/renew`,
      signatureDomain: "nexus-runner-lease-renew-v1",
    },
    runId,
  });
}

export function parseEngineLeaseRenewal(input, expectedInput) {
  const expected = normalizeExpected(expectedInput);
  const bytes = boundedBytes(input);
  if (!expected || !bytes) return undefined;
  let text;
  let parsed;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !exactRecord(parsed, [
      "cancelRequested",
      "expiresAt",
      "fence",
      "leaseId",
      "runId",
    ]) ||
    typeof dataValue(parsed, "cancelRequested") !== "boolean" ||
    !canonicalTimestamp(dataValue(parsed, "expiresAt")) ||
    dataValue(parsed, "fence") !== expected.fence ||
    dataValue(parsed, "leaseId") !== expected.leaseId ||
    dataValue(parsed, "runId") !== expected.runId ||
    canonicalJson(parsed) !== text
  ) {
    return undefined;
  }
  return cloneAndFreeze(parsed);
}

export function mergeEngineLeaseRenewal(input) {
  if (
    !exactRecord(input, ["current", "renewal"])
  ) {
    throw invalidContract("Invalid engine lease merge input.");
  }
  const current = normalizeLeaseState(dataValue(input, "current"));
  const renewal = normalizeRenewal(dataValue(input, "renewal"));
  if (
    !current ||
    !renewal ||
    renewal.fence !== current.fence ||
    renewal.leaseId !== current.leaseId ||
    renewal.runId !== current.runId ||
    renewal.expiresAt > current.deadlineAt
  ) {
    throw invalidContract("Invalid engine lease renewal.");
  }
  const extended = renewal.expiresAt > current.expiresAt;
  return cloneAndFreeze({
    cancelRequested:
      current.cancelRequested ||
      renewal.cancelRequested,
    deadlineAt: current.deadlineAt,
    expiresAt: extended ? renewal.expiresAt : current.expiresAt,
    extended,
    fence: current.fence,
    leaseId: current.leaseId,
    runId: current.runId,
  });
}

export function nextEngineLeaseRenewAtMs(input) {
  if (
    !exactRecord(input, ["expiresAt", "nowMs"]) ||
    !canonicalTimestamp(dataValue(input, "expiresAt")) ||
    !validNowMs(dataValue(input, "nowMs"))
  ) {
    throw invalidContract("Invalid engine lease schedule input.");
  }
  const nowMs = dataValue(input, "nowMs");
  const safeRenewBeforeMs =
    Date.parse(dataValue(input, "expiresAt")) -
    ENGINE_LEASE_RUNTIME_LIMITS.renewIntervalMs / 2;
  return Math.max(
    nowMs,
    Math.min(
      nowMs + ENGINE_LEASE_RUNTIME_LIMITS.renewIntervalMs,
      safeRenewBeforeMs,
    ),
  );
}

export function engineLeaseLossHorizonMs(expiresAt) {
  if (!canonicalTimestamp(expiresAt)) {
    throw invalidContract("Invalid engine lease horizon.");
  }
  return Date.parse(expiresAt);
}

export function shouldPropagateEngineCancel(input) {
  if (
    !exactRecord(input, ["cancelSent", "renewal"]) ||
    typeof dataValue(input, "cancelSent") !== "boolean"
  ) {
    throw invalidContract("Invalid engine cancel propagation input.");
  }
  const renewal = normalizeRenewal(dataValue(input, "renewal"));
  if (!renewal) {
    throw invalidContract("Invalid engine lease renewal.");
  }
  return !dataValue(input, "cancelSent") && renewal.cancelRequested;
}

export function createRuntimePrestartReceipt(input) {
  if (
    !exactRecord(input, [
      "engine",
      "engineVersion",
      "reason",
      "recordedAt",
    ]) ||
    !ENGINE_NAMES.has(dataValue(input, "engine")) ||
    typeof dataValue(input, "engineVersion") !== "string" ||
    !PRESTART_REASONS.has(dataValue(input, "reason")) ||
    !canonicalTimestamp(dataValue(input, "recordedAt"))
  ) {
    throw invalidContract("Invalid runtime prestart receipt input.");
  }
  const recordedAt = dataValue(input, "recordedAt");
  const reason = dataValue(input, "reason");
  const canceled = reason === "cancel_requested";
  const receipt = {
    cancelRequested: canceled,
    engine: dataValue(input, "engine"),
    engineVersion: dataValue(input, "engineVersion"),
    exitCode: null,
    finishedAt: recordedAt,
    reason,
    startedAt: recordedAt,
    status: canceled ? "canceled" : "failed",
    stderr: emptyStreamReceipt(),
    stdout: emptyStreamReceipt(),
    summary: reason,
    timedOut: false,
  };
  if (!parseEngineExecutionResult(receipt)) {
    throw invalidContract("Invalid runtime prestart receipt.");
  }
  return cloneAndFreeze(receipt);
}

export function createPrestartCancelingRecord(input) {
  try {
    if (
      !exactRecord(input, [
        "claimed",
        "createdAt",
        "observedAt",
        "renewal",
        "starting",
      ]) ||
      !canonicalTimestamp(dataValue(input, "createdAt")) ||
      !canonicalTimestamp(dataValue(input, "observedAt"))
    ) {
      throw invalidContract("Invalid prestart-cancel input.");
    }
    const records = validateAttemptRecordSet({
      claimed: dataValue(input, "claimed"),
      starting: dataValue(input, "starting"),
    });
    const renewal = normalizeRenewal(dataValue(input, "renewal"));
    if (!records || !renewal || renewal.cancelRequested !== true) {
      throw invalidContract("Invalid prestart-cancel evidence.");
    }
    const canceling = finalizeAttemptRecord({
      attemptId: records.claimed.attemptId,
      createdAt: dataValue(input, "createdAt"),
      observedAt: dataValue(input, "observedAt"),
      renewal,
      source: "renew",
      state: "canceling",
      v: 1,
    });
    const valid = validateAttemptRecordSet({
      ...records,
      canceling,
    });
    if (!valid) {
      throw invalidContract("Invalid starting-to-canceling transition.");
    }
    return valid.canceling;
  } catch (error) {
    if (error instanceof EngineLeaseRuntimeContractError) throw error;
    throw invalidContract("Invalid starting-to-canceling transition.");
  }
}

export function createSpawningRecord(input) {
  try {
    if (
      !exactRecord(input, ["claimed", "createdAt", "starting"]) ||
      !canonicalTimestamp(dataValue(input, "createdAt"))
    ) {
      throw invalidContract("Invalid spawning-record input.");
    }
    const records = validateAttemptRecordSet({
      claimed: dataValue(input, "claimed"),
      starting: dataValue(input, "starting"),
    });
    if (!records) {
      throw invalidContract("Invalid spawning journal prefix.");
    }
    const spawning = finalizeAttemptRecord({
      attemptId: records.claimed.attemptId,
      createdAt: dataValue(input, "createdAt"),
      state: "spawning",
      v: 1,
    });
    const valid = validateAttemptRecordSet({
      ...records,
      spawning,
    });
    if (!valid) {
      throw invalidContract("Invalid starting-to-spawning transition.");
    }
    return valid.spawning;
  } catch (error) {
    if (error instanceof EngineLeaseRuntimeContractError) throw error;
    throw invalidContract("Invalid starting-to-spawning transition.");
  }
}

export function createRuntimePrestartResultRecord(input) {
  try {
    const canceling = dataValue(input, "canceling");
    const spawning = dataValue(input, "spawning");
    const keys = canceling !== undefined
      ? ["canceling", "claimed", "createdAt", "reason", "starting"]
      : spawning === undefined
        ? ["claimed", "createdAt", "reason", "starting"]
        : ["claimed", "createdAt", "reason", "spawning", "starting"];
    if (
      (canceling !== undefined && spawning !== undefined) ||
      !exactRecord(input, keys) ||
      !canonicalTimestamp(dataValue(input, "createdAt"))
    ) {
      throw invalidContract("Invalid runtime prestart result input.");
    }
    const prefix = {
      claimed: dataValue(input, "claimed"),
      starting: dataValue(input, "starting"),
      ...(canceling === undefined ? {} : { canceling }),
      ...(spawning === undefined ? {} : { spawning }),
    };
    const records = validateAttemptRecordSet(prefix);
    if (!records) {
      throw invalidContract("Invalid runtime prestart journal prefix.");
    }
    const receipt = createRuntimePrestartReceipt({
      engine: records.starting.engine,
      engineVersion: records.starting.engineVersion,
      reason: dataValue(input, "reason"),
      recordedAt: dataValue(input, "createdAt"),
    });
    const result = finalizeAttemptRecord({
      attemptId: records.claimed.attemptId,
      createdAt: dataValue(input, "createdAt"),
      receipt,
      state: "result",
      v: 1,
    });
    const valid = validateAttemptRecordSet({
      ...records,
      result,
    });
    if (!valid) {
      throw invalidContract("Invalid runtime prestart result transition.");
    }
    return valid.result;
  } catch (error) {
    if (error instanceof EngineLeaseRuntimeContractError) throw error;
    throw invalidContract("Invalid runtime prestart result transition.");
  }
}

export function createPrestartAbandonedRecord(input) {
  try {
    if (!plainRecord(input)) {
      throw invalidContract("Invalid prestart abandonment input.");
    }
    const starting = dataValue(input, "starting");
    const spawning = dataValue(input, "spawning");
    const keys = spawning !== undefined
      ? ["claimed", "createdAt", "denial", "spawning", "starting"]
      : starting === undefined
        ? ["claimed", "createdAt", "denial"]
        : ["claimed", "createdAt", "denial", "starting"];
    if (
      !exactRecord(input, keys) ||
      !canonicalTimestamp(dataValue(input, "createdAt"))
    ) {
      throw invalidContract("Invalid prestart abandonment input.");
    }
    const prefix = starting === undefined
      ? { claimed: dataValue(input, "claimed") }
      : {
          claimed: dataValue(input, "claimed"),
          starting,
          ...(spawning === undefined ? {} : { spawning }),
        };
    const records = validateAttemptRecordSet(prefix);
    const denial = normalizeDenial(dataValue(input, "denial"));
    if (!records || !denial) {
      throw invalidContract("Invalid prestart abandonment evidence.");
    }
    const settled = finalizeAttemptRecord({
      attemptId: records.claimed.attemptId,
      createdAt: dataValue(input, "createdAt"),
      denial,
      operationId: records.claimed.claimOperationId,
      outcome: "abandoned",
      state: "settled",
      v: 1,
    });
    const valid = validateAttemptRecordSet({
      ...records,
      settled,
    });
    if (!valid) {
      throw invalidContract("Invalid prestart abandonment transition.");
    }
    return valid.settled;
  } catch (error) {
    if (error instanceof EngineLeaseRuntimeContractError) throw error;
    throw invalidContract("Invalid prestart abandonment transition.");
  }
}

export function createPrestartRejectedRecord(input) {
  try {
    if (
      !exactRecord(input, [
        "claimed",
        "createdAt",
        "descriptor",
        "observedAt",
        "reason",
      ]) ||
      !canonicalTimestamp(dataValue(input, "createdAt")) ||
      !canonicalTimestamp(dataValue(input, "observedAt"))
    ) {
      throw invalidContract("Invalid prestart rejection input.");
    }
    const records = validateAttemptRecordSet({
      claimed: dataValue(input, "claimed"),
    });
    const descriptor = normalizeDescriptor(
      dataValue(input, "descriptor"),
    );
    const createdAt = dataValue(input, "createdAt");
    const observedAt = dataValue(input, "observedAt");
    const reason = dataValue(input, "reason");
    const budget = descriptor
      ? evaluateDescriptorBudget({
          descriptor,
          nowMs: Date.parse(observedAt),
        })
      : undefined;
    const expectedReason = budget?.accepted
      ? undefined
      : budget?.reason;
    if (
      !records ||
      !descriptor ||
      observedAt > createdAt ||
      descriptor.runId !== records.claimed.runId ||
      descriptor.job.engine !== records.claimed.engine ||
      reason !== expectedReason
    ) {
      throw invalidContract("Invalid prestart rejection evidence.");
    }
    const settled = finalizeAttemptRecord({
      attemptId: records.claimed.attemptId,
      createdAt,
      operationId: records.claimed.claimOperationId,
      outcome: "abandoned",
      rejection: {
        descriptor,
        observedAt,
        reason,
      },
      state: "settled",
      v: 1,
    });
    const valid = validateAttemptRecordSet({
      ...records,
      settled,
    });
    if (!valid) {
      throw invalidContract("Invalid prestart rejection transition.");
    }
    return valid.settled;
  } catch (error) {
    if (error instanceof EngineLeaseRuntimeContractError) throw error;
    throw invalidContract("Invalid prestart rejection transition.");
  }
}

function normalizeExpected(input) {
  if (
    !exactRecord(input, ["fence", "leaseId", "runId"]) ||
    !validFence(dataValue(input, "fence")) ||
    !LEASE_PATTERN.test(dataValue(input, "leaseId") ?? "") ||
    !RUN_PATTERN.test(dataValue(input, "runId") ?? "")
  ) {
    return undefined;
  }
  return {
    fence: dataValue(input, "fence"),
    leaseId: dataValue(input, "leaseId"),
    runId: dataValue(input, "runId"),
  };
}

function normalizeRenewal(input) {
  if (
    !exactRecord(input, [
      "cancelRequested",
      "expiresAt",
      "fence",
      "leaseId",
      "runId",
    ]) ||
    typeof dataValue(input, "cancelRequested") !== "boolean" ||
    !canonicalTimestamp(dataValue(input, "expiresAt")) ||
    !validFence(dataValue(input, "fence")) ||
    !LEASE_PATTERN.test(dataValue(input, "leaseId") ?? "") ||
    !RUN_PATTERN.test(dataValue(input, "runId") ?? "")
  ) {
    return undefined;
  }
  return {
    cancelRequested: dataValue(input, "cancelRequested"),
    expiresAt: dataValue(input, "expiresAt"),
    fence: dataValue(input, "fence"),
    leaseId: dataValue(input, "leaseId"),
    runId: dataValue(input, "runId"),
  };
}

function normalizeLeaseState(input) {
  if (
    !exactRecord(input, [
      "cancelRequested",
      "deadlineAt",
      "expiresAt",
      "fence",
      "leaseId",
      "runId",
    ]) ||
    typeof dataValue(input, "cancelRequested") !== "boolean" ||
    !canonicalTimestamp(dataValue(input, "deadlineAt")) ||
    !canonicalTimestamp(dataValue(input, "expiresAt")) ||
    dataValue(input, "expiresAt") > dataValue(input, "deadlineAt") ||
    !validFence(dataValue(input, "fence")) ||
    !LEASE_PATTERN.test(dataValue(input, "leaseId") ?? "") ||
    !RUN_PATTERN.test(dataValue(input, "runId") ?? "")
  ) {
    return undefined;
  }
  return {
    cancelRequested: dataValue(input, "cancelRequested"),
    deadlineAt: dataValue(input, "deadlineAt"),
    expiresAt: dataValue(input, "expiresAt"),
    fence: dataValue(input, "fence"),
    leaseId: dataValue(input, "leaseId"),
    runId: dataValue(input, "runId"),
  };
}

function normalizeDenial(input) {
  if (
    !exactRecord(input, [
      "httpStatus",
      "observedAt",
      "serverError",
      "source",
    ]) ||
    !Number.isInteger(dataValue(input, "httpStatus")) ||
    !canonicalTimestamp(dataValue(input, "observedAt")) ||
    typeof dataValue(input, "serverError") !== "string" ||
    !["claim", "prompt", "renew"].includes(
      dataValue(input, "source"),
    )
  ) {
    return undefined;
  }
  return {
    httpStatus: dataValue(input, "httpStatus"),
    observedAt: dataValue(input, "observedAt"),
    serverError: dataValue(input, "serverError"),
    source: dataValue(input, "source"),
  };
}

function normalizeDescriptor(input) {
  try {
    const bytes = Buffer.from(canonicalJson(input), "utf8");
    return parseEngineLeaseDescriptor(bytes);
  } catch {
    return undefined;
  }
}

function boundedBytes(input) {
  try {
    if (typeof input === "string") {
      const bytes = Buffer.from(input, "utf8");
      return bytes.byteLength >= 2 &&
          bytes.byteLength <= ENGINE_LEASE_RUNTIME_LIMITS.responseMaxBytes
        ? bytes
        : undefined;
    }
    if (input instanceof Uint8Array) {
      return input.byteLength >= 2 &&
          input.byteLength <= ENGINE_LEASE_RUNTIME_LIMITS.responseMaxBytes
        ? Buffer.from(input)
        : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function emptyStreamReceipt() {
  return {
    bytes: 0,
    excerptBase64Url: "",
    sha256: EMPTY_SHA256,
    truncated: false,
  };
}

function validFence(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= ENGINE_LEASE_LIMITS.fenceMax
  );
}

function validNowMs(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
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

function invalidContract(message) {
  return new EngineLeaseRuntimeContractError(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactRecord(value, keys) {
  if (!plainRecord(value)) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (!ownKeys.every((key) => typeof key === "string")) return false;
    const actual = ownKeys.sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]) &&
      actual.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && descriptor.enumerable && "value" in descriptor;
      })
    );
  } catch {
    return false;
  }
}

function plainRecord(value) {
  try {
    return Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype,
    );
  } catch {
    return false;
  }
}

function dataValue(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
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
