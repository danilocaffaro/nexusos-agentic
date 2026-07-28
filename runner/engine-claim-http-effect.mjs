import { createHash } from "node:crypto";
import {
  createEngineClaimIntent,
  createEnginePromptIntent,
  evaluateDescriptorBudget,
  parseEngineLeaseDescriptor,
  verifyPromptPayload,
} from "./engine-claim-contract.mjs";
import {
  ENGINE_HTTP_IO_TIMEOUT_MS,
  ENGINE_HTTP_TIMEOUT,
  createEngineHttpDeadline,
} from "./engine-http-deadline.mjs";

const CLAIM_RESPONSE_MAX_BYTES = 4_096;
const PROMPT_RESPONSE_MAX_BYTES = 8_192;
const MAX_RESPONSE_READS = 1_024;
const RUNNER_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const CLAIM_DENIALS = new Map([
  ["403:runner_rejected", "auth"],
  ["409:run_unavailable", "rejected"],
  ["409:engine_mismatch", "rejected"],
  ["409:run_assignment_mismatch", "rejected"],
  ["409:engine_deadline_insufficient", "rejected"],
  ["409:engine_inventory_mismatch", "rejected"],
  ["409:runner_conflict", "rejected"],
  ["409:operation_conflict", "rejected"],
  ["410:operation_horizon_exceeded", "rejected"],
  ["409:runner_busy", "retryable"],
  ["409:nonce_reused", "retryable"],
  ["409:conflict_retry", "retryable"],
  ["503:runner_audience_unconfigured", "retryable"],
  ["500:run_operation_failed", "retryable"],
]);

const PROMPT_DENIALS = new Map([
  ["403:runner_rejected", "auth"],
  ["404:prompt_unavailable", "rejected"],
  ["410:prompt_erased", "rejected"],
  ["409:run_unavailable", "rejected"],
  ["409:lease_superseded", "superseded"],
  ["410:lease_expired", "superseded"],
  ["409:nonce_reused", "retryable"],
  ["409:conflict_retry", "retryable"],
  ["503:prompt_cipher_key_unavailable", "retryable"],
  ["503:runner_audience_unconfigured", "retryable"],
  ["500:run_operation_failed", "retryable"],
]);

const EDGE_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export class EngineClaimHttpEffectError extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineClaimHttpEffectError";
    this.code = "engine_claim_http_effect_invalid";
  }
}

export function createEngineClaimHttpEffect(input) {
  const signedRequest = dataValue(input, "signedRequest");
  const now = dataValue(input, "now") ?? Date.now;
  const ioTimeoutMs = dataValue(input, "ioTimeoutMs") ??
    ENGINE_HTTP_IO_TIMEOUT_MS;
  if (
    typeof signedRequest !== "function" ||
    typeof now !== "function" ||
    !validIoTimeout(ioTimeoutMs)
  ) {
    throw new EngineClaimHttpEffectError(
      "Engine claim HTTP dependencies are invalid.",
    );
  }

  return async function performEngineClaimEffect(envelope) {
    let deadline;
    try {
      const normalized = normalizeClaimEnvelope(envelope);
      if (!normalized) return responseError("protocol", null);
      deadline = createEngineHttpDeadline({ timeoutMs: ioTimeoutMs });
      let response;
      try {
        response = await deadline.race(
          () =>
            signedRequest({
              audience: normalized.context.audience,
              body: normalized.body,
              domain: normalized.intent.request.signatureDomain,
              keyId: normalized.context.runnerId,
              pathname: normalized.intent.request.pathname,
              privateKey: normalized.context.privateKey,
              publicKey: normalized.context.publicKey,
              signal: deadline.signal,
            }),
          cancelResponseBody,
        );
      } catch {
        return deadline.checkpoint()
          ? transportError()
          : ioTimeoutError();
      }
      if (response === ENGINE_HTTP_TIMEOUT) return ioTimeoutError();
      const captured = await captureBoundedResponse(
        response,
        CLAIM_RESPONSE_MAX_BYTES,
        undefined,
        deadline,
      );
      if (!captured.ok) {
        return responseError(
          normalizedCaptureCode(captured),
          captured.httpStatus,
        );
      }
      if (!deadline.checkpoint()) return ioTimeoutError();
      if (captured.httpStatus !== 200) {
        return classifyDenial(
          captured,
          CLAIM_DENIALS,
        );
      }
      if (captured.contentType !== JSON_CONTENT_TYPE) {
        return responseError("protocol", 200);
      }
      const descriptor = parseEngineLeaseDescriptor(captured.bytes);
      if (
        !descriptor ||
        descriptor.runId !== normalized.intent.runId ||
        descriptor.job.engine !== normalized.intent.engine ||
        !deadline.checkpoint()
      ) {
        return deadline.expired
          ? ioTimeoutError()
          : responseError("protocol", 200);
      }
      let nowMs;
      try {
        nowMs = now();
      } catch {
        return responseError("protocol", 200);
      }
      let budget;
      try {
        budget = evaluateDescriptorBudget({ descriptor, nowMs });
      } catch {
        return responseError("protocol", 200);
      }
      if (!deadline.checkpoint()) return ioTimeoutError();
      if (!budget.accepted) {
        return Object.freeze({
          descriptor,
          httpStatus: 200,
          kind: "descriptor_rejected",
          observedAt: new Date(nowMs).toISOString(),
          reason: budget.reason,
          replay: captured.replay,
        });
      }
      return Object.freeze({
        descriptor,
        httpStatus: 200,
        kind: "descriptor",
        replay: captured.replay,
      });
    } catch {
      return deadline && !deadline.checkpoint()
        ? ioTimeoutError()
        : responseError("protocol", null);
    } finally {
      deadline?.close();
    }
  };
}

