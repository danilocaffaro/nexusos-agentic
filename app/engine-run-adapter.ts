import {
  ENGINE_RUN_OPTION_DISABLED_REASONS,
  ENGINE_RUN_OPTIONS_MAX_OPTIONS,
  type EngineRunOption,
  type EngineRunOptionDisabledReason,
  type EngineRunOptionsView,
} from "@/src/contracts/engine-run-options";
import {
  ENGINE_EXECUTION_REASONS,
  ENGINE_EXECUTION_STATUSES,
  ENGINE_PROBE_READINESS,
  ENGINE_PROBE_REASONS,
  ENGINE_PROBE_STATUSES,
  EXECUTION_ENGINE_NAMES,
} from "@/src/contracts/execution-engines";
import {
  ENGINE_RUN_EXCERPT_MAX_BYTES,
  ENGINE_RUN_EXCERPT_SCHEMA_VERSION,
  type EngineRunExcerptReceiptFacts,
  type EngineRunExcerptStreamFacts,
  type EngineRunExcerptView,
} from "@/src/contracts/engine-run-excerpts";
import type {
  EngineRunRead,
  EngineRunReadDetail,
  EngineRunRegistry,
} from "@/src/contracts/runs";
import type {
  EngineRunCreationState,
  EngineRunDetailView,
  EngineRunFreshness,
  EngineRunListItemView,
  EngineRunOptionView,
} from "./engine-run-view";

export const ENGINE_RUN_CLIENT_LIMITS = Object.freeze({
  events: 100,
  listPage: 50,
  loadedRuns: 200,
  options: ENGINE_RUN_OPTIONS_MAX_OPTIONS,
  responseCursorBytes: 256,
});

const RUN_ID_PATTERN = /^run_[0-9a-f]{32}$/u;
const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const CREATION_ID_PATTERN = /^ecr_[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ENGINE_RUN_STATUSES = [
  "queued",
  "leased",
  "completed",
  "canceled",
  "expired",
] as const;
const ENGINE_DEADLINE_STATES = [
  "pending",
  "overdue_awaiting_reconciliation",
  "settled",
] as const;
const LEASE_STATUSES = [
  "active",
  "superseded",
  "released",
  "revoked",
] as const;
const LEASE_END_REASONS = [
  "canceled",
  "expired",
  "runner_revoked",
  "diagnostic_complete",
  "engine_complete",
  "deadline_exhausted",
] as const;
const RUN_EVENT_KINDS = [
  "run.created",
  "lease.claimed",
  "lease.renewed",
  "lease.superseded",
  "lease.released",
  "lease.revoked",
  "run.cancel_requested",
  "run.completed",
  "run.canceled",
  "run.expired",
] as const;
const OUTCOME_STATUSES = ["succeeded", "failed", "canceled"] as const;

export type EngineRunPage = {
  runs: EngineRunListItemView[];
  nextCursor: string | null;
};

export type EngineRunCreationResolution =
  | {
      creationId: string;
      state: "created";
      runId: string;
    }
  | {
      creationId: string;
      state: "confirmed_not_created";
      notCreatedProofId: string;
      confirmedAt: string;
    };

export type EngineRunCreateClassification =
  | {
      kind: "confirmed";
      resolution: Extract<EngineRunCreationResolution, { state: "created" }>;
    }
  | {
      kind: "failure_confirmed";
      code: string;
    }
  | {
      kind: "outcome_unknown";
      reason: "invalid_success_response" | "server_or_transport_failure";
    };

export type EngineRunReconcileClassification =
  | { kind: "authoritative"; resolution: EngineRunCreationResolution }
  | {
      kind: "outcome_unknown";
      reason: "invalid_success_response" | "server_or_transport_failure";
    };

export function readEngineRunOptions(
  value: unknown,
): EngineRunOptionsView | null {
  if (!plainRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "trustDisclosure",
    "truncated",
    "options",
  ])) {
    return null;
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.trustDisclosure !== "string" ||
    utf8ByteLength(value.trustDisclosure) > 4_096 ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.options) ||
    value.options.length > ENGINE_RUN_CLIENT_LIMITS.options ||
    !value.options.every(isEngineRunOption)
  ) {
    return null;
  }
  const keys = new Set<string>();
  for (const option of value.options) {
    const key = engineRunOptionId(option.runnerId, option.engine);
    if (keys.has(key)) return null;
    keys.add(key);
  }
  return value as EngineRunOptionsView;
}

