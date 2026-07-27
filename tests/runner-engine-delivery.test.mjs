import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

const cli = new URL("../runner/nexus-runner.mjs", import.meta.url).pathname;
const publicKeyPrefix = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const runnerId = "rnr_1234567890abcdef1234567890abcdef";

test("engine delivery acknowledges, scrubs and suppresses an unchanged report", async (t) => {
  const fixture = await safeFixture(t);
  const harness = await nexusServer(t);
  await enroll(fixture, harness.origin);

  const first = await report(fixture);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(
    {
      status: JSON.parse(first.stdout).status,
      recovered: JSON.parse(first.stdout).recovered,
      replaced: JSON.parse(first.stdout).replaced,
    },
    { status: "reported", recovered: false, replaced: false },
  );
  assert.equal(harness.engineAttempts.length, 1);
  assert.equal(harness.effects.size, 1);
  const entries = await engineEntries(fixture.stateDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "acked");
  assert.equal("bodyBase64" in entries[0], false);
  assert.equal("response" in entries[0], false);
  assert.equal("responseSha256" in entries[0], true);
  assert.equal(
    (await stat(
      join(fixture.stateDir, "engine-report-state.json"),
    )).mode & 0o777,
    0o600,
  );

  const second = await report(fixture);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, "suppressed");
  assert.equal(harness.engineAttempts.length, 1);
  assert.equal((await engineEntries(fixture.stateDir)).length, 1);
});

test("engine delivery recovers every crash boundary without losing truth", async (t) => {
  await t.test("post-persist resumes the durable body", async (t) => {
    const fixture = await safeFixture(t);
    const harness = await nexusServer(t);
    await enroll(fixture, harness.origin);
    const crashed = await report(fixture, {
      NEXUS_RUNNER_TEST: "1",
      NEXUS_RUNNER_TEST_CRASH: "after-engine-report-persist",
    });
    assert.equal(crashed.code, 86);
    assert.equal(harness.engineAttempts.length, 0);
    assert.equal((await engineEntries(fixture.stateDir))[0].status, "pending");

    const recovered = await report(fixture);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).recovered, true);
    assert.equal(harness.engineAttempts.length, 1);
  });

  await t.test("post-send replays the exact body effect-once", async (t) => {
    const fixture = await safeFixture(t);
    const harness = await nexusServer(t);
    await enroll(fixture, harness.origin);
    const crashed = await report(fixture, {
      NEXUS_RUNNER_TEST: "1",
      NEXUS_RUNNER_TEST_CRASH: "after-engine-report-send",
    });
    assert.equal(crashed.code, 86);
    assert.equal(harness.engineAttempts.length, 1);
    assert.equal(harness.effects.size, 1);
    assert.equal((await engineEntries(fixture.stateDir))[0].status, "pending");

    const recovered = await report(fixture);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).recovered, true);
    assert.equal(JSON.parse(recovered.stdout).replay, true);
    assert.equal(harness.engineAttempts.length, 2);
    assert.equal(harness.effects.size, 1);
    assert.equal(
      harness.engineAttempts[0].body,
      harness.engineAttempts[1].body,
    );
  });

  await t.test("post-ack may duplicate early but never suppresses undelivered work", async (t) => {
    const fixture = await safeFixture(t);
    const harness = await nexusServer(t);
    await enroll(fixture, harness.origin);
    const crashed = await report(fixture, {
      NEXUS_RUNNER_TEST: "1",
      NEXUS_RUNNER_TEST_CRASH: "after-engine-report-ack",
    });
    assert.equal(crashed.code, 86);
    assert.equal((await engineEntries(fixture.stateDir))[0].status, "acked");
    await assert.rejects(
      stat(join(fixture.stateDir, "engine-report-state.json")),
      { code: "ENOENT" },
    );

    const retried = await report(fixture);
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal(JSON.parse(retried.stdout).recovered, false);
    assert.equal(harness.engineAttempts.length, 2);
    assert.equal(harness.effects.size, 2);
    assert.notEqual(
      harness.engineAttempts[0].report.reportId,
      harness.engineAttempts[1].report.reportId,
    );
  });
});

test("a changed local declaration abandons pending bytes before fresh delivery", async (t) => {
  const fixture = await safeFixture(t);
  const harness = await nexusServer(t);
  await enroll(fixture, harness.origin);
  const crashed = await report(fixture, {
    NEXUS_RUNNER_TEST: "1",
    NEXUS_RUNNER_TEST_CRASH: "after-engine-report-persist",
  });
  assert.equal(crashed.code, 86);

  const configured = await runCli(
    [
      "engines",
      "set",
      "--engine",
      "codex_cli",
      "--path",
      "/opt/nexus/definitely-missing-codex",
      "--state-dir",
      fixture.stateDir,
    ],
    { TMPDIR: fixture.root },
  );
  assert.equal(configured.code, 0, configured.stderr);
  const delivered = await report(fixture);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(JSON.parse(delivered.stdout).replaced, true);
  assert.deepEqual(
    (await engineEntries(fixture.stateDir))
      .map((entry) => entry.status)
      .sort(),
    ["abandoned", "acked"],
  );
  assert.equal(harness.engineAttempts.length, 1);
});

