import type {
  EngineProbeReason,
  EngineProbeReadiness,
  EngineProbeStatus,
  ExecutionEngineName,
} from "../../contracts/execution-engines";
import {
  EXECUTION_ENGINE_NAMES,
} from "../../contracts/execution-engines";
import engineReportLimits from "../../contracts/engine-report-limits.json";
import { canonicalJson } from "../governance/canonical-json";
import { sha256Hex } from "../governance/crypto";
import {
  ENGINE_TIMESTAMP_PATTERN,
  ENGINE_VERSION_PATTERN,
  parseEngineProbe,
} from "./execution-engine";

export const ENGINE_REPORT_ID_PATTERN = /^egr_[0-9a-f]{32}$/u;
export const ENGINE_REPORT_MAX_BYTES = engineReportLimits.reportMaxBytes;
export const ENGINE_FRESHNESS_DEFAULT_SECONDS =
  engineReportLimits.freshnessDefaultSeconds;
export const ENGINE_FRESHNESS_MIN_SECONDS =
  engineReportLimits.freshnessMinSeconds;
export const ENGINE_FRESHNESS_MAX_SECONDS =
  engineReportLimits.freshnessMaxSeconds;
export const ENGINE_REPORT_INTERVAL_MAX_SECONDS =
  engineReportLimits.reportIntervalMaxSeconds;

export type RunnerEngineEvidence = {
  engine: ExecutionEngineName;
  readiness: EngineProbeReadiness;
  reason: EngineProbeReason;
  status: EngineProbeStatus;
  version?: string;
};

export type RunnerEngineReport = {
  collectedAt: string;
  engines: RunnerEngineEvidence[];
  reportId: string;
  schemaVersion: 1;
  truncated: boolean;
};

export type RunnerEngineReportAck = {
  nextReportBy: string;
  receivedAt: string;
  reportId: string;
};

export function parseRunnerEngineReport(
  raw: Uint8Array,
): RunnerEngineReport | undefined {
  if (raw.byteLength < 1 || raw.byteLength > ENGINE_REPORT_MAX_BYTES) {
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
  const report = plainRecord(parsed);
  if (
    !report ||
    !hasExactKeys(report, [
      "collectedAt",
      "engines",
      "reportId",
      "schemaVersion",
      "truncated",
    ]) ||
    !isCanonicalTimestamp(report.collectedAt) ||
    !ENGINE_REPORT_ID_PATTERN.test(stringValue(report.reportId)) ||
    report.schemaVersion !== 1 ||
    typeof report.truncated !== "boolean" ||
    !Array.isArray(report.engines) ||
    report.engines.length !== EXECUTION_ENGINE_NAMES.length
  ) {
    return undefined;
  }

  const engines: RunnerEngineEvidence[] = [];
  for (const [index, input] of report.engines.entries()) {
    const evidence = plainRecord(input);
    const hasVersion = evidence?.version !== undefined;
    if (
      !evidence ||
      !hasExactKeys(
        evidence,
        hasVersion
          ? ["engine", "readiness", "reason", "status", "version"]
          : ["engine", "readiness", "reason", "status"],
      ) ||
      evidence.engine !== EXECUTION_ENGINE_NAMES[index]
    ) {
      return undefined;
    }
    const probe = parseEngineProbe({
      ...evidence,
      collectedAt: report.collectedAt,
    });
    if (!probe) return undefined;
    engines.push({
      engine: probe.engine,
      readiness: probe.readiness,
      reason: probe.reason,
      status: probe.status,
      ...(probe.version === undefined ? {} : { version: probe.version }),
    });
  }

  try {
    if (canonicalJson(report) !== text) return undefined;
  } catch {
    return undefined;
  }
  return {
    collectedAt: report.collectedAt as string,
    engines,
    reportId: report.reportId as string,
    schemaVersion: 1,
    truncated: report.truncated,
  };
}

export async function runnerEngineDeclarationHash(
  report: RunnerEngineReport,
): Promise<string> {
  const parsed = parseRunnerEngineReport(
    new TextEncoder().encode(canonicalJson(report)),
  );
  if (!parsed) {
    throw new TypeError("Invalid engine report.");
  }
  return sha256Hex(
    [
      "nexus.runner.engine.declaration.v1",
      canonicalJson({
        engines: parsed.engines,
        schemaVersion: parsed.schemaVersion,
        truncated: parsed.truncated,
      }),
    ].join("\n"),
  );
}

export function buildRunnerEngineReportAck(input: {
  engineFreshnessSeconds: number;
  receivedAt: string;
  reportId: string;
}): RunnerEngineReportAck {
  if (
    !ENGINE_REPORT_ID_PATTERN.test(input.reportId) ||
    !isCanonicalTimestamp(input.receivedAt) ||
    !isEngineFreshnessSeconds(input.engineFreshnessSeconds)
  ) {
    throw new TypeError("Invalid engine report acknowledgement.");
  }
  const intervalSeconds = Math.min(
    ENGINE_REPORT_INTERVAL_MAX_SECONDS,
    Math.floor(input.engineFreshnessSeconds / 2),
  );
  const nextReportAt =
    Date.parse(input.receivedAt) + intervalSeconds * 1_000;
  if (
    !Number.isFinite(nextReportAt) ||
    nextReportAt > Date.parse("9999-12-31T23:59:59.999Z")
  ) {
    throw new TypeError("Invalid engine report acknowledgement.");
  }
  return {
    nextReportBy: new Date(nextReportAt).toISOString(),
    receivedAt: input.receivedAt,
    reportId: input.reportId,
  };
}

export function parseRunnerEngineReportAck(
  input: unknown,
): RunnerEngineReportAck | undefined {
  const value = plainRecord(input);
  if (
    !value ||
    !hasExactKeys(value, ["nextReportBy", "receivedAt", "reportId"]) ||
    !ENGINE_REPORT_ID_PATTERN.test(stringValue(value.reportId)) ||
    !isCanonicalTimestamp(value.receivedAt) ||
    !isCanonicalTimestamp(value.nextReportBy) ||
    !isEngineReportInterval(value.receivedAt, value.nextReportBy)
  ) {
    return undefined;
  }
  return {
    nextReportBy: value.nextReportBy as string,
    receivedAt: value.receivedAt as string,
    reportId: value.reportId as string,
  };
}

function isEngineReportInterval(
  receivedAt: unknown,
  nextReportBy: unknown,
): boolean {
  if (typeof receivedAt !== "string" || typeof nextReportBy !== "string") {
    return false;
  }
  const seconds = (Date.parse(nextReportBy) - Date.parse(receivedAt)) / 1_000;
  return (
    Number.isInteger(seconds) &&
    seconds >= Math.floor(ENGINE_FRESHNESS_MIN_SECONDS / 2) &&
    seconds <= ENGINE_REPORT_INTERVAL_MAX_SECONDS
  );
}

export function isEngineFreshnessSeconds(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= ENGINE_FRESHNESS_MIN_SECONDS &&
    (value as number) <= ENGINE_FRESHNESS_MAX_SECONDS
  );
}

export function isEngineReportVersion(value: unknown): value is string {
  return typeof value === "string" && ENGINE_VERSION_PATTERN.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ENGINE_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
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