export function readEngineRunRegistry(
  value: unknown,
): EngineRunRegistry | null {
  if (
    !plainRecord(value) ||
    !hasOnlyKeys(value, ["runs", "nextCursor"]) ||
    !Object.hasOwn(value, "runs") ||
    !Array.isArray(value.runs) ||
    value.runs.length > ENGINE_RUN_CLIENT_LIMITS.listPage ||
    !value.runs.every(isEngineRunRead) ||
    !isOptionalCursor(value.nextCursor)
  ) {
    return null;
  }
  if (new Set(value.runs.map((run) => run.id)).size !== value.runs.length) {
    return null;
  }
  return value as EngineRunRegistry;
}

export function readEngineRunDetail(
  value: unknown,
  expectedRunId: string,
): EngineRunReadDetail | null {
  if (
    !RUN_ID_PATTERN.test(expectedRunId) ||
    !plainRecord(value) ||
    !hasOnlyKeys(value, ["run", "events", "eventsTruncated", "receipt"]) ||
    !hasRequiredKeys(value, ["run", "events", "eventsTruncated"]) ||
    !isEngineRunRead(value.run) ||
    value.run.id !== expectedRunId ||
    !Array.isArray(value.events) ||
    value.events.length > ENGINE_RUN_CLIENT_LIMITS.events ||
    !value.events.every(isRunEvent) ||
    typeof value.eventsTruncated !== "boolean" ||
    (Object.hasOwn(value, "receipt") &&
      !isEngineRunReceipt(value.receipt))
  ) {
    return null;
  }
  let previousSequence = 0;
  for (const event of value.events) {
    if (event.sequence <= previousSequence) return null;
    previousSequence = event.sequence;
  }
  return value as EngineRunReadDetail;
}

export function readEngineRunCreationResolution(
  value: unknown,
  expectedCreationId: string,
): EngineRunCreationResolution | null {
  if (
    !CREATION_ID_PATTERN.test(expectedCreationId) ||
    !plainRecord(value) ||
    value.creationId !== expectedCreationId
  ) {
    return null;
  }
  if (
    value.state === "created" &&
    hasExactKeys(value, ["creationId", "state", "runId"]) &&
    typeof value.runId === "string" &&
    RUN_ID_PATTERN.test(value.runId)
  ) {
    return value as EngineRunCreationResolution;
  }
  if (
    value.state === "confirmed_not_created" &&
    hasExactKeys(value, [
      "creationId",
      "state",
      "notCreatedProofId",
      "confirmedAt",
    ]) &&
    typeof value.notCreatedProofId === "string" &&
    /^ncp_[0-9a-f]{32}$/u.test(value.notCreatedProofId) &&
    isCanonicalTimestamp(value.confirmedAt)
  ) {
    return value as EngineRunCreationResolution;
  }
  return null;
}

