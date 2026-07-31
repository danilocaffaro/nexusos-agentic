import {
  ENGINE_PROMPT_MAX_BYTES,
  type ExecutionEngineName,
} from "@/src/contracts/execution-engines";
import type { OperationPublication } from "@/src/contracts/operations";
import { isExecutionEngineName } from "@/src/domain/runners/execution-engine";

export const OPERATION_REQUEST_MAX_BYTES = 16 * 1024;
export const OPERATION_ID_PATTERN = /^opr_[0-9a-f]{32}$/u;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/+()-]{0,99}$/u;

export type OperationCreateInput = {
  projectId: string;
  workItemId: string;
  agentId: string;
  assignedRunnerId: string;
  engine: ExecutionEngineName;
  prompt: string;
};

export type OperationContextSnapshot = {
  agentName: string;
  agentRole: string;
  agentModel: string;
  workItemRef: string;
  workItemTitle: string;
  workItemDescription: string;
};

export class OperationInputError extends Error {
  constructor(
    readonly code:
      | "invalid_operation_idempotency_key"
      | "invalid_operation_request"
      | "operation_prompt_too_large"
      | "operation_request_too_large",
    readonly status: 400 | 413,
  ) {
    super(code);
    this.name = "OperationInputError";
  }
}

export class OperationOutputError extends Error {
  constructor(
    readonly code: "output_empty" | "output_unavailable",
  ) {
    super(code);
    this.name = "OperationOutputError";
  }
}

export function parseOperationIdempotencyKey(
  value: string | null,
): `opr_${string}` {
  if (!value || !OPERATION_ID_PATTERN.test(value)) {
    throw new OperationInputError(
      "invalid_operation_idempotency_key",
      400,
    );
  }
  return value as `opr_${string}`;
}

export async function readOperationRequest(
  request: Request,
): Promise<Record<string, unknown>> {
  const length = request.headers.get("content-length");
  if (length && (!/^(?:0|[1-9]\d*)$/u.test(length) ||
    Number(length) > OPERATION_REQUEST_MAX_BYTES)) {
    throw new OperationInputError("operation_request_too_large", 413);
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > OPERATION_REQUEST_MAX_BYTES) {
    throw new OperationInputError("operation_request_too_large", 413);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const parsed: unknown = JSON.parse(text);
    if (!plainRecord(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw new OperationInputError("invalid_operation_request", 400);
  }
}

export async function readOperationPublishRequest(
  request: Request,
): Promise<void> {
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength === 0) return;
  if (raw.byteLength > 32) {
    throw new OperationInputError("invalid_operation_request", 400);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const parsed: unknown = JSON.parse(text);
    if (!plainRecord(parsed) || Object.keys(parsed).length !== 0) {
      throw new Error("invalid");
    }
  } catch {
    throw new OperationInputError("invalid_operation_request", 400);
  }
}

export function parseOperationCreateInput(
  input: Record<string, unknown>,
): OperationCreateInput {
  if (
    !hasExactKeys(input, [
      "projectId",
      "workItemId",
      "agentId",
      "assignedRunnerId",
      "engine",
      "prompt",
    ]) ||
    !entityId(input.projectId) ||
    !entityId(input.workItemId) ||
    !entityId(input.agentId) ||
    typeof input.assignedRunnerId !== "string" ||
    !RUNNER_ID_PATTERN.test(input.assignedRunnerId) ||
    !isExecutionEngineName(input.engine) ||
    typeof input.prompt !== "string" ||
    hasUnmatchedSurrogate(input.prompt) ||
    new TextEncoder().encode(input.prompt).byteLength < 1 ||
    new TextEncoder().encode(input.prompt).byteLength > 6_000
  ) {
    throw new OperationInputError("invalid_operation_request", 400);
  }
  return {
    projectId: input.projectId,
    workItemId: input.workItemId,
    agentId: input.agentId,
    assignedRunnerId: input.assignedRunnerId,
    engine: input.engine,
    prompt: input.prompt,
  };
}

export function validateOperationModel(value: string): string {
  if (
    !MODEL_PATTERN.test(value) ||
    new TextEncoder().encode(value).byteLength > 200
  ) {
    throw new OperationInputError("invalid_operation_request", 400);
  }
  return value;
}

export function contextualizeOperationPrompt(
  snapshot: OperationContextSnapshot,
  prompt: string,
): string {
  const contextualized = [
    "# NexusOS operation",
    "",
    "Analyze and answer the requested work without tools, MCPs, workspace reads, or mutations.",
    "",
    "## Agent snapshot",
    `Name: ${snapshot.agentName}`,
    `Role: ${snapshot.agentRole}`,
    `Model: ${snapshot.agentModel}`,
    "",
    "## Work item snapshot",
    `Reference: ${snapshot.workItemRef}`,
    `Title: ${snapshot.workItemTitle}`,
    "",
    snapshot.workItemDescription,
    "",
    "## Request",
    prompt,
  ].join("\n");
  if (
    new TextEncoder().encode(contextualized).byteLength >
    ENGINE_PROMPT_MAX_BYTES
  ) {
    throw new OperationInputError("operation_prompt_too_large", 413);
  }
  return contextualized;
}

export function projectOperationArtifactContent(
  engine: ExecutionEngineName,
  bytes: Uint8Array,
  truncated: boolean,
): string {
  if (truncated) throw new OperationOutputError("output_unavailable");
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new OperationOutputError("output_unavailable");
  }
  if (engine === "claude_code_cli") {
    if (text.trim().length === 0) {
      throw new OperationOutputError("output_empty");
    }
    return text;
  }
  return projectCodexJsonLines(text);
}

