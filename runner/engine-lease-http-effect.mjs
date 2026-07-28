import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ENGINE_LEASE_RUNTIME_LIMITS,
  createEngineLeaseRenewIntent,
  parseEngineLeaseRenewal,
} from "./engine-lease-runtime-contract.mjs";

const MAX_RESPONSE_READS = 1_024;
const DEFAULT_READ_TIMEOUT_MS = 10_000;
const READ_TIMEOUT = Symbol("engine_lease_read_timeout");
const RUNNER_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const RENEW_DENIALS = new Map([
  ["403:runner_rejected", "auth"],
  ["409:run_unavailable", "rejected"],
  ["409:lease_superseded", "superseded"],
  ["410:lease_expired", "superseded"],
  ["409:engine_deadline_insufficient", "exhausted"],
  ["409:nonce_reused", "retryable"],
  ["409:conflict_retry", "retryable"],
  ["503:runner_audience_unconfigured", "retryable"],
  ["503:runner_rejected", "retryable"],
  ["500:run_operation_failed", "retryable"],
]);
const EDGE_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class EngineLeaseHttpEffectError extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineLeaseHttpEffectError";
    this.code = "engine_lease_http_effect_invalid";
  }
}

export function createEngineLeaseRenewHttpEffect(input) {
  const signedRequest = dataValue(input, "signedRequest");
  const readTimeoutMs =
    dataValue(input, "readTimeoutMs") ??
    DEFAULT_READ_TIMEOUT_MS;
  if (
    typeof signedRequest !== "function" ||
    !Number.isSafeInteger(readTimeoutMs) ||
    readTimeoutMs < 1 ||
    readTimeoutMs > DEFAULT_READ_TIMEOUT_MS
  ) {
    throw new EngineLeaseHttpEffectError(
      "Engine lease HTTP dependencies are invalid.",
    );
  }

  return async function performEngineLeaseRenewEffect(envelope) {
    try {
      const normalized = normalizeRenewEnvelope(envelope);
      if (!normalized) return responseError("protocol", null);
      let response;
      try {
        response = await signedRequest({
          audience: normalized.context.audience,
          body: normalized.body,
          domain: normalized.intent.request.signatureDomain,
          keyId: normalized.context.runnerId,
          pathname: normalized.intent.request.pathname,
          privateKey: normalized.context.privateKey,
          publicKey: normalized.context.publicKey,
        });
      } catch {
        return transportError();
      }
      const captured = await captureBoundedResponse(
        response,
        readTimeoutMs,
      );
      if (!captured.ok) {
        return responseError(
          normalizedCaptureCode(captured),
          captured.httpStatus,
        );
      }
      if (captured.httpStatus !== 200) {
        return classifyDenial(captured);
      }
      if (captured.contentType !== JSON_CONTENT_TYPE) {
        return responseError("protocol", 200);
      }
      const renewal = parseEngineLeaseRenewal(
        captured.bytes,
        normalized.intent.expected,
      );
      if (!renewal) {
        return responseError("protocol", 200);
      }
      return Object.freeze({
        httpStatus: 200,
        kind: "renewal",
        renewal,
        replay: captured.replay,
      });
    } catch {
      return responseError("protocol", null);
    }
  };
}

function normalizeRenewEnvelope(value) {
  if (!exactRecord(value, ["controlContext", "intent"])) return undefined;
  const context = normalizeControlContext(dataValue(value, "controlContext"));
  const inputIntent = dataValue(value, "intent");
  if (
    !context ||
    !exactRecord(inputIntent, ["expected", "request", "runId"])
  ) {
    return undefined;
  }
  const expectedInput = dataValue(inputIntent, "expected");
  if (
    !exactRecord(expectedInput, ["fence", "leaseId", "runId"])
  ) {
    return undefined;
  }
  let expected;
  try {
    expected = createEngineLeaseRenewIntent({
      fence: dataValue(expectedInput, "fence"),
      leaseId: dataValue(expectedInput, "leaseId"),
      runId: dataValue(expectedInput, "runId"),
    });
  } catch {
    return undefined;
  }
  if (
    !sameSerializableValue(inputIntent, expected) ||
    !validRequestBody(dataValue(inputIntent, "request"))
  ) {
    return undefined;
  }
  return {
    body: Buffer.from(expected.request.bodyBase64Url, "base64url"),
    context,
    intent: expected,
  };
}

function normalizeControlContext(value) {
  if (!plainRecord(value)) return undefined;
  const audience = dataValue(value, "audience");
  const privateKey = dataValue(value, "privateKey");
  const publicKey = dataValue(value, "publicKey");
  const state = dataValue(value, "state");
  const runnerId = dataValue(state, "runnerId");
  if (
    typeof audience !== "string" ||
    !/^https?:\/\/[^/]+$/u.test(audience) ||
    !privateKey ||
    typeof publicKey !== "string" ||
    !RUNNER_PATTERN.test(runnerId ?? "")
  ) {
    return undefined;
  }
  return { audience, privateKey, publicKey, runnerId };
}

