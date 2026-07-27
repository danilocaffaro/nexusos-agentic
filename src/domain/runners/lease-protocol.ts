import type { RunOutcomeStatus } from "../../contracts/runs";
import { canonicalJson } from "../governance/canonical-json";
import { sha256Bytes, sha256Hex } from "../governance/crypto";
import type { RunnerSignatureDomain } from "./runner-protocol";

export const RUN_ID_PATTERN = /^run_[0-9a-f]{32}$/u;
export const LEASE_ID_PATTERN = /^lse_[0-9a-f]{32}$/u;
export const OPERATION_ID_PATTERN = /^op_[0-9a-f]{32}$/u;
export const LEASE_TTL_MS = 60_000;
export const LEASE_RENEW_INTERVAL_SECONDS = 20;
export const DIAGNOSTIC_HOLD_SECONDS = 45;
export const RUN_DEADLINE_MS = 15 * 60_000;
export const RUN_MAX_CLAIMS = 5;
export const RUNNER_LEASE_NONCE_TTL_MS = 15 * 60_000;
export const RUNNER_OPERATION_RESPONSE_TTL_MS = 30 * 24 * 60 * 60_000;
export const RUNNER_OUTBOX_ACK_TTL_MS = 7 * 24 * 60 * 60_000;
export const OUTCOME_SUMMARY_MAX_BYTES = 1_024;

export type LeaseClaimBody = {
  operationId: string;
};

export type LeaseRenewBody = {
  fence: number;
  leaseId: string;
};

export type RunCompleteBody = {
  fence: number;
  leaseId: string;
  operationId: string;
  outcome: {
    status: RunOutcomeStatus;
    summary: string;
  };
};

export function generateRunId(): string {
  return prefixedId("run");
}

export function generateLeaseId(): string {
  return prefixedId("lse");
}

export function generateOperationId(): string {
  return prefixedId("op");
}

export function isRunDeadlineExpired(input: {
  status: "queued" | "leased" | "completed" | "canceled";
  deadlineAt: string;
  now: string;
}): boolean {
  return (
    (input.status === "queued" || input.status === "leased") &&
    input.deadlineAt <= input.now
  );
}

export function parseLeaseClaimBody(
  raw: Uint8Array,
): LeaseClaimBody | undefined {
  const value = parseCanonicalRecord(raw);
  if (
    !value ||
    Object.keys(value).length !== 1 ||
    !OPERATION_ID_PATTERN.test(stringValue(value.operationId))
  ) {
    return undefined;
  }
  return { operationId: stringValue(value.operationId) };
}

export function parseLeaseRenewBody(
  raw: Uint8Array,
): LeaseRenewBody | undefined {
  const value = parseCanonicalRecord(raw);
  if (
    !value ||
    Object.keys(value).length !== 2 ||
    !isFence(value.fence) ||
    !LEASE_ID_PATTERN.test(stringValue(value.leaseId))
  ) {
    return undefined;
  }
  return {
    fence: value.fence as number,
    leaseId: stringValue(value.leaseId),
  };
}

export function parseRunCompleteBody(
  raw: Uint8Array,
): RunCompleteBody | undefined {
  const value = parseCanonicalRecord(raw);
  const outcome = plainRecord(value?.outcome);
  const status = stringValue(outcome?.status);
  const summary = stringValue(outcome?.summary);
  if (
    !value ||
    Object.keys(value).length !== 4 ||
    !isFence(value.fence) ||
    !LEASE_ID_PATTERN.test(stringValue(value.leaseId)) ||
    !OPERATION_ID_PATTERN.test(stringValue(value.operationId)) ||
    !outcome ||
    Object.keys(outcome).length !== 2 ||
    !["succeeded", "failed", "canceled"].includes(status) ||
    summary.length < 1 ||
    new TextEncoder().encode(summary).byteLength > OUTCOME_SUMMARY_MAX_BYTES
  ) {
    return undefined;
  }
  return {
    fence: value.fence as number,
    leaseId: stringValue(value.leaseId),
    operationId: stringValue(value.operationId),
    outcome: {
      status: status as RunOutcomeStatus,
      summary,
    },
  };
}

export async function runnerOperationRequestHash(input: {
  domain: RunnerSignatureDomain;
  runnerId: string;
  pathname: string;
  body: Uint8Array;
}): Promise<string> {
  return sha256Hex(
    [
      "nexus.runner.operation.v1",
      input.domain,
      input.runnerId,
      input.pathname,
      (await sha256Bytes(input.body)).hex,
    ].join("\n"),
  );
}

export function isRunEventSequenceConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed:\s*run_events\.run_id,\s*run_events\.sequence|sqlite_autoindex_run_events_1|invalid_run_(?:event|lease|transition)/iu.test(
      error.message,
    )
  );
}

function parseCanonicalRecord(
  raw: Uint8Array,
): Record<string, unknown> | undefined {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = plainRecord(value);
  if (!record) return undefined;
  try {
    return canonicalJson(record) === text ? record : undefined;
  } catch {
    return undefined;
  }
}

function plainRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isFence(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 2_147_483_647
  );
}

function prefixedId(prefix: "run" | "lse" | "op"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}
