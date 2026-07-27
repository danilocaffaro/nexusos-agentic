import type {
  EngineJobDescriptor,
  ExecutionEngineName,
} from "../../contracts/execution-engines";
import {
  ENGINE_CREATE_REQUEST_MAX_BYTES,
  ENGINE_PROMPT_MAX_BYTES,
  ENGINE_PROMPT_MIN_BYTES,
  ENGINE_SIGNED_CONTROL_BODY_MAX_BYTES,
} from "../../contracts/execution-engines";
import { canonicalJson } from "../governance/canonical-json";
import { sha256Bytes } from "../governance/crypto";
import {
  buildEngineJobDescriptor,
  ENGINE_PROMPT_REF_PATTERN,
  isExecutionEngineName,
} from "./execution-engine";
import {
  LEASE_ID_PATTERN,
  OPERATION_ID_PATTERN,
  RUN_ID_PATTERN,
} from "./lease-protocol";

const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const MAX_FENCE = 2_147_483_647;

export type EngineRunCreateRequest = {
  assignedRunnerId: string;
  engine: ExecutionEngineName;
  promptBytes: Uint8Array;
  promptSha256: string;
};

export type EngineLeaseClaimBody = {
  engine: ExecutionEngineName;
  operationId: string;
};

export type EnginePromptReadBody = {
  fence: number;
  leaseId: string;
  promptRef: string;
};

export type EngineLeaseClaimDescriptor = {
  cancelRequested: boolean;
  expiresAt: string;
  fence: number;
  job: EngineJobDescriptor;
  leaseId: string;
  runId: string;
};

export type EnginePromptReadSentinel = {
  promptRef: string;
};

export class EngineControlPlaneInputError extends Error {
  readonly code:
    | "engine_run_request_too_large"
    | "invalid_engine_run_request";
  readonly status: 400 | 413;

  constructor(
    code: EngineControlPlaneInputError["code"],
    status: EngineControlPlaneInputError["status"],
  ) {
    super(code);
    this.name = "EngineControlPlaneInputError";
    this.code = code;
    this.status = status;
  }
}

export async function readBoundedEngineRunRequest(
  request: Request,
): Promise<Uint8Array> {
  const declaredLength = parseDeclaredLength(
    request.headers.get("content-length"),
  );
  if (declaredLength !== undefined) {
    if (declaredLength > ENGINE_CREATE_REQUEST_MAX_BYTES) {
      throw new EngineControlPlaneInputError(
        "engine_run_request_too_large",
        413,
      );
    }
  }
  if (!request.body) {
    if (declaredLength !== undefined && declaredLength !== 0) {
      throw invalidCreateRequest();
    }
    return new Uint8Array();
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    throw invalidCreateRequest();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw invalidCreateRequest();
      }
      total += result.value.byteLength;
      if (total > ENGINE_CREATE_REQUEST_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new EngineControlPlaneInputError(
          "engine_run_request_too_large",
          413,
        );
      }
      if (result.value.byteLength > 0) chunks.push(result.value.slice());
    }
  } catch (error) {
    if (error instanceof EngineControlPlaneInputError) throw error;
    throw invalidCreateRequest();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The body is already bounded and no raw stream error is exposed.
    }
  }
  if (declaredLength !== undefined && total !== declaredLength) {
    throw invalidCreateRequest();
  }
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

export async function parseEngineRunCreateRequest(
  raw: Uint8Array,
): Promise<EngineRunCreateRequest> {
  if (
    raw.byteLength < 1 ||
    raw.byteLength > ENGINE_CREATE_REQUEST_MAX_BYTES ||
    hasUtf8Bom(raw)
  ) {
    throw invalidCreateRequest();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(raw),
    );
  } catch {
    throw invalidCreateRequest();
  }
  const value = plainRecord(parsed);
  if (
    !value ||
    !hasExactKeys(value, ["assignedRunnerId", "engine", "prompt"]) ||
    typeof value.assignedRunnerId !== "string" ||
    !RUNNER_ID_PATTERN.test(value.assignedRunnerId) ||
    !isExecutionEngineName(value.engine) ||
    typeof value.prompt !== "string"
  ) {
    throw invalidCreateRequest();
  }
  const promptBytes = encodeExactPrompt(value.prompt);
  return {
    assignedRunnerId: value.assignedRunnerId,
    engine: value.engine,
    promptBytes,
    promptSha256: (await sha256Bytes(promptBytes)).hex,
  };
}

export function encodeExactPrompt(prompt: string): Uint8Array {
  if (hasUnmatchedSurrogate(prompt)) throw invalidCreateRequest();
  const bytes = new TextEncoder().encode(prompt);
  if (
    bytes.byteLength < ENGINE_PROMPT_MIN_BYTES ||
    bytes.byteLength > ENGINE_PROMPT_MAX_BYTES
  ) {
    throw invalidCreateRequest();
  }
  return bytes;
}