function validRequestBody(request) {
  try {
    const encoded = dataValue(request, "bodyBase64Url");
    const body = Buffer.from(encoded, "base64url");
    return (
      typeof encoded === "string" &&
      body.toString("base64url") === encoded &&
      sha256(body) === dataValue(request, "bodySha256")
    );
  } catch {
    return false;
  }
}

async function captureBoundedResponse(response, readTimeoutMs) {
  const readDeadlineMs = performance.now() + readTimeoutMs;
  const httpStatus = safeHttpStatus(response);
  if (httpStatus === null) {
    await cancelResponseBody(response);
    return captureFailure("protocol", null);
  }
  let headers;
  let body;
  try {
    headers = response.headers;
    body = response.body;
  } catch {
    await cancelResponseBody(response);
    return captureFailure("protocol", httpStatus);
  }
  let getHeader;
  try {
    getHeader = headers?.get;
  } catch {
    await cancelBody(body);
    return captureFailure("protocol", httpStatus);
  }
  if (!headers || typeof getHeader !== "function") {
    await cancelBody(body);
    return captureFailure("protocol", httpStatus);
  }
  let contentLength;
  let contentType;
  let replay;
  try {
    contentLength = getHeader.call(headers, "content-length");
    contentType = getHeader.call(headers, "content-type");
    replay = getHeader.call(headers, "x-nexus-replay") === "1";
  } catch {
    await cancelBody(body);
    return captureFailure("protocol", httpStatus);
  }
  const maximum = ENGINE_LEASE_RUNTIME_LIMITS.responseMaxBytes;
  if (
    (contentType !== null && typeof contentType !== "string") ||
    (
      contentLength !== null &&
      (
        typeof contentLength !== "string" ||
        !/^(0|[1-9]\d*)$/u.test(contentLength) ||
        contentLength.length > String(maximum).length ||
        Number(contentLength) > maximum
      )
    )
  ) {
    await cancelBody(body);
    return captureFailure("protocol", httpStatus);
  }
  const scratch = new Uint8Array(maximum);
  if (body === null) {
    if (contentLength !== null && contentLength !== "0") {
      return captureFailure("protocol", httpStatus);
    }
    return {
      bytes: scratch.subarray(0, 0),
      contentType,
      httpStatus,
      ok: true,
      replay,
    };
  }
  let getReader;
  try {
    getReader = body?.getReader;
  } catch {
    await cancelBody(body);
    return captureFailure("protocol", httpStatus);
  }
  if (!body || typeof getReader !== "function") {
    await cancelBody(body);
    return captureFailure("protocol", httpStatus);
  }
  let reader;
  try {
    reader = getReader.call(body);
  } catch {
    await cancelBody(body);
    return captureFailure("protocol", httpStatus);
  }
  let readReader;
  let cancelReaderMethod;
  let releaseReader;
  try {
    readReader = reader?.read;
    cancelReaderMethod = reader?.cancel;
    releaseReader = reader?.releaseLock;
  } catch {
    await cancelReader(reader);
    safeReleaseReader(reader, releaseReader);
    await cancelBody(body);
    return captureFailure("protocol", httpStatus);
  }
  if (
    !reader ||
    typeof readReader !== "function" ||
    typeof cancelReaderMethod !== "function" ||
    typeof releaseReader !== "function"
  ) {
    await cancelReader(reader, cancelReaderMethod);
    safeReleaseReader(reader, releaseReader);
    await cancelBody(body);
    return captureFailure("protocol", httpStatus);
  }
  let reads = 0;
  let size = 0;
  try {
    while (reads < MAX_RESPONSE_READS) {
      reads += 1;
      const remainingReadMs = Math.ceil(
        readDeadlineMs - performance.now(),
      );
      if (remainingReadMs <= 0) {
        await cancelReader(reader, cancelReaderMethod);
        return captureFailure("retryable", httpStatus);
      }
      let item;
      try {
        item = await readWithTimeout(
          readReader,
          reader,
          remainingReadMs,
        );
      } catch {
        await cancelReader(reader, cancelReaderMethod);
        return captureFailure("retryable", httpStatus);
      }
      if (item === READ_TIMEOUT) {
        await cancelReader(reader, cancelReaderMethod);
        return captureFailure("retryable", httpStatus);
      }
      if (!exactRecord(item, ["done", "value"])) {
        await cancelReader(reader, cancelReaderMethod);
        return captureFailure("protocol", httpStatus);
      }
      const done = dataValue(item, "done");
      const chunk = dataValue(item, "value");
      if (done === true) {
        if (chunk !== undefined) {
          await cancelReader(reader, cancelReaderMethod);
          return captureFailure("protocol", httpStatus);
        }
        if (
          contentLength !== null &&
          Number(contentLength) !== size
        ) {
          await cancelReader(reader, cancelReaderMethod);
          return captureFailure("protocol", httpStatus);
        }
        return {
          bytes: scratch.subarray(0, size),
          contentType,
          httpStatus,
          ok: true,
          replay,
        };
      }
      if (done !== false || !ArrayBuffer.isView(chunk)) {
        await cancelReader(reader, cancelReaderMethod);
        return captureFailure("protocol", httpStatus);
      }
      let chunkBytes;
      let chunkLength;
      try {
        chunkLength = chunk.byteLength;
        chunkBytes = new Uint8Array(
          chunk.buffer,
          chunk.byteOffset,
          chunkLength,
        );
      } catch {
        await cancelReader(reader, cancelReaderMethod);
        return captureFailure("protocol", httpStatus);
      }
      if (
        !Number.isSafeInteger(chunkLength) ||
        chunkLength < 1 ||
        chunkLength > maximum - size
      ) {
        await cancelReader(reader, cancelReaderMethod);
        return captureFailure("protocol", httpStatus);
      }
      try {
        scratch.set(chunkBytes, size);
      } catch {
        await cancelReader(reader, cancelReaderMethod);
        return captureFailure("protocol", httpStatus);
      }
      size += chunkLength;
    }
    await cancelReader(reader, cancelReaderMethod);
    return captureFailure("protocol", httpStatus);
  } finally {
    safeReleaseReader(reader, releaseReader);
  }
}

