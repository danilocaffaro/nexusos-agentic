import { createHash } from "node:crypto";
import {
  finalizeAttemptRecord,
  isAttemptRecord,
  validateAttemptRecordSet,
} from "./attempt-journal-contract.mjs";
import {
  ENGINE_LEASE_LIMITS,
} from "./engine-lease-limits.mjs";

export const ENGINE_CLAIM_CONTRACT_LIMITS = ENGINE_LEASE_LIMITS;

export const ENGINE_DESCRIPTOR_REJECTION_REASONS = Object.freeze([
  "engine_deadline_insufficient",
  "lease_expired",
]);

const ATTEMPT_PATTERN = /^att_[0-9a-f]{32}$/u;
const ENGINE_NAMES = new Set(["claude_code_cli", "codex_cli"]);
const LEASE_PATTERN = /^lse_[0-9a-f]{32}$/u;
const OPERATION_PATTERN = /^op_[0-9a-f]{32}$/u;
const PROMPT_PATTERN = /^prm_[0-9a-f]{32}$/u;
const RUN_PATTERN = /^run_[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VERSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,63}$/u;
const CLAIM_OPERATION_DOMAIN =
  "nexus-runner-engine-claim-operation-v1";
const CLAIM_SIGNATURE_DOMAIN =
  "nexus-runner-engine-lease-claim-v1";
const PROMPT_SIGNATURE_DOMAIN =
  "nexus-runner-engine-prompt-read-v1";
const OUTPUT_BOUNDS = Object.freeze({
  stderrBytes: 65_536,
  stdoutBytes: 262_144,
});

export class EngineClaimContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineClaimContractError";
    this.code = "engine_claim_contract_invalid";
  }
}

export function deriveEngineClaimOperationId(attemptId) {
  if (
    typeof attemptId !== "string" ||
    !ATTEMPT_PATTERN.test(attemptId)
  ) {
    throw invalidContract("Invalid engine attempt identifier.");
  }
  const digest = createHash("sha256")
    .update(canonicalJson({
      attemptId,
      domain: CLAIM_OPERATION_DOMAIN,
    }))
    .digest("hex")
    .slice(0, 32);
  return `op_${digest}`;
}

export function createEngineClaimBody(input) {
  if (
    !exactRecord(input, ["engine", "operationId"]) ||
    !ENGINE_NAMES.has(dataValue(input, "engine")) ||
    !OPERATION_PATTERN.test(dataValue(input, "operationId") ?? "")
  ) {
    throw invalidContract("Invalid engine claim body.");
  }
  return Buffer.from(canonicalJson({
    engine: dataValue(input, "engine"),
    operationId: dataValue(input, "operationId"),
  }), "utf8");
}

export function createEngineClaimIntent(input) {
  if (
    !exactRecord(input, ["attemptId", "engine", "runId"]) ||
    !ATTEMPT_PATTERN.test(dataValue(input, "attemptId") ?? "") ||
    !ENGINE_NAMES.has(dataValue(input, "engine")) ||
    !RUN_PATTERN.test(dataValue(input, "runId") ?? "")
  ) {
    throw invalidContract("Invalid engine claim intent.");
  }
  const attemptId = dataValue(input, "attemptId");
  const engine = dataValue(input, "engine");
  const runId = dataValue(input, "runId");
  const operationId = deriveEngineClaimOperationId(attemptId);
  const body = createEngineClaimBody({ engine, operationId });
  return cloneAndFreeze({
    attemptId,
    engine,
    operationId,
    request: {
      bodyBase64Url: body.toString("base64url"),
      bodySha256: sha256(body),
      pathname: `/api/runs/${runId}/engine-lease/claim`,
      signatureDomain: CLAIM_SIGNATURE_DOMAIN,
    },
    runId,
  });
}

export function createPromptReadBody(input) {
  if (
    !exactRecord(input, ["fence", "leaseId", "promptRef"]) ||
    !validFence(dataValue(input, "fence")) ||
    !LEASE_PATTERN.test(dataValue(input, "leaseId") ?? "") ||
    !PROMPT_PATTERN.test(dataValue(input, "promptRef") ?? "")
  ) {
    throw invalidContract("Invalid engine prompt-read body.");
  }
  return Buffer.from(canonicalJson({
    fence: dataValue(input, "fence"),
    leaseId: dataValue(input, "leaseId"),
    promptRef: dataValue(input, "promptRef"),
  }), "utf8");
}