export function deriveOperationPublicationState(facts: {
  runStatus: "queued" | "leased" | "completed" | "canceled" | "expired";
  outcomeStatus: "succeeded" | "failed" | "canceled" | null;
  receiptStatus: "succeeded" | "failed" | "canceled" | null;
  receiptReason: string | null;
  stdoutBytes: number | null;
  stdoutTruncated: boolean;
  excerptAvailable: boolean;
}): Exclude<OperationPublication, { state: "published" }> {
  if (facts.runStatus === "queued" || facts.runStatus === "leased") {
    return { state: "pending" };
  }
  if (
    facts.runStatus !== "completed" ||
    facts.outcomeStatus !== "succeeded" ||
    facts.receiptStatus !== "succeeded" ||
    facts.receiptReason !== "none"
  ) {
    return { state: "blocked", reason: "run_not_succeeded" };
  }
  if ((facts.stdoutBytes ?? 0) < 1) {
    return { state: "blocked", reason: "output_empty" };
  }
  if (facts.stdoutTruncated || !facts.excerptAvailable) {
    return { state: "blocked", reason: "output_unavailable" };
  }
  return { state: "eligible" };
}

function projectCodexJsonLines(text: string): string {
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new OperationOutputError("output_unavailable");
  }
  let threadStarted = false;
  let turnStarted = false;
  let turnCompleted = false;
  const messages: string[] = [];
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new OperationOutputError("output_unavailable");
    }
    if (!plainRecord(event) || typeof event.type !== "string") {
      throw new OperationOutputError("output_unavailable");
    }
    if (event.type === "thread.started") {
      if (
        threadStarted ||
        turnStarted ||
        turnCompleted ||
        !hasExactKeys(event, ["thread_id", "type"]) ||
        typeof event.thread_id !== "string" ||
        event.thread_id.length < 1 ||
        event.thread_id.length > 256
      ) {
        throw new OperationOutputError("output_unavailable");
      }
      threadStarted = true;
      continue;
    }
    if (event.type === "turn.started") {
      if (
        !threadStarted ||
        turnStarted ||
        turnCompleted ||
        !hasExactKeys(event, ["type"])
      ) {
        throw new OperationOutputError("output_unavailable");
      }
      turnStarted = true;
      continue;
    }
    if (event.type === "turn.completed") {
      if (
        !threadStarted ||
        !turnStarted ||
        turnCompleted ||
        !hasExactKeys(event, ["type", "usage"]) ||
        !plainRecord(event.usage)
      ) {
        throw new OperationOutputError("output_unavailable");
      }
      turnCompleted = true;
      continue;
    }
    if (
      turnCompleted ||
      !threadStarted ||
      !turnStarted ||
      !hasExactKeys(event, ["item", "type"]) ||
      !["item.started", "item.completed"].includes(event.type) ||
      !plainRecord(event.item) ||
      !hasExactKeys(event.item, ["id", "text", "type"]) ||
      typeof event.item.id !== "string" ||
      event.item.id.length < 1 ||
      event.item.id.length > 256 ||
      !["agent_message", "reasoning"].includes(String(event.item.type)) ||
      typeof event.item.text !== "string"
    ) {
      throw new OperationOutputError("output_unavailable");
    }
    if (
      event.type === "item.completed" &&
      event.item.type === "agent_message"
    ) {
      if (event.item.text.trim().length === 0) {
        throw new OperationOutputError("output_empty");
      }
      messages.push(event.item.text);
    }
  }
  if (
    !threadStarted ||
    !turnStarted ||
    !turnCompleted ||
    messages.length === 0
  ) {
    throw new OperationOutputError(
      messages.length === 0 ? "output_empty" : "output_unavailable",
    );
  }
  return messages.join("\n\n");
}

function entityId(value: unknown): value is string {
  return typeof value === "string" && ENTITY_ID_PATTERN.test(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
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
