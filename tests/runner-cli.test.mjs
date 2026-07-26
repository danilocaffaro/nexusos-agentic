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
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const cli = new URL("../runner/nexus-runner.mjs", import.meta.url).pathname;
const publicKeyPrefix = Buffer.from("302a300506032b6570032100", "hex");
const token = randomBytes(32).toString("base64url");

test("enrolls, protects secrets, recovers a lost response, and heartbeats", async (t) => {
  const requests = [];
  let dropFirstRecovery = true;
  const server = createServer(async (request, response) => {
    const body = await requestBytes(request);
    const publicKey = String(request.headers["x-nexus-runner-key"] ?? "");
    verifySignedRequest({ request, body, publicKey, audience: server.origin });
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      publicKey,
      body: body.toString("utf8"),
    });

    if (request.url === "/api/runners/enroll") {
      const parsed = JSON.parse(body.toString("utf8"));
      if (parsed.displayName === "Recoverable runner" && dropFirstRecovery) {
        dropFirstRecovery = false;
        request.socket.destroy();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          runnerId: "rnr_1234567890abcdef1234567890abcdef",
          principalId: "prn_1234567890abcdef1234567890abcdef",
          organizationId: "org-local",
          enrolledAt: "2026-07-26T00:00:00.000Z",
          trustProfile: "operator_trust",
        }),
      );
      return;
    }
    if (
      request.url ===
      "/api/runners/rnr_1234567890abcdef1234567890abcdef/heartbeat"
    ) {
      assert.equal(body.toString("utf8"), "{}");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          status: "active",
          observedAt: "2026-07-26T00:00:30.000Z",
          nextHeartbeatSeconds: 30,
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(server);
  t.after(() => server.close());

  const stateDir = await mkdtemp(join(tmpdir(), "nexus-runner-recovery-"));
  const enrollArgs = [
    "enroll",
    "--server",
    server.origin,
    "--name",
    "Recoverable runner",
    "--token-stdin",
    "--state-dir",
    stateDir,
  ];
  const ambiguous = await runCli(enrollArgs, `${token}\n`);
  assert.equal(ambiguous.code, 75);
  assert.match(ambiguous.stderr, /outcome is unknown/u);
  assert.equal(ambiguous.stdout.includes(token), false);
  assert.equal(ambiguous.stderr.includes(token), false);
  const stagedPublicKey = requests[0].publicKey;
  assert.equal((await stat(join(stateDir, "identity.pk8"))).mode & 0o777, 0o600);
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);

  const recovered = await runCli(enrollArgs, `${token}\n`);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(requests[1].publicKey, stagedPublicKey);
  assert.equal(recovered.stdout.includes(token), false);
  const stateText = await readFile(join(stateDir, "runner.json"), "utf8");
  assert.equal(stateText.includes(token), false);
  assert.equal((await stat(join(stateDir, "runner.json"))).mode & 0o777, 0o600);

  const heartbeat = await runCli([
    "heartbeat",
    "--state-dir",
    stateDir,
  ]);
  assert.equal(heartbeat.code, 0, heartbeat.stderr);
  assert.deepEqual(JSON.parse(heartbeat.stdout), {
    status: "heartbeat",
    runnerId: "rnr_1234567890abcdef1234567890abcdef",
    observedAt: "2026-07-26T00:00:30.000Z",
    nextHeartbeatSeconds: 30,
    replay: false,
  });
  assert.equal(requests[2].authorization, undefined);
  assert.equal(requests[0].url.includes(token), false);
  assert.equal(requests[0].authorization, `Bearer ${token}`);
});

test("removes a staged key after a definitive server rejection", async (t) => {
  const server = createServer(async (request, response) => {
    await requestBytes(request);
    response.statusCode = 403;
    response.end('{"error":"enrollment_rejected"}');
  });
  await listen(server);
  t.after(() => server.close());
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-runner-rejected-"));
  const result = await runCli(
    [
      "enroll",
      "--server",
      server.origin,
      "--name",
      "Rejected runner",
      "--token-stdin",
      "--state-dir",
      stateDir,
    ],
    `${token}\n`,
  );
  assert.equal(result.code, 77);
  assert.match(result.stderr, /staged identity was removed/u);
  await assert.rejects(stat(join(stateDir, "identity.pk8")), {
    code: "ENOENT",
  });
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
});

