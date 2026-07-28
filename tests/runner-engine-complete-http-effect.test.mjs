import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createEngineCompletionHttpEffect,
} from "../runner/engine-complete-http-effect.mjs";

const operationId = `op_${"a".repeat(32)}`;
const runId = `run_${"b".repeat(32)}`;
const runnerId = `rnr_${"c".repeat(32)}`;

test("HTTP effect signs the exact prepared descriptor and captures a bounded response", async () => {
  const calls = [];
  const responseBody = Buffer.from(JSON.stringify({
    late: false,
    recordedAt: "2026-07-28T12:00:00.000Z",
    runId,
    status: "completed",
  }));
  const perform = createEngineCompletionHttpEffect({
    async signedRequest(value) {
      calls.push(value);
      return new Response(responseBody, {
        headers: {
          "content-length": String(responseBody.byteLength),
          "x-nexus-replay": "1",
        },
        status: 200,
      });
    },
  });
  const envelope = validEnvelope();
  const result = await perform(envelope);
  assert.deepEqual(result, {
    bodyBase64Url: responseBody.toString("base64url"),
    httpStatus: 200,
    kind: "response",
    operationId,
    replay: true,
    runId,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    {
      audience: calls[0].audience,
      body: calls[0].body.toString("base64url"),
      domain: calls[0].domain,
      keyId: calls[0].keyId,
      pathname: calls[0].pathname,
      privateKey: calls[0].privateKey,
      publicKey: calls[0].publicKey,
    },
    {
      audience: "http://127.0.0.1:3001",
      body: envelope.intent.request.bodyBase64Url,
      domain: "nexus-runner-engine-complete-v1",
      keyId: runnerId,
      pathname: `/api/runs/${runId}/engine-complete`,
      privateKey: envelope.completionContext.privateKey,
      publicKey: "public-key",
    },
  );
});

test("HTTP effect classifies transport and mid-body failures without throwing", async () => {
  const transport = createEngineCompletionHttpEffect({
    async signedRequest() {
      throw new Error("private network detail");
    },
  });
  assert.deepEqual(await transport(validEnvelope()), {
    kind: "transport_error",
    operationId,
    runId,
  });

  const midBody = createEngineCompletionHttpEffect({
    async signedRequest() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.error(new Error("private body detail"));
          },
        }),
        { status: 200 },
      );
    },
  });
  assert.deepEqual(await midBody(validEnvelope()), {
    code: "retryable",
    httpStatus: 200,
    kind: "response_error",
    operationId,
    runId,
  });
});

test("HTTP effect enforces content length, fixed-buffer and read-count bounds", async (t) => {
  for (const scenario of [
    {
      name: "noncanonical content length",
      response: () => new Response("x", {
        headers: { "content-length": "01" },
        status: 200,
      }),
    },
    {
      name: "declared overflow",
      response: () => new Response("x", {
        headers: { "content-length": "65537" },
        status: 200,
      }),
    },
    {
      name: "chunked overflow",
      response: () => streamResponse([
        new Uint8Array(65_536),
        new Uint8Array([1]),
      ]),
    },
    {
      name: "zero byte nonterminal chunk",
      response: () => streamResponse([new Uint8Array(0)]),
    },
    {
      name: "excessive read count",
      response: () => streamResponse(
        Array.from({ length: 1_025 }, () => new Uint8Array([1])),
      ),
    },
    {
      name: "declared length drift",
      response: () => new Response("x", {
        headers: { "content-length": "2" },
        status: 200,
      }),
    },
  ]) {
    await t.test(scenario.name, async () => {
      const perform = createEngineCompletionHttpEffect({
        async signedRequest() {
          return scenario.response();
        },
      });
      assert.deepEqual(await perform(validEnvelope()), {
        code: "protocol",
        httpStatus: 200,
        kind: "response_error",
        operationId,
        runId,
      });
    });
  }

  const exact = Buffer.alloc(65_536, 7);
  const performExact = createEngineCompletionHttpEffect({
    async signedRequest() {
      return streamResponse([exact], {
        "content-length": "65536",
      });
    },
  });
  const captured = await performExact(validEnvelope());
  assert.equal(captured.kind, "response");
  assert.equal(
    Buffer.from(captured.bodyBase64Url, "base64url").equals(exact),
    true,
  );
});

