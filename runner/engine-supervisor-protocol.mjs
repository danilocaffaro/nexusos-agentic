import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { posix } from "node:path";
import { parseEngineExecutionResult } from "./engine-complete-contract.mjs";
import {
  normalizeEngineExecutableFingerprint,
} from "./engine-executable-identity.mjs";

export const SUPERVISOR_BOOTSTRAP_MAX_BYTES = 512;
export const SUPERVISOR_CONTROL_MAX_BYTES = 16 * 1_024;
export const SUPERVISOR_EVENT_MAX_BYTES = 8 * 1_024;
export const SUPERVISOR_HANDSHAKE_TIMEOUT_MS = 5_000;
export const SUPERVISOR_INPUT_MAX_BYTES = 8 * 1_024;
export const SUPERVISOR_PROTOCOL_VERSION = 2;

const ATTEMPT_PATTERN = /^att_[0-9a-f]{32}$/u;
const ENGINE_NAMES = new Set(["claude_code_cli", "codex_cli"]);
const FAULT_CODES = new Set([
  "cancel_requested",
  "engine_deadline_exhausted",
  "engine_incompatible",
  "interrupted_after_start",
  "lease_lost",
  "prompt_erased",
  "prompt_integrity_mismatch",
  "prompt_unavailable",
  "protocol_invalid",
  "spawn_failed",
  "timed_out",
]);
const TERMINATION_REASONS = new Set([
  "cancel_requested",
  "engine_deadline_exhausted",
  "engine_incompatible",
  "lease_lost",
  "prompt_erased",
  "prompt_integrity_mismatch",
  "prompt_unavailable",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VERSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,63}$/u;
const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function encodeSupervisorStartToken(port, token) {
  if (!validPort(port) || !stringMatches(token, TOKEN_PATTERN)) {
    throw new TypeError("Supervisor identity is invalid.");
  }
  return `sup2:${port}:${token}`;
}

export function parseSupervisorStartToken(value) {
  // Undefined is an ambiguous identity, never evidence that a process is dead.
  if (typeof value !== "string") return undefined;
  const match = /^sup2:([1-9][0-9]{0,4}):([0-9a-f]{32})$/u.exec(value);
  if (!match) return undefined;
  const port = Number(match[1]);
  if (!validPort(port)) return undefined;
  return Object.freeze({ port, token: match[2] });
}

export function encodeChildStartToken(supervisorToken, ordinal) {
  if (
    !stringMatches(supervisorToken, TOKEN_PATTERN) ||
    ordinal !== 1
  ) {
    throw new TypeError("Supervisor child identity is invalid.");
  }
  return `eng2:${supervisorToken}:${ordinal}`;
}

export function parseChildStartToken(value) {
  if (typeof value !== "string") return undefined;
  const match = /^eng2:([0-9a-f]{32}):(1)$/u.exec(value);
  if (!match) return undefined;
  return Object.freeze({ ordinal: 1, supervisorToken: match[1] });
}

export function supervisorChallengeProof(token, attemptId, nonce) {
  if (
    !stringMatches(token, TOKEN_PATTERN) ||
    !stringMatches(attemptId, ATTEMPT_PATTERN) ||
    !stringMatches(nonce, TOKEN_PATTERN)
  ) {
    throw new TypeError("Supervisor challenge is invalid.");
  }
  return createHmac("sha256", Buffer.from(token, "hex"))
    .update(
      canonicalJson({
        attemptId,
        domain: "nexus-engine-supervisor-challenge-v2",
        nonce,
      }),
    )
    .digest("hex");
}

export function verifySupervisorHelloAck(challenge, frame) {
  if (!plainRecord(challenge)) return false;
  const { token, attemptId, nonce } = challenge;
  if (
    !isEvent(frame) ||
    frame.kind !== "hello_ack" ||
    frame.attemptId !== attemptId ||
    frame.nonce !== nonce
  ) {
    return false;
  }
  let expected;
  try {
    expected = supervisorChallengeProof(token, attemptId, nonce);
  } catch {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(frame.proof, "hex"),
  );
}

export function verifySupervisorChildEvent(token, frame) {
  if (
    !stringMatches(token, TOKEN_PATTERN) ||
    !isEvent(frame) ||
    !["running", "waiting_input"].includes(frame.state)
  ) {
    return false;
  }
  const child = parseChildStartToken(frame.childToken);
  return Boolean(
    child &&
      timingSafeEqual(
        Buffer.from(token, "hex"),
        Buffer.from(child.supervisorToken, "hex"),
      ),
  );
}

export function supervisorFaultReason(state, code) {
  if (
    !["waiting_spawn", "waiting_input", "running"].includes(state) ||
    !FAULT_CODES.has(code)
  ) {
    throw new TypeError("Supervisor fault classification is invalid.");
  }
  if (code === "cancel_requested") return "cancel_requested";
  if (code === "engine_deadline_exhausted") {
    return "engine_deadline_exhausted";
  }
  if (code === "lease_lost") return "lease_lost";
  if (
    [
      "engine_incompatible",
      "prompt_erased",
      "prompt_integrity_mismatch",
      "prompt_unavailable",
    ].includes(code)
  ) {
    return code;
  }
  if (state === "waiting_spawn") return "spawn_failed";
  if (code === "timed_out") return "timed_out";
  if (code === "protocol_invalid") return "protocol_invalid";
  return "interrupted_after_start";
}

export function createSupervisorPrestartReceipt({
  engine,
  engineVersion,
  recordedAt,
  reason = "spawn_failed",
}) {
  const canceled = reason === "cancel_requested";
  if (
    ![
      "cancel_requested",
      "engine_deadline_exhausted",
      "engine_incompatible",
      "lease_lost",
      "prompt_erased",
      "prompt_integrity_mismatch",
      "prompt_unavailable",
      "spawn_failed",
    ].includes(reason)
  ) {
    throw new TypeError("Supervisor prestart receipt is invalid.");
  }
  const receipt = {
    cancelRequested: canceled,
    engine,
    engineVersion,
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
    throw new TypeError("Supervisor prestart receipt is invalid.");
  }
  return cloneAndFreeze(receipt);
}

export function encodeSupervisorBootstrap(frame) {
  if (!isBootstrap(frame)) {
    throw new TypeError("Supervisor bootstrap frame is invalid.");
  }
  return encodeFrame(frame, SUPERVISOR_BOOTSTRAP_MAX_BYTES);
}

export function parseSupervisorBootstrap(input) {
  return parseFrame(input, SUPERVISOR_BOOTSTRAP_MAX_BYTES, isBootstrap);
}

export function encodeSupervisorControl(frame) {
  if (!isControl(frame)) {
    throw new TypeError("Supervisor control frame is invalid.");
  }
  return encodeFrame(frame, SUPERVISOR_CONTROL_MAX_BYTES);
}

export function parseSupervisorControl(input) {
  return parseFrame(input, SUPERVISOR_CONTROL_MAX_BYTES, isControl);
}

export function encodeSupervisorEvent(frame) {
  if (!isEvent(frame)) {
    throw new TypeError("Supervisor event frame is invalid.");
  }
  return encodeFrame(frame, SUPERVISOR_EVENT_MAX_BYTES);
}

export function parseSupervisorEvent(input) {
  return parseFrame(input, SUPERVISOR_EVENT_MAX_BYTES, isEvent);
}

function isBootstrap(frame) {
  return Boolean(
    plainRecord(frame) &&
      hasExactKeys(frame, ["kind", "pid", "port", "token", "v"]) &&
    frame.v === SUPERVISOR_PROTOCOL_VERSION &&
      frame.kind === "ready" &&
      validPid(frame.pid) &&
      validPort(frame.port) &&
      stringMatches(frame.token, TOKEN_PATTERN),
  );
}

/*
 * The connection is the authentication scope: a token-bearing control may be
 * sent only on the same socket whose hello_ack was verified. Reconnection
 * always starts with a fresh nonce and proof. pid/childPid are audit facts
 * only; recovery never signals either and asks the verified supervisor to
 * terminate its own process group.
 */
function isControl(frame) {
  if (
    !plainRecord(frame) ||
    frame.v !== SUPERVISOR_PROTOCOL_VERSION ||
    ![
      "abandon",
      "ack_result",
      "attach",
      "authorize_input",
      "authorize_spawn",
      "hello",
      "terminate",
    ].includes(frame.kind) ||
    !stringMatches(frame.attemptId, ATTEMPT_PATTERN)
  ) {
    return false;
  }
  if (frame.kind === "hello") {
    return (
      hasExactKeys(frame, ["attemptId", "kind", "nonce", "v"]) &&
      stringMatches(frame.nonce, TOKEN_PATTERN)
    );
  }
  if (frame.kind === "attach") {
    return Boolean(
      hasExactKeys(frame, ["attemptId", "kind", "token", "v"]) &&
        stringMatches(frame.token, TOKEN_PATTERN),
    );
  }
  if (frame.kind === "terminate") {
    return Boolean(
      hasExactKeys(frame, [
        "attemptId",
        "kind",
        "reason",
        "token",
        "v",
      ]) &&
        TERMINATION_REASONS.has(frame.reason) &&
        stringMatches(frame.token, TOKEN_PATTERN),
    );
  }
  if (frame.kind === "authorize_spawn") {
    return (
      hasExactKeys(frame, [
        "attemptId",
        "kind",
        "request",
        "token",
        "v",
      ]) &&
      stringMatches(frame.token, TOKEN_PATTERN) &&
      validSpawnRequest(frame.request)
    );
  }
  if (frame.kind === "authorize_input") {
    const child = parseChildStartToken(frame.childToken);
    return (
      hasExactKeys(frame, [
        "attemptId",
        "childToken",
        "kind",
        "token",
        "v",
      ]) &&
      stringMatches(frame.token, TOKEN_PATTERN) &&
      child &&
      child.supervisorToken === frame.token
    );
  }
  return Boolean(
    hasExactKeys(frame, ["attemptId", "kind", "token", "v"]) &&
      stringMatches(frame.token, TOKEN_PATTERN),
  );
}

function validSpawnRequest(request) {
  if (
    !plainRecord(request) ||
    !hasExactKeys(request, [
      "cwdRoot",
      "deadlineAt",
      "engine",
      "engineVersion",
      "binaryFingerprint",
      "executableRealPath",
      "inputBase64",
      "inputSha256",
      "timeoutMs",
    ]) ||
    !safeAbsolutePath(request.cwdRoot) ||
    !safeAbsolutePath(request.executableRealPath) ||
    !canonicalTimestamp(request.deadlineAt) ||
    !ENGINE_NAMES.has(request.engine) ||
    !normalizeEngineExecutableFingerprint(
      request.binaryFingerprint,
    ) ||
    typeof request.engineVersion !== "string" ||
    !VERSION_PATTERN.test(request.engineVersion) ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 270_000 ||
    request.timeoutMs > 600_000 ||
    typeof request.inputBase64 !== "string" ||
    typeof request.inputSha256 !== "string" ||
    !stringMatches(request.inputSha256, SHA256_PATTERN)
  ) {
    return false;
  }
  const input = decodeCanonicalBase64Url(request.inputBase64);
  const valid = Boolean(
    input &&
      input.byteLength >= 1 &&
      input.byteLength <= SUPERVISOR_INPUT_MAX_BYTES &&
      createHash("sha256").update(input).digest("hex") ===
        request.inputSha256,
  );
  input?.fill(0);
  return valid;
}

function isEvent(frame) {
  if (
    !plainRecord(frame) ||
    frame.v !== SUPERVISOR_PROTOCOL_VERSION ||
    !stringMatches(frame.attemptId, ATTEMPT_PATTERN)
  ) {
    return false;
  }
  if (frame.kind === "hello_ack") {
    return Boolean(
      hasExactKeys(frame, [
        "attemptId",
        "kind",
        "nonce",
        "proof",
        "v",
      ]) &&
        stringMatches(frame.nonce, TOKEN_PATTERN) &&
        stringMatches(frame.proof, SHA256_PATTERN),
    );
  }
  if (
    frame.kind !== "state" ||
    !["fault", "result", "running", "waiting_input", "waiting_spawn"].includes(
      frame.state,
    )
  ) {
    return false;
  }
  if (frame.state === "waiting_spawn") {
    return hasExactKeys(frame, ["attemptId", "kind", "state", "v"]);
  }
  if (frame.state === "waiting_input" || frame.state === "running") {
    // The parent must copy this exact startedAt into started.json and the
    // eventual receipt; the frozen journal contract rejects timestamp drift.
    return Boolean(
      hasExactKeys(frame, [
        "attemptId",
        "childPid",
        "childToken",
        "kind",
        "startedAt",
        "state",
        "v",
      ]) &&
        validPid(frame.childPid) &&
        parseChildStartToken(frame.childToken) &&
        canonicalTimestamp(frame.startedAt),
    );
  }
  if (frame.state === "result") {
    return (
      hasExactKeys(frame, [
        "attemptId",
        "kind",
        "receipt",
        "state",
        "v",
      ]) && Boolean(parseEngineExecutionResult(frame.receipt))
    );
  }
  return Boolean(
    hasExactKeys(frame, [
      "attemptId",
      "code",
      "kind",
      "state",
      "v",
    ]) && FAULT_CODES.has(frame.code),
  );
}

function parseFrame(input, maximum, validate) {
  const bytes =
    typeof input === "string"
      ? Buffer.from(input, "utf8")
      : input instanceof Uint8Array
        ? Buffer.from(input)
        : undefined;
  if (!bytes || bytes.byteLength < 2 || bytes.byteLength > maximum) {
    return undefined;
  }
  let text;
  let frame;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    frame = JSON.parse(text);
  } catch {
    bytes.fill(0);
    return undefined;
  }
  if (
    !validate(frame) ||
    text !== `${canonicalJson(frame)}\n`
  ) {
    bytes.fill(0);
    return undefined;
  }
  const parsed = cloneAndFreeze(frame);
  bytes.fill(0);
  return parsed;
}

