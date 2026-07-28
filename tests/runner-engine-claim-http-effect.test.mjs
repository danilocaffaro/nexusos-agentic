import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createEngineClaimHttpEffect,
  createEnginePromptHttpEffect,
} from "../runner/engine-claim-http-effect.mjs";
import {
  createEngineClaimIntent,
  createEnginePromptIntent,
} from "../runner/engine-claim-contract.mjs";

const attemptId = `att_${"a".repeat(32)}`;
const runId = `run_${"1".repeat(32)}`;
const runnerId = `rnr_${"2".repeat(32)}`;
const leaseId = `lse_${"5".repeat(32)}`;
const promptRef = `prm_${"3".repeat(32)}`;
const nowMs = Date.parse("2026-07-27T12:00:00.000Z");

test("claim effect signs exact frozen intent and accepts canonical descriptor", async () => {
  const calls = [];
  const descriptor = claimDescriptor();
  const perform = createEngineClaimHttpEffect({
    now: () => nowMs,
    async signedRequest(value) {
      calls.push(value);
      return jsonResponse(descriptor, 200, {
        "x-nexus-replay": "1",
      });
    },
  });
  const envelope = claimEnvelope();
  const result = await perform(envelope);
  assert.deepEqual(result, {
    descriptor,
    httpStatus: 200,
    kind: "descriptor",
    replay: true,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.descriptor), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(safeCall(calls[0]), {
    audience: "http://127.0.0.1:3001",
    body: Buffer.from(
      envelope.intent.request.bodyBase64Url,
      "base64url",
    ).toString("utf8"),
    domain: "nexus-runner-engine-lease-claim-v1",
    keyId: runnerId,
    pathname: `/api/runs/${runId}/engine-lease/claim`,
    privateKey: envelope.controlContext.privateKey,
    publicKey: "public-key",
  });
});

test("claim replay requires exact header and still revalidates descriptor", async (t) => {
  for (const [header, expected] of [
    ["1", true],
    ["01", false],
    ["true", false],
    [" 1", false],
    [undefined, false],
  ]) {
    await t.test(String(header), async () => {
      const perform = createEngineClaimHttpEffect({
        now: () => nowMs,
        async signedRequest() {
          const response = jsonResponse(
            claimDescriptor(),
            200,
            header === undefined ? {} : { "x-nexus-replay": header },
          );
          if (header !== " 1") return response;
          return {
            body: response.body,
            headers: {
              get(name) {
                return name === "x-nexus-replay"
                  ? " 1"
                  : response.headers.get(name);
              },
            },
            status: response.status,
          };
        },
      });
      assert.equal((await perform(claimEnvelope())).replay, expected);
    });
  }
  const performDrift = createEngineClaimHttpEffect({
    now: () => nowMs,
    async signedRequest() {
      return jsonResponse(
        { ...claimDescriptor(), runId: `run_${"9".repeat(32)}` },
        200,
        { "x-nexus-replay": "1" },
      );
    },
  });
  assert.deepEqual(await performDrift(claimEnvelope()), {
    code: "protocol",
    httpStatus: 200,
    kind: "response_error",
  });
});

test("claim effect rejects a valid but locally exhausted descriptor", async () => {
  const descriptor = claimDescriptor();
  descriptor.job.deadlineAt = "2026-07-27T12:05:00.000Z";
  descriptor.expiresAt = "2026-07-27T12:01:00.000Z";
  const perform = createEngineClaimHttpEffect({
    now: () => nowMs + 1,
    async signedRequest() {
      return jsonResponse(descriptor, 200);
    },
  });
  assert.deepEqual(await perform(claimEnvelope()), {
    httpStatus: 200,
    kind: "descriptor_rejected",
    reason: "engine_deadline_insufficient",
    replay: false,
  });
});

test("claim effect rejects an expired replay before deadline exhaustion", async () => {
  const descriptor = claimDescriptor();
  descriptor.expiresAt = "2026-07-27T12:00:00.000Z";
  descriptor.job.deadlineAt = "2026-07-27T12:04:59.999Z";
  const perform = createEngineClaimHttpEffect({
    now: () => nowMs,
    async signedRequest() {
      return jsonResponse(descriptor, 200, {
        "x-nexus-replay": "1",
      });
    },
  });
  assert.deepEqual(await perform(claimEnvelope()), {
    httpStatus: 200,
    kind: "descriptor_rejected",
    reason: "lease_expired",
    replay: true,
  });
});

test("claim closed denial matrix retains only safe tokens", async (t) => {
  const cases = [
    [403, "runner_rejected", "auth"],
    [409, "run_unavailable", "rejected"],
    [409, "engine_mismatch", "rejected"],
    [409, "run_assignment_mismatch", "rejected"],
    [409, "engine_deadline_insufficient", "rejected"],
    [409, "engine_inventory_mismatch", "rejected"],
    [409, "runner_conflict", "rejected"],
    [409, "operation_conflict", "rejected"],
    [410, "operation_horizon_exceeded", "rejected"],
    [409, "runner_busy", "retryable"],
    [409, "nonce_reused", "retryable"],
    [409, "conflict_retry", "retryable"],
    [503, "runner_audience_unconfigured", "retryable"],
    [500, "run_operation_failed", "retryable"],
  ];
  for (const [status, serverError, classification] of cases) {
    await t.test(`${status} ${serverError}`, async () => {
      const perform = createEngineClaimHttpEffect({
        now: () => nowMs,
        async signedRequest() {
          return jsonResponse(
            { error: serverError },
            status,
            { "x-nexus-replay": "1" },
          );
        },
      });
      assert.deepEqual(await perform(claimEnvelope()), {
        class: classification,
        httpStatus: status,
        kind: "denied",
        replay: true,
        serverError,
      });
    });
  }
});

test("claim unknown pairs are protocol while bounded edge failures retry", async () => {
  const wrongPair = createEngineClaimHttpEffect({
    now: () => nowMs,
    async signedRequest() {
      return jsonResponse({ error: "runner_rejected" }, 409);
    },
  });
  assert.deepEqual(await wrongPair(claimEnvelope()), {
    code: "protocol",
    httpStatus: 409,
    kind: "response_error",
  });
  const edge = createEngineClaimHttpEffect({
    now: () => nowMs,
    async signedRequest() {
      return new Response("<html>private edge detail</html>", {
        headers: { "content-type": "text/html" },
        status: 502,
      });
    },
  });
  const result = await edge(claimEnvelope());
  assert.deepEqual(result, {
    code: "retryable",
    httpStatus: 502,
    kind: "response_error",
  });
  assert.equal(JSON.stringify(result).includes("private"), false);
  const oversizedEdge = createEngineClaimHttpEffect({
    now: () => nowMs,
    async signedRequest() {
      return new Response(Buffer.alloc(5_000, 7), {
        headers: { "content-type": "text/html" },
        status: 502,
      });
    },
  });
  assert.deepEqual(await oversizedEdge(claimEnvelope()), {
    code: "retryable",
    httpStatus: 502,
    kind: "response_error",
  });
});

test("claim response remains bounded, canonical and total", async (t) => {
  const scenarios = [
    [
      "noncanonical length",
      () => rawResponse(Buffer.from("{}"), 200, {
        "content-length": "02",
        "content-type": "application/json; charset=utf-8",
      }),
      "protocol",
    ],
    [
      "declared overflow",
      () => rawResponse(Buffer.from("{}"), 200, {
        "content-length": "4097",
        "content-type": "application/json; charset=utf-8",
      }),
      "protocol",
    ],
    [
      "chunked overflow",
      () => streamResponse(
        [new Uint8Array(4_096), new Uint8Array([1])],
        200,
        { "content-type": "application/json; charset=utf-8" },
      ),
      "protocol",
    ],
    [
      "zero chunk",
      () => streamResponse(
        [new Uint8Array(0)],
        200,
        { "content-type": "application/json; charset=utf-8" },
      ),
      "protocol",
    ],
    [
      "read cap",
      () => streamResponse(
        Array.from({ length: 1_025 }, () => new Uint8Array([1])),
        200,
        { "content-type": "application/json; charset=utf-8" },
      ),
      "protocol",
    ],
  ];
  for (const [name, response, code] of scenarios) {
    await t.test(name, async () => {
      const perform = createEngineClaimHttpEffect({
        now: () => nowMs,
        async signedRequest() {
          return response();
        },
      });
      assert.equal((await perform(claimEnvelope())).code, code);
    });
  }
  const transport = createEngineClaimHttpEffect({
    now: () => nowMs,
    async signedRequest() {
      throw new Error("private network detail");
    },
  });
  assert.deepEqual(await transport(claimEnvelope()), {
    kind: "transport_error",
  });
});

test("claim request drift and hostile envelopes never reach network", async () => {
  let calls = 0;
  const perform = createEngineClaimHttpEffect({
    now: () => nowMs,
    async signedRequest() {
      calls += 1;
      return jsonResponse(claimDescriptor(), 200);
    },
  });
  for (const mutate of [
    (v) => { v.intent.operationId = `op_${"9".repeat(32)}`; },
    (v) => { v.intent.request.bodySha256 = "9".repeat(64); },
    (v) => { v.intent.request.pathname = "/wrong"; },
    (v) => { v.intent.request.signatureDomain = "wrong"; },
    (v) => { v.intent.extra = true; },
  ]) {
    const envelope = claimEnvelope();
    mutate(envelope);
    assert.equal((await perform(envelope)).code, "protocol");
  }
  const hostile = new Proxy({}, {
    ownKeys() {
      throw new Error("private accessor");
    },
  });
  assert.equal((await perform(hostile)).code, "protocol");
  assert.equal(calls, 0);
});

test("prompt effect transfers one exact buffer and zeroes its scratch", async () => {
  const prompt = Buffer.from("PRIVATE_PROMPT_CANARY");
  const descriptor = promptDescriptor(prompt);
  const retained = [];
  const calls = [];
  const perform = createEnginePromptHttpEffect({
    allocateScratch() {
      const scratch = new Uint8Array(8_193);
      retained.push(scratch);
      return scratch;
    },
    async signedRequest(value) {
      calls.push(value);
      return promptResponse(prompt, descriptor, {
        "x-nexus-replay": "1",
      });
    },
  });
  const envelope = promptEnvelope(descriptor);
  const result = await perform(envelope);
  assert.deepEqual(result.outcome, {
    httpStatus: 200,
    kind: "prompt",
    promptBytes: prompt.byteLength,
    promptRef,
    promptSha256: sha256(prompt),
    replay: true,
  });
  assert.deepEqual(result.promptBuffer, new Uint8Array(prompt));
  assert.equal(Object.isFrozen(result.outcome), true);
  assert.equal(Object.isFrozen(result), true);
  assert.ok(retained[0].every((byte) => byte === 0));
  prompt.fill(0);
  assert.equal(
    Buffer.from(result.promptBuffer).toString("utf8"),
    "PRIVATE_PROMPT_CANARY",
  );
  assert.deepEqual(safeCall(calls[0]), {
    audience: "http://127.0.0.1:3001",
    body: Buffer.from(
      envelope.intent.request.bodyBase64Url,
      "base64url",
    ).toString("utf8"),
    domain: "nexus-runner-engine-prompt-read-v1",
    keyId: runnerId,
    pathname: `/api/runs/${runId}/prompt`,
    privateKey: envelope.controlContext.privateKey,
    publicKey: "public-key",
  });
});

test("prompt integrity mismatches return null and erase canaries", async (t) => {
  const prompt = Buffer.from("PRIVATE_PROMPT_CANARY");
  const base = promptDescriptor(prompt);
  const cases = [
    ["body", (body, descriptor) => [Buffer.from("PRIVATE_PROMPT_CHANGED"), descriptor]],
    ["bytes header", (body, descriptor) => [body, descriptor, {
      "x-nexus-prompt-bytes": String(body.byteLength - 1),
    }]],
    ["ref header", (body, descriptor) => [body, descriptor, {
      "x-nexus-prompt-ref": `prm_${"9".repeat(32)}`,
    }]],
    ["sha header", (body, descriptor) => [body, descriptor, {
      "x-nexus-prompt-sha256": "9".repeat(64),
    }]],
  ];
  for (const [name, change] of cases) {
    await t.test(name, async () => {
      const scratch = new Uint8Array(8_193);
      const [body, descriptor, headers = {}] = change(
        Buffer.from(prompt),
        structuredClone(base),
      );
      const perform = createEnginePromptHttpEffect({
        allocateScratch: () => scratch,
        async signedRequest() {
          return promptResponse(body, descriptor, headers);
        },
      });
      const result = await perform(promptEnvelope(base));
      assert.deepEqual(result, {
        outcome: {
          httpStatus: 200,
          kind: "prompt_rejected",
          reason: "prompt_integrity_mismatch",
          replay: false,
        },
        promptBuffer: null,
      });
      assert.ok(scratch.every((byte) => byte === 0));
      assert.equal(
        JSON.stringify(result.outcome).includes("PRIVATE_PROMPT"),
        false,
      );
      assert.equal(
        JSON.stringify(result.outcome).includes(
          Buffer.from("PRIVATE_PROMPT").toString("base64"),
        ),
        false,
      );
    });
  }
});

test("prompt closed denial matrix includes repository conflict_retry", async (t) => {
  const prompt = Buffer.from("PRIVATE_PROMPT_CANARY");
  const descriptor = promptDescriptor(prompt);
  const cases = [
    [403, "runner_rejected", "auth"],
    [404, "prompt_unavailable", "rejected"],
    [410, "prompt_erased", "rejected"],
    [409, "run_unavailable", "rejected"],
    [409, "lease_superseded", "superseded"],
    [410, "lease_expired", "superseded"],
    [409, "nonce_reused", "retryable"],
    [409, "conflict_retry", "retryable"],
    [503, "prompt_cipher_key_unavailable", "retryable"],
    [503, "runner_audience_unconfigured", "retryable"],
    [500, "run_operation_failed", "retryable"],
  ];
  for (const [status, serverError, classification] of cases) {
    await t.test(`${status} ${serverError}`, async () => {
      const scratch = new Uint8Array(8_193);
      const perform = createEnginePromptHttpEffect({
        allocateScratch: () => scratch,
        async signedRequest() {
          return jsonResponse(
            { error: serverError },
            status,
            { "x-nexus-replay": "1" },
          );
        },
      });
      assert.deepEqual(await perform(promptEnvelope(descriptor)), {
        outcome: {
          class: classification,
          httpStatus: status,
          kind: "denied",
          replay: true,
          serverError,
        },
        promptBuffer: null,
      });
      assert.ok(scratch.every((byte) => byte === 0));
    });
  }
});

test("prompt accepts absent response length and rejects lying or overflowing streams", async (t) => {
  const exact = Buffer.alloc(8_192, 7);
  const descriptor = promptDescriptor(exact);
  const success = createEnginePromptHttpEffect({
    async signedRequest() {
      return promptResponse(exact, descriptor);
    },
  });
  assert.equal(
    (await success(promptEnvelope(descriptor))).promptBuffer.byteLength,
    8_192,
  );
  const cases = [
    [
      "noncanonical length",
      () => promptResponse(exact, descriptor, { "content-length": "08192" }),
    ],
    [
      "lying length",
      () => promptResponse(exact, descriptor, { "content-length": "1" }),
    ],
    [
      "overflow",
      () => streamResponse(
        [new Uint8Array(8_192), new Uint8Array([1])],
        200,
        promptHeaders(descriptor),
      ),
    ],
    [
      "read cap",
      () => streamResponse(
        Array.from({ length: 1_025 }, () => new Uint8Array([1])),
        200,
        promptHeaders({
          ...descriptor,
          job: {
            ...descriptor.job,
            promptBytes: 1_025,
            promptSha256: "0".repeat(64),
          },
        }),
      ),
    ],
    [
      "NaN chunk length",
      () => {
        class NaNLengthChunk extends Uint8Array {
          get byteLength() {
            return Number.NaN;
          }
        }
        return streamResponse(
          [new NaNLengthChunk([1])],
          200,
          promptHeaders(descriptor),
        );
      },
    ],
  ];
  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const scratch = new Uint8Array(8_193);
      const perform = createEnginePromptHttpEffect({
        allocateScratch: () => scratch,
        async signedRequest() {
          return response();
        },
      });
      const result = await perform(promptEnvelope(descriptor));
      assert.equal(result.outcome.kind, "response_error");
      assert.equal(result.outcome.code, "protocol");
      assert.equal(result.promptBuffer, null);
      assert.ok(scratch.every((byte) => byte === 0));
    });
  }
});

