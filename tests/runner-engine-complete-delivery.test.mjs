import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  drainEngineCompletionOutbox,
  deliverEngineCompletion,
  EngineCompletionDeliveryError,
} from "../runner/nexus-runner.mjs";
import {
  persistDeclarationOperation,
} from "../runner/durable-outbox.mjs";
import { OUTBOX_V3_DIRECTORY } from "../runner/outbox-contract.mjs";

const publicKeyPrefix = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const runnerId = `rnr_${"a".repeat(32)}`;
const defaultRunId = `run_${"2".repeat(32)}`;
const defaultOperationId = `op_${"4".repeat(32)}`;
const cli = fileURLToPath(
  new URL("../runner/nexus-runner.mjs", import.meta.url),
);
const privateOutputMarkerBase64 = Buffer.from(
  "PRIVATE_OUTPUT_MARKER\n",
).toString("base64url");

test("the dedicated sender signs exact bytes, acks, scrubs and surfaces replay", async (t) => {
  const stateDir = await temporaryState(t, "nexus-engine-complete-send-");
  const source = await completionFixture();
  const requests = [];
  const harness = await responseServer(t, async (request, response, body) => {
    requests.push({ body, request });
    verifyCompletionRequest(request, body, harness.origin);
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.setHeader("x-nexus-replay", "1");
    response.end(await fixture("engine-complete-response-v1.json"));
  });
  const context = runnerContext(harness.origin);
  const entry = await persistCompletion(
    stateDir,
    source,
    defaultRunId,
    defaultOperationId,
  );
  const result = await deliverEngineCompletion(context, stateDir, entry);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.equals(source), true);
  assert.deepEqual(
    {
      late: result.ack.late,
      replay: result.replay,
      runId: result.ack.runId,
      status: result.status,
    },
    {
      late: false,
      replay: true,
      runId: defaultRunId,
      status: "acked",
    },
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.ack), true);
  assert.equal(Object.isFrozen(result.entry), true);
  const stored = await readStored(stateDir, defaultOperationId);
  assert.equal(stored.status, "acked");
  assert.equal(stored.responseStatus, 200);
  assert.equal("bodyBase64" in stored, false);
  assert.equal("response" in stored, false);
  assert.equal(
    JSON.stringify(result).includes(privateOutputMarkerBase64),
    false,
  );

  const settledText = await readFile(
    storedPath(stateDir, defaultOperationId),
    "utf8",
  );
  await assert.rejects(
    deliverEngineCompletion(context, stateDir, entry),
    /pending engine completion is invalid/u,
  );
  assert.equal(requests.length, 1);
  assert.equal(
    await readFile(storedPath(stateDir, defaultOperationId), "utf8"),
    settledText,
  );

  const replayDrain = await drainEngineCompletionOutbox(context, stateDir);
  assert.deepEqual(replayDrain, {
    attempted: 0,
    delivered: [],
    failed: [],
    halt: null,
    remainingPending: 0,
  });
  assert.equal(requests.length, 1);
});

