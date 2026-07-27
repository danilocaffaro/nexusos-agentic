import { canonicalJson } from "@/src/domain/governance/canonical-json";

export const DEADLINE_RECONCILER_EXTERNAL_ID =
  "system:deadline-reconciler:v1";
export const DEADLINE_RECONCILER_PURPOSE = "deadline_reconciler";
export const ENGINE_DEADLINE_REASON = "engine_deadline_exhausted";
export const SCHEDULED_DEADLINE_RECONCILE_LIMIT = 100;
export const MUTATION_DEADLINE_RECONCILE_LIMIT = 25;
export const DEADLINE_HEALTH_GRACE_MS = 10 * 60_000;

const RUN_ID_PATTERN = /^run_[0-9a-f]{32}$/u;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type DeadlineExpiryMetadata = {
  deadlineAt: string;
  operationId: string;
  reason: typeof ENGINE_DEADLINE_REASON;
};

export type DeadlineRaceSnapshot = {
  status: string;
  version: number;
  deadlineAt: string;
};

export function deadlineOperationId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new TypeError("Invalid deadline run id");
  }
  return `op_${runId.slice(4)}`;
}

export function deadlineExpiryMetadata(
  runId: string,
  deadlineAt: string,
): DeadlineExpiryMetadata {
  assertCanonicalTimestamp(deadlineAt);
  return {
    deadlineAt,
    operationId: deadlineOperationId(runId),
    reason: ENGINE_DEADLINE_REASON,
  };
}

export function canonicalDeadlineExpiryMetadata(
  runId: string,
  deadlineAt: string,
): string {
  return canonicalJson(deadlineExpiryMetadata(runId, deadlineAt));
}

export function deadlineLedgerPayload(
  runId: string,
  deadlineAt: string,
): DeadlineExpiryMetadata & { runId: string } {
  return {
    ...deadlineExpiryMetadata(runId, deadlineAt),
    runId,
  };
}

export function assertCanonicalTimestamp(value: string): void {
  if (
    !CANONICAL_TIMESTAMP_PATTERN.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError("Invalid canonical timestamp");
  }
}

export function deadlineHealthCutoff(now: string): string {
  assertCanonicalTimestamp(now);
  return new Date(Date.parse(now) - DEADLINE_HEALTH_GRACE_MS).toISOString();
}

export function isBenignDeadlineRace(input: {
  candidateVersion: number;
  observedAt: string;
  current: DeadlineRaceSnapshot | null;
}): boolean {
  assertCanonicalTimestamp(input.observedAt);
  if (!input.current) return false;
  if (!["queued", "leased"].includes(input.current.status)) return true;
  if (input.current.version !== input.candidateVersion) return true;
  return input.current.deadlineAt > input.observedAt;
}