function classifyDenial(captured) {
  const status = captured.httpStatus;
  if (captured.contentType === JSON_CONTENT_TYPE) {
    const parsed = parseCanonicalError(captured.bytes);
    const classification = parsed
      ? RENEW_DENIALS.get(`${status}:${parsed.error}`)
      : undefined;
    if (classification) {
      return Object.freeze({
        class: classification,
        httpStatus: status,
        kind: "denied",
        replay: captured.replay,
        serverError: parsed.error,
      });
    }
  }
  return responseError(
    EDGE_RETRYABLE_STATUSES.has(status)
      ? "retryable"
      : "protocol",
    status,
  );
}

function parseCanonicalError(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 2 ||
    bytes.byteLength > ENGINE_LEASE_RUNTIME_LIMITS.responseMaxBytes
  ) {
    return undefined;
  }
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const parsed = JSON.parse(text);
    if (
      !exactRecord(parsed, ["error"]) ||
      typeof dataValue(parsed, "error") !== "string" ||
      canonicalJson(parsed) !== text
    ) {
      return undefined;
    }
    return { error: dataValue(parsed, "error") };
  } catch {
    return undefined;
  }
}

function safeHttpStatus(response) {
  try {
    const status = response?.status;
    return Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : null;
  } catch {
    return null;
  }
}

function responseError(code, httpStatus) {
  return Object.freeze({
    code,
    httpStatus,
    kind: "response_error",
  });
}

function transportError() {
  return Object.freeze({ kind: "transport_error" });
}

function captureFailure(code, httpStatus) {
  return { code, httpStatus, ok: false };
}

function normalizedCaptureCode(captured) {
  return (
    captured.code === "protocol" &&
    EDGE_RETRYABLE_STATUSES.has(captured.httpStatus)
  )
    ? "retryable"
    : captured.code;
}

function safeReleaseReader(reader, releaseMethod) {
  try {
    const release =
      typeof releaseMethod === "function"
        ? releaseMethod
        : reader?.releaseLock;
    if (typeof release === "function") release.call(reader);
  } catch {
    // Hostile release cannot widen or replace the typed result.
  }
}

async function cancelResponseBody(response) {
  try {
    const body = response?.body;
    await cancelBody(body);
  } catch {
    // Cancellation remains best effort across hostile response objects.
  }
}

async function cancelBody(body) {
  try {
    const cancel = body?.cancel;
    if (typeof cancel === "function") {
      settleBestEffort(cancel.call(body));
    }
  } catch {
    // Cancellation is best effort and does not change classification.
  }
}

async function cancelReader(reader, cancelMethod) {
  try {
    const cancel =
      typeof cancelMethod === "function" ? cancelMethod : reader?.cancel;
    if (typeof cancel === "function") {
      settleBestEffort(cancel.call(reader));
    }
  } catch {
    // Cancellation is best effort and does not change classification.
  }
}

async function readWithTimeout(read, reader, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => read.call(reader)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(READ_TIMEOUT), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function settleBestEffort(value) {
  try {
    Promise.resolve(value).catch(() => {});
  } catch {
    // A hostile thenable cannot make cancellation block the effect.
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameSerializableValue(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function exactRecord(value, keys) {
  if (!plainRecord(value)) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (!ownKeys.every((key) => typeof key === "string")) return false;
    const actual = ownKeys.sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]) &&
      actual.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && descriptor.enumerable && "value" in descriptor;
      })
    );
  } catch {
    return false;
  }
}

function plainRecord(value) {
  try {
    return Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype,
    );
  } catch {
    return false;
  }
}

function dataValue(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