test("the sender preserves pending bytes for retryable and protocol failures", async (t) => {
  for (const scenario of [
    {
      code: "retryable",
      error: "run_operation_failed",
      name: "server failure",
      status: 500,
    },
    {
      code: "retryable",
      error: "conflict_retry",
      name: "conflict retry",
      status: 409,
    },
    {
      code: "retryable",
      error: "nonce_reused",
      name: "nonce retry",
      status: 409,
    },
    {
      code: "protocol",
      name: "unexpected successful status",
      status: 204,
    },
    {
      code: "protocol",
      name: "invalid acknowledgement",
      status: 200,
      value: { invalid: true },
    },
    {
      code: "protocol",
      name: "oversized response stream",
      oversized: true,
      status: 200,
    },
    {
      code: "retryable",
      name: "connection reset after headers",
      resetAfterHeaders: true,
      status: 200,
    },
    {
      code: "protocol",
      name: "unknown gateway response",
      raw: "<html>not NexusOS</html>",
      status: 404,
    },
    {
      code: "protocol",
      name: "unknown proxy authorization response",
      raw: "<html>denied by proxy</html>",
      status: 403,
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const stateDir = await temporaryState(
        t,
        "nexus-engine-complete-pending-",
      );
      const harness = await responseServer(
        t,
        async (_request, response) => {
          response.statusCode = scenario.status;
          if (scenario.resetAfterHeaders) {
            response.setHeader("content-type", "application/json");
            response.flushHeaders();
            response.write('{"late":');
            await new Promise((resolveDelay) =>
              setTimeout(resolveDelay, 10),
            );
            response.socket.destroy();
          } else if (scenario.oversized) {
            response.end(Buffer.alloc(65_537, 97));
          } else if (scenario.status === 204) {
            response.end();
          } else if (scenario.raw) {
            response.setHeader("content-type", "text/html");
            response.end(scenario.raw);
          } else {
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify(
                scenario.value ?? {
                  error: scenario.error,
                  marker: "RESPONSE_SECRET_MARKER",
                },
              ),
            );
          }
        },
      );
      const context = runnerContext(harness.origin);
      const entry = await persistCompletion(
        stateDir,
        await completionFixture(),
        defaultRunId,
        defaultOperationId,
      );
      const before = await readFile(
        storedPath(stateDir, defaultOperationId),
        "utf8",
      );
      await assert.rejects(
        deliverEngineCompletion(context, stateDir, entry),
        (error) => {
          assert.equal(error instanceof EngineCompletionDeliveryError, true);
          assert.equal(error.code, scenario.code);
          assert.equal(error.outboxStatus, "pending");
          assert.equal(error.httpStatus, scenario.status);
          assert.equal(
            error.exitCodeHint,
            scenario.code === "protocol" ? 76 : 75,
          );
          assert.equal(
            JSON.stringify(error).includes("RESPONSE_SECRET_MARKER"),
            false,
          );
          return true;
        },
      );
      assert.equal(
        await readFile(storedPath(stateDir, defaultOperationId), "utf8"),
        before,
      );
    });
  }
});

test("terminal responses scrub before typed superseded, rejected and auth errors", async (t) => {
  const scenarios = [
    ...[
      "lease_superseded",
      "run_unavailable",
      "lease_expired",
      "engine_deadline_exhausted",
    ].map((error) => ({
      code: "superseded",
      error,
      exitCodeHint: 75,
      outboxStatus: "superseded",
      status: 409,
    })),
    {
      code: "rejected",
      error: "operation_conflict",
      exitCodeHint: 75,
      outboxStatus: "rejected",
      status: 409,
    },
    {
      code: "rejected",
      error: "operation_horizon_exceeded",
      exitCodeHint: 75,
      outboxStatus: "rejected",
      status: 410,
    },
    ...[401, 403].map((status) => ({
      code: "auth",
      error: "runner_rejected",
      exitCodeHint: 77,
      outboxStatus: "rejected",
      status,
    })),
  ];
  for (const scenario of scenarios) {
    await t.test(`${scenario.status} ${scenario.error}`, async (t) => {
      const stateDir = await temporaryState(
        t,
        "nexus-engine-complete-terminal-",
      );
      const responseText = JSON.stringify({
        error: scenario.error,
        marker: "RESPONSE_SECRET_MARKER",
      });
      const harness = await responseServer(
        t,
        async (_request, response) => {
          response.statusCode = scenario.status;
          response.setHeader("content-type", "application/json");
          response.end(responseText);
        },
      );
      const entry = await persistCompletion(
        stateDir,
        await completionFixture(),
        defaultRunId,
        defaultOperationId,
      );
      let deliveredError;
      await assert.rejects(
        deliverEngineCompletion(
          runnerContext(harness.origin),
          stateDir,
          entry,
        ),
        (error) => {
          deliveredError = error;
          return error instanceof EngineCompletionDeliveryError;
        },
      );
      assert.deepEqual(
        {
          code: deliveredError.code,
          exitCodeHint: deliveredError.exitCodeHint,
          httpStatus: deliveredError.httpStatus,
          outboxStatus: deliveredError.outboxStatus,
          serverError: deliveredError.serverError,
        },
        {
          code: scenario.code,
          exitCodeHint: scenario.exitCodeHint,
          httpStatus: scenario.status,
          outboxStatus: scenario.outboxStatus,
          serverError: scenario.error,
        },
      );
      const storedText = await readFile(
        storedPath(stateDir, defaultOperationId),
        "utf8",
      );
      const stored = JSON.parse(storedText);
      assert.equal(stored.status, scenario.outboxStatus);
      assert.equal(stored.responseStatus, scenario.status);
      assert.equal(stored.responseSha256, sha256(responseText));
      assert.equal("bodyBase64" in stored, false);
      assert.equal(storedText.includes("PRIVATE_OUTPUT_MARKER"), false);
      assert.equal(storedText.includes(privateOutputMarkerBase64), false);
      assert.equal(storedText.includes("RESPONSE_SECRET_MARKER"), false);
      assert.equal(
        JSON.stringify(deliveredError).includes("RESPONSE_SECRET_MARKER"),
        false,
      );
    });
  }
});

