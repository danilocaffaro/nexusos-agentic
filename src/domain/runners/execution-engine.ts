import type {
  EngineCompleteBody,
  EngineExecutionInput,
  EngineExecutionReason,
  EngineExecutionResult,
  EngineExecutionSummary,
  EngineJobDescriptor,
  EngineProbe,
  EnginePromptDescriptor,
  EngineStreamReceipt,
  ExecutionEngineName,
} from "../../contracts/execution-engines";
import {
  ENGINE_COMPLETION_MAX_BYTES,
  ENGINE_CREATE_REQUEST_MAX_BYTES,
  ENGINE_EXECUTION_LIMITS,
  ENGINE_EXECUTION_REASONS,
  ENGINE_EXECUTION_STATUSES,
  ENGINE_EXECUTION_TIMEOUT_MAX_MS,
  ENGINE_EXECUTION_TIMEOUT_MIN_MS,
  ENGINE_EXCERPT_MAX_BYTES,
  ENGINE_OUTPUT_BOUNDS,
  ENGINE_PROMPT_MAX_BYTES,
  ENGINE_PROMPT_MIN_BYTES,
  ENGINE_PROBE_READINESS,
  ENGINE_PROBE_REASONS,
  ENGINE_PROBE_STATUSES,
  ENGINE_STDERR_MAX_BYTES,
  ENGINE_STDOUT_MAX_BYTES,
  ENGINE_SUMMARY_MAX_BYTES,
  ENGINE_VERSION_MAX_BYTES,
  EXECUTION_ENGINE_NAMES,
} from "../../contracts/execution-engines";
import { canonicalJson } from "../governance/canonical-json";
import { sha256Bytes } from "../governance/crypto";
import {
  LEASE_ID_PATTERN,
  OPERATION_ID_PATTERN,
} from "./lease-protocol";

export const ENGINE_PROMPT_REF_PATTERN = /^prm_[0-9a-f]{32}$/u;
export const ENGINE_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const ENGINE_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export const ENGINE_VERSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,63}$/u;

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_FENCE = 2_147_483_647;

export interface ExecutionEngine {
  readonly name: ExecutionEngineName;
  execute(input: EngineExecutionInput): Promise<EngineExecutionResult>;
  probe(): Promise<EngineProbe>;
}

type EngineExecutionFaultReason = Exclude<
  EngineExecutionReason,
  "none" | "engine_exit_nonzero" | "output_limit_reached"
>;

export class EngineExecutionFault extends Error {
  readonly reason: EngineExecutionFaultReason;

  constructor(
    reason: EngineExecutionFaultReason,
  ) {
    super(reason);
    this.name = "EngineExecutionFault";
    this.reason = reason;
  }
}

export class EngineContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineContractError";
  }
}

export class FakeExecutionEngine implements ExecutionEngine {
  executeCount = 0;
  readonly name: ExecutionEngineName;
  readonly #execute: (
    input: EngineExecutionInput,
  ) => Promise<EngineExecutionResult>;
  readonly #probe: () => Promise<EngineProbe>;

  constructor(input: {
    execute: (
      execution: EngineExecutionInput,
    ) => Promise<EngineExecutionResult>;
    name: ExecutionEngineName;
    probe?: () => Promise<EngineProbe>;
  }) {
    this.name = input.name;
    this.#execute = input.execute;
    this.#probe =
      input.probe ??
      (async () => ({
        collectedAt: "2026-07-26T12:00:00.000Z",
        engine: input.name,
        readiness: "ready",
        reason: "none",
        status: "available",
        version: "fake-1.0.0",
      }));
  }

  async execute(input: EngineExecutionInput): Promise<EngineExecutionResult> {
    this.executeCount += 1;
    return this.#execute(input);
  }

  probe(): Promise<EngineProbe> {
    return this.#probe();
  }
}

export function isExecutionEngineName(
  value: unknown,
): value is ExecutionEngineName {
  return isMember(EXECUTION_ENGINE_NAMES, value);
}