function encodeFrame(frame, maximum) {
  const bytes = Buffer.from(`${canonicalJson(frame)}\n`, "utf8");
  if (bytes.byteLength > maximum) {
    throw new TypeError("Supervisor frame exceeds its transport bound.");
  }
  return bytes;
}

function decodeCanonicalBase64Url(value) {
  if (!/^(?:[A-Za-z0-9_-]{2,})$/u.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function safeAbsolutePath(value) {
  return Boolean(
    typeof value === "string" &&
      Buffer.byteLength(value, "utf8") <= 1_024 &&
      value.isWellFormed() &&
      posix.isAbsolute(value) &&
      value !== "/" &&
      !value.endsWith("/") &&
      !hasControlCharacter(value) &&
      !value.includes("//") &&
      !value.split("/").includes(".") &&
      !value.split("/").includes(".."),
  );
}

function validPid(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 2_147_483_647
  );
}

function validPort(value) {
  return Number.isSafeInteger(value) && value >= 1_024 && value <= 65_535;
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function stringMatches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function emptyStreamReceipt() {
  return {
    bytes: 0,
    excerptBase64Url: "",
    sha256: EMPTY_SHA256,
    truncated: false,
  };
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreeze(item)));
  }
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          cloneAndFreeze(item),
        ]),
      ),
    );
  }
  return value;
}

function canonicalJson(value) {
  if (value === undefined) {
    throw new TypeError("Undefined is not canonical JSON.");
  }
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
