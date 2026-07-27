import { createHash } from "node:crypto";
import { declarationContract } from "./declaration-registry.mjs";

export const OUTBOX_V1_DIRECTORY = "outbox";
export const OUTBOX_V2_DIRECTORY = "outbox-v2";
export const OUTBOX_V3_DIRECTORY = "outbox-v3";
export const OUTBOX_ENTRY_MAX_BYTES = 128 * 1_024;

const OPERATION_PATTERN = /^op_[0-9a-f]{32}$/u;
const RUN_PATTERN = /^run_[0-9a-f]{32}$/u;
const RUNNER_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const REPORT_PATTERN = /^cap_[0-9a-f]{32}$/u;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OUTBOX_KINDS = new Set([
  "lease.claim",
  "run.complete",
  "capability.report",
]);
const OUTBOX_STATES = new Set([
  "pending",
  "acked",
  "rejected",
  "superseded",
  "abandoned",
]);

export function outboxStorageDirectory(version) {
  if (version === 1) return OUTBOX_V1_DIRECTORY;
  if (version === 2) return OUTBOX_V2_DIRECTORY;
  if (version === 3) return OUTBOX_V3_DIRECTORY;
  throw new TypeError("Unsupported outbox version.");
}

export function deriveOutboxPathname(entry) {
  if (entry.v === 3) {
    const contract = declarationContract(entry.declarationKind);
    if (contract) return contract.pathname(entry);
  }
  if (entry.kind === "lease.claim") {
    return `/api/runs/${entry.runId}/lease/claim`;
  }
  if (entry.kind === "run.complete") {
    return `/api/runs/${entry.runId}/complete`;
  }
  if (entry.kind === "capability.report") {
    return `/api/runners/${entry.runnerId}/capability-reports`;
  }
  throw new TypeError("Unsupported outbox kind.");
}

export function finalizeOutboxEntry(entry) {
  const withoutChecksum = { ...entry };
  delete withoutChecksum.entrySha256;
  return {
    ...withoutChecksum,
    entrySha256: outboxEntryChecksum(withoutChecksum),
  };
}

export function outboxEntryChecksum(entry) {
  const withoutChecksum = { ...entry };
  delete withoutChecksum.entrySha256;
  return createHash("sha256")
    .update(canonicalJson(withoutChecksum))
    .digest("hex");
}

export function parseOutboxEntryText(text) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > OUTBOX_ENTRY_MAX_BYTES
  ) {
    return undefined;
  }
  let entry;
  try {
    entry = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isOutboxEntry(entry) ? entry : undefined;
}

export function isOutboxEntry(entry) {
  if (
    !plainRecord(entry) ||
    ![1, 2, 3].includes(entry.v) ||
    !OPERATION_PATTERN.test(entry.operationId ?? "") ||
    !isCanonicalTimestamp(entry.createdAt) ||
    !isCanonicalTimestamp(entry.updatedAt) ||
    !OUTBOX_STATES.has(entry.status) ||
    !HEX_SHA256_PATTERN.test(entry.entrySha256 ?? "")
  ) {
    return false;
  }

  if (entry.v === 3) {
    return isDeclarationEntry(entry);
  }
  if (
    !OUTBOX_KINDS.has(entry.kind) ||
    !HEX_SHA256_PATTERN.test(entry.bodySha256 ?? "") ||
    !isValidResponse(entry.response)
  ) {
    return false;
  }
  const body = decodeCanonicalBase64Url(entry.bodyBase64);
  if (
    !body ||
    body.byteLength < 1 ||
    body.byteLength > 4_096 ||
    createHash("sha256").update(body).digest("hex") !== entry.bodySha256
  ) {
    return false;
  }

  if (entry.v === 1) {
    if (
      !["lease.claim", "run.complete"].includes(entry.kind) ||
      !RUN_PATTERN.test(entry.runId ?? "") ||
      !hasExactKeys(entry, [
        "bodyBase64",
        "bodySha256",
        "createdAt",
        "entrySha256",
        "kind",
        "operationId",
        "pathname",
        "response",
        "runId",
        "status",
        "updatedAt",
        "v",
      ]) ||
      entry.pathname !== deriveOutboxPathname(entry)
    ) {
      return false;
    }
  } else if (entry.kind === "capability.report") {
    if (
      !RUNNER_PATTERN.test(entry.runnerId ?? "") ||
      !REPORT_PATTERN.test(entry.reportId ?? "") ||
      capabilityReportId(body) !== entry.reportId ||
      !hasExactKeys(entry, [
        "bodyBase64",
        "bodySha256",
        "createdAt",
        "entrySha256",
        "kind",
        "operationId",
        "reportId",
        "response",
        "runnerId",
        "status",
        "updatedAt",
        "v",
      ])
    ) {
      return false;
    }
  } else if (
    !["lease.claim", "run.complete"].includes(entry.kind) ||
    !RUN_PATTERN.test(entry.runId ?? "") ||
    !hasExactKeys(entry, [
      "bodyBase64",
      "bodySha256",
      "createdAt",
      "entrySha256",
      "kind",
      "operationId",
      "response",
      "runId",
      "status",
      "updatedAt",
      "v",
    ])
  ) {
    return false;
  }

  return entry.entrySha256 === outboxEntryChecksum(entry);
}

