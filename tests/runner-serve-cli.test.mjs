import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  finalizeAttemptRecord,
  parseAttemptRecordText,
} from "../runner/attempt-journal-contract.mjs";
import {
  persistAttemptRecord,
  recoverAttemptJournals,
} from "../runner/attempt-journal-store.mjs";
import {
  deriveEngineCompletionOperationId,
} from "../runner/engine-attempt-coordinator.mjs";
import {
  recoverOutbox,
} from "../runner/durable-outbox.mjs";

const cli = fileURLToPath(
  new URL("../runner/nexus-runner.mjs", import.meta.url),
);
const publicKeyPrefix = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const runnerId = `rnr_${"1".repeat(32)}`;
const token = randomBytes(32).toString("base64url");

test("serve heartbeats beside recovery, owns one lock and stops cleanly", async (t) => {
  const requests = [];
  const harness = await serverHarness(t, async (request, response, body) => {
    requests.push(request.url);
    verifySignedRequest(request, body, harness.origin);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/runners/enroll") {
      response.end(JSON.stringify(enrollment()));
      return;
    }
    if (request.url === `/api/runners/${runnerId}/heartbeat`) {
      response.end(JSON.stringify({
        nextHeartbeatSeconds: 30,
        observedAt: "2026-07-28T13:00:00.000Z",
        status: "active",
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const stateDir = await enrolledState(t, harness.origin);
  const child = spawn(process.execPath, [
    cli,
    "serve",
    "--state-dir",
    stateDir,
    "--interval-seconds",
    "10",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectChild(child);
  await output.waitFor((lines) =>
    lines.some((line) => parseLine(line)?.status === "heartbeat")
  );

  const locked = await runCli(["outbox", "--state-dir", stateDir]);
  assert.equal(locked.code, 3);
  assert.match(locked.stderr, /Another runner process/u);
  child.kill("SIGTERM");
  const result = await output.done;
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(events[0].status, "started");
  assert.deepEqual(events[0].loops, ["heartbeat", "recovery"]);
  assert.equal(events.some((event) => event.status === "recovery"), true);
  assert.equal(events.some((event) => event.status === "heartbeat"), true);
  assert.deepEqual(events.at(-1), {
    exitCode: 0,
    heartbeatFailures: 0,
    reason: "stop_requested",
    recoveryFailures: 0,
    releaseDisposition: "released",
    status: "stopped",
  });
  await assert.rejects(stat(join(stateDir, "outbox.lock")), {
    code: "ENOENT",
  });
  assert.equal(requests.some((value) => /claim|prompt/u.test(value)), false);
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
});

test("serve crosses the real effect-only cycle and durably settles completion", async (t) => {
  const identity = "0".repeat(31) + "1";
  const runId = `run_${identity}`;
  const operationId = deriveEngineCompletionOperationId(
    `att_${identity}`,
  );
  let completionRequests = 0;
  let markCompletionStarted;
  let releaseCompletion;
  const completionStarted = new Promise((resolve) => {
    markCompletionStarted = resolve;
  });
  const completionGate = new Promise((resolve) => {
    releaseCompletion = resolve;
  });
  const harness = await serverHarness(t, async (request, response, body) => {
    verifySignedRequest(request, body, harness.origin);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/runners/enroll") {
      response.end(JSON.stringify(enrollment()));
      return;
    }
    if (request.url === `/api/runners/${runnerId}/heartbeat`) {
      response.end(JSON.stringify({
        nextHeartbeatSeconds: 30,
        observedAt: "2026-07-28T13:00:00.000Z",
        status: "active",
      }));
      return;
    }
    if (request.url === `/api/runs/${runId}/engine-complete`) {
      completionRequests += 1;
      markCompletionStarted();
      await completionGate;
      assert.equal(
        request.headers["x-nexus-runner-id"],
        runnerId,
      );
      response.end(JSON.stringify({
        late: false,
        recordedAt: "2026-07-28T13:00:01.000Z",
        runId,
        status: "completed",
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const stateDir = await enrolledState(t, harness.origin);
  await seedGeneratedJournal(stateDir, 1);
  const child = spawn(process.execPath, [
    cli,
    "serve",
    "--state-dir",
    stateDir,
    "--interval-seconds",
    "10",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectChild(child);
  await withTimeout(completionStarted, 2_000);
  child.kill("SIGTERM");
  releaseCompletion();
  const result = await output.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(completionRequests, 1);
  const [entry] = await recoverOutbox(stateDir);
  assert.equal(entry.operationId, operationId);
  assert.equal(entry.status, "acked");
  assert.equal(entry.responseStatus, 200);
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.equal(attempt.records.settled.operationId, operationId);
  assert.equal(attempt.records.settled.outcome, "acked");
  assert.equal(result.stdout.includes(bodyMarker()), false);
});

test("serve exits 77 after heartbeat authentication rejection and releases", async (t) => {
  let enrolled = false;
  const harness = await serverHarness(t, async (request, response, body) => {
    verifySignedRequest(request, body, harness.origin);
    response.setHeader("content-type", "application/json");
    if (!enrolled && request.url === "/api/runners/enroll") {
      enrolled = true;
      response.end(JSON.stringify(enrollment()));
      return;
    }
    response.statusCode = 403;
    response.end('{"error":"runner_rejected"}');
  });
  const stateDir = await enrolledState(t, harness.origin);
  const result = await runCli([
    "serve",
    "--state-dir",
    stateDir,
    "--interval-seconds",
    "10",
  ]);
  assert.equal(result.code, 77, result.stderr);
  assert.match(result.stderr, /authentication was rejected/u);
  assert.doesNotMatch(result.stderr, /stopped safely/u);
  const events = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(events.at(-1).exitCode, 77);
  assert.equal(events.at(-1).releaseDisposition, "released");
  await assert.rejects(stat(join(stateDir, "outbox.lock")), {
    code: "ENOENT",
  });
});

test("durable completion auth rejection retains a stale lock until next owner", async (t) => {
  const identity = "0".repeat(31) + "1";
  const runId = `run_${identity}`;
  const operationId = deriveEngineCompletionOperationId(
    `att_${identity}`,
  );
  let markCompletionStarted;
  let releaseCompletion;
  const completionStarted = new Promise((resolve) => {
    markCompletionStarted = resolve;
  });
  const completionGate = new Promise((resolve) => {
    releaseCompletion = resolve;
  });
  const harness = await serverHarness(t, async (request, response, body) => {
    verifySignedRequest(request, body, harness.origin);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/runners/enroll") {
      response.end(JSON.stringify(enrollment()));
      return;
    }
    if (request.url === `/api/runners/${runnerId}/heartbeat`) {
      response.end(JSON.stringify({
        nextHeartbeatSeconds: 30,
        observedAt: "2026-07-28T13:00:00.000Z",
        status: "active",
      }));
      return;
    }
    if (request.url === `/api/runs/${runId}/engine-complete`) {
      markCompletionStarted();
      await completionGate;
      response.statusCode = 403;
      response.end('{"error":"runner_rejected"}');
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const stateDir = await enrolledState(t, harness.origin);
  await seedGeneratedJournal(stateDir, 1);
  const child = spawn(process.execPath, [
    cli,
    "serve",
    "--state-dir",
    stateDir,
    "--interval-seconds",
    "10",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectChild(child);
  await withTimeout(completionStarted, 2_000);
  child.kill("SIGTERM");
  releaseCompletion();
  const result = await output.done;
  assert.equal(result.code, 77, result.stderr);
  assert.match(result.stderr, /durably rejected/u);
  const events = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.at(-1), {
    exitCode: 77,
    heartbeatFailures: 0,
    reason: "durable_auth_rejected",
    recoveryFailures: 0,
    releaseDisposition: "retained",
    status: "stopped",
  });
  assert.equal((await stat(join(stateDir, "outbox.lock"))).isFile(), true);

  const recoveredOwner = await runCli(["outbox", "--state-dir", stateDir]);
  assert.equal(recoveredOwner.code, 0, recoveredOwner.stderr);
  const [entry] = await recoverOutbox(stateDir);
  assert.equal(entry.operationId, operationId);
  assert.equal(entry.status, "rejected");
  assert.equal(entry.responseStatus, 403);
  const [attempt] = await recoverAttemptJournals(stateDir);
  assert.equal(attempt.records.settled.outcome, "rejected");
  await assert.rejects(stat(join(stateDir, "outbox.lock")), {
    code: "ENOENT",
  });
});

test("abrupt serve death leaves a stale pid lock that the next owner recovers", async (t) => {
  const harness = await serverHarness(t, async (request, response, body) => {
    verifySignedRequest(request, body, harness.origin);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/runners/enroll") {
      response.end(JSON.stringify(enrollment()));
      return;
    }
    response.end(JSON.stringify({
      nextHeartbeatSeconds: 30,
      observedAt: "2026-07-28T13:00:00.000Z",
      status: "active",
    }));
  });
  const stateDir = await enrolledState(t, harness.origin);
  const child = spawn(process.execPath, [
    cli,
    "serve",
    "--state-dir",
    stateDir,
    "--interval-seconds",
    "10",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectChild(child);
  await output.waitFor((lines) =>
    lines.some((line) => parseLine(line)?.status === "started")
  );
  child.kill("SIGKILL");
  const killed = await output.done;
  assert.equal(killed.signal, "SIGKILL");
  assert.equal((await stat(join(stateDir, "outbox.lock"))).isFile(), true);

  const recovered = await runCli(["outbox", "--state-dir", stateDir]);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).status, "outbox");
  await assert.rejects(stat(join(stateDir, "outbox.lock")), {
    code: "ENOENT",
  });
});

test("serve CLI validates its exact public options before lock acquisition", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-serve-usage-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  for (const value of ["9", "301", "010", "ten"]) {
    const result = await runCli([
      "serve",
      "--state-dir",
      stateDir,
      "--interval-seconds",
      value,
    ]);
    assert.equal(result.code, 64);
    assert.match(result.stderr, /integer from 10 to 300/u);
  }
  const unknown = await runCli([
    "serve",
    "--state-dir",
    stateDir,
    "--claim",
    "yes",
  ]);
  assert.equal(unknown.code, 64);
  assert.match(unknown.stderr, /Unsupported command option/u);
  await assert.rejects(stat(join(stateDir, "outbox.lock")), {
    code: "ENOENT",
  });
});

test("serve preserves actionable configuration diagnostics", async (t) => {
  const harness = await serverHarness(t, async (request, response, body) => {
    verifySignedRequest(request, body, harness.origin);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/runners/enroll") {
      response.end(JSON.stringify(enrollment()));
      return;
    }
    response.statusCode = 500;
    response.end();
  });
  const stateDir = await enrolledState(t, harness.origin);
  const result = await runCli([
    "serve",
    "--server",
    "http://127.0.0.1:1",
    "--state-dir",
    stateDir,
    "--interval-seconds",
    "10",
  ]);
  assert.equal(result.code, 64, result.stderr);
  assert.match(
    result.stderr,
    /configuration does not match the enrolled runner/u,
  );
  assert.doesNotMatch(result.stderr, /stopped safely/u);
  await assert.rejects(stat(join(stateDir, "outbox.lock")), {
    code: "ENOENT",
  });
});

async function enrolledState(t, origin) {
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-serve-cli-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const result = await runCli(
    [
      "enroll",
      "--server",
      origin,
      "--name",
      "Serve runner",
      "--token-stdin",
      "--state-dir",
      stateDir,
    ],
    `${token}\n`,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    (await readFile(join(stateDir, "runner.json"), "utf8")).includes(token),
    false,
  );
  return stateDir;
}

function enrollment() {
  return {
    enrolledAt: "2026-07-28T12:59:00.000Z",
    organizationId: "org-local",
    principalId: `prn_${"2".repeat(32)}`,
    runnerId,
    trustProfile: "operator_trust",
  };
}

async function serverHarness(t, responder) {
  const server = createServer(async (request, response) => {
    try {
      const body = await requestBytes(request);
      await responder(request, response, body);
    } catch (error) {
      response.destroy(error);
    }
  });
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", resolve)
  );
  const address = server.address();
  server.origin = `http://127.0.0.1:${address.port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

function verifySignedRequest(request, body, audience) {
  const publicKey = String(request.headers["x-nexus-runner-key"] ?? "");
  const timestamp = String(request.headers["x-nexus-timestamp"] ?? "");
  const nonce = String(request.headers["x-nexus-nonce"] ?? "");
  const signature = String(request.headers["x-nexus-signature"] ?? "");
  const engineComplete = request.url?.endsWith("/engine-complete");
  const domain = request.url === "/api/runners/enroll"
    ? "nexus-runner-enroll-v1"
    : engineComplete
      ? "nexus-runner-engine-complete-v1"
      : "nexus-runner-heartbeat-v1";
  const keyId = engineComplete
    ? String(request.headers["x-nexus-runner-id"] ?? "")
    : null;
  const hash = awaitHash(body);
  const signed = [
    domain,
    ...(keyId ? [keyId] : []),
    "POST",
    request.url,
    audience,
    timestamp,
    nonce,
    `sha256:${hash}`,
  ].join("\n");
  const raw = Buffer.from(publicKey, "base64url");
  assert.equal(
    verify(
      null,
      Buffer.from(signed),
      createPublicKey({
        format: "der",
        key: Buffer.concat([publicKeyPrefix, raw]),
        type: "spki",
      }),
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
}

async function seedGeneratedJournal(stateDir, index) {
  const identity = index.toString(16).padStart(32, "0");
  const attemptId = `att_${identity}`;
  const runId = `run_${identity}`;
  const engine = "claude_code_cli";
  const claimOperationId = `op_${identity}`;
  const records = {
    claimed: finalizeAttemptRecord({
      attemptId,
      claimBodySha256: createHash("sha256")
        .update(canonicalJson({ engine, operationId: claimOperationId }))
        .digest("hex"),
      claimOperationId,
      createdAt: "2026-07-27T12:00:00.000Z",
      engine,
      runId,
      state: "claimed",
      v: 1,
    }),
  };
  for (const state of [
    "starting",
    "spawning",
    "supervisor",
    "started",
    "result",
  ]) {
    const source = parseAttemptRecordText(
      await readFile(
        new URL(
          `./fixtures/s6-b4/attempt-${state}-v1.json`,
          import.meta.url,
        ),
        "utf8",
      ),
      state,
    );
    const value = { ...source };
    delete value.recordSha256;
    records[state] = finalizeAttemptRecord({
      ...value,
      attemptId,
      ...(state === "starting" ? { runId } : {}),
    });
  }
  for (const state of [
    "claimed",
    "starting",
    "spawning",
    "supervisor",
    "started",
    "result",
  ]) {
    await persistAttemptRecord(stateDir, records[state]);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

function bodyMarker() {
  return "RkFLRV9FTkdJTkVfT1VUUFVUCg";
}

function awaitHash(body) {
  return createHash("sha256").update(body).digest("hex");
}

function requestBytes(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function runCli(args, stdin = "") {
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(stdin);
  return collectChild(child).done;
}

function collectChild(child) {
  let stdout = "";
  let stderr = "";
  const waiters = new Set();
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    for (const waiter of waiters) waiter();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const done = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      for (const waiter of waiters) waiter();
      resolve({ code, signal, stderr, stdout });
    });
  });
  return {
    done,
    async waitFor(predicate) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const lines = stdout.trim().split("\n").filter(Boolean);
        if (predicate(lines)) return;
        await new Promise((resolve) => {
          const wake = () => {
            waiters.delete(wake);
            resolve();
          };
          waiters.add(wake);
          setTimeout(wake, 25);
        });
      }
      assert.fail(`Timed out waiting for serve output: ${stdout}\n${stderr}`);
    },
  };
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function withTimeout(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Completion did not start.")),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