export function readEngineRunExcerpt(
  value: unknown,
  expectedRunId: string,
): EngineRunExcerptView | null {
  if (
    !RUN_ID_PATTERN.test(expectedRunId) ||
    !plainRecord(value) ||
    value.schemaVersion !== ENGINE_RUN_EXCERPT_SCHEMA_VERSION ||
    value.runId !== expectedRunId
  ) {
    return null;
  }
  if (
    value.state === "absent" &&
    hasExactKeys(value, ["schemaVersion", "runId", "state"])
  ) {
    return value as EngineRunExcerptView;
  }
  if (
    value.state === "erased" &&
    hasExactKeys(value, [
      "schemaVersion",
      "runId",
      "state",
      "erasedAt",
      "receipt",
    ]) &&
    isCanonicalTimestamp(value.erasedAt) &&
    isEngineRunExcerptReceipt(value.receipt)
  ) {
    return value as EngineRunExcerptView;
  }
  if (
    value.state === "stored" &&
    hasExactKeys(value, [
      "schemaVersion",
      "runId",
      "state",
      "encoding",
      "interpretation",
      "stdoutBase64Url",
      "stderrBase64Url",
      "receipt",
    ]) &&
    value.encoding === "base64url" &&
    value.interpretation === "opaque_bytes" &&
    typeof value.stdoutBase64Url === "string" &&
    typeof value.stderrBase64Url === "string" &&
    isEngineRunExcerptReceipt(value.receipt) &&
    canonicalBase64UrlLength(value.stdoutBase64Url) ===
      value.receipt.stdout.excerptBytes &&
    canonicalBase64UrlLength(value.stderrBase64Url) ===
      value.receipt.stderr.excerptBytes &&
    value.receipt.stdout.excerptBytes +
      value.receipt.stderr.excerptBytes <=
      ENGINE_RUN_EXCERPT_MAX_BYTES
  ) {
    return value as EngineRunExcerptView;
  }
  return null;
}

export function mapEngineRunOptions(
  payload: EngineRunOptionsView,
): EngineRunOptionView[] {
  return payload.options.map((option) => ({
    optionId: engineRunOptionId(option.runnerId, option.engine),
    assignedRunnerId: option.runnerId,
    runnerDisplayName: option.runnerName,
    engine: option.engine,
    engineVersion: option.version,
    status: option.status,
    readiness: option.readiness,
    reason: option.reason,
    freshness: engineRunOptionFreshness(option),
    reportId: option.reportId,
    reportReceivedAt: option.receivedAt,
    freshUntil: option.freshUntil,
    evaluatedAt: option.evaluatedAt,
    trust: option.trust,
    eligible: option.eligible,
    disabledReasonCode: option.disabledReason,
    disabledReason: engineRunOptionDisabledCopy(option.disabledReason),
  }));
}

export function mapEngineRunPage(
  payload: EngineRunRegistry,
  runnerNames: ReadonlyMap<string, string> = new Map(),
): EngineRunPage {
  return {
    runs: payload.runs.map((run) => mapEngineRun(run, runnerNames)),
    nextCursor: payload.nextCursor ?? null,
  };
}

export function mapEngineRunDetail(
  payload: EngineRunReadDetail,
  runnerNames: ReadonlyMap<string, string> = new Map(),
): EngineRunDetailView {
  const run = mapEngineRun(payload.run, runnerNames);
  const receipt = payload.receipt;
  return {
    run: {
      ...run,
      leaseGeneration: payload.run.leaseGeneration,
      currentLeaseId: payload.run.currentLease?.id ?? null,
      currentRunnerId: payload.run.currentLease?.runnerId ?? null,
    },
    eventsCount: payload.events.length,
    eventsTruncated: payload.eventsTruncated,
    receipt: receipt
      ? {
          receiptSha256: receipt.receiptSha256,
          engineVersion: receipt.engineVersion,
          status: receipt.status,
          reason: receipt.reason,
          exitCode: receipt.exitCode,
          timedOut: receipt.timedOut,
          cancelRequested: receipt.cancelRequested,
          startedAt: receipt.startedAt,
          finishedAt: receipt.finishedAt,
          recordedAt: receipt.recordedAt,
          stdout: receipt.stdout,
          stderr: receipt.stderr,
          ...(receipt.excerptStorageState === "erased"
            ? {
                excerptStorageState: "erased" as const,
                erasedAt: receipt.erasedAt,
              }
            : { excerptStorageState: "stored_encrypted" as const }),
        }
      : null,
  };
}

export function engineRunOptionFreshness(
  option: EngineRunOption,
): EngineRunFreshness {
  if (option.disabledReason === "engine_policy_invalid") {
    return "not_evaluated";
  }
  if (option.disabledReason === "engine_report_absent") return "absent";
  if (option.disabledReason === "engine_report_future") return "future";
  if (option.disabledReason === "engine_report_stale") return "stale";
  if (
    option.reportId === null ||
    option.receivedAt === null ||
    option.freshUntil === null
  ) {
    return "not_evaluated";
  }
  if (option.receivedAt > option.evaluatedAt) return "future";
  if (option.evaluatedAt > option.freshUntil) return "stale";
  return "fresh";
}