test("HTTP effect is total for hostile envelopes and response surfaces", async () => {
  let accessorReads = 0;
  const hostileIntent = validEnvelope().intent;
  Object.defineProperty(hostileIntent.request, "pathname", {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error("must not run");
    },
  });
  const perform = createEngineCompletionHttpEffect({
    async signedRequest() {
      throw new Error("must not be reached");
    },
  });
  const malformed = await perform({
    completionContext: validEnvelope().completionContext,
    intent: hostileIntent,
  });
  assert.equal(accessorReads, 0);
  assert.deepEqual(malformed, {
    code: "protocol",
    httpStatus: null,
    kind: "response_error",
    operationId,
    runId,
  });

  const hostileResponse = createEngineCompletionHttpEffect({
    async signedRequest() {
      return Object.defineProperty({}, "status", {
        get() {
          throw new Error("hostile status");
        },
      });
    },
  });
  assert.deepEqual(await hostileResponse(validEnvelope()), {
    code: "protocol",
    httpStatus: null,
    kind: "response_error",
    operationId,
    runId,
  });

  const proxyResult = await perform(new Proxy({}, {
    ownKeys() {
      throw new Error("hostile reflection");
    },
  }));
  assert.equal(proxyResult.kind, "response_error");
  assert.equal(proxyResult.code, "protocol");
});

test("every early reader protocol exit attempts cancellation", async () => {
  let nativeCancellations = 0;
  const zeroChunk = createEngineCompletionHttpEffect({
    async signedRequest() {
      return new Response(
        new ReadableStream({
          cancel() {
            nativeCancellations += 1;
          },
          pull(controller) {
            controller.enqueue(new Uint8Array(0));
          },
        }),
        { status: 200 },
      );
    },
  });
  assert.equal((await zeroChunk(validEnvelope())).code, "protocol");
  assert.equal(nativeCancellations, 1);

  let hostileCancellations = 0;
  const malformedRead = createEngineCompletionHttpEffect({
    async signedRequest() {
      return {
        body: {
          getReader() {
            return {
              async cancel() {
                hostileCancellations += 1;
              },
              async read() {
                return { done: false };
              },
              releaseLock() {},
            };
          },
        },
        headers: {
          get() {
            return null;
          },
        },
        status: 200,
      };
    },
  });
  assert.equal((await malformedRead(validEnvelope())).code, "protocol");
  assert.equal(hostileCancellations, 1);
});

test("request descriptor drift never reaches the signed request", async () => {
  let calls = 0;
  const perform = createEngineCompletionHttpEffect({
    async signedRequest() {
      calls += 1;
      return new Response("", { status: 200 });
    },
  });
  for (const mutate of [
    (value) => {
      value.intent.attemptId = "NOT_AN_ATTEMPT";
    },
    (value) => {
      value.intent.expectedEntrySha256 = "NOT_A_SHA";
    },
    (value) => {
      value.intent.operationId = `op_${"z".repeat(32)}`;
    },
    (value) => {
      value.intent.runId = `run_${"z".repeat(32)}`;
    },
    (value) => {
      value.intent.request.pathname = `/api/runs/${runId}/complete`;
    },
    (value) => {
      value.intent.request.signatureDomain = "wrong-domain";
    },
    (value) => {
      value.intent.request.bodySha256 = "0".repeat(64);
    },
    (value) => {
      value.intent.request.bodyBase64Url += "=";
    },
    (value) => {
      value.completionContext.state.runnerId =
        `rnr_${"z".repeat(32)}`;
    },
  ]) {
    const value = validEnvelope();
    mutate(value);
    const result = await perform(value);
    assert.equal(result.kind, "response_error");
    assert.equal(result.code, "protocol");
  }
  assert.equal(calls, 0);
});

function validEnvelope() {
  const body = Buffer.from(JSON.stringify({
    attemptId: `att_${"d".repeat(32)}`,
    runId,
  }));
  return {
    completionContext: {
      audience: "http://127.0.0.1:3001",
      privateKey: Object.freeze({ opaque: true }),
      publicKey: "public-key",
      state: {
        runnerId,
      },
    },
    intent: {
      attemptId: `att_${"d".repeat(32)}`,
      expectedEntrySha256: "e".repeat(64),
      operationId,
      request: {
        bodyBase64Url: body.toString("base64url"),
        bodySha256: createHash("sha256").update(body).digest("hex"),
        pathname: `/api/runs/${runId}/engine-complete`,
        signatureDomain: "nexus-runner-engine-complete-v1",
      },
      runId,
    },
  };
}

function streamResponse(chunks, headers = {}) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers, status: 200 },
  );
}