export function createEnginePromptHttpEffect(input) {
  const signedRequest = dataValue(input, "signedRequest");
  const allocateScratch =
    dataValue(input, "allocateScratch") ??
    (() => new Uint8Array(PROMPT_RESPONSE_MAX_BYTES + 1));
  const ioTimeoutMs = dataValue(input, "ioTimeoutMs") ??
    ENGINE_HTTP_IO_TIMEOUT_MS;
  if (
    typeof signedRequest !== "function" ||
    typeof allocateScratch !== "function" ||
    !validIoTimeout(ioTimeoutMs)
  ) {
    throw new EngineClaimHttpEffectError(
      "Engine prompt HTTP dependencies are invalid.",
    );
  }

  return async function performEnginePromptEffect(envelope) {
    let deadline;
    try {
      const normalized = normalizePromptEnvelope(envelope);
      if (!normalized) {
        return promptPair(responseError("protocol", null), null);
      }
      deadline = createEngineHttpDeadline({ timeoutMs: ioTimeoutMs });
      let response;
      try {
        response = await deadline.race(
          () =>
            signedRequest({
              audience: normalized.context.audience,
              body: normalized.body,
              domain: normalized.intent.request.signatureDomain,
              keyId: normalized.context.runnerId,
              pathname: normalized.intent.request.pathname,
              privateKey: normalized.context.privateKey,
              publicKey: normalized.context.publicKey,
              signal: deadline.signal,
            }),
          cancelResponseBody,
        );
      } catch {
        return promptPair(
          deadline.checkpoint()
            ? transportError()
            : ioTimeoutError(),
          null,
        );
      }
      if (response === ENGINE_HTTP_TIMEOUT) {
        return promptPair(ioTimeoutError(), null);
      }
      let scratch;
      try {
        scratch = allocateScratch();
      } catch {
        await cancelResponseBody(response);
        return promptPair(responseError("protocol", null), null);
      }
      return await captureEnginePromptResponseWithinDeadline({
        deadline,
        expected: normalized.intent.expected,
        response,
        scratch,
      });
    } catch {
      return promptPair(
        deadline && !deadline.checkpoint()
          ? ioTimeoutError()
          : responseError("protocol", null),
        null,
      );
    } finally {
      deadline?.close();
    }
  };
}