test("network failure stays retryable and leaves the exact entry pending", async (t) => {
  const stateDir = await temporaryState(t, "nexus-engine-complete-network-");
  const harness = await responseServer(t, async () => undefined);
  const origin = harness.origin;
  await closeServer(harness.server);
  const entry = await persistCompletion(
    stateDir,
    await completionFixture(),
    defaultRunId,
    defaultOperationId,
  );
  const before = await readFile(
    storedPath(stateDir, defaultOperationId),
    "utf8",
  );
  await assert.rejects(
    deliverEngineCompletion(runnerContext(origin), stateDir, entry),
    (error) =>
      error instanceof EngineCompletionDeliveryError &&
      error.code === "retryable" &&
      error.httpStatus === null &&
      error.outboxStatus === "pending",
  );
  assert.equal(
    await readFile(storedPath(stateDir, defaultOperationId), "utf8"),
    before,
  );
});

test("the drain continues after per-run terminal failures in deterministic order", async (t) => {
  const stateDir = await temporaryState(t, "nexus-engine-drain-continue-");
  const operation1 = `op_${"1".repeat(32)}`;
  const operation2 = `op_${"2".repeat(32)}`;
  const run1 = `run_${"1".repeat(32)}`;
  const run2 = `run_${"2".repeat(32)}`;
  const attempts = [];
  const harness = await responseServer(t, async (request, response, body) => {
    const operationId = JSON.parse(body.toString("utf8")).operationId;
    attempts.push(operationId);
    if (operationId === operation1) {
      response.statusCode = 409;
      response.end('{"error":"operation_conflict"}');
      return;
    }
    response.statusCode = 200;
    response.end(completionAck(runFromPath(request.url)));
  });
  const [entry1, entry2] = await seedTwo(
    stateDir,
    operation1,
    operation2,
    run1,
    run2,
  );
  const outcome = await drainEngineCompletionOutbox(
    runnerContext(harness.origin),
    stateDir,
    [entry2, entry1],
  );
  assert.deepEqual(attempts, [operation1, operation2]);
  assert.equal(outcome.attempted, 2);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].operationId, operation1);
  assert.equal(outcome.delivered.length, 1);
  assert.equal(outcome.delivered[0].operationId, operation2);
  assert.equal(outcome.halt, null);
  assert.equal(outcome.remainingPending, 0);
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(Object.isFrozen(outcome.failed), true);
  assert.equal(Object.isFrozen(outcome.delivered[0]), true);
  const replay = await drainEngineCompletionOutbox(
    runnerContext(harness.origin),
    stateDir,
  );
  assert.equal(replay.attempted, 0);
  assert.deepEqual(attempts, [operation1, operation2]);
});

test("the drain halts on shared pending and auth failures without touching later bytes", async (t) => {
  for (const scenario of [
    {
      code: "retryable",
      expectedFirstStatus: "pending",
      status: 500,
      body: '{"error":"run_operation_failed"}',
      remainingPending: 2,
    },
    {
      code: "protocol",
      expectedFirstStatus: "pending",
      status: 200,
      body: '{"invalid":true}',
      remainingPending: 2,
    },
    {
      code: "auth",
      expectedFirstStatus: "rejected",
      status: 403,
      body: '{"error":"runner_rejected"}',
      remainingPending: 1,
    },
  ]) {
    await t.test(scenario.code, async (t) => {
      const stateDir = await temporaryState(
        t,
        "nexus-engine-drain-halt-",
      );
      const operation1 = `op_${"1".repeat(32)}`;
      const operation2 = `op_${"2".repeat(32)}`;
      let requests = 0;
      const harness = await responseServer(
        t,
        async (_request, response) => {
          requests += 1;
          response.statusCode = scenario.status;
          response.end(scenario.body);
        },
      );
      const [entry1, entry2] = await seedTwo(
        stateDir,
        operation1,
        operation2,
        `run_${"1".repeat(32)}`,
        `run_${"2".repeat(32)}`,
      );
      const secondBefore = await readFile(
        storedPath(stateDir, operation2),
        "utf8",
      );
      const outcome = await drainEngineCompletionOutbox(
        runnerContext(harness.origin),
        stateDir,
        [entry2, entry1],
      );
      assert.equal(requests, 1);
      assert.equal(outcome.attempted, 1);
      assert.equal(outcome.delivered.length, 0);
      assert.equal(outcome.failed.length, 0);
      assert.equal(outcome.halt.code, scenario.code);
      assert.equal(
        outcome.halt.exitCodeHint,
        scenario.code === "auth"
          ? 77
          : scenario.code === "protocol"
            ? 76
            : 75,
      );
      assert.equal(outcome.remainingPending, scenario.remainingPending);
      assert.equal(
        (await readStored(stateDir, operation1)).status,
        scenario.expectedFirstStatus,
      );
      assert.equal(
        await readFile(storedPath(stateDir, operation2), "utf8"),
        secondBefore,
      );
    });
  }
});

