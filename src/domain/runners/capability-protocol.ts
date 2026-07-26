import { canonicalJson } from "../governance/canonical-json";
import { sha256Hex } from "../governance/crypto";
import { RUNNER_TIMESTAMP_PATTERN } from "./runner-protocol";

export const CAPABILITY_REPORT_ID_PATTERN = /^cap_[0-9a-f]{32}$/u;
export const CAPABILITY_REPORT_MAX_BYTES = 4_096;
export const CAPABILITY_REPORT_MAX_ITEMS = 16;
export const CAPABILITY_VERSION_MAX_BYTES = 64;
export const CAPABILITY_REPORT_INTERVAL_MS = 12 * 60 * 60 * 1_000;
export const DEFAULT_CAPABILITY_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
export const MAX_CAPABILITY_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1_000;

export const RUNNER_CAPABILITIES = [
  "node_permission_model",
  "bubblewrap",
  "landlock",
  "seccomp",
  "user_namespace",
  "docker",
  "podman",
] as const;

export const RUNNER_CAPABILITY_STATUSES = [
  "available",
  "unavailable",
  "unknown",
] as const;

export const RUNNER_CAPABILITY_DETECTIONS = [
  "node_flag",
  "binary_version",
  "proc_read",
  "syscall",
  "none",
] as const;

export const RUNNER_CAPABILITY_REASON_CODES = [
  "none",
  "not_found",
  "not_supported",
  "permission_denied",
  "probe_disabled",
  "unknown",
] as const;

export const RUNNER_PLATFORM_OSES = [
  "aix",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
  "win32",
] as const;

export const RUNNER_PLATFORM_ARCHITECTURES = [
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
] as const;

export type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];
export type RunnerCapabilityStatus =
  (typeof RUNNER_CAPABILITY_STATUSES)[number];
export type RunnerCapabilityDetection =
  (typeof RUNNER_CAPABILITY_DETECTIONS)[number];
export type RunnerCapabilityReasonCode =
  (typeof RUNNER_CAPABILITY_REASON_CODES)[number];
export type RunnerPlatformOs = (typeof RUNNER_PLATFORM_OSES)[number];
export type RunnerPlatformArchitecture =
  (typeof RUNNER_PLATFORM_ARCHITECTURES)[number];

export type RunnerCapabilityEvidence = {
  capability: RunnerCapability;
  detection: RunnerCapabilityDetection;
  reasonCode: RunnerCapabilityReasonCode;
  status: RunnerCapabilityStatus;
  version?: string;
};

export type RunnerCapabilityReport = {
  capabilities: RunnerCapabilityEvidence[];
  collectedAt: string;
  platform: {
    arch: RunnerPlatformArchitecture;
    nodeVersion: string;
    os: RunnerPlatformOs;
  };
  reportId: string;
  schemaVersion: 1;
  truncated: boolean;
};

const capabilityOrder = new Map<RunnerCapability, number>(
  RUNNER_CAPABILITIES.map((capability, index) => [capability, index]),
);

export function parseRunnerCapabilityReport(
  raw: Uint8Array,
): RunnerCapabilityReport | undefined {
  if (raw.byteLength < 1 || raw.byteLength > CAPABILITY_REPORT_MAX_BYTES) {
    return undefined;
  }

  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    value = JSON.parse(text);
  } catch {
    return undefined;
  }

  const report = plainRecord(value);
  if (
    !report ||
    !hasExactKeys(report, [
      "capabilities",
      "collectedAt",
      "platform",
      "reportId",
      "schemaVersion",
      "truncated",
    ]) ||
    !Array.isArray(report.capabilities) ||
    report.capabilities.length < 1 ||
    report.capabilities.length > CAPABILITY_REPORT_MAX_ITEMS ||
    !CAPABILITY_REPORT_ID_PATTERN.test(stringValue(report.reportId)) ||
    report.schemaVersion !== 1 ||
    typeof report.truncated !== "boolean" ||
    !isCanonicalTimestamp(report.collectedAt)
  ) {
    return undefined;
  }

  const platform = plainRecord(report.platform);
  if (
    !platform ||
    !hasExactKeys(platform, ["arch", "nodeVersion", "os"]) ||
    !isMember(RUNNER_PLATFORM_ARCHITECTURES, platform.arch) ||
    !isMember(RUNNER_PLATFORM_OSES, platform.os) ||
    !isNodeVersion(platform.nodeVersion)
  ) {
    return undefined;
  }

  const capabilities: RunnerCapabilityEvidence[] = [];
  let previousOrder = -1;
  for (const item of report.capabilities) {
    const evidence = plainRecord(item);
    if (
      !evidence ||
      !hasExactKeys(
        evidence,
        evidence.version === undefined
          ? ["capability", "detection", "reasonCode", "status"]
          : ["capability", "detection", "reasonCode", "status", "version"],
      ) ||
      !isMember(RUNNER_CAPABILITIES, evidence.capability) ||
      !isMember(RUNNER_CAPABILITY_DETECTIONS, evidence.detection) ||
      !isMember(RUNNER_CAPABILITY_REASON_CODES, evidence.reasonCode) ||
      !isMember(RUNNER_CAPABILITY_STATUSES, evidence.status) ||
      (evidence.version !== undefined && !isSafeVersion(evidence.version))
    ) {
      return undefined;
    }
    const order = capabilityOrder.get(evidence.capability);
    if (order === undefined || order <= previousOrder) return undefined;
    previousOrder = order;
    capabilities.push({
      capability: evidence.capability,
      detection: evidence.detection,
      reasonCode: evidence.reasonCode,
      status: evidence.status,
      ...(evidence.version === undefined
        ? {}
        : { version: evidence.version as string }),
    });
  }

  try {
    if (canonicalJson(report) !== text) return undefined;
  } catch {
    return undefined;
  }

  return {
    capabilities,
    collectedAt: report.collectedAt as string,
    platform: {
      arch: platform.arch,
      nodeVersion: platform.nodeVersion as string,
      os: platform.os,
    },
    reportId: report.reportId as string,
    schemaVersion: 1,
    truncated: report.truncated,
  };
}

export async function runnerCapabilityDeclarationHash(
  report: RunnerCapabilityReport,
): Promise<string> {
  return sha256Hex(
    [
      "nexus.runner.capability.declaration.v1",
      canonicalJson({
        capabilities: report.capabilities,
        platform: report.platform,
        schemaVersion: report.schemaVersion,
        truncated: report.truncated,
      }),
    ].join("\n"),
  );
}

export function isCapabilityReportFresh(input: {
  receivedAt: string;
  nowMs: number;
  maxAgeMs?: number;
}): boolean {
  if (!isCanonicalTimestamp(input.receivedAt)) return false;
  const receivedAtMs = Date.parse(input.receivedAt);
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_CAPABILITY_FRESHNESS_MS;
  return (
    Number.isFinite(receivedAtMs) &&
    Number.isSafeInteger(maxAgeMs) &&
    maxAgeMs >= 1 &&
    maxAgeMs <= MAX_CAPABILITY_FRESHNESS_MS &&
    receivedAtMs <= input.nowMs &&
    receivedAtMs >= input.nowMs - maxAgeMs
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !RUNNER_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isSafeVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <=
      CAPABILITY_VERSION_MAX_BYTES &&
    /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(value)
  );
}

function isNodeVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^v\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/u.test(
      value,
    )
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function isMember<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === "string" && values.includes(value);
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
