import { createHash } from "node:crypto";
import { ENGINE_REPORT_LIMITS } from "./engine-report-limits.mjs";

export const ENGINE_NAMES = Object.freeze([
  "claude_code_cli",
  "codex_cli",
]);
export const ENGINE_REPORT_ID_PATTERN = /^egr_[0-9a-f]{32}$/u;
export const ENGINE_REPORT_MAX_BYTES = ENGINE_REPORT_LIMITS.reportMaxBytes;
export const ENGINE_REPORT_INTERVAL_MIN_SECONDS =
  Math.floor(ENGINE_REPORT_LIMITS.freshnessMinSeconds / 2);
export const ENGINE_REPORT_INTERVAL_MAX_SECONDS =
  ENGINE_REPORT_LIMITS.reportIntervalMaxSeconds;

const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,63}$/u;
const STATUSES = new Set(["available", "unavailable", "unknown"]);
const READINESS = new Set(["ready", "attention_required", "unknown"]);
const REASONS = new Set([
  "none",
  "engine_not_configured",
  "engine_binary_invalid",
  "engine_auth_attention_required",
  "engine_incompatible",
  "engine_probe_failed",
]);

export function parseEngineReportBody(input) {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    return undefined;
  }
  const raw = typeof input === "string"
    ? Buffer.from(input, "utf8")
    : Buffer.from(input);
  if (raw.byteLength < 1 || raw.byteLength > ENGINE_REPORT_MAX_BYTES) {
    return undefined;
  }
  let text;
  let report;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(raw);
    report = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !plainRecord(report) ||
    !hasExactKeys(report, [
      "collectedAt",
      "engines",
      "reportId",
      "schemaVersion",
      "truncated",
    ]) ||
    !canonicalTimestamp(report.collectedAt) ||
    typeof report.reportId !== "string" ||
    !ENGINE_REPORT_ID_PATTERN.test(report.reportId) ||
    report.schemaVersion !== 1 ||
    typeof report.truncated !== "boolean" ||
    !Array.isArray(report.engines) ||
    report.engines.length !== ENGINE_NAMES.length
  ) {
    return undefined;
  }
  for (const [index, evidence] of report.engines.entries()) {
    const hasVersion = evidence?.version !== undefined;
    if (
      !plainRecord(evidence) ||
      !hasExactKeys(
        evidence,
        hasVersion
          ? ["engine", "readiness", "reason", "status", "version"]
          : ["engine", "readiness", "reason", "status"],
      ) ||
      evidence.engine !== ENGINE_NAMES[index] ||
      !STATUSES.has(evidence.status) ||
      !READINESS.has(evidence.readiness) ||
      !REASONS.has(evidence.reason) ||
      (hasVersion &&
        (typeof evidence.version !== "string" ||
          !VERSION_PATTERN.test(evidence.version))) ||
      !consistentEvidence(evidence, hasVersion)
    ) {
      return undefined;
    }
  }
  return canonicalJson(report) === text ? report : undefined;
}

export function encodeEngineReport(report) {
  const body = Buffer.from(canonicalJson(report), "utf8");
  if (!parseEngineReportBody(body)) {
    throw new TypeError("Invalid engine report.");
  }
  return body;
}

export function engineDeclarationHash(report) {
  const parsed = parseEngineReportBody(encodeEngineReport(report));
  return createHash("sha256")
    .update(
      [
        "nexus.runner.engine.declaration.v1",
        canonicalJson({
          engines: parsed.engines,
          schemaVersion: parsed.schemaVersion,
          truncated: parsed.truncated,
        }),
      ].join("\n"),
    )
    .digest("hex");
}

export function parseEngineReportAck(input, reportId) {
  if (
    !plainRecord(input) ||
    !hasExactKeys(input, ["nextReportBy", "receivedAt", "reportId"]) ||
    input.reportId !== reportId ||
    typeof input.reportId !== "string" ||
    !ENGINE_REPORT_ID_PATTERN.test(input.reportId) ||
    !canonicalTimestamp(input.receivedAt) ||
    !canonicalTimestamp(input.nextReportBy) ||
    !validReportInterval(input.receivedAt, input.nextReportBy)
  ) {
    return undefined;
  }
  return input;
}

function validReportInterval(receivedAt, nextReportBy) {
  const seconds = (Date.parse(nextReportBy) - Date.parse(receivedAt)) / 1_000;
  return (
    Number.isInteger(seconds) &&
    seconds >= ENGINE_REPORT_INTERVAL_MIN_SECONDS &&
    seconds <= ENGINE_REPORT_INTERVAL_MAX_SECONDS
  );
}

function consistentEvidence(value, hasVersion) {
  if (value.readiness === "ready") {
    return value.status === "available" && value.reason === "none" && hasVersion;
  }
  if (value.readiness === "unknown") {
    return (
      value.status === "unknown" &&
      value.reason === "engine_probe_failed" &&
      !hasVersion
    );
  }
  if (value.readiness !== "attention_required") return false;
  if (
    value.reason === "engine_not_configured" ||
    value.reason === "engine_binary_invalid"
  ) {
    return value.status === "unavailable" && !hasVersion;
  }
  return (
    (value.reason === "engine_auth_attention_required" ||
      value.reason === "engine_incompatible") &&
    value.status === "available" &&
    hasVersion
  );
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index])
  );
}

function plainRecord(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}
