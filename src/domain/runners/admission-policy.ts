import type {
  RunnerAdmissionPolicy,
  RunnerCapabilityName,
} from "@/src/contracts/runners";
import {
  DEFAULT_CAPABILITY_FRESHNESS_MS,
  MAX_CAPABILITY_FRESHNESS_MS,
  RUNNER_CAPABILITIES,
} from "./capability-protocol";
import { RUNNER_TIMESTAMP_PATTERN } from "./runner-protocol";

export const MIN_ADMISSION_FRESHNESS_SECONDS = 60 * 60;
export const MAX_ADMISSION_FRESHNESS_SECONDS =
  MAX_CAPABILITY_FRESHNESS_MS / 1_000;
export const DEFAULT_ADMISSION_FRESHNESS_SECONDS =
  DEFAULT_CAPABILITY_FRESHNESS_MS / 1_000;
export const MAX_ADMISSION_POLICY_VERSION = 2_147_483_646;

export const DEFAULT_RUNNER_ADMISSION_POLICY: RunnerAdmissionPolicy = {
  version: 0,
  source: "default",
  capabilityFreshnessSeconds: DEFAULT_ADMISSION_FRESHNESS_SECONDS,
  allowedCapabilities: [...RUNNER_CAPABILITIES],
};

export type AdmissionPolicyPut = {
  expectedVersion: number;
  capabilityFreshnessSeconds: number;
  allowedCapabilities: RunnerCapabilityName[];
};

const capabilityOrder = new Map<RunnerCapabilityName, number>(
  RUNNER_CAPABILITIES.map((capability, index) => [capability, index]),
);

export function parseAdmissionPolicyPut(
  input: Record<string, unknown>,
): AdmissionPolicyPut | undefined {
  if (
    !hasExactKeys(input, [
      "allowedCapabilities",
      "capabilityFreshnessSeconds",
      "expectedVersion",
    ]) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    (input.expectedVersion as number) < 0 ||
    (input.expectedVersion as number) > MAX_ADMISSION_POLICY_VERSION ||
    !Number.isSafeInteger(input.capabilityFreshnessSeconds) ||
    (input.capabilityFreshnessSeconds as number) <
      MIN_ADMISSION_FRESHNESS_SECONDS ||
    (input.capabilityFreshnessSeconds as number) >
      MAX_ADMISSION_FRESHNESS_SECONDS ||
    !Array.isArray(input.allowedCapabilities) ||
    input.allowedCapabilities.length > RUNNER_CAPABILITIES.length
  ) {
    return undefined;
  }

  const allowed = new Set<RunnerCapabilityName>();
  for (const capability of input.allowedCapabilities) {
    if (
      typeof capability !== "string" ||
      !capabilityOrder.has(capability as RunnerCapabilityName) ||
      allowed.has(capability as RunnerCapabilityName)
    ) {
      return undefined;
    }
    allowed.add(capability as RunnerCapabilityName);
  }
  return {
    expectedVersion: input.expectedVersion as number,
    capabilityFreshnessSeconds:
      input.capabilityFreshnessSeconds as number,
    allowedCapabilities: [...allowed].sort(
      (left, right) =>
        (capabilityOrder.get(left) ?? 0) -
        (capabilityOrder.get(right) ?? 0),
    ),
  };
}

export function nextPolicyUpdatedAt(
  serverNow: string,
  previousUpdatedAt?: string,
): string | undefined {
  if (
    !isCanonicalTimestamp(serverNow) ||
    (previousUpdatedAt !== undefined &&
      !isCanonicalTimestamp(previousUpdatedAt))
  ) {
    return undefined;
  }
  if (!previousUpdatedAt || previousUpdatedAt < serverNow) return serverNow;
  const next = Date.parse(previousUpdatedAt) + 1;
  return Number.isFinite(next) ? new Date(next).toISOString() : undefined;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function isCanonicalTimestamp(value: string): boolean {
  if (!RUNNER_TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}