export function createEnginePromptIntent(descriptorInput) {
  const descriptor = normalizeDescriptor(descriptorInput);
  if (!descriptor) {
    throw invalidContract("Invalid engine lease descriptor.");
  }
  const body = createPromptReadBody({
    fence: descriptor.fence,
    leaseId: descriptor.leaseId,
    promptRef: descriptor.job.promptRef,
  });
  return cloneAndFreeze({
    expected: {
      promptBytes: descriptor.job.promptBytes,
      promptRef: descriptor.job.promptRef,
      promptSha256: descriptor.job.promptSha256,
    },
    request: {
      bodyBase64Url: body.toString("base64url"),
      bodySha256: sha256(body),
      pathname: `/api/runs/${descriptor.runId}/prompt`,
      signatureDomain: PROMPT_SIGNATURE_DOMAIN,
    },
    runId: descriptor.runId,
  });
}

export function createEnginePromptIntentFromStarting(starting) {
  if (
    !isAttemptRecord(starting) ||
    starting.state !== "starting"
  ) {
    throw invalidContract("Invalid starting prompt intent.");
  }
  const body = createPromptReadBody({
    fence: starting.fence,
    leaseId: starting.leaseId,
    promptRef: starting.promptRef,
  });
  return cloneAndFreeze({
    expected: {
      promptBytes: starting.promptBytes,
      promptRef: starting.promptRef,
      promptSha256: starting.promptSha256,
    },
    request: {
      bodyBase64Url: body.toString("base64url"),
      bodySha256: sha256(body),
      pathname: `/api/runs/${starting.runId}/prompt`,
      signatureDomain: PROMPT_SIGNATURE_DOMAIN,
    },
    runId: starting.runId,
  });
}

export function parseEngineLeaseDescriptor(input) {
  const bytes = exactBytes(input);
  if (
    !bytes ||
    bytes.byteLength < 2 ||
    bytes.byteLength > ENGINE_CLAIM_CONTRACT_LIMITS.descriptorBytes ||
    hasUtf8Bom(bytes)
  ) {
    return undefined;
  }
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const parsed = JSON.parse(text);
    const descriptor = normalizeDescriptor(parsed);
    if (!descriptor || canonicalJson(descriptor) !== text) {
      return undefined;
    }
    return cloneAndFreeze(descriptor);
  } catch {
    return undefined;
  }
}

export function evaluateDescriptorBudget(input) {
  if (
    !exactRecord(input, ["descriptor", "nowMs"]) ||
    !Number.isSafeInteger(dataValue(input, "nowMs")) ||
    dataValue(input, "nowMs") < 0
  ) {
    throw invalidContract("Invalid engine descriptor budget input.");
  }
  const descriptor = normalizeDescriptor(dataValue(input, "descriptor"));
  if (!descriptor) {
    throw invalidContract("Invalid engine lease descriptor.");
  }
  if (Date.parse(descriptor.expiresAt) <= dataValue(input, "nowMs")) {
    return Object.freeze({
      accepted: false,
      reason: "lease_expired",
    });
  }
  const remainingMs =
    Date.parse(descriptor.job.deadlineAt) -
    dataValue(input, "nowMs") -
    ENGINE_CLAIM_CONTRACT_LIMITS.deadlineReserveMs;
  const effectiveTimeoutMs = Math.min(
    descriptor.job.timeoutMs,
    remainingMs,
  );
  if (
    !Number.isSafeInteger(effectiveTimeoutMs) ||
    effectiveTimeoutMs <
      ENGINE_CLAIM_CONTRACT_LIMITS.effectiveTimeoutMinMs
  ) {
    return Object.freeze({
      accepted: false,
      reason: "engine_deadline_insufficient",
    });
  }
  return Object.freeze({
    accepted: true,
    effectiveTimeoutMs,
  });
}

export function verifyPromptPayload(input) {
  if (
    !exactRecord(input, ["bytes", "expected", "headers"])
  ) {
    return Object.freeze({ kind: "protocol" });
  }
  const bytes = exactBytes(dataValue(input, "bytes"));
  const expected = normalizeExpectedPrompt(dataValue(input, "expected"));
  const headers = normalizePromptHeaders(dataValue(input, "headers"));
  if (!bytes || !expected || !headers) {
    return Object.freeze({ kind: "protocol" });
  }
  if (
    headers.promptBytes !== expected.promptBytes ||
    headers.promptRef !== expected.promptRef ||
    headers.promptSha256 !== expected.promptSha256 ||
    bytes.byteLength !== expected.promptBytes ||
    sha256(bytes) !== expected.promptSha256
  ) {
    return Object.freeze({
      kind: "integrity",
      reason: "prompt_integrity_mismatch",
    });
  }
  return Object.freeze({
    kind: "verified",
    metadata: Object.freeze({
      promptBytes: expected.promptBytes,
      promptRef: expected.promptRef,
      promptSha256: expected.promptSha256,
    }),
  });
}