test("engine response classification preserves or scrubs exactly", async (t) => {
  let scenario;
  const harness = await nexusServer(t, ({ report, response }) => {
    response.statusCode = scenario.status;
    response.setHeader("content-type", "application/json");
    if (scenario.invalidAck) {
      response.end(JSON.stringify({
        receivedAt: "2026-07-26T12:00:00.000Z",
        reportId: report.reportId,
      }));
      return;
    }
    response.end(JSON.stringify({ error: scenario.error }));
  });
  for (const item of [
    { status: 500, error: "server_error", code: 75, stored: "pending" },
    { status: 429, error: "rate_limited", code: 75, stored: "pending" },
    { status: 409, error: "nonce_reused", code: 75, stored: "pending" },
    { status: 401, error: "unauthorized", code: 77, stored: "rejected" },
    { status: 403, error: "forbidden", code: 77, stored: "rejected" },
    { status: 409, error: "report_conflict", code: 75, stored: "rejected" },
    { status: 410, error: "gone", code: 75, stored: "rejected" },
    {
      status: 201,
      error: undefined,
      invalidAck: true,
      code: 76,
      stored: "pending",
    },
  ]) {
    scenario = item;
    const fixture = await safeFixture(t);
    await enroll(fixture, harness.origin);
    const result = await report(fixture);
    assert.equal(
      result.code,
      item.code,
      `${JSON.stringify(item)}: ${result.stderr}`,
    );
    assert.equal(
      (await engineEntries(fixture.stateDir))[0].status,
      item.stored,
      JSON.stringify(item),
    );
  }
});

test("network loss preserves the pending engine report", async (t) => {
  const fixture = await safeFixture(t);
  const harness = await nexusServer(t);
  await enroll(fixture, harness.origin);
  await closeServer(harness.server);
  const result = await report(fixture);
  assert.equal(result.code, 75);
  assert.match(result.stderr, /durable entry was preserved/u);
  assert.equal((await engineEntries(fixture.stateDir))[0].status, "pending");
});

async function nexusServer(t, engineResponder) {
  const engineAttempts = [];
  const effects = new Map();
  const server = createServer(async (request, response) => {
    const bytes = await requestBytes(request);
    if (request.url === "/api/runners/enroll") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        runnerId,
        principalId: "prn_1234567890abcdef1234567890abcdef",
        organizationId: "org-local",
        enrolledAt: "2026-07-26T00:00:00.000Z",
        trustProfile: "operator_trust",
      }));
      return;
    }
    if (request.url?.endsWith("/engine-reports")) {
      verifyEngineRequest(request, bytes, server.origin);
      const body = bytes.toString("utf8");
      const report = JSON.parse(body);
      engineAttempts.push({ body, report });
      if (engineResponder) {
        engineResponder({ report, request, response });
        return;
      }
      let acknowledgement = effects.get(report.reportId);
      if (!acknowledgement) {
        const receivedAt = new Date();
        acknowledgement = {
          nextReportBy: new Date(
            receivedAt.getTime() + 12 * 60 * 60 * 1_000,
          ).toISOString(),
          receivedAt: receivedAt.toISOString(),
          reportId: report.reportId,
        };
        effects.set(report.reportId, acknowledgement);
      } else {
        response.setHeader("x-nexus-replay", "1");
      }
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(acknowledgement));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(server);
  t.after(() => closeServer(server));
  return { effects, engineAttempts, origin: server.origin, server };
}

async function enroll(fixture, origin) {
  const token = randomBytes(32).toString("base64url");
  const result = await runCli(
    [
      "enroll",
      "--server",
      origin,
      "--name",
      "Engine test runner",
      "--token-stdin",
      "--state-dir",
      fixture.stateDir,
    ],
    { TMPDIR: fixture.root },
    `${token}\n`,
  );
  assert.equal(result.code, 0, result.stderr);
}

function report(fixture, extraEnvironment = {}) {
  return runCli(
    ["engines", "report", "--state-dir", fixture.stateDir],
    { TMPDIR: fixture.root, ...extraEnvironment },
  );
}

async function safeFixture(t) {
  const root = await mkdtemp(join(process.cwd(), ".engine-delivery-test-"));
  await chmod(root, 0o700);
  const stateDir = join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateDir };
}

async function engineEntries(stateDir) {
  const directory = join(stateDir, "outbox-v3");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return Promise.all(
    names.map(async (name) =>
      JSON.parse(await readFile(join(directory, name), "utf8")),
    ),
  );
}

function verifyEngineRequest(request, body, audience) {
  assert.equal(request.method, "POST");
  assert.equal(
    request.url,
    `/api/runners/${runnerId}/engine-reports`,
  );
  assert.equal(request.headers["x-nexus-runner-id"], runnerId);
  assert.equal(request.headers["content-length"], String(body.byteLength));
  const publicKey = String(request.headers["x-nexus-runner-key"] ?? "");
  const timestamp = String(request.headers["x-nexus-timestamp"] ?? "");
  const nonce = String(request.headers["x-nexus-nonce"] ?? "");
  const signature = String(request.headers["x-nexus-signature"] ?? "");
  const signed = [
    "nexus-runner-engine-report-v1",
    runnerId,
    "POST",
    request.url,
    audience,
    timestamp,
    nonce,
    `sha256:${createHash("sha256").update(body).digest("hex")}`,
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
      server.origin = `http://127.0.0.1:${address.port}`;
      resolveListen();
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

function runCli(args, extraEnvironment = {}, input = "") {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH, ...extraEnvironment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin.end(input);
    child.once("close", (code) => {
      resolveRun({ code, stderr, stdout });
    });
  });
}