export function mergeEngineRunAppend(
  current: readonly EngineRunListItemView[],
  incoming: readonly EngineRunListItemView[],
): EngineRunListItemView[] {
  return mergeAndSortEngineRuns(current, incoming);
}

export function mergeEngineRunRefresh(input: {
  current: readonly EngineRunListItemView[];
  incoming: readonly EngineRunListItemView[];
  firstPageHasMore: boolean;
  loadedAdditionalPages: boolean;
}): EngineRunListItemView[] {
  if (!input.firstPageHasMore || !input.loadedAdditionalPages) {
    return mergeAndSortEngineRuns([], input.incoming);
  }
  return mergeAndSortEngineRuns(input.current, input.incoming);
}

export function classifyEngineRunCreateResponse(input: {
  status: number;
  value: unknown;
  creationId: string;
}): EngineRunCreateClassification {
  if (input.status >= 200 && input.status < 300) {
    const resolution = readEngineRunCreationResolution(
      input.value,
      input.creationId,
    );
    return resolution?.state === "created"
      ? { kind: "confirmed", resolution }
      : { kind: "outcome_unknown", reason: "invalid_success_response" };
  }
  if (input.status >= 400 && input.status < 500) {
    const notCreated = readEngineRunCreationResolution(
      input.value,
      input.creationId,
    );
    if (
      input.status === 409 &&
      notCreated?.state === "confirmed_not_created"
    ) {
      return {
        kind: "failure_confirmed",
        code: "confirmed_not_created",
      };
    }
    const code = readExpectedCreateError(input.status, input.value);
    if (!code) {
      return {
        kind: "outcome_unknown",
        reason: "server_or_transport_failure",
      };
    }
    return {
      kind: "failure_confirmed",
      code,
    };
  }
  return {
    kind: "outcome_unknown",
    reason: "server_or_transport_failure",
  };
}

export function classifyEngineRunReconcileResponse(input: {
  status: number;
  value: unknown;
  creationId: string;
}): EngineRunReconcileClassification {
  if (input.status >= 200 && input.status < 300) {
    const resolution = readEngineRunCreationResolution(
      input.value,
      input.creationId,
    );
    return resolution
      ? { kind: "authoritative", resolution }
      : { kind: "outcome_unknown", reason: "invalid_success_response" };
  }
  return {
    kind: "outcome_unknown",
    reason: "server_or_transport_failure",
  };
}

export function engineRunListUrl(cursor: string | null): string {
  const query = new URLSearchParams({
    limit: String(ENGINE_RUN_CLIENT_LIMITS.listPage),
  });
  if (cursor !== null) query.set("cursor", cursor);
  return `/api/runs/engine?${query.toString()}`;
}

export function engineRunDetailUrl(runId: string): string {
  return `/api/runs/engine/${encodeURIComponent(runId)}`;
}

export function engineRunExcerptUrl(runId: string): string {
  return `${engineRunDetailUrl(runId)}/excerpt`;
}

export function engineRunReconcileUrl(creationId: string): string {
  return `/api/runs/engine/creations/${encodeURIComponent(creationId)}/reconcile`;
}

