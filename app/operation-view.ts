import type {
  OperationPublishResult,
  OperationRead,
  OperationRegistry,
} from "@/src/contracts/operations";
import {
  ENGINE_EXECUTION_REASONS,
  ENGINE_EXECUTION_STATUSES,
  EXECUTION_ENGINE_NAMES,
  type ExecutionEngineName,
} from "@/src/contracts/execution-engines";
import type { EngineRunOptionView } from "./engine-run-view";

export const OPERATION_UI_LIMITS = Object.freeze({
  operations: 50,
  promptBytes: 6_000,
});

const OPERATION_ID_PATTERN = /^opr_[0-9a-f]{32}$/u;
const RUN_ID_PATTERN = /^run_[0-9a-f]{32}$/u;
const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const RUN_STATUSES = [
  "queued",
  "leased",
  "completed",
  "canceled",
  "expired",
] as const;
const OUTCOME_STATUSES = ["succeeded", "failed", "canceled"] as const;
const BLOCKED_REASONS = [
  "run_not_succeeded",
  "output_empty",
  "output_unavailable",
] as const;

export type OperationCreateRequest = {
  projectId: string;
  workItemId: string;
  agentId: string;
  assignedRunnerId: string;
  engine: ExecutionEngineName;
  prompt: string;
};

export type OperationCreateResult = {
  created: boolean;
  operation: OperationRead;
};

export type OperationCreateClassification =
  | { kind: "confirmed"; result: OperationCreateResult }
  | { kind: "failure_confirmed"; code: string }
  | {
      kind: "outcome_unknown";
      reason: "invalid_success_response" | "server_or_transport_failure";
    };

export type OperationCreateGate = {
  canSubmit: boolean;
  reason: string;
  promptBytes: number;
};

export function readOperationRegistry(
  value: unknown,
): OperationRegistry | null {
  try {
    if (
      !plainRecord(value) ||
      !hasExactKeys(value, ["operations"]) ||
      !Array.isArray(value.operations) ||
      value.operations.length > OPERATION_UI_LIMITS.operations ||
      !value.operations.every(isOperationRead)
    ) {
      return null;
    }
    if (
      new Set(value.operations.map((operation) => operation.id)).size !==
      value.operations.length
    ) {
      return null;
    }
    return value as OperationRegistry;
  } catch {
    return null;
  }
}

export function readOperationCreateResult(
  value: unknown,
  expectedOperationId: string,
): OperationCreateResult | null {
  try {
    if (
      !OPERATION_ID_PATTERN.test(expectedOperationId) ||
      !plainRecord(value) ||
      !hasExactKeys(value, ["created", "operation"]) ||
      typeof value.created !== "boolean" ||
      !isOperationRead(value.operation) ||
      value.operation.id !== expectedOperationId
    ) {
      return null;
    }
    return value as OperationCreateResult;
  } catch {
    return null;
  }
}

export function readOperationPublishResult(
  value: unknown,
  expectedOperationId: string,
): OperationPublishResult | null {
  try {
    if (
      !OPERATION_ID_PATTERN.test(expectedOperationId) ||
      !plainRecord(value) ||
      !hasExactKeys(value, ["published", "operation"]) ||
      typeof value.published !== "boolean" ||
      !isOperationRead(value.operation) ||
      value.operation.id !== expectedOperationId
    ) {
      return null;
    }
    return value as OperationPublishResult;
  } catch {
    return null;
  }
}

export function classifyOperationCreateResponse(input: {
  status: number;
  value: unknown;
  operationId: string;
}): OperationCreateClassification {
  if (input.status >= 200 && input.status < 300) {
    const result = readOperationCreateResult(input.value, input.operationId);
    return result
      ? { kind: "confirmed", result }
      : { kind: "outcome_unknown", reason: "invalid_success_response" };
  }
  if (input.status >= 500 || input.status < 100) {
    return {
      kind: "outcome_unknown",
      reason: "server_or_transport_failure",
    };
  }
  return {
    kind: "failure_confirmed",
    code:
      readOperationErrorCode(input.value) ?? "operation_create_rejected",
  };
}

