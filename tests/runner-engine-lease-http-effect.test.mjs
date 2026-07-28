import assert from "node:assert/strict";
import test from "node:test";
import {
  createEngineLeaseRenewHttpEffect,
} from "../runner/engine-lease-http-effect.mjs";
import {
  createEngineLeaseRenewIntent,
} from "../runner/engine-lease-runtime-contract.mjs";

const leaseId = `lse_${"5".repeat(32)}`;
const runId = `run_${"1".repeat(32)}`;
const runnerId = `rnr_${"2".repeat(32)}`;

test("renew effect signs exact intent and accepts canonical renewal", async () => {
  const calls = [];
  const perform = createEngineLeaseRenewHttpEffect({
    async signedRequest(value) {
      calls.push(value);
      return jsonResponse(renewalValue(), 200, {
        "x-nexus-replay": "1",
      });
    },
  });
  const envelope = renewEnvelope();
  const result = await perform(envelope);
  assert.deepEqual(result, {
    httpStatus: 200,
    kind: "renewal",
    renewal: renewalValue(),
    replay: true,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.renewal), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(safeCall(calls[0]), {
    audience: "http://127.0.0.1:3001",
    body: Buffer.from(
      envelope.intent.request.bodyBase64Url,
      "base64url",
    ).toString("utf8"),
    domain: "nexus-runner-lease-renew-v1",
    keyId: runnerId,
    pathname: `/api/runs/${runId}/lease/renew`,
    privateKey: envelope.controlContext.privateKey,
    publicKey: "public-key",
  });
});

test("renew replay header never bypasses identity validation", async () => {
  for (const [header, replay] of [
    ["1", true],
    ["01", false],
    ["true", false],
    [undefined, false],
  ]) {
    const perform = createEngineLeaseRenewHttpEffect({
      async signedRequest() {
        return jsonResponse(
          renewalValue(),
          200,
          header === undefined ? {} : { "x-nexus-replay": header },
        );
      },
    });
    assert.equal((await perform(renewEnvelope())).replay, replay);
  }
  const drift = createEngineLeaseRenewHttpEffect({
    async signedRequest() {
      return jsonResponse(
        { ...renewalValue(), fence: 8 },
        200,
        { "x-nexus-replay": "1" },
      );
    },
  });
  assert.deepEqual(await drift(renewEnvelope()), {
    code: "protocol",
    httpStatus: 200,
    kind: "response_error",
  });
});

test("renew denial matrix is closed over the real server surface", async (t) => {
  const cases = [
    [403, "runner_rejected", "auth"],
    [409, "run_unavailable", "rejected"],
    [409, "lease_superseded", "superseded"],
    [410, "lease_expired", "superseded"],
    [409, "engine_deadline_insufficient", "exhausted"],
    [409, "nonce_reused", "retryable"],
    [409, "conflict_retry", "retryable"],
    [503, "runner_audience_unconfigured", "retryable"],
    [503, "runner_rejected", "retryable"],
    [500, "run_operation_failed", "retryable"],
  ];
  for (const [status, serverError, classification] of cases) {
    await t.test(`${status} ${serverError}`, async () => {
      const perform = createEngineLeaseRenewHttpEffect({
        async signedRequest() {
          return jsonResponse(
            { error: serverError },
            status,
            { "x-nexus-replay": "1" },
          );
        },
      });
      assert.deepEqual(await perform(renewEnvelope()), {
        class: classification,
        httpStatus: status,
        kind: "denied",
        replay: true,
        serverError,
      });
    });
  }
});

test("unknown pairs are protocol while malformed edge responses retry", async () => {
  const wrongPair = createEngineLeaseRenewHttpEffect({
    async signedRequest() {
      return jsonResponse({ error: "runner_rejected" }, 409);
    },
  });
  assert.deepEqual(await wrongPair(renewEnvelope()), {
    code: "protocol",
    httpStatus: 409,
    kind: "response_error",
  });

  for (const status of [429, 500, 502, 503, 504]) {
    const edge = createEngineLeaseRenewHttpEffect({
      async signedRequest() {
        return new Response("<html>private edge detail</html>", {
          headers: { "content-type": "text/html" },
          status,
        });
      },
    });
    const result = await edge(renewEnvelope());
    assert.deepEqual(result, {
      code: "retryable",
      httpStatus: status,
      kind: "response_error",
    });
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("renew response is canonical, content-bound and capped at 4096 bytes", async (t) => {
  const cases = [
    [
      "wrong content type",
      jsonResponse(renewalValue(), 200, {
        "content-type": "application/json",
      }),
      "protocol",
    ],
    [
      "noncanonical body",
      new Response(
        `{"runId":"${runId}","leaseId":"${leaseId}","fence":7,"expiresAt":"2026-07-28T12:01:00.000Z","cancelRequested":false}`,
        {
          headers: { "content-type": "application/json; charset=utf-8" },
          status: 200,
        },
      ),
      "protocol",
    ],
    [
      "declared oversize",
      rawResponse(Buffer.from("{}"), 200, {
        "content-length": "4097",
        "content-type": "application/json; charset=utf-8",
      }),
      "protocol",
    ],
    [
      "length mismatch",
      rawResponse(Buffer.from("{}"), 200, {
        "content-length": "3",
        "content-type": "application/json; charset=utf-8",
      }),
      "protocol",
    ],
    [
      "stream oversize",
      new Response(Buffer.alloc(4_097, 7), {
        headers: { "content-type": "application/json; charset=utf-8" },
        status: 200,
      }),
      "protocol",
    ],
  ];
  for (const [name, response, code] of cases) {
    await t.test(name, async () => {
      const perform = createEngineLeaseRenewHttpEffect({
        async signedRequest() {
          return response;
        },
      });
      assert.deepEqual(await perform(renewEnvelope()), {
        code,
        httpStatus: 200,
        kind: "response_error",
      });
    });
  }
});

test("malformed readers are canceled and released without rejection", async () => {
  const counts = { body: 0, reader: 0, release: 0 };
  const response = {
    body: {
      async cancel() {
        counts.body += 1;
      },
      getReader() {
        return {
          async cancel() {
            counts.reader += 1;
          },
          async read() {
            return { done: "private", value: undefined };
          },
          releaseLock() {
            counts.release += 1;
          },
        };
      },
    },
    headers: new Headers({
      "content-type": "application/json; charset=utf-8",
    }),
    status: 200,
  };
  const perform = createEngineLeaseRenewHttpEffect({
    async signedRequest() {
      return response;
    },
  });
  assert.deepEqual(await perform(renewEnvelope()), {
    code: "protocol",
    httpStatus: 200,
    kind: "response_error",
  });
  assert.deepEqual(counts, { body: 0, reader: 1, release: 1 });
});

test("hung response reads time out, cancel and release", async () => {
  const counts = { cancel: 0, release: 0 };
  const perform = createEngineLeaseRenewHttpEffect({
    readTimeoutMs: 5,
    async signedRequest() {
      return {
        body: {
          async cancel() {},
          getReader() {
            return {
              async cancel() {
                counts.cancel += 1;
              },
              async read() {
                return await new Promise(() => {});
              },
              releaseLock() {
                counts.release += 1;
              },
            };
          },
        },
        headers: new Headers({
          "content-type": "application/json; charset=utf-8",
        }),
        status: 200,
      };
    },
  });
  assert.deepEqual(await perform(renewEnvelope()), {
    code: "retryable",
    httpStatus: 200,
    kind: "response_error",
  });
  assert.deepEqual(counts, { cancel: 1, release: 1 });
});

test("response read timeout is absolute across drip chunks", async () => {
  const counts = { cancel: 0, read: 0, release: 0 };
  const startedAt = performance.now();
  const perform = createEngineLeaseRenewHttpEffect({
    readTimeoutMs: 30,
    async signedRequest() {
      return {
        body: {
          async cancel() {},
          getReader() {
            return {
              async cancel() {
                counts.cancel += 1;
              },
              async read() {
                counts.read += 1;
                await new Promise((resolve) => setTimeout(resolve, 20));
                return {
                  done: false,
                  value: new Uint8Array([counts.read]),
                };
              },
              releaseLock() {
                counts.release += 1;
              },
            };
          },
        },
        headers: new Headers({
          "content-type": "application/json; charset=utf-8",
        }),
        status: 200,
      };
    },
  });
  assert.deepEqual(await perform(renewEnvelope()), {
    code: "retryable",
    httpStatus: 200,
    kind: "response_error",
  });
  assert.equal(counts.cancel, 1);
  assert.ok(counts.read >= 1 && counts.read <= 2);
  assert.equal(counts.release, 1);
  assert.ok(performance.now() - startedAt < 200);
});

test("effect remains total across hostile response accessors and transport errors", async () => {
  const transport = createEngineLeaseRenewHttpEffect({
    async signedRequest() {
      throw new Error("private transport detail");
    },
  });
  assert.deepEqual(await transport(renewEnvelope()), {
    kind: "transport_error",
  });

  const hostile = createEngineLeaseRenewHttpEffect({
    async signedRequest() {
      return Object.defineProperty({}, "status", {
        get() {
          throw new Error("private response detail");
        },
      });
    },
  });
  assert.deepEqual(await hostile(renewEnvelope()), {
    code: "protocol",
    httpStatus: null,
    kind: "response_error",
  });
});

test("read timeout configuration is closed and bounded", () => {
  for (const readTimeoutMs of [0, 10_001, 1.5, "10"]) {
    assert.throws(
      () =>
        createEngineLeaseRenewHttpEffect({
          readTimeoutMs,
          async signedRequest() {},
        }),
      /dependencies are invalid/u,
    );
  }
});

test("intent drift fails before network access", async () => {
  let calls = 0;
  const perform = createEngineLeaseRenewHttpEffect({
    async signedRequest() {
      calls += 1;
      return jsonResponse(renewalValue());
    },
  });
  const envelope = renewEnvelope();
  envelope.intent.request.bodySha256 = "0".repeat(64);
  assert.deepEqual(await perform(envelope), {
    code: "protocol",
    httpStatus: null,
    kind: "response_error",
  });
  assert.equal(calls, 0);
});

function renewEnvelope() {
  return {
    controlContext: {
      audience: "http://127.0.0.1:3001",
      privateKey: { key: "private-test-key" },
      publicKey: "public-key",
      state: { runnerId },
    },
    intent: structuredClone(createEngineLeaseRenewIntent({
      fence: 7,
      leaseId,
      runId,
    })),
  };
}

function renewalValue() {
  return {
    cancelRequested: false,
    expiresAt: "2026-07-28T12:01:00.000Z",
    fence: 7,
    leaseId,
    runId,
  };
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    status,
  });
}

function rawResponse(bytes, status, headers) {
  let sent = false;
  return {
    body: {
      async cancel() {},
      getReader() {
        return {
          async cancel() {},
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          releaseLock() {},
        };
      },
    },
    headers: {
      get(name) {
        return headers[name] ?? null;
      },
    },
    status,
  };
}

function safeCall(value) {
  return {
    ...value,
    body: Buffer.from(value.body).toString("utf8"),
  };
}