export function generatePromptRef(): string {
  return `prm_${Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function parseEngineLeaseClaimBody(
  raw: Uint8Array,
): EngineLeaseClaimBody | undefined {
  const value = parseCanonicalRecord(raw);
  if (
    !value ||
    !hasExactKeys(value, ["engine", "operationId"]) ||
    !isExecutionEngineName(value.engine) ||
    typeof value.operationId !== "string" ||
    !OPERATION_ID_PATTERN.test(value.operationId)
  ) {
    return undefined;
  }
  return {
    engine: value.engine,
    operationId: value.operationId,
  };
}

export function canonicalEngineLeaseClaimBody(
  value: EngineLeaseClaimBody,
): string {
  const text = canonicalJson(value);
  if (!parseEngineLeaseClaimBody(new TextEncoder().encode(text))) {
    throw new TypeError("Invalid engine lease claim body.");
  }
  return text;
}

export function parseEnginePromptReadBody(
  raw: Uint8Array,
): EnginePromptReadBody | undefined {
  const value = parseCanonicalRecord(raw);
  if (
    !value ||
    !hasExactKeys(value, ["fence", "leaseId", "promptRef"]) ||
    !isFence(value.fence) ||
    typeof value.leaseId !== "string" ||
    !LEASE_ID_PATTERN.test(value.leaseId) ||
    typeof value.promptRef !== "string" ||
    !ENGINE_PROMPT_REF_PATTERN.test(value.promptRef)
  ) {
    return undefined;
  }
  return {
    fence: value.fence as number,
    leaseId: value.leaseId,
    promptRef: value.promptRef,
  };
}

export function canonicalEnginePromptReadBody(
  value: EnginePromptReadBody,
): string {
  const text = canonicalJson(value);
  if (!parseEnginePromptReadBody(new TextEncoder().encode(text))) {
    throw new TypeError("Invalid engine prompt read body.");
  }
  return text;
}

export function buildEnginePromptReadSentinel(
  promptRef: string,
): EnginePromptReadSentinel {
  if (!ENGINE_PROMPT_REF_PATTERN.test(promptRef)) {
    throw new TypeError("Invalid engine prompt reference.");
  }
  return { promptRef };
}

export function buildEngineLeaseClaimDescriptor(input: {
  cancelRequested: boolean;
  deadlineAt: string;
  engine: ExecutionEngineName;
  engineVersion: string;
  expiresAt: string;
  fence: number;
  leaseId: string;
  promptBytes: number;
  promptRef: string;
  promptSha256: string;
  runId: string;
  timeoutMs: number;
}): EngineLeaseClaimDescriptor {
  if (
    typeof input.cancelRequested !== "boolean" ||
    !isFence(input.fence) ||
    !LEASE_ID_PATTERN.test(input.leaseId) ||
    !RUN_ID_PATTERN.test(input.runId) ||
    !isCanonicalTimestamp(input.expiresAt)
  ) {
    throw new TypeError("Invalid engine lease claim descriptor.");
  }
  const job = buildEngineJobDescriptor({
    deadlineAt: input.deadlineAt,
    engine: input.engine,
    engineVersion: input.engineVersion,
    promptBytes: input.promptBytes,
    promptRef: input.promptRef,
    promptSha256: input.promptSha256,
    timeoutMs: input.timeoutMs,
  });
  if (input.expiresAt > input.deadlineAt) {
    throw new TypeError("Invalid engine lease claim descriptor.");
  }
  return {
    cancelRequested: input.cancelRequested,
    expiresAt: input.expiresAt,
    fence: input.fence,
    job,
    leaseId: input.leaseId,
    runId: input.runId,
  };
}

export function canonicalEngineLeaseClaimDescriptor(
  value: EngineLeaseClaimDescriptor,
): string {
  const rebuilt = buildEngineLeaseClaimDescriptor({
    cancelRequested: value.cancelRequested,
    deadlineAt: value.job.deadlineAt,
    engine: value.job.engine,
    engineVersion: value.job.engineVersion,
    expiresAt: value.expiresAt,
    fence: value.fence,
    leaseId: value.leaseId,
    promptBytes: value.job.promptBytes,
    promptRef: value.job.promptRef,
    promptSha256: value.job.promptSha256,
    runId: value.runId,
    timeoutMs: value.job.timeoutMs,
  });
  return canonicalJson(rebuilt);
}

function parseDeclaredLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw invalidCreateRequest();
  }
  if (
    value.length > String(ENGINE_CREATE_REQUEST_MAX_BYTES).length ||
    (value.length === String(ENGINE_CREATE_REQUEST_MAX_BYTES).length &&
      value > String(ENGINE_CREATE_REQUEST_MAX_BYTES))
  ) {
    throw new EngineControlPlaneInputError(
      "engine_run_request_too_large",
      413,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidCreateRequest();
  return parsed;
}

function parseCanonicalRecord(
  raw: Uint8Array,
): Record<string, unknown> | undefined {
  if (
    raw.byteLength < 2 ||
    raw.byteLength > ENGINE_SIGNED_CONTROL_BODY_MAX_BYTES ||
    hasUtf8Bom(raw)
  ) {
    return undefined;
  }
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(raw);
    const value = plainRecord(JSON.parse(text));
    return value && canonicalJson(value) === text ? value : undefined;
  } catch {
    return undefined;
  }
}

function hasUnmatchedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasUtf8Bom(raw: Uint8Array): boolean {
  return raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
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

function isFence(value: unknown): boolean {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_FENCE
  );
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function invalidCreateRequest(): EngineControlPlaneInputError {
  return new EngineControlPlaneInputError(
    "invalid_engine_run_request",
    400,
  );
}