export function createClaimedRecord(input) {
  if (
    !exactRecord(input, [
      "attemptId",
      "createdAt",
      "engine",
      "runId",
    ]) ||
    !canonicalTimestamp(dataValue(input, "createdAt"))
  ) {
    throw invalidContract("Invalid claimed-record input.");
  }
  const intent = createEngineClaimIntent({
    attemptId: dataValue(input, "attemptId"),
    engine: dataValue(input, "engine"),
    runId: dataValue(input, "runId"),
  });
  const body = Buffer.from(intent.request.bodyBase64Url, "base64url");
  return cloneAndFreeze(finalizeAttemptRecord({
    attemptId: intent.attemptId,
    claimBodySha256: sha256(body),
    claimOperationId: intent.operationId,
    createdAt: dataValue(input, "createdAt"),
    engine: intent.engine,
    runId: intent.runId,
    state: "claimed",
    v: 1,
  }));
}

export function createStartingRecord(input) {
  if (
    !exactRecord(input, [
      "claimed",
      "createdAt",
      "descriptor",
      "effectiveTimeoutMs",
    ]) ||
    !canonicalTimestamp(dataValue(input, "createdAt"))
  ) {
    throw invalidContract("Invalid starting-record input.");
  }
  const claimedSet = validateAttemptRecordSet({
    claimed: dataValue(input, "claimed"),
  });
  const descriptor = normalizeDescriptor(dataValue(input, "descriptor"));
  const effectiveTimeoutMs = dataValue(input, "effectiveTimeoutMs");
  const budget = descriptor
    ? evaluateDescriptorBudget({
        descriptor,
        nowMs: Date.parse(dataValue(input, "createdAt")),
      })
    : undefined;
  if (
    !claimedSet ||
    !descriptor ||
    !budget?.accepted ||
    !Number.isSafeInteger(effectiveTimeoutMs) ||
    effectiveTimeoutMs !== budget.effectiveTimeoutMs ||
    descriptor.runId !== claimedSet.claimed.runId ||
    descriptor.job.engine !== claimedSet.claimed.engine
  ) {
    throw invalidContract("Claim and lease descriptor do not correlate.");
  }
  const starting = finalizeAttemptRecord({
    attemptId: claimedSet.claimed.attemptId,
    cancelRequested: descriptor.cancelRequested,
    createdAt: dataValue(input, "createdAt"),
    deadlineAt: descriptor.job.deadlineAt,
    engine: descriptor.job.engine,
    engineVersion: descriptor.job.engineVersion,
    expiresAt: descriptor.expiresAt,
    fence: descriptor.fence,
    leaseId: descriptor.leaseId,
    outputBounds: descriptor.job.outputBounds,
    promptBytes: descriptor.job.promptBytes,
    promptRef: descriptor.job.promptRef,
    promptSha256: descriptor.job.promptSha256,
    runId: descriptor.runId,
    state: "starting",
    timeoutMs: effectiveTimeoutMs,
    v: 1,
  });
  const valid = validateAttemptRecordSet({
    claimed: claimedSet.claimed,
    starting,
  });
  if (!valid) {
    throw invalidContract("Invalid claimed-to-starting transition.");
  }
  return valid.starting;
}