test("invalid entries fail before network and unrelated outbox kinds remain dark", async (t) => {
  const stateDir = await temporaryState(t, "nexus-engine-complete-guard-");
  let requests = 0;
  const harness = await responseServer(t, async (_request, response) => {
    requests += 1;
    response.statusCode = 500;
    response.end();
  });
  const entry = await persistCompletion(
    stateDir,
    await completionFixture(),
    defaultRunId,
    defaultOperationId,
  );
  await assert.rejects(
    deliverEngineCompletion(
      runnerContext(harness.origin),
      stateDir,
      { ...entry, bodySha256: "0".repeat(64) },
    ),
    /pending engine completion is invalid/u,
  );
  assert.equal(requests, 0);
  await assert.rejects(
    deliverEngineCompletion(
      {
        ...runnerContext(harness.origin),
        audience: "not-an-origin",
      },
      stateDir,
      entry,
    ),
    /pending engine completion is invalid/u,
  );
  assert.equal(requests, 0);
  await assert.rejects(
    drainEngineCompletionOutbox(
      runnerContext(harness.origin),
      stateDir,
      [entry, entry],
    ),
    /drain entries are invalid/u,
  );
  assert.equal(requests, 0);

  const changed = JSON.parse(
    (await completionFixture()).toString("utf8"),
  );
  changed.receipt.finishedAt = "2026-07-26T12:00:02.000Z";
  await rm(storedPath(stateDir, defaultOperationId));
  const replacement = await persistCompletion(
    stateDir,
    Buffer.from(canonicalJson(changed)),
    defaultRunId,
    defaultOperationId,
  );
  assert.notEqual(replacement.entrySha256, entry.entrySha256);
  await assert.rejects(
    deliverEngineCompletion(
      runnerContext(harness.origin),
      stateDir,
      entry,
    ),
    /pending engine completion is invalid/u,
  );
  assert.equal(requests, 0);
  assert.equal(
    (await readStored(stateDir, defaultOperationId)).entrySha256,
    replacement.entrySha256,
  );

  const source = await readFile(
    new URL("../runner/nexus-runner.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /Declaration delivery is not enabled in this runner version/u,
  );
  assert.doesNotMatch(
    source.slice(
      source.indexOf('const command = process.argv[2]'),
      source.indexOf("async function engines"),
    ),
    /deliverEngineCompletion|drainEngineCompletionOutbox/u,
  );
  const ignored = await drainEngineCompletionOutbox(
    runnerContext(harness.origin),
    stateDir,
    [],
  );
  assert.deepEqual(ignored, {
    attempted: 0,
    delivered: [],
    failed: [],
    halt: null,
    remainingPending: 0,
  });
  assert.equal(requests, 0);
});

test("direct execution keeps the existing help and unknown-command surface", async (t) => {
  const help = await runCli(["help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /^NexusOS reference runner 0\.5\.0/u);
  assert.match(help.stdout, /nexus-runner engines report/u);
  assert.match(help.stdout, /\n {2}nexus-runner serve/u);
  assert.doesNotMatch(help.stdout, /engine-complete/u);

  const unknown = await runCli(["not-a-command"]);
  assert.equal(unknown.code, 64);
  assert.equal(unknown.stdout, "");
  assert.equal(unknown.stderr, "nexus-runner: Unknown command.\n");

  if (process.platform !== "win32") {
    const directory = await temporaryState(t, "nexus-runner-link-");
    const link = join(directory, "nexus-runner-link.mjs");
    await symlink(cli, link);
    const linked = await runNode(link, ["version"]);
    assert.equal(linked.code, 0, linked.stderr);
    assert.equal(linked.stdout, "0.5.0\n");
  }
});

async function seedTwo(
  stateDir,
  operation1,
  operation2,
  run1,
  run2,
) {
  const base = JSON.parse(
    (await completionFixture()).toString("utf8"),
  );
  const entry1 = await persistCompletion(
    stateDir,
    Buffer.from(canonicalJson({ ...base, operationId: operation1 })),
    run1,
    operation1,
  );
  const entry2 = await persistCompletion(
    stateDir,
    Buffer.from(canonicalJson({ ...base, operationId: operation2 })),
    run2,
    operation2,
  );
  return [entry1, entry2];
}

function persistCompletion(stateDir, body, runId, operationId) {
  return persistDeclarationOperation(stateDir, {
    body,
    declarationKind: "engine.complete",
    operationId,
    runId,
  });
}

async function completionFixture() {
  return Buffer.from(await fixture("engine-complete-body-v1.json"), "utf8");
}

function fixture(name) {
  return readFile(
    new URL(`./fixtures/s6-b4/${name}`, import.meta.url),
    "utf8",
  ).then((value) => value.trimEnd());
}

function runnerContext(audience) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const spki = createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  return {
    audience,
    privateKey,
    publicKey: spki.subarray(publicKeyPrefix.byteLength).toString("base64url"),
    state: { audience, runnerId },
  };
}

function verifyCompletionRequest(request, body, audience) {
  assert.equal(request.method, "POST");
  assert.equal(
    request.url,
    `/api/runs/${defaultRunId}/engine-complete`,
  );
  assert.equal(request.headers["x-nexus-runner-id"], runnerId);
  assert.equal(request.headers["content-length"], String(body.byteLength));
  const publicKey = String(request.headers["x-nexus-runner-key"] ?? "");
  const timestamp = String(request.headers["x-nexus-timestamp"] ?? "");
  const nonce = String(request.headers["x-nexus-nonce"] ?? "");
  const signature = String(request.headers["x-nexus-signature"] ?? "");
  const signed = [
    "nexus-runner-engine-complete-v1",
    runnerId,
    "POST",
    request.url,
    audience,
    timestamp,
    nonce,
    `sha256:${sha256(body)}`,
  ].join("\n");
  const key = createPublicKey({
    format: "der",
    key: Buffer.concat([
      publicKeyPrefix,
      Buffer.from(publicKey, "base64url"),
    ]),
    type: "spki",
  });
  assert.equal(
    verify(
      null,
      Buffer.from(signed, "utf8"),
      key,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(
        signed.replace(`sha256:${sha256(body)}`, `sha256:${"0".repeat(64)}`),
        "utf8",
      ),
      key,
      Buffer.from(signature, "base64url"),
    ),
    false,
  );
}

function responseServer(t, responder) {
  const server = createServer(async (request, response) => {
    try {
      const body = await requestBytes(request);
      await responder(request, response, body);
    } catch (error) {
      response.destroy(error);
    }
  });
  return listen(server).then((origin) => {
    t.after(() => closeServer(server));
    return { origin, server };
  });
}

function runCli(args) {
  return runNode(cli, args);
}

function runNode(modulePath, args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [modulePath, ...args], {
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("close", (code) => {
      resolveRun({ code, stderr, stdout });
    });
  });
}

function requestBytes(request) {
  return new Promise((resolveBytes, rejectBytes) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolveBytes(Buffer.concat(chunks)));
    request.on("error", rejectBytes);
  });
}

function listen(server) {
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveListen(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(resolveClose);
  });
}

function completionAck(runId) {
  return canonicalJson({
    late: false,
    recordedAt: "2026-07-27T12:00:05.000Z",
    runId,
    status: "completed",
  });
}

function runFromPath(pathname) {
  return pathname.split("/")[3];
}

async function temporaryState(t, prefix) {
  const stateDir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  return stateDir;
}

function storedPath(stateDir, operationId) {
  return join(
    stateDir,
    OUTBOX_V3_DIRECTORY,
    `${operationId}.json`,
  );
}

function readStored(stateDir, operationId) {
  return readFile(storedPath(stateDir, operationId), "utf8").then(JSON.parse);
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