function isDeclarationEntry(entry) {
  const contract = declarationContract(entry.declarationKind);
  const identity = contract?.identity(entry);
  if (
    !contract ||
    !identity ||
    entry.updatedAt < entry.createdAt ||
    !HEX_SHA256_PATTERN.test(entry.bodySha256 ?? "")
  ) {
    return false;
  }
  if (entry.status === "pending") {
    const body = decodeCanonicalBase64Url(entry.bodyBase64);
    const bodyIdentity = body ? contract.bodyIdentity(body) : undefined;
    if (
      !body ||
      body.byteLength < 1 ||
      body.byteLength > contract.bodyMaxBytes ||
      createHash("sha256").update(body).digest("hex") !== entry.bodySha256 ||
      !plainRecord(bodyIdentity) ||
      Object.keys(bodyIdentity).length < 1 ||
      !Object.entries(bodyIdentity).every(
        ([key, value]) =>
          Object.hasOwn(entry, key) && entry[key] === value,
      ) ||
      entry.response !== null ||
      !hasExactKeys(entry, [
        "bodyBase64",
        "bodySha256",
        "createdAt",
        "declarationKind",
        "entrySha256",
        "operationId",
        "response",
        "status",
        "updatedAt",
        "v",
        ...Object.keys(identity),
      ])
    ) {
      return false;
    }
  } else {
    if (
      !isCanonicalTimestamp(entry.settledAt) ||
      entry.settledAt !== entry.updatedAt ||
      !hasExactKeys(entry, [
        "bodySha256",
        "createdAt",
        "declarationKind",
        "entrySha256",
        "operationId",
        "responseSha256",
        "responseStatus",
        "settledAt",
        "status",
        "updatedAt",
        "v",
        ...Object.keys(identity),
      ])
    ) {
      return false;
    }
    if (entry.status === "abandoned") {
      if (entry.responseStatus !== null || entry.responseSha256 !== null) {
        return false;
      }
    } else if (
      !Number.isInteger(entry.responseStatus) ||
      entry.responseStatus < 100 ||
      entry.responseStatus > 599 ||
      !HEX_SHA256_PATTERN.test(entry.responseSha256 ?? "") ||
      (entry.status === "acked" &&
        entry.responseStatus !== contract.ackStatus) ||
      (entry.status !== "acked" &&
        entry.responseStatus >= 200 &&
        entry.responseStatus < 300)
    ) {
      return false;
    }
  }
  return entry.entrySha256 === outboxEntryChecksum(entry);
}

function isValidResponse(response) {
  if (response === null) return true;
  if (
    !plainRecord(response) ||
    !hasExactKeys(response, ["bodyBase64", "status"]) ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599
  ) {
    return false;
  }
  const body = decodeCanonicalBase64Url(response.bodyBase64);
  return Boolean(body && body.byteLength <= 64 * 1_024);
}

function capabilityReportId(body) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
  return plainRecord(value) && REPORT_PATTERN.test(value.reportId ?? "")
    ? value.reportId
    : undefined;
}

function decodeCanonicalBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value)) {
    return undefined;
  }
  const body = Buffer.from(value, "base64url");
  return body.toString("base64url") === value ? body : undefined;
}

function isCanonicalTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
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
