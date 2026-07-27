import {
  assertCanonicalTimestamp,
  DEADLINE_HEALTH_GRACE_MS,
} from "@/src/domain/runners/deadline-reconciliation";

export const PROMPT_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const PROMPT_RETENTION_HEALTH_GRACE_MS = DEADLINE_HEALTH_GRACE_MS;
export const SCHEDULED_PROMPT_RETENTION_LIMIT = 100;
export const MUTATION_PROMPT_RETENTION_LIMIT = 25;

export const PROMPT_RETENTION_TERMINAL_STATUSES = [
  "completed",
  "canceled",
  "expired",
] as const;

export type PromptRetentionTerminalStatus =
  (typeof PROMPT_RETENTION_TERMINAL_STATUSES)[number];

export function promptRetentionCutoff(now: string): string {
  assertCanonicalTimestamp(now);
  return new Date(Date.parse(now) - PROMPT_RETENTION_MS).toISOString();
}

export function promptRetentionHealthCutoff(now: string): string {
  assertCanonicalTimestamp(now);
  return new Date(
    Date.parse(now) -
      PROMPT_RETENTION_MS -
      PROMPT_RETENTION_HEALTH_GRACE_MS,
  ).toISOString();
}

export function isPromptRetentionEligible(input: {
  observedAt: string;
  recordedAt: string;
  status: string;
}): boolean {
  assertCanonicalTimestamp(input.observedAt);
  assertCanonicalTimestamp(input.recordedAt);
  return (
    PROMPT_RETENTION_TERMINAL_STATUSES.includes(
      input.status as PromptRetentionTerminalStatus,
    ) &&
    Date.parse(input.observedAt) - Date.parse(input.recordedAt) >=
      PROMPT_RETENTION_MS
  );
}