test("oversized prompt edge error remains bounded and retryable", async () => {
  const descriptor = promptDescriptor(Buffer.from("PRIVATE_PROMPT_CANARY"));
  const scratch = new Uint8Array(8_193);
  const perform = createEnginePromptHttpEffect({
    allocateScratch: () => scratch,
    async signedRequest() {
      return new Response(Buffer.alloc(5_000, 7), {
        headers: { "content-type": "text/html" },
        status: 504,
      });
    },
  });
  assert.deepEqual(await perform(promptEnvelope(descriptor)), {
    outcome: {
      code: "retryable",
      httpStatus: 504,
      kind: "response_error",
    },
    promptBuffer: null,
  });
  assert.ok(scratch.every((byte) => byte === 0));
});

test("prompt hostile streams cancel, release and never throw plaintext", async () => {
  const prompt = Buffer.from("PRIVATE_PROMPT_CANARY");
  const descriptor = promptDescriptor(prompt);
  let cancellations = 0;
  let releases = 0;
  const perform = createEnginePromptHttpEffect({
    async signedRequest() {
      return {
        body: {
          getReader() {
            return {
              async cancel() {
                cancellations += 1;
                throw new Error("private cancel");
              },
              async read() {
                return { done: false };
              },
              releaseLock() {
                releases += 1;
                throw new Error("private release");
              },
            };
          },
        },
        headers: new Headers(promptHeaders(descriptor)),
        status: 200,
      };
    },
  });
  const result = await perform(promptEnvelope(descriptor));
  assert.deepEqual(result, {
    outcome: {
      code: "protocol",
      httpStatus: 200,
      kind: "response_error",
    },
    promptBuffer: null,
  });
  assert.equal(cancellations, 1);
  assert.equal(releases, 1);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("prompt invalid or hostile scratch is zeroed and response cancellation is total", async () => {
  const prompt = Buffer.from("PRIVATE_PROMPT_CANARY");
  const descriptor = promptDescriptor(prompt);
  let invalidCanceled = 0;
  const wrongSize = new Uint8Array(8_192);
  wrongSize.fill(65);
  const invalid = createEnginePromptHttpEffect({
    allocateScratch: () => wrongSize,
    async signedRequest() {
      return {
        body: {
          async cancel() {
            invalidCanceled += 1;
          },
        },
        headers: new Headers(promptHeaders(descriptor)),
        status: 200,
      };
    },
  });
  assert.deepEqual(await invalid(promptEnvelope(descriptor)), {
    outcome: {
      code: "protocol",
      httpStatus: null,
      kind: "response_error",
    },
    promptBuffer: null,
  });
  assert.equal(invalidCanceled, 1);
  assert.ok(wrongSize.every((byte) => byte === 0));

  class HostileFillScratch extends Uint8Array {
    fill() {
      throw new Error("fill_escape");
    }
  }
  const hostile = new HostileFillScratch(8_193);
  Uint8Array.prototype.fill.call(hostile, 66);
  const hostileEffect = createEnginePromptHttpEffect({
    allocateScratch: () => hostile,
    async signedRequest() {
      return promptResponse(prompt, descriptor, {
        "content-type": "text/plain",
      });
    },
  });
  const hostileResult = await hostileEffect(promptEnvelope(descriptor));
  assert.equal(hostileResult.outcome.kind, "response_error");
  assert.equal(hostileResult.promptBuffer, null);
  assert.ok(hostile.every((byte) => byte === 0));

  let allocationCanceled = 0;
  const allocationFailure = createEnginePromptHttpEffect({
    allocateScratch() {
      throw new Error("private allocator");
    },
    async signedRequest() {
      return {
        body: {
          async cancel() {
            allocationCanceled += 1;
          },
        },
        headers: new Headers(promptHeaders(descriptor)),
        status: 200,
      };
    },
  });
  assert.equal(
    (await allocationFailure(promptEnvelope(descriptor))).outcome.kind,
    "response_error",
  );
  assert.equal(allocationCanceled, 1);
});

test("hostile header and body method accessors still attempt cancellation", async (t) => {
  const descriptor = promptDescriptor(Buffer.from("PRIVATE_PROMPT_CANARY"));
  for (const target of ["headers", "body"]) {
    await t.test(target, async () => {
      let canceled = 0;
      const body = {
        async cancel() {
          canceled += 1;
        },
      };
      if (target === "body") {
        Object.defineProperty(body, "getReader", {
          get() {
            throw new Error("private accessor");
          },
        });
      }
      const headers = target === "headers"
        ? Object.defineProperty({}, "get", {
            get() {
              throw new Error("private accessor");
            },
          })
        : new Headers(promptHeaders(descriptor));
      const perform = createEnginePromptHttpEffect({
        async signedRequest() {
          return { body, headers, status: 200 };
        },
      });
      const result = await perform(promptEnvelope(descriptor));
      assert.equal(result.outcome.kind, "response_error");
      assert.equal(result.promptBuffer, null);
      assert.equal(canceled, 1);
    });
  }
  let bodyCanceled = 0;
  let readerCanceled = 0;
  let readerReleased = 0;
  const malformedReader = createEnginePromptHttpEffect({
    async signedRequest() {
      return {
        body: {
          async cancel() {
            bodyCanceled += 1;
          },
          getReader() {
            return {
              async cancel() {
                readerCanceled += 1;
              },
              read: null,
              releaseLock() {
                readerReleased += 1;
              },
            };
          },
        },
        headers: new Headers(promptHeaders(descriptor)),
        status: 200,
      };
    },
  });
  const result = await malformedReader(promptEnvelope(descriptor));
  assert.equal(result.outcome.kind, "response_error");
  assert.equal(result.promptBuffer, null);
  assert.equal(bodyCanceled, 1);
  assert.equal(readerCanceled, 1);
  assert.equal(readerReleased, 1);
});

test("prompt request drift is total and does not call signed transport", async () => {
  const descriptor = promptDescriptor(Buffer.from("PRIVATE_PROMPT_CANARY"));
  let calls = 0;
  const perform = createEnginePromptHttpEffect({
    async signedRequest() {
      calls += 1;
      return promptResponse(Buffer.from("x"), descriptor);
    },
  });
  for (const mutate of [
    (v) => { v.intent.request.bodySha256 = "0".repeat(64); },
    (v) => { v.intent.request.bodyBase64Url += "="; },
    (v) => { v.intent.request.pathname = "/wrong"; },
    (v) => { v.intent.expected.promptRef = `prm_${"9".repeat(32)}`; },
    (v) => { v.intent.extra = true; },
    (v) => { v.intent[Symbol("extra")] = true; },
  ]) {
    const envelope = promptEnvelope(descriptor);
    mutate(envelope);
    const result = await perform(envelope);
    assert.equal(result.outcome.kind, "response_error");
    assert.equal(result.outcome.code, "protocol");
  }
  assert.equal(calls, 0);
});

function claimEnvelope() {
  return {
    controlContext: controlContext(),
    intent: structuredClone(createEngineClaimIntent({
      attemptId,
      engine: "claude_code_cli",
      runId,
    })),
  };
}

function promptEnvelope(descriptor) {
  return {
    controlContext: controlContext(),
    intent: structuredClone(createEnginePromptIntent(descriptor)),
  };
}

function controlContext() {
  return {
    audience: "http://127.0.0.1:3001",
    privateKey: Object.freeze({ opaque: true }),
    publicKey: "public-key",
    state: { runnerId },
  };
}

function claimDescriptor() {
  return {
    cancelRequested: false,
    expiresAt: "2026-07-27T12:01:00.000Z",
    fence: 1,
    job: {
      deadlineAt: "2026-07-27T12:20:00.000Z",
      engine: "claude_code_cli",
      engineVersion: "2.1.219",
      outputBounds: {
        stderrBytes: 65_536,
        stdoutBytes: 262_144,
      },
      promptBytes: 120,
      promptRef,
      promptSha256: "4".repeat(64),
      timeoutMs: 600_000,
    },
    leaseId,
    runId,
  };
}

function promptDescriptor(prompt) {
  const descriptor = claimDescriptor();
  descriptor.job.promptBytes = prompt.byteLength;
  descriptor.job.promptSha256 = sha256(prompt);
  return descriptor;
}

function promptResponse(body, descriptor, extraHeaders = {}) {
  return rawResponse(body, 200, {
    ...promptHeaders(descriptor),
    ...extraHeaders,
  });
}

function promptHeaders(descriptor) {
  return {
    "content-type": "application/octet-stream",
    "x-nexus-prompt-bytes": String(descriptor.job.promptBytes),
    "x-nexus-prompt-ref": descriptor.job.promptRef,
    "x-nexus-prompt-sha256": descriptor.job.promptSha256,
  };
}

function jsonResponse(value, status, extraHeaders = {}) {
  return rawResponse(
    Buffer.from(canonicalJson(value)),
    status,
    {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  );
}

function rawResponse(body, status, headers = {}) {
  return new Response(body, { headers, status });
}

function streamResponse(chunks, status, headers = {}) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers, status },
  );
}

function safeCall(value) {
  return {
    audience: value.audience,
    body: value.body.toString("utf8"),
    domain: value.domain,
    keyId: value.keyId,
    pathname: value.pathname,
    privateKey: value.privateKey,
    publicKey: value.publicKey,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