export function generateOperationId(
  bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): `opr_${string}` {
  if (bytes.byteLength !== 16) {
    throw new Error("operation id requires exactly 16 random bytes");
  }
  return `opr_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function operationExecutionCommand(input: {
  engine: ExecutionEngineName;
  runId: string;
  executablePath: string;
  serverOrigin: string;
}): string {
  if (
    !member(EXECUTION_ENGINE_NAMES, input.engine) ||
    !RUN_ID_PATTERN.test(input.runId) ||
    !isAbsoluteExecutionPath(input.executablePath) ||
    !isServerOrigin(input.serverOrigin)
  ) {
    throw new Error("invalid operation command input");
  }
  return `npm run local:engine -- --engine ${input.engine} --path ${shellQuote(input.executablePath)} --server ${shellQuote(input.serverOrigin)} --run ${input.runId}`;
}

export function isAbsoluteExecutionPath(value: string): boolean {
  return (
    validUnicode(value) &&
    value.startsWith("/") &&
    value.length > 1 &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    value.trim() === value
  );
}

export function operationCreateGate(input: {
  currentRole: string | undefined;
  projectId: string;
  workItemId: string;
  agentId: string;
  option: EngineRunOptionView | null;
  prompt: string;
  pending: boolean;
}): OperationCreateGate {
  const promptBytes = utf8ByteLength(input.prompt);
  if (input.currentRole !== "owner") {
    return {
      canSubmit: false,
      reason: "Somente o owner pode criar operações.",
      promptBytes,
    };
  }
  if (input.pending) {
    return {
      canSubmit: false,
      reason: "A operação atual ainda precisa de uma resolução explícita.",
      promptBytes,
    };
  }
  if (!input.projectId || !input.workItemId || !input.agentId) {
    return {
      canSubmit: false,
      reason: "Selecione projeto, work item e agente.",
      promptBytes,
    };
  }
  if (!input.option) {
    return {
      canSubmit: false,
      reason: "Selecione um runner e uma engine.",
      promptBytes,
    };
  }
  if (!input.option.eligible) {
    return {
      canSubmit: false,
      reason: "A opção de runner e engine não está elegível agora.",
      promptBytes,
    };
  }
  if (promptBytes < 1 || !validUnicode(input.prompt)) {
    return {
      canSubmit: false,
      reason: "Informe um prompt UTF-8 válido.",
      promptBytes,
    };
  }
  if (promptBytes > OPERATION_UI_LIMITS.promptBytes) {
    return {
      canSubmit: false,
      reason: `O prompt excede ${OPERATION_UI_LIMITS.promptBytes} bytes.`,
      promptBytes,
    };
  }
  return { canSubmit: true, reason: "", promptBytes };
}

export function selectEligibleOperationOptions(
  options: readonly EngineRunOptionView[],
): EngineRunOptionView[] {
  return options.filter(
    (option) =>
      option.eligible &&
      option.trust === "hostReported" &&
      option.status === "available" &&
      option.readiness === "ready" &&
      option.freshness === "fresh" &&
      option.disabledReasonCode === null,
  );
}

export function mergeOperation(
  current: readonly OperationRead[],
  operation: OperationRead,
): OperationRead[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  byId.set(operation.id, operation);
  return [...byId.values()]
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt < right.createdAt ? 1 : -1;
      }
      return left.id < right.id ? 1 : left.id === right.id ? 0 : -1;
    })
    .slice(0, OPERATION_UI_LIMITS.operations);
}

export function operationRunStatusLabel(operation: OperationRead): string {
  if (operation.run.outcomeStatus === "succeeded") return "Concluída";
  if (operation.run.outcomeStatus === "failed") return "Falhou";
  if (operation.run.outcomeStatus === "canceled") return "Cancelada";
  return {
    queued: "Na fila",
    leased: "Em execução",
    completed: "Concluída",
    canceled: "Cancelada",
    expired: "Expirada",
  }[operation.run.status];
}

export function operationPublicationLabel(operation: OperationRead): string {
  if (operation.publication.state === "published") return "Publicada";
  if (operation.publication.state === "eligible") return "Pronta para publicar";
  if (operation.publication.state === "blocked") return "Publicação bloqueada";
  return "Aguardando resultado";
}

export function operationPublicationReason(operation: OperationRead): string {
  if (operation.publication.state !== "blocked") return "";
  return {
    run_not_succeeded:
      "A execução não terminou com sucesso; nenhum output pode ser publicado.",
    output_empty: "A execução terminou sem output publicável.",
    output_unavailable:
      "O output não está disponível para publicação neste estado.",
  }[operation.publication.reason];
}

export function operationErrorMessage(code: string): string {
  return {
    forbidden: "Somente o owner pode executar esta ação.",
    workspace_owner_required: "Somente o owner pode executar esta ação.",
    operation_not_found: "A operação não foi encontrada.",
    operation_idempotency_conflict:
      "Esta chave de operação já foi usada com outro conteúdo.",
    idempotency_key_reused:
      "Esta chave de operação já foi usada com outro conteúdo.",
    invalid_operation_reference:
      "Projeto, work item, agente ou runner não está mais disponível.",
    operation_request_too_large:
      "A solicitação excedeu o limite aceito pela API.",
    operation_prompt_too_large:
      "O contexto imutável e o prompt excedem o limite da engine.",
    operation_not_publishable:
      "O resultado ainda não está elegível para publicação.",
    output_empty: "A execução terminou sem output publicável.",
    output_unavailable:
      "O output confirmado não está disponível para publicação.",
    runner_engine_not_eligible:
      "O runner e a engine não estão mais elegíveis. Atualize as opções.",
  }[code] ?? "A API rejeitou a solicitação.";
}

function isOperationRead(value: unknown): value is OperationRead {
  if (
    !plainRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "projectId",
      "workItem",
      "agent",
      "assignedRunnerId",
      "engine",
      "runId",
      "run",
      "receipt",
      "publication",
      "createdAt",
    ]) ||
    !hasRequiredKeys(value, [
      "id",
      "projectId",
      "workItem",
      "agent",
      "assignedRunnerId",
      "engine",
      "runId",
      "run",
      "publication",
      "createdAt",
    ]) ||
    typeof value.id !== "string" ||
    !OPERATION_ID_PATTERN.test(value.id) ||
    !boundedEntityId(value.projectId) ||
    !isWorkItemSnapshot(value.workItem) ||
    !isAgentSnapshot(value.agent) ||
    typeof value.assignedRunnerId !== "string" ||
    !RUNNER_ID_PATTERN.test(value.assignedRunnerId) ||
    !member(EXECUTION_ENGINE_NAMES, value.engine) ||
    typeof value.runId !== "string" ||
    !RUN_ID_PATTERN.test(value.runId) ||
    !isOperationRun(value.run) ||
    (Object.hasOwn(value, "receipt") &&
      !isOperationReceipt(value.receipt)) ||
    !isOperationPublication(value.publication) ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    return false;
  }
  return true;
}

function isWorkItemSnapshot(value: unknown): boolean {
  return (
    plainRecord(value) &&
    hasExactKeys(value, ["id", "ref", "title"]) &&
    boundedEntityId(value.id) &&
    boundedString(value.ref, 1, 80) &&
    boundedString(value.title, 1, 300)
  );
}

function isAgentSnapshot(value: unknown): boolean {
  return (
    plainRecord(value) &&
    hasExactKeys(value, ["id", "name", "role", "model"]) &&
    boundedEntityId(value.id) &&
    boundedString(value.name, 1, 160) &&
    boundedString(value.role, 1, 160) &&
    boundedString(value.model, 1, 200)
  );
}

function isOperationRun(value: unknown): boolean {
  return (
    plainRecord(value) &&
    hasOnlyKeys(value, [
      "status",
      "outcomeStatus",
      "deadlineAt",
      "createdAt",
    ]) &&
    hasRequiredKeys(value, ["status", "deadlineAt", "createdAt"]) &&
    member(RUN_STATUSES, value.status) &&
    (!Object.hasOwn(value, "outcomeStatus") ||
      member(OUTCOME_STATUSES, value.outcomeStatus)) &&
    isCanonicalTimestamp(value.deadlineAt) &&
    isCanonicalTimestamp(value.createdAt)
  );
}

function isOperationReceipt(value: unknown): boolean {
  return (
    plainRecord(value) &&
    hasExactKeys(value, [
      "status",
      "reason",
      "stdout",
      "receiptSha256",
      "recordedAt",
    ]) &&
    member(ENGINE_EXECUTION_STATUSES, value.status) &&
    member(
      ENGINE_EXECUTION_REASONS.filter(
        (reason) => reason !== "engine_deadline_exhausted",
      ),
      value.reason,
    ) &&
    isStdoutFacts(value.stdout) &&
    typeof value.receiptSha256 === "string" &&
    SHA256_PATTERN.test(value.receiptSha256) &&
    isCanonicalTimestamp(value.recordedAt)
  );
}

function isStdoutFacts(value: unknown): boolean {
  return (
    plainRecord(value) &&
    hasExactKeys(value, [
      "bytes",
      "sha256",
      "truncated",
      "excerptBytes",
    ]) &&
    boundedInteger(value.bytes, 0, 262_144) &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256) &&
    typeof value.truncated === "boolean" &&
    boundedInteger(value.excerptBytes, 0, 1_024) &&
    value.excerptBytes <= value.bytes
  );
}

function isOperationPublication(value: unknown): boolean {
  if (!plainRecord(value)) return false;
  if (
    (value.state === "pending" || value.state === "eligible") &&
    hasExactKeys(value, ["state"])
  ) {
    return true;
  }
  if (
    value.state === "blocked" &&
    hasExactKeys(value, ["state", "reason"]) &&
    member(BLOCKED_REASONS, value.reason)
  ) {
    return true;
  }
  return (
    value.state === "published" &&
    hasExactKeys(value, [
      "state",
      "artifactId",
      "versionNumber",
      "contentHash",
      "publishedAt",
      "stdoutTruncated",
    ]) &&
    boundedEntityId(value.artifactId) &&
    value.versionNumber === 1 &&
    typeof value.contentHash === "string" &&
    SHA256_PATTERN.test(value.contentHash) &&
    isCanonicalTimestamp(value.publishedAt) &&
    typeof value.stdoutTruncated === "boolean"
  );
}

export function readOperationErrorCode(value: unknown): string | null {
  try {
    return plainRecord(value) &&
      hasExactKeys(value, ["error"]) &&
      boundedString(value.error, 1, 120)
      ? value.error
      : null;
  } catch {
    return null;
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasRequiredKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}

function boundedEntityId(value: unknown): value is string {
  return typeof value === "string" && ENTITY_ID_PATTERN.test(value);
}

function boundedString(
  value: unknown,
  minBytes: number,
  maxBytes: number,
): value is string {
  if (typeof value !== "string" || !validUnicode(value)) return false;
  const bytes = utf8ByteLength(value);
  return bytes >= minBytes && bytes <= maxBytes;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function validUnicode(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isServerOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'"'"'`)}'`;
}

function member<const T extends readonly unknown[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return values.includes(value);
}