export function parseEngineProbe(input: unknown): EngineProbe | undefined {
  const value = plainRecord(input);
  const hasVersion = value?.version !== undefined;
  if (
    !value ||
    !hasExactKeys(
      value,
      hasVersion
        ? [
            "collectedAt",
            "engine",
            "readiness",
            "reason",
            "status",
            "version",
          ]
        : ["collectedAt", "engine", "readiness", "reason", "status"],
    ) ||
    !isCanonicalTimestamp(value.collectedAt) ||
    !isExecutionEngineName(value.engine) ||
    !isMember(ENGINE_PROBE_READINESS, value.readiness) ||
    !isMember(ENGINE_PROBE_REASONS, value.reason) ||
    !isMember(ENGINE_PROBE_STATUSES, value.status) ||
    (hasVersion && !isSafeVersion(value.version)) ||
    !isProbeConsistent(value, hasVersion)
  ) {
    return undefined;
  }
  return {
    collectedAt: value.collectedAt as string,
    engine: value.engine,
    readiness: value.readiness,
    reason: value.reason,
    status: value.status,
    ...(hasVersion ? { version: value.version as string } : {}),
  };
}

export function buildEngineJobDescriptor(
  input: EnginePromptDescriptor & {
    deadlineAt: string;
    engine: ExecutionEngineName;
    engineVersion: string;
    timeoutMs: number;
  },
): EngineJobDescriptor {
  if (
    !isExecutionEngineName(input.engine) ||
    !isSafeVersion(input.engineVersion) ||
    !isCanonicalTimestamp(input.deadlineAt) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < ENGINE_EXECUTION_TIMEOUT_MIN_MS ||
    input.timeoutMs > ENGINE_EXECUTION_TIMEOUT_MAX_MS ||
    !ENGINE_PROMPT_REF_PATTERN.test(input.promptRef) ||
    !ENGINE_SHA256_PATTERN.test(input.promptSha256) ||
    !Number.isSafeInteger(input.promptBytes) ||
    input.promptBytes < ENGINE_PROMPT_MIN_BYTES ||
    input.promptBytes > ENGINE_PROMPT_MAX_BYTES
  ) {
    throw new TypeError("Invalid engine job descriptor.");
  }
  return {
    deadlineAt: input.deadlineAt,
    engine: input.engine,
    engineVersion: input.engineVersion,
    outputBounds: ENGINE_OUTPUT_BOUNDS,
    promptBytes: input.promptBytes,
    promptRef: input.promptRef,
    promptSha256: input.promptSha256,
    timeoutMs: input.timeoutMs,
  };
}

export function parseEngineCompleteBody(
  raw: Uint8Array,
): EngineCompleteBody | undefined {
  if (
    raw.byteLength < 1 ||
    raw.byteLength > ENGINE_COMPLETION_MAX_BYTES
  ) {
    return undefined;
  }
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(raw);
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const value = plainRecord(parsed);
  if (
    !value ||
    !hasExactKeys(value, ["fence", "leaseId", "operationId", "receipt"]) ||
    !isFence(value.fence) ||
    !LEASE_ID_PATTERN.test(stringValue(value.leaseId)) ||
    !OPERATION_ID_PATTERN.test(stringValue(value.operationId))
  ) {
    return undefined;
  }
  const receipt = parseEngineExecutionResult(value.receipt);
  if (!receipt) return undefined;
  try {
    if (canonicalJson(value) !== text) return undefined;
  } catch {
    return undefined;
  }
  return {
    fence: value.fence as number,
    leaseId: value.leaseId as string,
    operationId: value.operationId as string,
    receipt,
  };
}

export function canonicalEngineCompleteBody(
  value: EngineCompleteBody,
): string {
  const text = canonicalJson(value);
  const raw = new TextEncoder().encode(text);
  if (!parseEngineCompleteBody(raw)) {
    throw new TypeError("Invalid engine completion body.");
  }
  return text;
}

