import { createHash } from "node:crypto";

const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_RESPONSE_READS = 1_024;
const ATTEMPT_ID_PATTERN = /^att_[0-9a-f]{32}$/u;
const OPERATION_ID_PATTERN = /^op_[0-9a-f]{32}$/u;
const RUN_ID_PATTERN = /^run_[0-9a-f]{32}$/u;
const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/u;

export class EngineCompleteHttpEffectError extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineCompleteHttpEffectError";
    this.code = "engine_complete_http_effect_invalid";
  }
}

export function createEngineCompletionHttpEffect(input) {
  const signedRequest = dataValue(input, "signedRequest");
  if (typeof signedRequest !== "function") {
    throw new EngineCompleteHttpEffectError(
      "Engine completion HTTP dependencies are invalid.",
    );
  }

  return async function performEngineCompletionEffect(envelope) {
    const fallback = safeIdentity(envelope);
    try {
      const normalized = normalizeEnvelope(envelope);
      if (!normalized) return protocolEffect(fallback);
      let response;
      try {
        response = await signedRequest({
          audience: normalized.context.audience,
          body: normalized.body,
          domain: normalized.request.signatureDomain,
          keyId: normalized.context.runnerId,
          pathname: normalized.request.pathname,
          privateKey: normalized.context.privateKey,
          publicKey: normalized.context.publicKey,
        });
      } catch {
        return transportEffect(normalized.identity);
      }
      const captured = await captureResponse(response);
      if (!captured.ok) {
        return Object.freeze({
          code: captured.code,
          httpStatus: captured.httpStatus,
          kind: "response_error",
          operationId: normalized.identity.operationId,
          runId: normalized.identity.runId,
        });
      }
      return Object.freeze({
        bodyBase64Url: captured.body.toString("base64url"),
        httpStatus: captured.httpStatus,
        kind: "response",
        operationId: normalized.identity.operationId,
        replay: captured.replay,
        runId: normalized.identity.runId,
      });
    } catch {
      return protocolEffect(fallback);
    }
  };
}

function normalizeEnvelope(value) {
  if (!exactRecord(value, ["completionContext", "intent"])) return null;
  const completionContext = dataValue(value, "completionContext");
  const intent = dataValue(value, "intent");
  if (
    !exactRecord(intent, [
      "attemptId",
      "expectedEntrySha256",
      "operationId",
      "request",
      "runId",
    ])
  ) {
    return null;
  }
  const attemptId = dataValue(intent, "attemptId");
  const expectedEntrySha256 = dataValue(
    intent,
    "expectedEntrySha256",
  );
  const operationId = dataValue(intent, "operationId");
  const runId = dataValue(intent, "runId");
  const request = dataValue(intent, "request");
  if (
    !ATTEMPT_ID_PATTERN.test(attemptId ?? "") ||
    !SHA256_PATTERN.test(expectedEntrySha256 ?? "") ||
    !OPERATION_ID_PATTERN.test(operationId ?? "") ||
    !RUN_ID_PATTERN.test(runId ?? "") ||
    !exactRecord(request, [
      "bodyBase64Url",
      "bodySha256",
      "pathname",
      "signatureDomain",
    ])
  ) {
    return null;
  }
  const bodyBase64Url = dataValue(request, "bodyBase64Url");
  const bodySha256 = dataValue(request, "bodySha256");
  const pathname = dataValue(request, "pathname");
  const signatureDomain = dataValue(request, "signatureDomain");
  if (
    typeof bodyBase64Url !== "string" ||
    bodyBase64Url.length > 8_192 ||
    !BASE64URL_PATTERN.test(bodyBase64Url) ||
    !SHA256_PATTERN.test(bodySha256 ?? "") ||
    pathname !== `/api/runs/${runId}/engine-complete` ||
    signatureDomain !== "nexus-runner-engine-complete-v1"
  ) {
    return null;
  }
  const body = Buffer.from(bodyBase64Url, "base64url");
  if (
    body.toString("base64url") !== bodyBase64Url ||
    createHash("sha256").update(body).digest("hex") !== bodySha256
  ) {
    return null;
  }
  const context = normalizeCompletionContext(completionContext);
  if (!context) return null;
  return {
    body,
    context,
    identity: { operationId, runId },
    request: { pathname, signatureDomain },
  };
}

function normalizeCompletionContext(value) {
  if (!plainRecord(value)) return null;
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
    !RUNNER_ID_PATTERN.test(runnerId ?? "")
  ) {
    return null;
  }
  return { audience, privateKey, publicKey, runnerId };
}