test("preserves a recovery key when a retry is definitively rejected", async (t) => {
  let attempts = 0;
  const server = createServer(async (request, response) => {
    await requestBytes(request);
    attempts += 1;
    if (attempts === 1) {
      request.socket.destroy();
      return;
    }
    response.statusCode = 403;
    response.end('{"error":"enrollment_rejected"}');
  });
  await listen(server);
  t.after(() => server.close());
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-runner-retained-"));
  const args = [
    "enroll",
    "--server",
    server.origin,
    "--name",
    "Retained runner",
    "--token-stdin",
    "--state-dir",
    stateDir,
  ];
  const ambiguous = await runCli(args, `${token}\n`);
  assert.equal(ambiguous.code, 75);
  const keyBefore = await readFile(join(stateDir, "identity.pk8"));

  const rejected = await runCli(args, `${token}\n`);
  assert.equal(rejected.code, 77);
  assert.match(rejected.stderr, /recovery identity was preserved/u);
  assert.deepEqual(
    await readFile(join(stateDir, "identity.pk8")),
    keyBefore,
  );
});

test("does not expose a token argument or permit non-TLS remote origins", async () => {
  const tokenArgument = await runCli([
    "enroll",
    "--server",
    "http://localhost:3001",
    "--name",
    "Unsafe runner",
    "--token",
    token,
  ]);
  assert.equal(tokenArgument.code, 64);
  assert.match(tokenArgument.stderr, /Token arguments are intentionally unsupported/u);
  assert.equal(tokenArgument.stderr.includes(token), false);

  const equalsTokenArgument = await runCli([
    "enroll",
    "--token=" + token,
  ]);
  assert.equal(equalsTokenArgument.code, 64);
  assert.equal(equalsTokenArgument.stderr.includes(token), false);

  const positionalToken = await runCli(["enroll", token]);
  assert.equal(positionalToken.code, 64);
  assert.equal(positionalToken.stderr.includes(token), false);

  const remoteHttp = await runCli(
    [
      "enroll",
      "--server",
      "http://example.com",
      "--name",
      "Unsafe runner",
      "--token-stdin",
    ],
    `${token}\n`,
  );
  assert.equal(remoteHttp.code, 64);
  assert.match(remoteHttp.stderr, /HTTPS origin/u);
});

test("bounds a chunked enrollment response and retains the recovery key", async (t) => {
  const server = createServer(async (request, response) => {
    await requestBytes(request);
    response.setHeader("content-type", "application/json");
    response.write('{"padding":"');
    response.write("x".repeat(70 * 1_024));
    response.end('"}');
  });
  await listen(server);
  t.after(() => server.close());
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-runner-bounded-"));
  const result = await runCli(
    [
      "enroll",
      "--server",
      server.origin,
      "--name",
      "Bounded runner",
      "--token-stdin",
      "--state-dir",
      stateDir,
    ],
    `${token}\n`,
  );
  assert.equal(result.code, 76);
  assert.match(result.stderr, /response exceeds the runner limit/u);
  assert.equal((await stat(join(stateDir, "identity.pk8"))).isFile(), true);
});