export function maximalEngineCompleteFixture(): EngineCompleteBody {
  const excerpt = encodeBase64Url(new Uint8Array(512).fill(255));
  const stream = {
    excerptBase64Url: excerpt,
    sha256: "f".repeat(64),
    truncated: true,
  };
  return {
    fence: MAX_FENCE,
    leaseId: `lse_${"f".repeat(32)}`,
    operationId: `op_${"f".repeat(32)}`,
    receipt: {
      cancelRequested: false,
      engine: "claude_code_cli",
      engineVersion: "V".repeat(ENGINE_VERSION_MAX_BYTES),
      exitCode: null,
      finishedAt: "9999-12-31T23:59:59.999Z",
      reason: "orphan_identity_ambiguous",
      startedAt: "0000-01-01T00:00:00.000Z",
      status: "failed",
      stderr: { ...stream, bytes: ENGINE_STDERR_MAX_BYTES },
      stdout: { ...stream, bytes: ENGINE_STDOUT_MAX_BYTES },
      summary: "orphan_identity_ambiguous",
      timedOut: false,
    },
  };
}

export async function executeWithEngine(
  engine: ExecutionEngine,
  input: EngineExecutionInput,
  clock: () => string = () => new Date().toISOString(),
): Promise<EngineExecutionResult> {
  await assertEngineExecutionInput(engine, input);
  const startedAt = checkedClock(clock);
  if (input.signal.aborted) {
    return validatedEngineResult(
      emptyFailureResult(
        input,
        "cancel_requested",
        startedAt,
        checkedClock(clock),
      ),
      "Closed cancellation produced an invalid result.",
    );
  }
  let rawResult: EngineExecutionResult;
  try {
    rawResult = await engine.execute(input);
  } catch (error) {
    if (error instanceof EngineExecutionFault) {
      const synthesized = emptyFailureResult(
        input,
        error.reason,
        startedAt,
        checkedClock(clock),
      );
      return validatedEngineResult(
        synthesized,
        "Closed execution fault produced an invalid result.",
      );
    }
    throw new EngineContractError(
      "Execution engine failed outside the closed fault protocol.",
    );
  }
  const result = validatedEngineResult(
    rawResult,
    "Execution engine returned an invalid result.",
  );
  if (
    result.engine !== engine.name ||
    result.engine !== input.engine ||
    result.engineVersion !== input.engineVersion
  ) {
    throw new EngineContractError(
      "Execution engine returned an invalid result.",
    );
  }
  return result;
}

export function engineCreateRequestCanRepresentWorstEscaping(): boolean {
  return (
    ENGINE_PROMPT_MAX_BYTES * 6 + 1_024 <=
    ENGINE_CREATE_REQUEST_MAX_BYTES
  );
}