export function generateEngineRunCreationId(
  bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): string {
  if (bytes.byteLength !== 16) {
    throw new TypeError("Engine creation ids require exactly 16 random bytes.");
  }
  return `ecr_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function pendingEngineRunCreationState(input: {
  creationId: string;
  incidentId?: string;
  message: string;
}): Extract<EngineRunCreationState, { phase: "outcome_unknown" }> {
  return {
    phase: "outcome_unknown",
    incidentId: input.incidentId ?? `incident:${input.creationId}`,
    message: input.message,
    requiredAction: "authoritative_reconciliation_required",
  };
}

export function isEngineRunCreationId(value: unknown): value is string {
  return typeof value === "string" && CREATION_ID_PATTERN.test(value);
}

function mapEngineRun(
  run: EngineRunRead,
  runnerNames: ReadonlyMap<string, string>,
): EngineRunListItemView {
  return {
    id: run.id,
    assignedRunnerId: run.assignedRunnerId,
    runnerDisplayName: runnerNames.get(run.assignedRunnerId) ?? null,
    engine: run.engine,
    storedStatus: run.status,
    deadlineAt: run.deadlineAt,
    overdue: run.overdue,
    deadlineState: run.deadlineState,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function mergeAndSortEngineRuns(
  current: readonly EngineRunListItemView[],
  incoming: readonly EngineRunListItemView[],
): EngineRunListItemView[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) byId.set(run.id, run);
  return [...byId.values()]
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt < right.createdAt ? 1 : -1;
      }
      if (left.id === right.id) return 0;
      return left.id < right.id ? 1 : -1;
    })
    .slice(0, ENGINE_RUN_CLIENT_LIMITS.loadedRuns);
}

function engineRunOptionId(runnerId: string, engine: string): string {
  return `${runnerId}:${engine}`;
}

function engineRunOptionDisabledCopy(
  reason: EngineRunOptionDisabledReason | null,
): string {
  if (reason === null) return "";
  return {
    runner_inactive: "O runner não está ativo.",
    engine_policy_invalid:
      "A política de freshness da engine não pôde ser avaliada.",
    engine_report_absent: "O runner ainda não enviou inventário de engines.",
    engine_report_future:
      "O inventário recebido está no futuro segundo o relógio do servidor.",
    engine_report_stale: "O inventário da engine está fora da janela vigente.",
    engine_evidence_missing:
      "O inventário não contém evidência para esta engine.",
    engine_unavailable: "A engine não está disponível neste runner.",
    engine_auth_attention_required:
      "A autenticação local da engine requer atenção no host.",
    engine_misconfigured: "A engine está incompatível ou mal configurada.",
    engine_version_missing:
      "O runner não informou uma versão válida da engine.",
    engine_inventory_inconsistent:
      "O inventário da engine está inconsistente e falhou fechado.",
  }[reason];
}

function isEngineRunExcerptReceipt(
  value: unknown,
): value is EngineRunExcerptReceiptFacts {
  return (
    plainRecord(value) &&
    hasExactKeys(value, [
      "excerptRef",
      "excerptSha256",
      "receiptSha256",
      "recordedAt",
      "stdout",
      "stderr",
    ]) &&
    typeof value.excerptRef === "string" &&
    /^exc_[0-9a-f]{32}$/u.test(value.excerptRef) &&
    typeof value.excerptSha256 === "string" &&
    SHA256_PATTERN.test(value.excerptSha256) &&
    typeof value.receiptSha256 === "string" &&
    SHA256_PATTERN.test(value.receiptSha256) &&
    isCanonicalTimestamp(value.recordedAt) &&
    isEngineRunExcerptStream(value.stdout) &&
    isEngineRunExcerptStream(value.stderr) &&
    value.stdout.excerptBytes + value.stderr.excerptBytes <=
      ENGINE_RUN_EXCERPT_MAX_BYTES
  );
}

function isEngineRunExcerptStream(
  value: unknown,
): value is EngineRunExcerptStreamFacts {
  return (
    plainRecord(value) &&
    hasExactKeys(value, ["bytes", "excerptBytes", "sha256", "truncated"]) &&
    Number.isSafeInteger(value.bytes) &&
    Number(value.bytes) >= 0 &&
    Number.isSafeInteger(value.excerptBytes) &&
    Number(value.excerptBytes) >= 0 &&
    Number(value.excerptBytes) <= ENGINE_RUN_EXCERPT_MAX_BYTES &&
    Number(value.excerptBytes) <= Number(value.bytes) &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256) &&
    typeof value.truncated === "boolean" &&
    value.truncated ===
      (Number(value.excerptBytes) < Number(value.bytes))
  );
}

function canonicalBase64UrlLength(value: string): number | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return null;
  const remainder = value.length % 4;
  const finalCharacter = value.at(-1);
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalIndex = finalCharacter ? alphabet.indexOf(finalCharacter) : 0;
  if (
    (remainder === 2 && (finalIndex & 15) !== 0) ||
    (remainder === 3 && (finalIndex & 3) !== 0)
  ) {
    return null;
  }
  return (
    Math.floor(value.length / 4) * 3 +
    (remainder === 2 ? 1 : remainder === 3 ? 2 : 0)
  );
}

function isEngineRunOption(value: unknown): value is EngineRunOption {
  if (
    !plainRecord(value) ||
    !hasExactKeys(value, [
      "evaluatedAt",
      "trust",
      "reportId",
      "receivedAt",
      "freshUntil",
      "engine",
      "status",
      "readiness",
      "reason",
      "version",
      "eligible",
      "runnerId",
      "runnerName",
      "runnerState",
      "disabledReason",
    ]) ||
    !isCanonicalTimestamp(value.evaluatedAt) ||
    value.trust !== "hostReported" ||
    !isNullableBoundedId(value.reportId, 160) ||
    !isNullableCanonicalTimestamp(value.receivedAt) ||
    !isNullableCanonicalTimestamp(value.freshUntil) ||
    !member(EXECUTION_ENGINE_NAMES, value.engine) ||
    !nullableMember(ENGINE_PROBE_STATUSES, value.status) ||
    !nullableMember(ENGINE_PROBE_READINESS, value.readiness) ||
    !nullableMember(ENGINE_PROBE_REASONS, value.reason) ||
    !isNullableBoundedString(value.version, 64) ||
    typeof value.eligible !== "boolean" ||
    typeof value.runnerId !== "string" ||
    !RUNNER_ID_PATTERN.test(value.runnerId) ||
    typeof value.runnerName !== "string" ||
    utf8ByteLength(value.runnerName) < 1 ||
    utf8ByteLength(value.runnerName) > 120 ||
    !member(["active", "inactive"] as const, value.runnerState) ||
    !nullableMember(
      ENGINE_RUN_OPTION_DISABLED_REASONS,
      value.disabledReason,
    )
  ) {
    return false;
  }
  return value.eligible
    ? value.runnerState === "active" && value.disabledReason === null
    : value.disabledReason !== null;
}

function isEngineRunRead(value: unknown): value is EngineRunRead {
  if (
    !plainRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "organizationId",
      "requestedBy",
      "kind",
      "engine",
      "assignedRunnerId",
      "status",
      "overdue",
      "deadlineState",
      "version",
      "leaseGeneration",
      "claimCount",
      "maxClaims",
      "deadlineAt",
      "cancelRequestedAt",
      "outcomeStatus",
      "outcomeSummary",
      "completedOperationId",
      "recordedAt",
      "currentLease",
      "createdAt",
      "updatedAt",
    ]) ||
    !hasRequiredKeys(value, [
      "id",
      "organizationId",
      "requestedBy",
      "kind",
      "engine",
      "assignedRunnerId",
      "status",
      "overdue",
      "deadlineState",
      "version",
      "leaseGeneration",
      "claimCount",
      "maxClaims",
      "deadlineAt",
      "createdAt",
      "updatedAt",
    ]) ||
    typeof value.id !== "string" ||
    !RUN_ID_PATTERN.test(value.id) ||
    !isBoundedString(value.organizationId, 160) ||
    !isBoundedString(value.requestedBy, 160) ||
    value.kind !== "engine_prompt" ||
    !member(EXECUTION_ENGINE_NAMES, value.engine) ||
    typeof value.assignedRunnerId !== "string" ||
    !RUNNER_ID_PATTERN.test(value.assignedRunnerId) ||
    !member(ENGINE_RUN_STATUSES, value.status) ||
    typeof value.overdue !== "boolean" ||
    !member(ENGINE_DEADLINE_STATES, value.deadlineState) ||
    !isNonNegativeInteger(value.version) ||
    !isNonNegativeInteger(value.leaseGeneration) ||
    !isNonNegativeInteger(value.claimCount) ||
    !isNonNegativeInteger(value.maxClaims) ||
    !isCanonicalTimestamp(value.deadlineAt) ||
    !isOptionalCanonicalTimestamp(value.cancelRequestedAt) ||
    !isOptionalMember(OUTCOME_STATUSES, value.outcomeStatus) ||
    !isOptionalBoundedString(value.outcomeSummary, 256) ||
    !isOptionalBoundedString(value.completedOperationId, 160) ||
    !isOptionalCanonicalTimestamp(value.recordedAt) ||
    (Object.hasOwn(value, "currentLease") &&
      !isEngineRunLease(value.currentLease)) ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt)
  ) {
    return false;
  }
  const nonterminal = value.status === "queued" || value.status === "leased";
  if (!nonterminal && (value.overdue || value.deadlineState !== "settled")) {
    return false;
  }
  if (
    nonterminal &&
    ((value.overdue &&
      value.deadlineState !== "overdue_awaiting_reconciliation") ||
      (!value.overdue && value.deadlineState !== "pending"))
  ) {
    return false;
  }
  return true;
}

function isEngineRunLease(value: unknown): boolean {
  return (
    plainRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "runnerId",
      "fence",
      "status",
      "issuedAt",
      "expiresAt",
      "expired",
      "renewedAt",
      "renewCount",
      "endedAt",
      "endedReason",
    ]) &&
    hasRequiredKeys(value, [
      "id",
      "runnerId",
      "fence",
      "status",
      "issuedAt",
      "expiresAt",
      "expired",
      "renewCount",
    ]) &&
    isBoundedString(value.id, 160) &&
    typeof value.runnerId === "string" &&
    RUNNER_ID_PATTERN.test(value.runnerId) &&
    isNonNegativeInteger(value.fence) &&
    member(LEASE_STATUSES, value.status) &&
    isCanonicalTimestamp(value.issuedAt) &&
    isCanonicalTimestamp(value.expiresAt) &&
    typeof value.expired === "boolean" &&
    isOptionalCanonicalTimestamp(value.renewedAt) &&
    isNonNegativeInteger(value.renewCount) &&
    isOptionalCanonicalTimestamp(value.endedAt) &&
    isOptionalMember(LEASE_END_REASONS, value.endedReason)
  );
}

function isRunEvent(value: unknown): boolean {
  if (
    !plainRecord(value) ||
    !hasOnlyKeys(value, [
      "sequence",
      "kind",
      "actorId",
      "occurredAt",
      "fence",
      "metadata",
    ]) ||
    !hasRequiredKeys(value, [
      "sequence",
      "kind",
      "actorId",
      "occurredAt",
      "metadata",
    ]) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    !member(RUN_EVENT_KINDS, value.kind) ||
    !isBoundedString(value.actorId, 160) ||
    !isCanonicalTimestamp(value.occurredAt) ||
    (Object.hasOwn(value, "fence") &&
      (!Number.isSafeInteger(value.fence) || (value.fence as number) < 1)) ||
    !plainRecord(value.metadata)
  ) {
    return false;
  }
  try {
    return utf8ByteLength(JSON.stringify(value.metadata)) <= 8_192;
  } catch {
    return false;
  }
}

function isEngineRunReceipt(value: unknown): boolean {
  if (
    !plainRecord(value) ||
    !hasOnlyKeys(value, [
      "operationId",
      "leaseId",
      "fence",
      "engine",
      "engineVersion",
      "status",
      "reason",
      "exitCode",
      "timedOut",
      "cancelRequested",
      "startedAt",
      "finishedAt",
      "stdout",
      "stderr",
      "receiptSha256",
      "recordedAt",
      "excerptStorageState",
      "erasedAt",
    ]) ||
    !hasRequiredKeys(value, [
      "operationId",
      "leaseId",
      "fence",
      "engine",
      "engineVersion",
      "status",
      "reason",
      "exitCode",
      "timedOut",
      "cancelRequested",
      "startedAt",
      "finishedAt",
      "stdout",
      "stderr",
      "receiptSha256",
      "recordedAt",
      "excerptStorageState",
    ]) ||
    !isBoundedString(value.operationId, 160) ||
    !isBoundedString(value.leaseId, 160) ||
    !Number.isSafeInteger(value.fence) ||
    (value.fence as number) < 1 ||
    !member(EXECUTION_ENGINE_NAMES, value.engine) ||
    !isBoundedString(value.engineVersion, 64) ||
    !member(ENGINE_EXECUTION_STATUSES, value.status) ||
    !member(
      ENGINE_EXECUTION_REASONS.filter(
        (reason) => reason !== "engine_deadline_exhausted",
      ),
      value.reason,
    ) ||
    !(
      value.exitCode === null ||
      (Number.isSafeInteger(value.exitCode) &&
        (value.exitCode as number) >= -1 &&
        (value.exitCode as number) <= 255)
    ) ||
    typeof value.timedOut !== "boolean" ||
    typeof value.cancelRequested !== "boolean" ||
    !isCanonicalTimestamp(value.startedAt) ||
    !isCanonicalTimestamp(value.finishedAt) ||
    !isReceiptStream(value.stdout) ||
    !isReceiptStream(value.stderr) ||
    typeof value.receiptSha256 !== "string" ||
    !SHA256_PATTERN.test(value.receiptSha256) ||
    !isCanonicalTimestamp(value.recordedAt)
  ) {
    return false;
  }
  return value.excerptStorageState === "stored_encrypted"
    ? !Object.hasOwn(value, "erasedAt")
    : value.excerptStorageState === "erased" &&
        isCanonicalTimestamp(value.erasedAt);
}

function isReceiptStream(value: unknown): boolean {
  return (
    plainRecord(value) &&
    hasExactKeys(value, ["bytes", "sha256", "truncated", "excerptBytes"]) &&
    isNonNegativeInteger(value.bytes) &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256) &&
    typeof value.truncated === "boolean" &&
    isNonNegativeInteger(value.excerptBytes) &&
    (value.excerptBytes as number) <= 1_024 &&
    (value.excerptBytes as number) <= (value.bytes as number)
  );
}

function readExpectedCreateError(
  status: number,
  value: unknown,
): string | null {
  const code = plainRecord(value) &&
    hasExactKeys(value, ["error"]) &&
    typeof value.error === "string" &&
    /^[a-z0-9_]{1,96}$/u.test(value.error)
    ? value.error
    : null;
  if (!code) return null;
  const expectedByStatus: Readonly<Record<number, readonly string[]>> = {
    400: [
      "invalid_engine_run_request",
      "invalid_engine_run_creation_id",
    ],
    401: ["authentication_required"],
    403: ["forbidden", "workspace_owner_required"],
    404: ["runner_not_found"],
    409: ["conflict_retry", "runner_not_active"],
    422: ["engine_run_creation_key_reused"],
  };
  return expectedByStatus[status]?.includes(code) ? code : null;
}

function isOptionalCursor(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length >= 1 &&
      utf8ByteLength(value) <= ENGINE_RUN_CLIENT_LIMITS.responseCursorBytes)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isNullableCanonicalTimestamp(value: unknown): boolean {
  return value === null || isCanonicalTimestamp(value);
}

function isOptionalCanonicalTimestamp(value: unknown): boolean {
  return value === undefined || isCanonicalTimestamp(value);
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    utf8ByteLength(value) >= 1 &&
    utf8ByteLength(value) <= maxBytes
  );
}

function isOptionalBoundedString(value: unknown, maxBytes: number): boolean {
  return value === undefined || isBoundedString(value, maxBytes);
}

function isNullableBoundedString(value: unknown, maxBytes: number): boolean {
  return value === null || isBoundedString(value, maxBytes);
}

function isNullableBoundedId(value: unknown, maxBytes: number): boolean {
  return (
    value === null ||
    (isBoundedString(value, maxBytes) &&
      /^[A-Za-z0-9._:-]+$/u.test(value))
  );
}

function member<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function nullableMember<const T extends readonly string[]>(
  values: T,
  value: unknown,
): boolean {
  return value === null || member(values, value);
}

function isOptionalMember<const T extends readonly string[]>(
  values: T,
  value: unknown,
): boolean {
  return value === undefined || member(values, value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return (
    keys.length === canonicalExpected.length &&
    keys.every((key, index) => key === canonicalExpected[index])
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function hasRequiredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