test("diagnostic outbox survives a post-effect crash and replays once", async (t) => {
  const runId = `run_${"1".repeat(32)}`;
  const leaseId = `lse_${"2".repeat(32)}`;
  const seenOperations = new Map();
  let renewals = 0;
  let completionEffects = 0;
  const server = createServer(async (request, response) => {
    const body = await requestBytes(request);
    const publicKey = String(request.headers["x-nexus-runner-key"] ?? "");
    verifySignedRequest({ request, body, publicKey, audience: server.origin });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/runners/enroll") {
      response.end(
        JSON.stringify({
          runnerId: "rnr_1234567890abcdef1234567890abcdef",
          principalId: "prn_1234567890abcdef1234567890abcdef",
          organizationId: "org-local",
          enrolledAt: "2026-07-26T00:00:00.000Z",
          trustProfile: "operator_trust",
        }),
      );
      return;
    }
    if (request.url === `/api/runs/${runId}/lease/claim`) {
      const { operationId } = JSON.parse(body.toString("utf8"));
      const stored = seenOperations.get(operationId);
      if (stored) response.setHeader("x-nexus-replay", "1");
      const payload =
        stored ??
        JSON.stringify({
          cancelRequested: false,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          fence: 1,
          leaseId,
          runId,
        });
      seenOperations.set(operationId, payload);
      response.end(payload);
      return;
    }
    if (request.url === `/api/runs/${runId}/lease/renew`) {
      renewals += 1;
      response.end(
        JSON.stringify({
          cancelRequested: false,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          fence: 1,
          leaseId,
          runId,
        }),
      );
      return;
    }
    if (request.url === `/api/runs/${runId}/complete`) {
      const { operationId } = JSON.parse(body.toString("utf8"));
      const stored = seenOperations.get(operationId);
      if (stored) {
        response.setHeader("x-nexus-replay", "1");
      } else {
        completionEffects += 1;
      }
      const payload =
        stored ??
        JSON.stringify({
          late: false,
          recordedAt: "2026-07-26T00:01:00.000Z",
          runId,
          status: "completed",
        });
      seenOperations.set(operationId, payload);
      response.end(payload);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(server);
  t.after(() => server.close());
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-runner-outbox-"));
  const enrolled = await runCli(
    [
      "enroll",
      "--server",
      server.origin,
      "--name",
      "Durable runner",
      "--token-stdin",
      "--state-dir",
      stateDir,
    ],
    `${token}\n`,
  );
  assert.equal(enrolled.code, 0, enrolled.stderr);

  const crashed = await runCli(
    ["diagnose", "--run", runId, "--state-dir", stateDir],
    "",
    {
      NEXUS_RUNNER_TEST: "1",
      NEXUS_RUNNER_TEST_HOLD_MS: "70",
      NEXUS_RUNNER_TEST_RENEW_MS: "20",
      NEXUS_RUNNER_TEST_CRASH: "after-complete-send",
    },
  );
  assert.equal(crashed.code, 86);
  assert.match(crashed.stderr, /test crash at after-complete-send/u);
  assert.ok(renewals >= 2);
  assert.equal(completionEffects, 1);
  const beforeRecovery = await readdir(join(stateDir, "outbox"));
  assert.equal(
    beforeRecovery.filter((name) => name.endsWith(".json")).length,
    2,
  );

  const recovered = await runCli(
    ["diagnose", "--run", runId, "--state-dir", stateDir],
    "",
    { NEXUS_RUNNER_TEST: "1" },
  );
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.deepEqual(JSON.parse(recovered.stdout), {
    status: "completed",
    runId,
    durableReplay: true,
    recovered: true,
  });
  assert.equal(completionEffects, 1);
  const outbox = await runCli(["outbox", "--state-dir", stateDir]);
  assert.equal(outbox.code, 0, outbox.stderr);
  assert.deepEqual(
    JSON.parse(outbox.stdout).operations.map((operation) => operation.status),
    ["acked", "acked"],
  );
  for (const name of (await readdir(join(stateDir, "outbox"))).filter((value) =>
    value.endsWith(".json"),
  )) {
    assert.equal(
      (await stat(join(stateDir, "outbox", name))).mode & 0o777,
      0o600,
    );
    const text = await readFile(join(stateDir, "outbox", name), "utf8");
    assert.equal(text.includes(token), false);
    assert.equal(text.includes("PRIVATE KEY"), false);
  }

  const corruptId = `op_${"f".repeat(32)}`;
  await writeFile(
    join(stateDir, "outbox", `${corruptId}.json`),
    '{"v":1,"broken":true}\n',
    { mode: 0o600 },
  );
  const quarantined = await runCli(["outbox", "--state-dir", stateDir]);
  assert.equal(quarantined.code, 0, quarantined.stderr);
  assert.match(quarantined.stderr, /quarantined corrupt outbox entry/u);
  assert.ok(
    (await readdir(join(stateDir, "outbox", "corrupt"))).some((name) =>
      name.startsWith(`${corruptId}.json.`),
    ),
  );

  await writeFile(
    join(stateDir, "outbox.lock"),
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  const locked = await runCli(["outbox", "--state-dir", stateDir]);
  assert.equal(locked.code, 3);
  assert.match(locked.stderr, /Another runner process/u);
  await unlink(join(stateDir, "outbox.lock"));
});

function verifySignedRequest({ request, body, publicKey, audience }) {
  assert.equal(request.method, "POST");
  assert.equal(request.headers["content-length"], String(body.byteLength));
  const timestamp = String(request.headers["x-nexus-timestamp"] ?? "");
  const nonce = String(request.headers["x-nexus-nonce"] ?? "");
  const signature = String(request.headers["x-nexus-signature"] ?? "");
  assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.match(nonce, /^[A-Za-z0-9_-]{22}$/u);
  assert.match(publicKey, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(signature, /^[A-Za-z0-9_-]{86}$/u);
  const domain = request.url.endsWith("/heartbeat")
    ? "nexus-runner-heartbeat-v1"
    : request.url.endsWith("/lease/claim")
      ? "nexus-runner-lease-claim-v1"
      : request.url.endsWith("/lease/renew")
        ? "nexus-runner-lease-renew-v1"
        : request.url.endsWith("/complete")
          ? "nexus-runner-run-complete-v1"
          : "nexus-runner-enroll-v1";
  const keyId = String(request.headers["x-nexus-runner-id"] ?? "");
  const bodyHash = createHash("sha256").update(body);
  const signed = [
    domain,
    ...(keyId ? [keyId] : []),
    "POST",
    request.url,
    audience,
    timestamp,
    nonce,
    `sha256:${bodyHash.digest("hex")}`,
  ].join("\n");
  const key = createPublicKey({
    key: Buffer.concat([
      publicKeyPrefix,
      Buffer.from(publicKey, "base64url"),
    ]),
    type: "spki",
    format: "der",
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
}

async function requestBytes(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      server.origin = `http://127.0.0.1:${address.port}`;
      resolveListen();
    });
  });
}

function runCli(args, input = "", extraEnv = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