export async function captureEnginePromptResponse(input) {
  const ioTimeoutMs = dataValue(input, "ioTimeoutMs") ??
    ENGINE_HTTP_IO_TIMEOUT_MS;
  const scratch = dataValue(input, "scratch");
  if (!validIoTimeout(ioTimeoutMs)) {
    safeZeroScratch(scratch);
    return promptPair(responseError("protocol", null), null);
  }
  const deadline = createEngineHttpDeadline({ timeoutMs: ioTimeoutMs });
  try {
    return await captureEnginePromptResponseWithinDeadline({
      deadline,
      expected: dataValue(input, "expected"),
      response: dataValue(input, "response"),
      scratch,
    });
  } finally {
    deadline.close();
  }
}

async function captureEnginePromptResponseWithinDeadline(input) {
  const deadline = dataValue(input, "deadline");
  const expected = dataValue(input, "expected");
  const response = dataValue(input, "response");
  const scratch = dataValue(input, "scratch");
  try {
    if (!validPromptScratch(scratch)) {
      await cancelResponseBody(response);
      return promptPair(responseError("protocol", null), null);
    }
    const captured = await captureBoundedResponse(
      response,
      PROMPT_RESPONSE_MAX_BYTES,
      scratch,
      deadline,
    );
    if (!captured.ok) {
      return promptPair(
        responseError(
          normalizedCaptureCode(captured),
          captured.httpStatus,
        ),
        null,
      );
    }
    if (!deadline.checkpoint()) {
      return promptPair(ioTimeoutError(), null);
    }
    if (captured.httpStatus !== 200) {
      return promptPair(
        classifyDenial(captured, PROMPT_DENIALS),
        null,
      );
    }
    const verification = verifyPromptPayload({
      bytes: captured.bytes,
      expected,
      headers: captured.headers,
    });
    if (!deadline.checkpoint()) {
      return promptPair(ioTimeoutError(), null);
    }
    if (verification.kind === "protocol") {
      return promptPair(responseError("protocol", 200), null);
    }
    if (verification.kind === "integrity") {
      return promptPair(
        Object.freeze({
          httpStatus: 200,
          kind: "prompt_rejected",
          reason: "prompt_integrity_mismatch",
          replay: captured.replay,
        }),
        null,
      );
    }
    const promptBuffer = Uint8Array.from(captured.bytes);
    if (!deadline.checkpoint()) {
      promptBuffer.fill(0);
      return promptPair(ioTimeoutError(), null);
    }
    return promptPair(
      Object.freeze({
        httpStatus: 200,
        kind: "prompt",
        promptBytes: verification.metadata.promptBytes,
        promptRef: verification.metadata.promptRef,
        promptSha256: verification.metadata.promptSha256,
        replay: captured.replay,
      }),
      promptBuffer,
    );
  } catch {
    return promptPair(responseError("protocol", null), null);
  } finally {
    safeZeroScratch(scratch);
  }
}