async function captureResponse(response) {
  const httpStatus = safeHttpStatus(response);
  if (httpStatus === null) {
    await cancelResponseBody(response);
    return responseFailure("protocol", null);
  }
  let headers;
  let body;
  try {
    headers = response.headers;
    body = response.body;
  } catch {
    await cancelResponseBody(response);
    return responseFailure("protocol", httpStatus);
  }
  if (!headers || typeof headers.get !== "function") {
    await cancelBody(body);
    return responseFailure("protocol", httpStatus);
  }
  let declared;
  let replay;
  try {
    declared = headers.get("content-length");
    replay = headers.get("x-nexus-replay") === "1";
  } catch {
    await cancelBody(body);
    return responseFailure("protocol", httpStatus);
  }
  if (
    declared !== null &&
    (
      typeof declared !== "string" ||
      !/^(0|[1-9]\d{0,4})$/u.test(declared) ||
      Number(declared) > MAX_RESPONSE_BYTES
    )
  ) {
    await cancelBody(body);
    return responseFailure("protocol", httpStatus);
  }
  if (body === null) {
    if (declared !== null && declared !== "0") {
      return responseFailure("protocol", httpStatus);
    }
    return {
      body: Buffer.alloc(0),
      httpStatus,
      ok: true,
      replay,
    };
  }
  if (!body || typeof body.getReader !== "function") {
    await cancelBody(body);
    return responseFailure("protocol", httpStatus);
  }
  let reader;
  try {
    reader = body.getReader();
  } catch {
    await cancelBody(body);
    return responseFailure("protocol", httpStatus);
  }
  if (
    !reader ||
    typeof reader.read !== "function" ||
    typeof reader.cancel !== "function" ||
    typeof reader.releaseLock !== "function"
  ) {
    await cancelBody(body);
    return responseFailure("protocol", httpStatus);
  }
  const scratch = Buffer.allocUnsafe(MAX_RESPONSE_BYTES);
  let reads = 0;
  let size = 0;
  try {
    while (reads < MAX_RESPONSE_READS) {
      reads += 1;
      let item;
      try {
        item = await reader.read();
      } catch {
        await cancelReader(reader);
        return responseFailure("retryable", httpStatus);
      }
      if (!exactRecord(item, ["done", "value"])) {
        await cancelReader(reader);
        return responseFailure("protocol", httpStatus);
      }
      const done = dataValue(item, "done");
      const chunk = dataValue(item, "value");
      if (done === true) {
        if (chunk !== undefined) {
          await cancelReader(reader);
          return responseFailure("protocol", httpStatus);
        }
        if (declared !== null && Number(declared) !== size) {
          await cancelReader(reader);
          return responseFailure("protocol", httpStatus);
        }
        return {
          body: Buffer.from(scratch.subarray(0, size)),
          httpStatus,
          ok: true,
          replay,
        };
      }
      if (
        done !== false ||
        !ArrayBuffer.isView(chunk) ||
        typeof chunk.byteLength !== "number" ||
        chunk.byteLength < 1
      ) {
        await cancelReader(reader);
        return responseFailure("protocol", httpStatus);
      }
      if (chunk.byteLength > MAX_RESPONSE_BYTES - size) {
        await cancelReader(reader);
        return responseFailure("protocol", httpStatus);
      }
      scratch.set(
        new Uint8Array(
          chunk.buffer,
          chunk.byteOffset,
          chunk.byteLength,
        ),
        size,
      );
      size += chunk.byteLength;
    }
    await cancelReader(reader);
    return responseFailure("protocol", httpStatus);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Releasing a hostile reader cannot make the effect throw.
    }
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

function safeIdentity(envelope) {
  try {
    const intent = dataValue(envelope, "intent");
    const operationId = dataValue(intent, "operationId");
    const runId = dataValue(intent, "runId");
    return {
      operationId:
        typeof operationId === "string" ? operationId : "",
      runId: typeof runId === "string" ? runId : "",
    };
  } catch {
    return { operationId: "", runId: "" };
  }
}

function protocolEffect(identity) {
  return Object.freeze({
    code: "protocol",
    httpStatus: null,
    kind: "response_error",
    operationId: identity.operationId,
    runId: identity.runId,
  });
}

function transportEffect(identity) {
  return Object.freeze({
    kind: "transport_error",
    operationId: identity.operationId,
    runId: identity.runId,
  });
}

function responseFailure(code, httpStatus) {
  return { code, httpStatus, ok: false };
}

async function cancelBody(body) {
  try {
    if (body && typeof body.cancel === "function") await body.cancel();
  } catch {
    // Cancellation is best effort and never widens the result.
  }
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best effort and never changes the typed result.
  }
}

async function cancelResponseBody(response) {
  try {
    await cancelBody(response?.body);
  } catch {
    // Hostile response accessors cannot make the effect throw.
  }
}

function exactRecord(value, keys) {
  if (!plainRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        ownKeys.includes(key) &&
        descriptor?.enumerable === true &&
        Object.hasOwn(descriptor, "value")
      );
    })
  );
}

function dataValue(value, key) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function plainRecord(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}
