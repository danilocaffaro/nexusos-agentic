import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  let engineDeliveryAttempts = 0;
  const server = createServer(async (request, response) => {
    const body = await requestBytes(request);
    if (request.url?.endsWith("/engine-reports")) {
      engineDeliveryAttempts += 1;
    }
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
  await seedDarkEngineOutbox(stateDir);

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
  const beforeRecovery = await readdir(join(stateDir, "outbox-v2"));
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
  assert.equal(engineDeliveryAttempts, 0);
  const outbox = await runCli(["outbox", "--state-dir", stateDir]);
  assert.equal(outbox.code, 0, outbox.stderr);
  assert.deepEqual(
    JSON.parse(outbox.stdout).operations
      .map((operation) => operation.status)
      .sort(),
    ["acked", "acked", "pending"],
  );
  assert.deepEqual(
    JSON.parse(outbox.stdout).operations
      .map((operation) => operation.v)
      .sort(),
    [2, 2, 3],
  );
  const darkOperation = JSON.parse(outbox.stdout).operations.find(
    (operation) => operation.v === 3,
  );
  assert.equal(
    darkOperation.kind,
    "engine.report",
  );
  for (const name of (
    await readdir(join(stateDir, "outbox-v2"))
  ).filter((value) => value.endsWith(".json"))) {
    assert.equal(
      (await stat(join(stateDir, "outbox-v2", name))).mode & 0o777,
      0o600,
    );
    const text = await readFile(
      join(stateDir, "outbox-v2", name),
      "utf8",
    );
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

test("retryable claim conflicts preserve pending state and resume one operation", async (t) => {
  const runId = `run_${"9".repeat(32)}`;
  const leaseId = `lse_${"8".repeat(32)}`;
  let claimError = "runner_busy";
  let firstOperationId;
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
      firstOperationId ??= operationId;
      assert.equal(operationId, firstOperationId);
      if (claimError) {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: claimError }));
        return;
      }
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
      response.end(
        JSON.stringify({
          late: false,
          recordedAt: "2026-07-26T00:01:00.000Z",
          runId,
          status: "completed",
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(server);
  t.after(() => server.close());

  const stateDir = await mkdtemp(join(tmpdir(), "nexus-runner-busy-"));
  const enrolled = await runCli(
    [
      "enroll",
      "--server",
      server.origin,
      "--name",
      "Busy-safe runner",
      "--token-stdin",
      "--state-dir",
      stateDir,
    ],
    `${token}\n`,
  );
  assert.equal(enrolled.code, 0, enrolled.stderr);

  const blocked = await runCli(
    ["diagnose", "--run", runId, "--state-dir", stateDir],
    "",
    { NEXUS_RUNNER_TEST: "1", NEXUS_RUNNER_TEST_HOLD_MS: "10" },
  );
  assert.equal(blocked.code, 75);
  assert.match(blocked.stderr, /runner_busy/u);
  const pending = await runCli(["outbox", "--state-dir", stateDir]);
  assert.deepEqual(
    JSON.parse(pending.stdout).operations.map((entry) => entry.status),
    ["pending"],
  );

  for (const retryableError of ["runner_conflict", "conflict_retry"]) {
    claimError = retryableError;
    const retryable = await runCli(
      ["diagnose", "--run", runId, "--state-dir", stateDir],
      "",
      { NEXUS_RUNNER_TEST: "1", NEXUS_RUNNER_TEST_HOLD_MS: "10" },
    );
    assert.equal(retryable.code, 75);
    assert.match(retryable.stderr, new RegExp(retryableError, "u"));
    const stillPending = await runCli(["outbox", "--state-dir", stateDir]);
    assert.deepEqual(
      JSON.parse(stillPending.stdout).operations.map((entry) => entry.status),
      ["pending"],
    );
  }

  claimError = undefined;
  const resumed = await runCli(
    ["diagnose", "--run", runId, "--state-dir", stateDir],
    "",
    { NEXUS_RUNNER_TEST: "1", NEXUS_RUNNER_TEST_HOLD_MS: "10" },
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  const resumedOutput = resumed.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(resumedOutput[0].status, "leased");
  assert.deepEqual(resumedOutput.at(-1), {
    status: "completed",
    runId,
    fence: 1,
    late: false,
    durableReplay: true,
  });
  const converged = await runCli(["outbox", "--state-dir", stateDir]);
  assert.deepEqual(
    JSON.parse(converged.stdout).operations.map((entry) => entry.status),
    ["acked", "acked"],
  );
});

test("capability report is honest, sibling-durable and crash recoverable", async (t) => {
  const privacyMarker = "PRIVATE_PROBE_OUTPUT_MUST_NOT_ESCAPE";
  const probeRoot = await mkdtemp(join(tmpdir(), "nexus-runner-probes-"));
  t.after(() => rm(probeRoot, { recursive: true, force: true }));
  await Promise.all([
    writeProbe(
      probeRoot,
      "/usr/bin/bwrap",
      "bubblewrap 0.11.0",
    ),
    writeProbe(
      probeRoot,
      "/usr/local/bin/docker",
      "Docker version 27.5.1, build abcdef1",
    ),
    writeProbe(
      probeRoot,
      "/usr/local/bin/podman",
      `podman version 5.4.2 ${privacyMarker} /home/operator`,
    ),
    writeProbeFile(
      probeRoot,
      "/proc/self/status",
      "Name:\tnode\nSeccomp:\t2\n",
    ),
    writeProbeFile(
      probeRoot,
      "/proc/sys/user/max_user_namespaces",
      "128000\n",
    ),
    writeProbeFile(
      probeRoot,
      "/proc/sys/kernel/unprivileged_userns_clone",
      "1\n",
    ),
  ]);
  const probeEnv = {
    NEXUS_RUNNER_TEST: "1",
    NEXUS_RUNNER_TEST_PROBE_ROOT: probeRoot,
    TMPDIR: tmpdir(),
  };
  const dryStateDir = join(
    tmpdir(),
    `nexus-runner-dry-${randomBytes(8).toString("hex")}`,
  );
  const dryRun = await runCli(
    [
      "report-capabilities",
      "--dry-run",
      "--state-dir",
      dryStateDir,
    ],
    "",
    probeEnv,
  );
  assert.equal(dryRun.code, 0, dryRun.stderr);
  const baseline = JSON.parse(dryRun.stdout);
  assert.equal(baseline.capabilities.length, 7);
  assert.deepEqual(
    baseline.capabilities.find(
      (item) => item.capability === "node_permission_model",
    ),
    {
      capability: "node_permission_model",
      detection: "node_flag",
      reasonCode: "none",
      status: "available",
      version: process.version,
    },
  );
  assert.deepEqual(
    baseline.capabilities.find((item) => item.capability === "docker"),
    {
      capability: "docker",
      detection: "binary_version",
      reasonCode: "none",
      status: "available",
      version: "27.5.1",
    },
  );
  assert.deepEqual(
    baseline.capabilities.find((item) => item.capability === "landlock"),
    {
      capability: "landlock",
      detection: "none",
      reasonCode: "probe_disabled",
      status: "unknown",
    },
  );
  assert.equal(dryRun.stdout.includes(privacyMarker), false);
  assert.equal(dryRun.stderr.includes(privacyMarker), false);
  assert.equal("hostname" in baseline, false);
  await assert.rejects(stat(dryStateDir), { code: "ENOENT" });
  const disabled = await runCli(
    ["report-capabilities", "--dry-run"],
    "",
    { NEXUS_RUNNER_DISABLE_PROBES: "1" },
  );
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.equal(
    JSON.parse(disabled.stdout).capabilities.every(
      (item) =>
        item.status === "unknown" &&
        item.detection === "none" &&
        item.reasonCode === "probe_disabled" &&
        !("version" in item),
    ),
    true,
  );
  const invalidDisable = await runCli(
    ["report-capabilities", "--dry-run"],
    "",
    { NEXUS_RUNNER_DISABLE_PROBES: "true" },
  );
  assert.equal(invalidDisable.code, 64);

  const fixturePath = new URL(
    "./fixtures/s6-b3/capability-report-v1.json",
    import.meta.url,
  ).pathname;
  const forbiddenFixture = await runCli(
    ["report-capabilities", "--dry-run"],
    "",
    { NEXUS_RUNNER_TEST_REPORT_FILE: fixturePath },
  );
  assert.equal(forbiddenFixture.code, 64);
  const forbiddenProbeRoot = await runCli(
    ["report-capabilities", "--dry-run"],
    "",
    {
      NEXUS_RUNNER_DISABLE_PROBES: "1",
      NEXUS_RUNNER_TEST_PROBE_ROOT: probeRoot,
    },
  );
  assert.equal(forbiddenProbeRoot.code, 64);
  assert.match(forbiddenProbeRoot.stderr, /probe root injection is test-only/u);
  for (const invalidRoot of ["relative-probe-root", "/"]) {
    const invalidProbeRoot = await runCli(
      ["report-capabilities", "--dry-run"],
      "",
      {
        NEXUS_RUNNER_TEST: "1",
        NEXUS_RUNNER_TEST_PROBE_ROOT: invalidRoot,
      },
    );
    assert.equal(invalidProbeRoot.code, 64);
    assert.match(invalidProbeRoot.stderr, /bounded temporary path/u);
  }
  const testFixture = await runCli(
    ["report-capabilities", "--dry-run"],
    "",
    {
      NEXUS_RUNNER_TEST: "1",
      NEXUS_RUNNER_TEST_REPORT_FILE: fixturePath,
    },
  );
  assert.equal(testFixture.code, 0, testFixture.stderr);
  assert.equal(
    JSON.parse(testFixture.stdout).capabilities.some(
      (item) => item.status === "available",
    ),
    true,
  );

  const reports = new Map();
  const receivedBodies = [];
  let reportEffects = 0;
  let engineDeliveryAttempts = 0;
  const server = createServer(async (request, response) => {
    const body = await requestBytes(request);
    if (request.url?.endsWith("/engine-reports")) {
      engineDeliveryAttempts += 1;
    }
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
    if (
      request.url ===
      "/api/runners/rnr_1234567890abcdef1234567890abcdef/capability-reports"
    ) {
      assert.equal(
        request.headers["x-nexus-runner-id"],
        "rnr_1234567890abcdef1234567890abcdef",
      );
      const report = JSON.parse(body.toString("utf8"));
      assert.equal(
        report.capabilities.some(
          (item) =>
            item.capability === "docker" &&
            item.status === "available" &&
            item.version === "27.5.1",
        ),
        true,
      );
      assert.equal(body.includes(privacyMarker), false);
      receivedBodies.push(body.toString("utf8"));
      let stored = reports.get(report.reportId);
      if (!stored) {
        reportEffects += 1;
        stored = JSON.stringify({
          receivedAt: "2026-07-26T00:02:00.000Z",
          reportId: report.reportId,
        });
        reports.set(report.reportId, stored);
      } else {
        response.setHeader("x-nexus-replay", "1");
      }
      response.statusCode = 201;
      response.end(stored);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(server);
  t.after(() => server.close());
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-runner-report-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const enrolled = await runCli(
    [
      "enroll",
      "--server",
      server.origin,
      "--name",
      "Capability runner",
      "--token-stdin",
      "--state-dir",
      stateDir,
    ],
    `${token}\n`,
  );
  assert.equal(enrolled.code, 0, enrolled.stderr);
  await seedDarkEngineOutbox(stateDir);

  const crashedBeforeSend = await runCli(
    ["report-capabilities", "--state-dir", stateDir],
    "",
    {
      ...probeEnv,
      NEXUS_RUNNER_TEST_CRASH: "after-report-persist",
    },
  );
  assert.equal(crashedBeforeSend.code, 86);
  assert.equal(reportEffects, 0);
  assert.equal(
    (await readdir(join(stateDir, "outbox-v2"))).filter((name) =>
      name.endsWith(".json"),
    ).length,
    1,
  );
  assert.deepEqual(
    (await readdir(join(stateDir, "outbox"))).filter((name) =>
      name.endsWith(".json"),
    ),
    [],
  );

  const recoveredBeforeSend = await runCli([
    "report-capabilities",
    "--state-dir",
    stateDir,
  ]);
  assert.equal(recoveredBeforeSend.code, 0, recoveredBeforeSend.stderr);
  assert.equal(reportEffects, 1);
  assert.equal(JSON.parse(recoveredBeforeSend.stdout).recovered, true);

  const crashedAfterSend = await runCli(
    ["report-capabilities", "--state-dir", stateDir],
    "",
    {
      ...probeEnv,
      NEXUS_RUNNER_TEST_CRASH: "after-report-send",
    },
  );
  assert.equal(crashedAfterSend.code, 86);
  assert.equal(reportEffects, 2);

  const recoveredAfterSend = await runCli([
    "report-capabilities",
    "--state-dir",
    stateDir,
  ]);
  assert.equal(recoveredAfterSend.code, 0, recoveredAfterSend.stderr);
  assert.deepEqual(
    {
      recovered: JSON.parse(recoveredAfterSend.stdout).recovered,
      replay: JSON.parse(recoveredAfterSend.stdout).replay,
    },
    { recovered: true, replay: true },
  );
  assert.equal(reportEffects, 2);
  assert.equal(receivedBodies.at(-1), receivedBodies.at(-2));
  assert.equal(engineDeliveryAttempts, 0);

  const outboxNames = (await readdir(join(stateDir, "outbox-v2"))).filter(
    (name) => name.endsWith(".json"),
  );
  assert.equal(outboxNames.length, 2);
  for (const name of outboxNames) {
    const entry = JSON.parse(
      await readFile(join(stateDir, "outbox-v2", name), "utf8"),
    );
    assert.equal(entry.v, 2);
    assert.equal(entry.kind, "capability.report");
    assert.equal(entry.status, "acked");
    assert.equal("pathname" in entry, false);
    assert.equal(
      Buffer.from(entry.bodyBase64, "base64url")
        .toString("utf8")
        .includes(privacyMarker),
      false,
    );
  }
  const inspected = await runCli(["outbox", "--state-dir", stateDir]);
  assert.equal(inspected.code, 0, inspected.stderr);
  const dark = JSON.parse(inspected.stdout).operations.find(
    (operation) => operation.v === 3,
  );
  assert.deepEqual(
    { kind: dark.kind, status: dark.status },
    { kind: "engine.report", status: "pending" },
  );
});

async function seedDarkEngineOutbox(stateDir) {
  const directory = join(stateDir, "outbox-v3");
  await mkdir(join(directory, "corrupt"), {
    recursive: true,
    mode: 0o700,
  });
  const fixture = await readFile(
    new URL(
      "./fixtures/s6-b4/outbox-v3-engine-report.json",
      import.meta.url,
    ),
  );
  await writeFile(
    join(directory, `op_${"7".repeat(32)}.json`),
    fixture,
    { mode: 0o600 },
  );
}

async function writeProbe(root, path, line) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    `#!/bin/sh\nprintf '%s\\n' '${line}'\n`,
    { mode: 0o700 },
  );
  await chmod(target, 0o700);
}

async function writeProbeFile(root, path, contents) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, { mode: 0o600 });
}

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
    : request.url.endsWith("/capability-reports")
      ? "nexus-runner-capability-report-v1"
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