function normalizeDescriptor(input) {
  try {
    if (
      !exactRecord(input, [
        "cancelRequested",
        "expiresAt",
        "fence",
        "job",
        "leaseId",
        "runId",
      ])
    ) {
      return undefined;
    }
    const cancelRequested = dataValue(input, "cancelRequested");
    const expiresAt = dataValue(input, "expiresAt");
    const fence = dataValue(input, "fence");
    const job = dataValue(input, "job");
    const leaseId = dataValue(input, "leaseId");
    const runId = dataValue(input, "runId");
    if (
      typeof cancelRequested !== "boolean" ||
      !canonicalTimestamp(expiresAt) ||
      !validFence(fence) ||
      !LEASE_PATTERN.test(leaseId ?? "") ||
      !RUN_PATTERN.test(runId ?? "") ||
      !exactRecord(job, [
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
      return undefined;
    }
    const deadlineAt = dataValue(job, "deadlineAt");
    const engine = dataValue(job, "engine");
    const engineVersion = dataValue(job, "engineVersion");
    const outputBounds = dataValue(job, "outputBounds");
    const promptBytes = dataValue(job, "promptBytes");
    const promptRef = dataValue(job, "promptRef");
    const promptSha256 = dataValue(job, "promptSha256");
    const timeoutMs = dataValue(job, "timeoutMs");
    if (
      !canonicalTimestamp(deadlineAt) ||
      expiresAt > deadlineAt ||
      !ENGINE_NAMES.has(engine) ||
      typeof engineVersion !== "string" ||
      Buffer.byteLength(engineVersion, "utf8") > 64 ||
      !VERSION_PATTERN.test(engineVersion) ||
      !exactOutputBounds(outputBounds) ||
      !Number.isSafeInteger(promptBytes) ||
      promptBytes < 1 ||
      promptBytes > ENGINE_CLAIM_CONTRACT_LIMITS.promptBytes ||
      !PROMPT_PATTERN.test(promptRef ?? "") ||
      !SHA256_PATTERN.test(promptSha256 ?? "") ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < ENGINE_CLAIM_CONTRACT_LIMITS.timeoutMinMs ||
      timeoutMs > ENGINE_CLAIM_CONTRACT_LIMITS.timeoutMaxMs
    ) {
      return undefined;
    }
    return {
      cancelRequested,
      expiresAt,
      fence,
      job: {
        deadlineAt,
        engine,
        engineVersion,
        outputBounds: {
          stderrBytes: OUTPUT_BOUNDS.stderrBytes,
          stdoutBytes: OUTPUT_BOUNDS.stdoutBytes,
        },
        promptBytes,
        promptRef,
        promptSha256,
        timeoutMs,
      },
      leaseId,
      runId,
    };
  } catch {
    return undefined;
  }
}

function normalizeExpectedPrompt(input) {
  if (
    !exactRecord(input, [
      "promptBytes",
      "promptRef",
      "promptSha256",
    ])
  ) {
    return undefined;
  }
  const promptBytes = dataValue(input, "promptBytes");
  const promptRef = dataValue(input, "promptRef");
  const promptSha256 = dataValue(input, "promptSha256");
  if (
    !Number.isSafeInteger(promptBytes) ||
    promptBytes < 1 ||
    promptBytes > ENGINE_CLAIM_CONTRACT_LIMITS.promptBytes ||
    !PROMPT_PATTERN.test(promptRef ?? "") ||
    !SHA256_PATTERN.test(promptSha256 ?? "")
  ) {
    return undefined;
  }
  return { promptBytes, promptRef, promptSha256 };
}

function normalizePromptHeaders(headers) {
  const contentType = safeHeader(headers, "content-type");
  const promptBytesText = safeHeader(
    headers,
    "x-nexus-prompt-bytes",
  );
  const promptRef = safeHeader(headers, "x-nexus-prompt-ref");
  const promptSha256 = safeHeader(
    headers,
    "x-nexus-prompt-sha256",
  );
  if (
    contentType !== "application/octet-stream" ||
    typeof promptBytesText !== "string" ||
    !/^[1-9]\d{0,3}$/u.test(promptBytesText) ||
    Number(promptBytesText) >
      ENGINE_CLAIM_CONTRACT_LIMITS.promptBytes ||
    !PROMPT_PATTERN.test(promptRef ?? "") ||
    !SHA256_PATTERN.test(promptSha256 ?? "")
  ) {
    return undefined;
  }
  return {
    promptBytes: Number(promptBytesText),
    promptRef,
    promptSha256,
  };
}

function safeHeader(headers, name) {
  try {
    const getHeader = headers?.get;
    if (headers && typeof getHeader === "function") {
      const value = getHeader.call(headers, name);
      return value === null || typeof value === "string"
        ? value
        : undefined;
    }
    if (plainRecord(headers)) {
      const value = dataValue(headers, name);
      return typeof value === "string" ? value : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function exactOutputBounds(value) {
  return Boolean(
    exactRecord(value, ["stderrBytes", "stdoutBytes"]) &&
      dataValue(value, "stderrBytes") === OUTPUT_BOUNDS.stderrBytes &&
      dataValue(value, "stdoutBytes") === OUTPUT_BOUNDS.stdoutBytes,
  );
}

function validFence(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= ENGINE_CLAIM_CONTRACT_LIMITS.fenceMax
  );
}

function canonicalTimestamp(value) {
  if (
    typeof value !== "string" ||
    !TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function exactBytes(input) {
  let byteView;
  try {
    byteView = input instanceof Uint8Array;
  } catch {
    return undefined;
  }
  if (typeof input !== "string" && !byteView) {
    return undefined;
  }
  return typeof input === "string" ? Buffer.from(input, "utf8") : input;
}

function hasUtf8Bom(bytes) {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
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

function invalidContract(message) {
  return new EngineClaimContractError(message);
}