function parseEngineExecutionResult(
  input: unknown,
): EngineExecutionResult | undefined {
  const value = plainRecord(input);
  if (
    !value ||
    !hasExactKeys(value, [
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
    !isExecutionEngineName(value.engine) ||
    !isSafeVersion(value.engineVersion) ||
    !isMember(ENGINE_EXECUTION_STATUSES, value.status) ||
    !isMember(ENGINE_EXECUTION_REASONS, value.reason) ||
    typeof value.cancelRequested !== "boolean" ||
    typeof value.timedOut !== "boolean" ||
    !isCanonicalTimestamp(value.startedAt) ||
    !isCanonicalTimestamp(value.finishedAt) ||
    stringValue(value.startedAt) > stringValue(value.finishedAt) ||
    !isSummary(value.summary)
  ) {
    return undefined;
  }
  const stdout = parseStreamReceipt(value.stdout, ENGINE_STDOUT_MAX_BYTES);
  const stderr = parseStreamReceipt(value.stderr, ENGINE_STDERR_MAX_BYTES);
  if (
    !stdout ||
    !stderr ||
    decodedBase64UrlBytes(stdout.excerptBase64Url) +
      decodedBase64UrlBytes(stderr.excerptBase64Url) >
      ENGINE_EXCERPT_MAX_BYTES ||
    !isOutcomeConsistent(value, stdout, stderr)
  ) {
    return undefined;
  }
  return {
    cancelRequested: value.cancelRequested,
    engine: value.engine,
    engineVersion: value.engineVersion as string,
    exitCode: value.exitCode as number | null,
    finishedAt: value.finishedAt as string,
    reason: value.reason,
    startedAt: value.startedAt as string,
    status: value.status,
    stderr,
    stdout,
    summary: value.summary as EngineExecutionSummary,
    timedOut: value.timedOut,
  };
}

function parseStreamReceipt(
  input: unknown,
  maxBytes: number,
): EngineStreamReceipt | undefined {
  const value = plainRecord(input);
  if (
    !value ||
    !hasExactKeys(value, [
      "bytes",
      "excerptBase64Url",
      "sha256",
      "truncated",
    ]) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    (value.bytes as number) > maxBytes ||
    !ENGINE_SHA256_PATTERN.test(stringValue(value.sha256)) ||
    typeof value.truncated !== "boolean"
  ) {
    return undefined;
  }
  const excerptBytes = decodeBase64Url(stringValue(value.excerptBase64Url));
  if (
    !excerptBytes ||
    excerptBytes.byteLength > (value.bytes as number) ||
    value.truncated !==
      ((value.bytes as number) > excerptBytes.byteLength) ||
    ((value.bytes as number) === 0 && value.sha256 !== EMPTY_SHA256) ||
    ((value.bytes as number) > 0 && value.sha256 === EMPTY_SHA256)
  ) {
    return undefined;
  }
  return {
    bytes: value.bytes as number,
    excerptBase64Url: value.excerptBase64Url as string,
    sha256: value.sha256 as string,
    truncated: value.truncated,
  };
}

function isOutcomeConsistent(
  value: Record<string, unknown>,
  stdout: EngineStreamReceipt,
  stderr: EngineStreamReceipt,
): boolean {
  const status = value.status;
  const reason = value.reason;
  const exitCode = value.exitCode;
  if (
    exitCode !== null &&
    (!Number.isInteger(exitCode) ||
      (exitCode as number) < 0 ||
      (exitCode as number) > 255)
  ) {
    return false;
  }
  if (status === "succeeded") {
    return (
      reason === "none" &&
      exitCode === 0 &&
      value.timedOut === false &&
      value.cancelRequested === false &&
      value.summary === "completed"
    );
  }
  if (status === "canceled") {
    return (
      reason === "cancel_requested" &&
      exitCode === null &&
      value.cancelRequested === true &&
      value.summary === "cancel_requested"
    );
  }
  return (
    status === "failed" &&
    reason !== "none" &&
    reason !== "cancel_requested" &&
    (reason !== "timed_out" || value.timedOut === true) &&
    value.summary === reason &&
    (reason === "engine_exit_nonzero"
      ? Number.isInteger(exitCode) && (exitCode as number) >= 1
      : exitCode === null) &&
    (reason !== "output_limit_reached" ||
      (stdout.bytes === ENGINE_STDOUT_MAX_BYTES && stdout.truncated) ||
      (stderr.bytes === ENGINE_STDERR_MAX_BYTES && stderr.truncated))
  );
}

function isProbeConsistent(
  value: Record<string, unknown>,
  hasVersion: boolean,
): boolean {
  if (value.readiness === "ready") {
    return (
      value.status === "available" &&
      value.reason === "none" &&
      hasVersion
    );
  }
  if (value.readiness === "unknown") {
    return (
      value.status === "unknown" &&
      value.reason === "engine_probe_failed" &&
      !hasVersion
    );
  }
  if (value.readiness !== "attention_required") return false;
  if (
    value.reason === "engine_not_configured" ||
    value.reason === "engine_binary_invalid"
  ) {
    return value.status === "unavailable" && !hasVersion;
  }
  return (
    (value.reason === "engine_auth_attention_required" ||
      value.reason === "engine_incompatible") &&
    value.status === "available" &&
    hasVersion
  );
}

async function assertEngineExecutionInput(
  engine: ExecutionEngine,
  input: EngineExecutionInput,
): Promise<void> {
  if (
    !(input.prompt instanceof Uint8Array) ||
    input.prompt.byteLength < ENGINE_PROMPT_MIN_BYTES ||
    input.prompt.byteLength > ENGINE_PROMPT_MAX_BYTES
  ) {
    throw new TypeError("Invalid execution engine input.");
  }
  const promptDigest = (await sha256Bytes(input.prompt)).hex;
  if (
    engine.name !== input.engine ||
    !isExecutionEngineName(input.engine) ||
    !isSafeVersion(input.engineVersion) ||
    !ENGINE_SHA256_PATTERN.test(input.promptSha256) ||
    promptDigest !== input.promptSha256 ||
    !isAbsoluteWorkdir(input.workdir) ||
    !isCanonicalTimestamp(input.deadlineAt) ||
    !hasExactLimits(input.limits) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < ENGINE_EXECUTION_TIMEOUT_MIN_MS ||
    input.timeoutMs > ENGINE_EXECUTION_TIMEOUT_MAX_MS ||
    typeof input.signal?.aborted !== "boolean"
  ) {
    throw new TypeError("Invalid execution engine input.");
  }
}

function emptyFailureResult(
  input: EngineExecutionInput,
  reason: EngineExecutionFaultReason,
  startedAt: string,
  finishedAt: string,
): EngineExecutionResult {
  const canceled = reason === "cancel_requested";
  return {
    cancelRequested: canceled,
    engine: input.engine,
    engineVersion: input.engineVersion,
    exitCode: null,
    finishedAt,
    reason,
    startedAt,
    status: canceled ? "canceled" : "failed",
    stderr: emptyStreamReceipt(),
    stdout: emptyStreamReceipt(),
    summary: reason,
    timedOut: reason === "timed_out",
  };
}

function validatedEngineResult(
  input: EngineExecutionResult,
  message: string,
): EngineExecutionResult {
  const parsed = parseEngineExecutionResult(input);
  if (!parsed) throw new EngineContractError(message);
  return parsed;
}

function emptyStreamReceipt(): EngineStreamReceipt {
  return {
    bytes: 0,
    excerptBase64Url: "",
    sha256: EMPTY_SHA256,
    truncated: false,
  };
}

function hasExactLimits(value: unknown): boolean {
  const limits = plainRecord(value);
  const bounds = plainRecord(limits?.outputBounds);
  return Boolean(
    limits &&
      bounds &&
      hasExactKeys(limits, ["excerptBytes", "outputBounds"]) &&
      hasExactKeys(bounds, ["stderrBytes", "stdoutBytes"]) &&
      limits.excerptBytes === ENGINE_EXECUTION_LIMITS.excerptBytes &&
      bounds.stderrBytes === ENGINE_OUTPUT_BOUNDS.stderrBytes &&
      bounds.stdoutBytes === ENGINE_OUTPUT_BOUNDS.stdoutBytes,
  );
}

function checkedClock(clock: () => string): string {
  const value = clock();
  if (!isCanonicalTimestamp(value)) {
    throw new TypeError("Execution clock returned an invalid timestamp.");
  }
  return value;
}

function isSummary(value: unknown): value is EngineExecutionSummary {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    new TextEncoder().encode(value).byteLength <= ENGINE_SUMMARY_MAX_BYTES &&
    (value === "completed" || isMember(ENGINE_EXECUTION_REASONS, value)) &&
    value !== "none"
  );
}

function isSafeVersion(value: unknown): boolean {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <= ENGINE_VERSION_MAX_BYTES &&
    ENGINE_VERSION_PATTERN.test(value)
  );
}

function isCanonicalTimestamp(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    !ENGINE_TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isAbsoluteWorkdir(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.includes("\0") ||
    /[\r\n]/u.test(value)
  ) {
    return false;
  }
  const normalizedSeparators = value.replaceAll("\\", "/");
  return Boolean(
    (normalizedSeparators.startsWith("/") ||
      /^[A-Za-z]:\//u.test(normalizedSeparators)) &&
      !normalizedSeparators.endsWith("/") &&
      !normalizedSeparators.includes("//") &&
      !/(?:^|\/)\.{1,2}(?:\/|$)/u.test(normalizedSeparators),
  );
}

function isFence(value: unknown): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_FENCE
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return undefined;
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + padding,
    );
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return encodeBase64Url(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function decodedBase64UrlBytes(value: string): number {
  return decodeBase64Url(value)?.byteLength ?? Number.POSITIVE_INFINITY;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index])
  );
}

function plainRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isMember<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === "string" && values.includes(value);
}