function normalizeClaimEnvelope(value) {
  if (!exactRecord(value, ["controlContext", "intent"])) return undefined;
  const context = normalizeControlContext(dataValue(value, "controlContext"));
  const inputIntent = dataValue(value, "intent");
  if (
    !context ||
    !exactRecord(inputIntent, [
      "attemptId",
      "engine",
      "operationId",
      "request",
      "runId",
    ])
  ) {
    return undefined;
  }
  let expected;
  try {
    expected = createEngineClaimIntent({
      attemptId: dataValue(inputIntent, "attemptId"),
      engine: dataValue(inputIntent, "engine"),
      runId: dataValue(inputIntent, "runId"),
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

function normalizePromptEnvelope(value) {
  if (!exactRecord(value, ["controlContext", "intent"])) return undefined;
  const context = normalizeControlContext(dataValue(value, "controlContext"));
  const inputIntent = dataValue(value, "intent");
  if (
    !context ||
    !exactRecord(inputIntent, ["expected", "request", "runId"])
  ) {
    return undefined;
  }
  const request = dataValue(inputIntent, "request");
  const expectedPrompt = dataValue(inputIntent, "expected");
  if (
    !exactRecord(expectedPrompt, [
      "promptBytes",
      "promptRef",
      "promptSha256",
    ]) ||
    !exactRecord(request, [
      "bodyBase64Url",
      "bodySha256",
      "pathname",
      "signatureDomain",
    ])
  ) {
    return undefined;
  }
  let parsedBody;
  try {
    const body = Buffer.from(
      dataValue(request, "bodyBase64Url") ?? "",
      "base64url",
    );
    parsedBody = JSON.parse(body.toString("utf8"));
    const syntheticDescriptor = {
      cancelRequested: false,
      expiresAt: "2099-01-01T00:00:00.000Z",
      fence: parsedBody.fence,
      job: {
        deadlineAt: "2099-01-01T00:00:00.000Z",
        engine: "claude_code_cli",
        engineVersion: "intent-validation",
        outputBounds: {
          stderrBytes: 65_536,
          stdoutBytes: 262_144,
        },
        promptBytes: dataValue(expectedPrompt, "promptBytes"),
        promptRef: dataValue(expectedPrompt, "promptRef"),
        promptSha256: dataValue(expectedPrompt, "promptSha256"),
        timeoutMs: 270_000,
      },
      leaseId: parsedBody.leaseId,
      runId: dataValue(inputIntent, "runId"),
    };
    const expected = createEnginePromptIntent(syntheticDescriptor);
    if (
      !sameSerializableValue(inputIntent, expected) ||
      !validRequestBody(dataValue(inputIntent, "request"))
    ) {
      return undefined;
    }
    return {
      body,
      context,
      intent: expected,
    };
  } catch {
    return undefined;
  }
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

async function captureBoundedResponse(
  response,
  maximum,
  providedScratch,
  deadline,
) {
  const failure = (code, httpStatus) =>
    deadline?.checkpoint()
      ? captureFailure(code, httpStatus)
      : captureFailure("retryable", null);
  if (!deadline?.checkpoint()) {
    cancelResponseBody(response);
    return failure("retryable", null);
  }
  const httpStatus = safeHttpStatus(response);
  if (httpStatus === null) {
    await cancelResponseBody(response);
    return failure("protocol", null);
  }
  const effectiveMaximum =
    httpStatus === 200
      ? maximum
      : Math.min(maximum, CLAIM_RESPONSE_MAX_BYTES);
  let headers;
  let body;
  try {
    headers = response.headers;
    body = response.body;
  } catch {
    await cancelResponseBody(response);
    return failure("protocol", httpStatus);
  }
  let getHeader;
  try {
    getHeader = headers?.get;
  } catch {
    await cancelBody(body);
    return failure("protocol", httpStatus);
  }
  if (!headers || typeof getHeader !== "function") {
    await cancelBody(body);
    return failure("protocol", httpStatus);
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
    return failure("protocol", httpStatus);
  }
  if (!deadline.checkpoint()) {
    cancelBody(body);
    return failure("retryable", null);
  }
  if (
    (contentType !== null && typeof contentType !== "string") ||
    (
      contentLength !== null &&
      (
        typeof contentLength !== "string" ||
        !/^(0|[1-9]\d*)$/u.test(contentLength) ||
        contentLength.length > String(effectiveMaximum).length ||
        Number(contentLength) > effectiveMaximum
      )
    )
  ) {
    await cancelBody(body);
    return failure("protocol", httpStatus);
  }
  const scratch =
    providedScratch ?? new Uint8Array(effectiveMaximum);
  if (
    !(scratch instanceof Uint8Array) ||
    scratch.byteLength < effectiveMaximum
  ) {
    await cancelBody(body);
    return failure("protocol", httpStatus);
  }
  if (body === null) {
    if (contentLength !== null && contentLength !== "0") {
      return failure("protocol", httpStatus);
    }
    if (!deadline.checkpoint()) {
      return failure("retryable", null);
    }
    return {
      bytes: scratch.subarray(0, 0),
      contentType,
      headers,
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
    return failure("protocol", httpStatus);
  }
  if (!body || typeof getReader !== "function") {
    await cancelBody(body);
    return failure("protocol", httpStatus);
  }
  let reader;
  try {
    reader = getReader.call(body);
  } catch {
    await cancelBody(body);
    return failure("protocol", httpStatus);
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
    return failure("protocol", httpStatus);
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
    return failure("protocol", httpStatus);
  }
  let reads = 0;
  let size = 0;
  try {
    while (reads < MAX_RESPONSE_READS) {
      reads += 1;
      let item;
      try {
        item = await deadline.race(() => readReader.call(reader));
      } catch {
        await cancelReader(reader, cancelReaderMethod);
        return failure(
          "retryable",
          deadline.checkpoint() ? httpStatus : null,
        );
      }
      if (item === ENGINE_HTTP_TIMEOUT) {
        await cancelReader(reader, cancelReaderMethod);
        return failure("retryable", null);
      }
      if (!exactRecord(item, ["done", "value"])) {
        await cancelReader(reader, cancelReaderMethod);
        return failure("protocol", httpStatus);
      }
      const done = dataValue(item, "done");
      const chunk = dataValue(item, "value");
      if (done === true) {
        if (chunk !== undefined) {
          await cancelReader(reader, cancelReaderMethod);
          return failure("protocol", httpStatus);
        }
        if (
          contentLength !== null &&
          Number(contentLength) !== size
        ) {
          await cancelReader(reader, cancelReaderMethod);
          return failure("protocol", httpStatus);
        }
        if (!deadline.checkpoint()) {
          await cancelReader(reader, cancelReaderMethod);
          return failure("retryable", null);
        }
        return {
          bytes: scratch.subarray(0, size),
          contentType,
          headers,
          httpStatus,
          ok: true,
          replay,
        };
      }
      if (done !== false || !ArrayBuffer.isView(chunk)) {
        await cancelReader(reader, cancelReaderMethod);
        return failure("protocol", httpStatus);
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
        return failure("protocol", httpStatus);
      }
      if (
        !Number.isSafeInteger(chunkLength) ||
        chunkLength < 1 ||
        chunkLength > effectiveMaximum - size
      ) {
        await cancelReader(reader, cancelReaderMethod);
        return failure("protocol", httpStatus);
      }
      try {
        scratch.set(chunkBytes, size);
      } catch {
        await cancelReader(reader, cancelReaderMethod);
        return failure("protocol", httpStatus);
      }
      size += chunkLength;
    }
    await cancelReader(reader, cancelReaderMethod);
    return failure("protocol", httpStatus);
  } finally {
    safeReleaseReader(reader, releaseReader);
  }
}

function classifyDenial(captured, table) {
  const status = captured.httpStatus;
  if (
    captured.contentType === JSON_CONTENT_TYPE
  ) {
    const parsed = parseCanonicalError(captured.bytes);
    const classification = parsed
      ? table.get(`${status}:${parsed.error}`)
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
    bytes.byteLength > CLAIM_RESPONSE_MAX_BYTES
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

function ioTimeoutError() {
  return responseError("retryable", null);
}

function transportError() {
  return Object.freeze({ kind: "transport_error" });
}

function promptPair(outcome, promptBuffer) {
  return Object.freeze({ outcome, promptBuffer });
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

function validIoTimeout(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= ENGINE_HTTP_IO_TIMEOUT_MS
  );
}

function validPromptScratch(scratch) {
  try {
    return (
      scratch instanceof Uint8Array &&
      scratch.byteLength === PROMPT_RESPONSE_MAX_BYTES + 1
    );
  } catch {
    return false;
  }
}

function safeZeroScratch(scratch) {
  try {
    if (scratch instanceof Uint8Array) {
      Uint8Array.prototype.fill.call(scratch, 0);
    }
  } catch {
    // A hostile injected test seam cannot make the total effect reject.
  }
}

function safeReleaseReader(reader, releaseMethod) {
  try {
    const release =
      typeof releaseMethod === "function"
        ? releaseMethod
        : reader?.releaseLock;
    if (typeof release === "function") release.call(reader);
  } catch {
    // A hostile release cannot widen or replace the typed result.
  }
}

function cancelResponseBody(response) {
  try {
    cancelBody(response?.body);
  } catch {
    // Cancellation remains best effort across hostile response objects.
  }
}

function cancelBody(body) {
  try {
    if (body && typeof body.cancel === "function") {
      settleBestEffort(body.cancel.call(body));
    }
  } catch {
    // Cancellation is best effort and does not change classification.
  }
}

function cancelReader(reader, cancelMethod) {
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

function settleBestEffort(value) {
  try {
    Promise.resolve(value).catch(() => undefined);
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
