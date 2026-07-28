import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import test from "node:test";
import {
  finalizeAttemptRecord,
} from "../runner/attempt-journal-contract.mjs";
import {
  ATTEMPT_JOURNAL_DIRECTORY,
  persistAttemptRecord,
  recoverAttemptJournals,
} from "../runner/attempt-journal-store.mjs";
import {
  abandonSupervisedAttempt,
  inspectSupervisedAttempt,
  resumeSupervisedAttempt,
  runSupervisedAttempt,
} from "../runner/engine-supervised-run.mjs";
import {
  encodeSupervisorControl,
  encodeSupervisorStartToken,
  parseSupervisorBootstrap,
  parseSupervisorEvent,
  SUPERVISOR_PRESTART_REASONS,
  SUPERVISOR_PROTOCOL_VERSION,
  verifySupervisorHelloAck,
} from "../runner/engine-supervisor-protocol.mjs";

const executableFingerprints = new Map();

test("a starting-only attempt cannot reach the spawn side effect", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-no-spawning-");
  const prompt = Buffer.from("committed-prestart");
  const { records } = await seedStartingAttempt(stateDir, prompt);
  let spawnCalls = 0;
  assert.throws(
    () =>
      runSupervisedAttempt({
        attempt: {
          claimed: records.claimed,
          starting: records.starting,
        },
        binaryFingerprint: fakeFingerprint(),
        executableRealPath: "/definitely/not/invoked",
        input: prompt,
        spawnSupervisor() {
          spawnCalls += 1;
        },
        stateDir,
      }),
    /Starting attempt is invalid/u,
  );
  assert.equal(spawnCalls, 0);
});

test("a real supervisor persists started before stdin and retains no prompt file", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-supervised-run-");
  const original = Buffer.from(
    `committed-${randomBytes(12).toString("hex")}`,
  );
  const marker = original.toString("utf8");
  const { records, attemptId } = await seedStartingAttempt(
    stateDir,
    original,
  );
  const launchPath = join(stateDir, "launches.txt");
  const observationPath = join(stateDir, "observation.json");
  const executable = await createFakeEngine(stateDir, {
    attemptId,
    launchPath,
    marker,
    observationPath,
  });

  let updateLease;
  const pending = runSupervisedAttempt({
    attempt: records,
    binaryFingerprint: fingerprintFor(executable),
    executableRealPath: executable,
    input: original,
    publishLeaseUpdater(update) {
      updateLease = update;
    },
    stateDir,
  });
  assert.equal(typeof updateLease, "function");
  await updateLease({
    expiresAt: records.starting.expiresAt,
    fence: records.starting.fence,
    leaseId: records.starting.leaseId,
  });
  original.fill(0x78);
  const completed = await pending;

  assert.ok(completed.supervisor);
  assert.ok(completed.started);
  assert.ok(completed.result);
  assert.equal(completed.outboxed, undefined);
  assert.equal(
    completed.result.receipt.status,
    "succeeded",
    JSON.stringify(completed.result.receipt),
  );
  assert.equal(completed.result.receipt.reason, "none");
  assert.equal(
    completed.result.receipt.startedAt,
    completed.started.startedAt,
  );
  assert.equal(
    completed.result.receipt.stdout.sha256,
    records.starting.promptSha256,
  );
  assert.equal(
    completed.result.receipt.stdout.bytes,
    records.starting.promptBytes,
  );
  assert.equal(await readFile(launchPath, "utf8"), "launch\n");
  const observation = JSON.parse(
    await readFile(observationPath, "utf8"),
  );
  assert.equal(observation.startedExists, true);
  assert.equal(observation.startedChildPid, observation.pid);
  assert.equal(observation.markerFound, false);
  assert.deepEqual(observation.files, []);
  assert.deepEqual(
    await readdir(join(stateDir, "engine-scratch-v1")),
    [],
  );
  assert.equal(
    (await stat(
      join(
        stateDir,
        ATTEMPT_JOURNAL_DIRECTORY,
        attemptId,
        "result.json",
      ),
    )).mode & 0o777,
    0o600,
  );
});

test("a missing executable becomes a durable prestart result without started", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-supervised-missing-");
  const prompt = Buffer.from("committed-prestart");
  const { records } = await seedStartingAttempt(stateDir, prompt);
  const missing = join(stateDir, "missing-engine");
  const completed = await runSupervisedAttempt({
    attempt: records,
    binaryFingerprint: fakeFingerprint(),
    executableRealPath: missing,
    input: prompt,
    stateDir,
  });

  assert.ok(completed.supervisor);
  assert.equal(completed.started, undefined);
  assert.equal(completed.result.receipt.status, "failed");
  assert.equal(completed.result.receipt.reason, "spawn_failed");
  assert.equal(completed.result.receipt.stdout.bytes, 0);
  assert.equal(completed.result.receipt.stderr.bytes, 0);
  assert.deepEqual(
    await readdir(join(stateDir, "engine-scratch-v1")),
    [],
  );
});

test("every reasoned waiting-spawn termination becomes durable", async (t) => {
  for (const reason of SUPERVISOR_PRESTART_REASONS.filter(
    (candidate) => candidate !== "spawn_failed",
  )) {
    await t.test(reason, async (childTest) => {
      const stateDir = await privateStateDir(
        childTest,
        `nexus-supervised-prestart-${reason}-`,
      );
      const prompt = Buffer.from(`prestart-${reason}`);
      const { records } = await seedStartingAttempt(stateDir, prompt);
      const termination = new AbortController();
      termination.abort(reason);
      const completed = await runSupervisedAttempt({
        attempt: records,
        binaryFingerprint: fakeFingerprint(),
        cancelSignal: termination.signal,
        executableRealPath: "/definitely/not/invoked",
        input: prompt,
        stateDir,
      });
      assert.ok(completed.supervisor);
      assert.equal(completed.started, undefined);
      assert.equal(completed.result.receipt.reason, reason);
      assert.equal(
        completed.result.receipt.status,
        reason === "cancel_requested" ? "canceled" : "failed",
      );
      assert.equal(
        completed.result.receipt.cancelRequested,
        reason === "cancel_requested",
      );
    });
  }
});

test("termination accepted during preparation prevents provider spawn", async (t) => {
  const stateDir = await privateStateDir(
    t,
    "nexus-supervised-prepare-termination-",
  );
  const scratchRoot = join(stateDir, "engine-scratch-v1");
  await mkdir(scratchRoot, { mode: 0o700 });
  await chmod(scratchRoot, 0o700);
  const attemptId = `att_${randomBytes(16).toString("hex")}`;
  const launchPath = join(stateDir, "prepare-termination-launches.txt");
  const prompt = Buffer.from("never-spawn-this-provider");
  const executable = await createFakeEngine(stateDir, {
    attemptId,
    launchPath,
    marker: prompt.toString("utf8"),
    observationPath: join(stateDir, "prepare-termination-observation.json"),
  });
  const supervisor = spawn(
    process.execPath,
    [
      new URL(
        "../runner/engine-supervisor-child.mjs",
        import.meta.url,
      ).pathname,
      "--supervisor-v3",
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  t.after(() => {
    if (supervisor.exitCode === null) supervisor.kill("SIGTERM");
  });
  const bootstrapReader = createLineReader(supervisor.stdout);
  const bootstrap = parseSupervisorBootstrap(
    await bootstrapReader.next(),
  );
  bootstrapReader.close();
  const session = await openDirectSession(bootstrap, attemptId);
  const common = {
    attemptId,
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  };
  const authorize = encodeSupervisorControl({
    ...common,
    kind: "authorize_spawn",
    request: {
      binaryFingerprint: fingerprintFor(executable),
      cwdRoot: scratchRoot,
      deadlineAt: new Date(Date.now() + 1_200_000).toISOString(),
      engine: "claude_code_cli",
      engineVersion: "2.1.219 (Claude Code)",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      executableRealPath: executable,
      fence: 7,
      inputBase64: prompt.toString("base64url"),
      inputSha256: createHash("sha256").update(prompt).digest("hex"),
      leaseId: `lse_${"a".repeat(32)}`,
      timeoutMs: 270_000,
    },
  });
  const terminate = encodeSupervisorControl({
    ...common,
    kind: "terminate",
    reason: "lease_lost",
  });
  await session.rawSend(Buffer.concat([authorize, terminate]));
  const terminal = await session.next();
  assert.equal(terminal.state, "fault", JSON.stringify(terminal));
  assert.equal(terminal.code, "lease_lost");
  session.close();
  await assert.rejects(stat(launchPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(scratchRoot), []);
});

test("a durable waiting-spawn supervisor survives the recovery gap", async (t) => {
  const attemptId = `att_${randomBytes(16).toString("hex")}`;
  const supervisor = spawn(
    process.execPath,
    [
      new URL(
        "../runner/engine-supervisor-child.mjs",
        import.meta.url,
      ).pathname,
      "--supervisor-v3",
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  t.after(() => {
    if (supervisor.exitCode === null) supervisor.kill("SIGTERM");
  });
  const bootstrapReader = createLineReader(supervisor.stdout);
  const bootstrap = parseSupervisorBootstrap(
    await bootstrapReader.next(),
  );
  bootstrapReader.close();
  assert.equal(bootstrap.pid, supervisor.pid);
  let session = await openDirectSession(bootstrap, attemptId);
  assert.equal(session.event.state, "waiting_spawn");
  session.close();

  await new Promise((resolve) => setTimeout(resolve, 5_100));

  session = await reconnectDirectSession(bootstrap, attemptId);
  assert.equal(session.event.state, "waiting_spawn");
  assert.equal(bootstrap.pid, supervisor.pid);
  await session.send({
    attemptId,
    kind: "terminate",
    reason: "lease_lost",
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  const terminal = await session.next();
  assert.equal(terminal.state, "fault");
  assert.equal(terminal.code, "lease_lost");
  session.close();
});

test("recovery after parent death resumes the same child without another launch", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-supervised-resume-");
  const prompt = Buffer.from(
    `recover-${randomBytes(12).toString("hex")}`,
  );
  const { records, attemptId } = await seedStartingAttempt(
    stateDir,
    prompt,
  );
  const launchPath = join(stateDir, "resume-launches.txt");
  const executable = await createFakeEngine(stateDir, {
    attemptId,
    delayMs: 1_000,
    launchPath,
    marker: prompt.toString("utf8"),
    observationPath: join(stateDir, "resume-observation.json"),
  });
  const helperSource = `
    import { runSupervisedAttempt } from ${JSON.stringify(
      new URL(
        "../runner/engine-supervised-run.mjs",
        import.meta.url,
      ).href,
    )};
    import { recoverAttemptJournals } from ${JSON.stringify(
      new URL(
        "../runner/attempt-journal-store.mjs",
        import.meta.url,
      ).href,
    )};
    const [attempt] = await recoverAttemptJournals(
      ${JSON.stringify(stateDir)},
    );
    await runSupervisedAttempt({
      attempt,
      binaryFingerprint: ${JSON.stringify(fingerprintFor(executable))},
      executableRealPath: ${JSON.stringify(executable)},
      input: Buffer.from(${JSON.stringify(prompt.toString("base64"))}, "base64"),
      stateDir: ${JSON.stringify(stateDir)},
    });
  `;
  const helper = spawn(
    process.execPath,
    ["--input-type=module", "-e", helperSource],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const startedPath = join(
    stateDir,
    ATTEMPT_JOURNAL_DIRECTORY,
    attemptId,
    "started.json",
  );
  await waitUntil(async () => {
    try {
      await stat(startedPath);
      return true;
    } catch {
      return false;
    }
  });
  helper.kill("SIGKILL");
  await new Promise((resolve) => helper.once("close", resolve));

  const [recovered] = await recoverAttemptJournals(stateDir);
  assert.ok(recovered.records.started);
  assert.equal(recovered.records.result, undefined);
  const completed = await resumeSupervisedAttempt({
    attempt: recovered,
    stateDir,
  });
  assert.equal(completed.result.receipt.status, "succeeded");
  assert.equal(
    completed.result.receipt.stdout.sha256,
    records.starting.promptSha256,
  );
  assert.equal(await readFile(launchPath, "utf8"), "launch\n");
  assert.deepEqual(
    await readdir(join(stateDir, "engine-scratch-v1")),
    [],
  );
});

test("detached supervisor reaps its provider at the authenticated lease horizon", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-supervised-lease-");
  const scratchRoot = join(stateDir, "engine-scratch-v1");
  await mkdir(scratchRoot, { mode: 0o700 });
  await chmod(scratchRoot, 0o700);
  const attemptId = `att_${randomBytes(16).toString("hex")}`;
  const launchPath = join(stateDir, "lease-launches.txt");
  const observationPath = join(stateDir, "lease-observation.json");
  const prompt = Buffer.from("lease-bounded-provider");
  const executable = await createFakeEngine(stateDir, {
    attemptId,
    delayMs: 10_000,
    launchPath,
    marker: prompt.toString("utf8"),
    observationPath,
  });
  const supervisor = spawn(
    process.execPath,
    [
      new URL(
        "../runner/engine-supervisor-child.mjs",
        import.meta.url,
      ).pathname,
      "--supervisor-v3",
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  t.after(() => {
    if (supervisor.exitCode === null) supervisor.kill("SIGTERM");
  });
  const bootstrapReader = createLineReader(supervisor.stdout);
  const bootstrap = parseSupervisorBootstrap(
    await bootstrapReader.next(),
  );
  bootstrapReader.close();
  const expiresAt = new Date(Date.now() + 900).toISOString();
  const extendedExpiresAt =
    new Date(Date.now() + 1_900).toISOString();
  let session = await openDirectSession(bootstrap, attemptId);
  await session.send({
    attemptId,
    kind: "authorize_spawn",
    request: {
      binaryFingerprint: fingerprintFor(executable),
      cwdRoot: scratchRoot,
      deadlineAt: new Date(Date.now() + 1_200_000).toISOString(),
      engine: "claude_code_cli",
      engineVersion: "2.1.219 (Claude Code)",
      executableRealPath: executable,
      expiresAt,
      fence: 7,
      inputBase64: prompt.toString("base64url"),
      inputSha256: createHash("sha256").update(prompt).digest("hex"),
      leaseId: `lse_${"a".repeat(32)}`,
      timeoutMs: 270_000,
    },
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  const waiting = await session.next();
  assert.equal(waiting.state, "waiting_input");
  await session.send({
    attemptId,
    childToken: waiting.childToken,
    kind: "authorize_input",
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  assert.equal((await session.next()).state, "running");
  await session.send({
    attemptId,
    expiresAt: extendedExpiresAt,
    fence: 7,
    kind: "extend_lease",
    leaseId: `lse_${"a".repeat(32)}`,
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  assert.deepEqual(await session.next(), {
    attemptId,
    expiresAt: extendedExpiresAt,
    fence: 7,
    kind: "lease_ack",
    leaseId: `lse_${"a".repeat(32)}`,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  await waitUntil(async () => {
    try {
      await stat(observationPath);
      return true;
    } catch {
      return false;
    }
  });
  const observation = JSON.parse(await readFile(observationPath, "utf8"));
  await session.send({
    attemptId,
    expiresAt,
    fence: 7,
    kind: "extend_lease",
    leaseId: `lse_${"a".repeat(32)}`,
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  await session.closed();

  await waitUntil(() => Date.now() > Date.parse(expiresAt) + 150);
  assert.doesNotThrow(() => process.kill(observation.pid, 0));
  await waitUntil(
    () => Date.now() > Date.parse(extendedExpiresAt) + 200,
  );
  await waitUntil(() => {
    try {
      process.kill(observation.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  session = await reconnectDirectSession(bootstrap, attemptId);
  const terminal =
    session.event.state === "result"
      ? session.event
      : await session.next();
  assert.equal(terminal.state, "result");
  assert.equal(terminal.receipt.reason, "lease_lost");
  assert.equal(terminal.receipt.status, "failed");
  assert.equal(await readFile(launchPath, "utf8"), "launch\n");
  await session.send({
    attemptId,
    kind: "ack_result",
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  await session.closed();
});

test("duplicate spawn controls and terminal reconnects remain effect-once", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-supervised-replay-");
  const scratchRoot = join(stateDir, "engine-scratch-v1");
  await mkdir(scratchRoot, { mode: 0o700 });
  await chmod(scratchRoot, 0o700);
  const attemptId = `att_${randomBytes(16).toString("hex")}`;
  const launchPath = join(stateDir, "direct-launches.txt");
  const prompt = Buffer.from("direct-reconnect");
  const executable = await createFakeEngine(stateDir, {
    attemptId,
    launchPath,
    marker: prompt.toString("utf8"),
    observationPath: join(stateDir, "direct-observation.json"),
  });
  const supervisor = spawn(
    process.execPath,
    [
      new URL(
        "../runner/engine-supervisor-child.mjs",
        import.meta.url,
      ).pathname,
      "--supervisor-v3",
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  t.after(() => {
    if (supervisor.exitCode === null) supervisor.kill("SIGTERM");
  });
  const bootstrapReader = createLineReader(supervisor.stdout);
  const bootstrap = parseSupervisorBootstrap(
    await bootstrapReader.next(),
  );
  bootstrapReader.close();
  assert.ok(bootstrap);
  assert.equal(bootstrap.pid, supervisor.pid);
  const untrustedAttempt = `att_${randomBytes(16).toString("hex")}`;
  const unauthenticatedHello = encodeSupervisorControl({
    attemptId: untrustedAttempt,
    kind: "hello",
    nonce: randomBytes(16).toString("hex"),
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  assert.equal(
    Object.hasOwn(
      JSON.parse(unauthenticatedHello.toString("utf8")),
      "token",
    ),
    false,
  );
  const probe = createConnection({
    host: "127.0.0.1",
    port: bootstrap.port,
  });
  await new Promise((resolve, reject) => {
    probe.once("connect", resolve);
    probe.once("error", reject);
  });
  const probeReader = createLineReader(probe);
  await new Promise((resolve, reject) => {
    probe.write(unauthenticatedHello, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const probeAck = parseSupervisorEvent(await probeReader.next());
  assert.equal(probeAck.attemptId, untrustedAttempt);
  probeReader.close();
  probe.destroy();
  const request = {
    cwdRoot: scratchRoot,
    deadlineAt: new Date(Date.now() + 1_200_000).toISOString(),
    engine: "claude_code_cli",
    engineVersion: "2.1.219 (Claude Code)",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    binaryFingerprint: fingerprintFor(executable),
    executableRealPath: executable,
    fence: 7,
    inputBase64: prompt.toString("base64url"),
    inputSha256: createHash("sha256").update(prompt).digest("hex"),
    leaseId: `lse_${"a".repeat(32)}`,
    timeoutMs: 270_000,
  };
  let session = await openDirectSession(bootstrap, attemptId);
  assert.equal(session.event.state, "waiting_spawn");
  const authorizeSpawn = {
    attemptId,
    kind: "authorize_spawn",
    request,
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  };
  await session.send(authorizeSpawn);
  await session.send(authorizeSpawn);
  let event;
  for (let count = 0; count < 5; count += 1) {
    event = await session.next();
    if (event.state === "waiting_input") break;
  }
  assert.equal(event.state, "waiting_input");
  const childIdentity = event;
  session.close();

  session = await reconnectDirectSession(bootstrap, attemptId);
  assert.equal(session.event.state, "waiting_input");
  assert.equal(session.event.childToken, childIdentity.childToken);
  await session.send(authorizeSpawn);
  assert.equal((await session.next()).state, "waiting_input");
  await session.send({
    attemptId,
    childToken: childIdentity.childToken,
    kind: "authorize_input",
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  assert.equal((await session.next()).state, "running");
  const terminal = await session.next();
  assert.equal(terminal.state, "result");
  session.close();
  assert.equal(await readFile(launchPath, "utf8"), "launch\n");

  await new Promise((resolve) => setTimeout(resolve, 5_100));
  session = await reconnectDirectSession(bootstrap, attemptId);
  assert.equal(session.event.childToken, childIdentity.childToken);
  const replayOne = await session.next();
  assert.deepEqual(replayOne, terminal);
  session.close();
  session = await reconnectDirectSession(bootstrap, attemptId);
  assert.equal(session.event.childToken, childIdentity.childToken);
  const replayTwo = await session.next();
  assert.deepEqual(replayTwo, terminal);
  await session.send({
    attemptId,
    kind: "ack_result",
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  await session.closed();
  assert.equal(await readFile(launchPath, "utf8"), "launch\n");
});

test("inspection cannot evict an active controller or duplicate its child", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-supervised-inspect-");
  const prompt = Buffer.from("inspect-without-takeover");
  const { records, attemptId } = await seedStartingAttempt(
    stateDir,
    prompt,
  );
  const launchPath = join(stateDir, "inspect-launches.txt");
  const executable = await createFakeEngine(stateDir, {
    attemptId,
    delayMs: 500,
    launchPath,
    marker: prompt.toString("utf8"),
    observationPath: join(stateDir, "inspect-observation.json"),
  });
  const pending = runSupervisedAttempt({
    attempt: records,
    binaryFingerprint: fingerprintFor(executable),
    executableRealPath: executable,
    input: prompt,
    stateDir,
  });
  const startedPath = join(
    stateDir,
    ATTEMPT_JOURNAL_DIRECTORY,
    attemptId,
    "started.json",
  );
  await waitUntil(async () => {
    try {
      await stat(startedPath);
      return true;
    } catch {
      return false;
    }
  });
  const [live] = await recoverAttemptJournals(stateDir);
  assert.deepEqual(
    await inspectSupervisedAttempt(
      live.records.supervisor.supervisorStartToken,
      attemptId,
    ),
    { status: "ambiguous" },
  );
  const completed = await pending;
  assert.equal(completed.result.receipt.status, "succeeded");
  assert.equal(await readFile(launchPath, "utf8"), "launch\n");
});

test("ambiguous recovery never signals the PID recorded in the journal", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-supervised-pid-");
  const prompt = Buffer.from("pid-is-audit-only");
  const { records } = await seedStartingAttempt(stateDir, prompt);
  const decoy = spawn(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    { stdio: "ignore" },
  );
  t.after(() => {
    if (decoy.exitCode === null) decoy.kill("SIGKILL");
  });
  const port = await refusedPort();
  const supervisor = finalizeAttemptRecord({
    attemptId: records.claimed.attemptId,
    createdAt: new Date().toISOString(),
    state: "supervisor",
    supervisorPid: decoy.pid,
    supervisorStartToken: encodeSupervisorStartToken(
      port,
      randomBytes(16).toString("hex"),
    ),
    v: 1,
  });
  const resumable = await persistAttemptRecord(stateDir, supervisor);
  await assert.rejects(
    resumeSupervisedAttempt({
      attempt: resumable,
      stateDir,
    }),
    /Supervisor session failed/u,
  );
  assert.doesNotThrow(() => process.kill(decoy.pid, 0));
});

test("a bounded control flood closes before any engine can launch", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-supervised-flood-");
  const scratchRoot = join(stateDir, "engine-scratch-v1");
  await mkdir(scratchRoot, { mode: 0o700 });
  await chmod(scratchRoot, 0o700);
  const attemptId = `att_${randomBytes(16).toString("hex")}`;
  const launchPath = join(stateDir, "flood-launches.txt");
  const prompt = Buffer.from("bounded-flood");
  const executable = await createFakeEngine(stateDir, {
    attemptId,
    launchPath,
    marker: prompt.toString("utf8"),
    observationPath: join(stateDir, "flood-observation.json"),
  });
  const supervisor = spawn(
    process.execPath,
    [
      new URL(
        "../runner/engine-supervisor-child.mjs",
        import.meta.url,
      ).pathname,
      "--supervisor-v3",
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  t.after(() => {
    if (supervisor.exitCode === null) supervisor.kill("SIGTERM");
  });
  const bootstrapReader = createLineReader(supervisor.stdout);
  const bootstrap = parseSupervisorBootstrap(
    await bootstrapReader.next(),
  );
  bootstrapReader.close();
  assert.ok(bootstrap);
  const session = await openDirectSession(bootstrap, attemptId);
  const frame = encodeSupervisorControl({
    attemptId,
    kind: "authorize_spawn",
    request: {
      cwdRoot: scratchRoot,
      deadlineAt: new Date(Date.now() + 1_200_000).toISOString(),
      engine: "claude_code_cli",
      engineVersion: "2.1.219 (Claude Code)",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      binaryFingerprint: fingerprintFor(executable),
      executableRealPath: executable,
      fence: 7,
      inputBase64: prompt.toString("base64url"),
      inputSha256: createHash("sha256").update(prompt).digest("hex"),
      leaseId: `lse_${"a".repeat(32)}`,
      timeoutMs: 270_000,
    },
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  await session.rawSend(Buffer.concat([frame, frame, frame]));
  await session.closed();
  await assert.rejects(stat(launchPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(scratchRoot), []);
});

test("authenticated abandon reaps a gated child and its exact scratch", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-supervised-abandon-");
  const scratchRoot = join(stateDir, "engine-scratch-v1");
  await mkdir(scratchRoot, { mode: 0o700 });
  await chmod(scratchRoot, 0o700);
  const attemptId = `att_${randomBytes(16).toString("hex")}`;
  const launchPath = join(stateDir, "abandon-launches.txt");
  const prompt = Buffer.from("abandon-before-input");
  const executable = await createFakeEngine(stateDir, {
    attemptId,
    launchPath,
    marker: prompt.toString("utf8"),
    observationPath: join(stateDir, "abandon-observation.json"),
  });
  const supervisor = spawn(
    process.execPath,
    [
      new URL(
        "../runner/engine-supervisor-child.mjs",
        import.meta.url,
      ).pathname,
      "--supervisor-v3",
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  t.after(() => {
    if (supervisor.exitCode === null) supervisor.kill("SIGTERM");
  });
  const bootstrapReader = createLineReader(supervisor.stdout);
  const bootstrap = parseSupervisorBootstrap(
    await bootstrapReader.next(),
  );
  bootstrapReader.close();
  const session = await openDirectSession(bootstrap, attemptId);
  await session.send({
    attemptId,
    kind: "authorize_spawn",
    request: {
      cwdRoot: scratchRoot,
      deadlineAt: new Date(Date.now() + 1_200_000).toISOString(),
      engine: "claude_code_cli",
      engineVersion: "2.1.219 (Claude Code)",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      binaryFingerprint: fingerprintFor(executable),
      executableRealPath: executable,
      fence: 7,
      inputBase64: prompt.toString("base64url"),
      inputSha256: createHash("sha256").update(prompt).digest("hex"),
      leaseId: `lse_${"a".repeat(32)}`,
      timeoutMs: 270_000,
    },
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  assert.equal((await session.next()).state, "waiting_input");
  session.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    await abandonSupervisedAttempt(
      encodeSupervisorStartToken(
        bootstrap.port,
        bootstrap.token,
      ),
      attemptId,
    ),
    { status: "requested" },
  );
  const launches = await readFile(launchPath, "utf8").catch(() => "");
  assert.ok(["", "launch\n"].includes(launches));
  assert.deepEqual(await readdir(scratchRoot), []);
});

test("supervised output closes at the first byte beyond the fixed bound", async (t) => {
  const stateDir = await privateStateDir(t, "nexus-supervised-output-");
  const prompt = Buffer.from("produce-bounded-output");
  const { records } = await seedStartingAttempt(stateDir, prompt);
  const executable = join(stateDir, "output-engine");
  await writeFile(
    executable,
    `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(
  Buffer.alloc(262145, 0x61),
));
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const executableRealPath = await recordExecutableFingerprint(executable);
  const completed = await runSupervisedAttempt({
    attempt: records,
    binaryFingerprint: fingerprintFor(executableRealPath),
    executableRealPath,
    input: prompt,
    stateDir,
  });
  const { receipt } = completed.result;
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.reason, "output_limit_reached");
  assert.equal(receipt.exitCode, null);
  assert.equal(receipt.stdout.bytes, 262_144);
  assert.equal(receipt.stdout.truncated, true);
  assert.equal(
    receipt.stdout.sha256,
    createHash("sha256")
      .update(Buffer.alloc(262_144, 0x61))
      .digest("hex"),
  );
  assert.deepEqual(
    await readdir(join(stateDir, "engine-scratch-v1")),
    [],
  );
});

test("the supervisor entry point is import-inert and rejects public invocation", async () => {
  await import("../runner/engine-supervisor-child.mjs");
  const child = spawn(
    process.execPath,
    [
      new URL(
        "../runner/engine-supervisor-child.mjs",
        import.meta.url,
      ).pathname,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const [code, stdout, stderr] = await Promise.all([
    new Promise((resolve) => child.once("close", resolve)),
    collect(child.stdout),
    collect(child.stderr),
  ]);
  assert.equal(code, 64);
  assert.equal(stdout.byteLength, 0);
  assert.equal(stderr.byteLength, 0);
});

async function seedStartingAttempt(stateDir, prompt) {
  const attemptId = `att_${randomBytes(16).toString("hex")}`;
  const runId = `run_${randomBytes(16).toString("hex")}`;
  const claimOperationId = `op_${randomBytes(16).toString("hex")}`;
  const now = Date.now();
  const engine = "claude_code_cli";
  const claimed = finalizeAttemptRecord({
    attemptId,
    claimBodySha256: createHash("sha256")
      .update(
        canonicalJson({
          engine,
          operationId: claimOperationId,
        }),
      )
      .digest("hex"),
    claimOperationId,
    createdAt: new Date(now - 2_000).toISOString(),
    engine,
    runId,
    state: "claimed",
    v: 1,
  });
  const starting = finalizeAttemptRecord({
    attemptId,
    cancelRequested: false,
    createdAt: new Date(now - 1_000).toISOString(),
    deadlineAt: new Date(now + 1_200_000).toISOString(),
    engine,
    engineVersion: "2.1.219 (Claude Code)",
    expiresAt: new Date(now + 60_000).toISOString(),
    fence: 1,
    leaseId: `lse_${randomBytes(16).toString("hex")}`,
    outputBounds: {
      stderrBytes: 65_536,
      stdoutBytes: 262_144,
    },
    promptBytes: prompt.byteLength,
    promptRef: `prm_${randomBytes(16).toString("hex")}`,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    runId,
    state: "starting",
    timeoutMs: 270_000,
    v: 1,
  });
  const spawning = finalizeAttemptRecord({
    attemptId,
    createdAt: new Date(now - 500).toISOString(),
    state: "spawning",
    v: 1,
  });
  await persistAttemptRecord(stateDir, claimed);
  await persistAttemptRecord(stateDir, starting);
  const records = await persistAttemptRecord(stateDir, spawning);
  return { attemptId, records };
}

async function createFakeEngine(
  stateDir,
  {
    attemptId,
    delayMs = 0,
    launchPath,
    marker,
    observationPath,
  },
) {
  const path = join(stateDir, `engine-${randomBytes(6).toString("hex")}`);
  const journalPath = join(
    stateDir,
    ATTEMPT_JOURNAL_DIRECTORY,
    attemptId,
    "started.json",
  );
  const source = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(${JSON.stringify(launchPath)}, "launch\\n");
let observed = false;
const chunks = [];
function walk(root, relative = "") {
  const names = fs.readdirSync(root).sort();
  const files = [];
  for (const name of names) {
    const next = path.join(root, name);
    const child = path.join(relative, name);
    const facts = fs.lstatSync(next);
    files.push(child);
    if (facts.isDirectory()) files.push(...walk(next, child));
  }
  return files;
}
process.stdin.on("data", (chunk) => {
  if (!observed) {
    observed = true;
    const files = walk(process.env.TMPDIR);
    let markerFound = false;
    for (const relative of files) {
      const candidate = path.join(process.env.TMPDIR, relative);
      try {
        if (fs.statSync(candidate).isFile()) {
          markerFound ||= fs.readFileSync(candidate).includes(
            Buffer.from(${JSON.stringify(marker)}),
          );
        }
      } catch {}
    }
    let started;
    try {
      started = JSON.parse(fs.readFileSync(
        ${JSON.stringify(journalPath)},
        "utf8",
      ));
    } catch {}
    fs.writeFileSync(
      ${JSON.stringify(observationPath)},
      JSON.stringify({
        files,
        markerFound,
        pid: process.pid,
        startedChildPid: started?.childPid,
        startedExists: Boolean(started),
      }),
    );
  }
  chunks.push(chunk);
});
process.stdin.on("end", () => setTimeout(
  () => process.stdout.write(Buffer.concat(chunks)),
  ${delayMs},
));
`;
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
  return recordExecutableFingerprint(path);
}

async function recordExecutableFingerprint(path) {
  const resolved = await realpath(path);
  const facts = await lstat(resolved, { bigint: true });
  executableFingerprints.set(resolved, {
    dev: facts.dev.toString(),
    ino: facts.ino.toString(),
    mode: Number(facts.mode),
    mtimeMs: Number(facts.mtimeNs) / 1_000_000,
    size: Number(facts.size),
    uid: Number(facts.uid),
  });
  return resolved;
}

function fingerprintFor(path) {
  return executableFingerprints.get(path) ?? fakeFingerprint();
}

function fakeFingerprint() {
  return {
    dev: "1",
    ino: "2",
    mode: 0o100700,
    mtimeMs: 3,
    size: 4,
    uid: process.getuid?.() ?? 0,
  };
}

async function privateStateDir(t, prefix) {
  const created = await mkdtemp(join(tmpdir(), prefix));
  const stateDir = await realpath(created);
  await chmod(stateDir, 0o700);
  t.after(() => rm(stateDir, { force: true, recursive: true }));
  return stateDir;
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for supervised test state.");
}

async function reconnectDirectSession(bootstrap, attemptId) {
  let lastError;
  for (let count = 0; count < 50; count += 1) {
    try {
      return await openDirectSession(bootstrap, attemptId);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function refusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { exclusive: true, host: "127.0.0.1", port: 0 },
      resolve,
    );
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function openDirectSession(bootstrap, attemptId) {
  const socket = createConnection({
    host: "127.0.0.1",
    port: bootstrap.port,
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const reader = createLineReader(socket);
  const nonce = randomBytes(16).toString("hex");
  await writeFrame(socket, {
    attemptId,
    kind: "hello",
    nonce,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  const hello = parseSupervisorEvent(await reader.next());
  assert.equal(
    verifySupervisorHelloAck(
      { attemptId, nonce, token: bootstrap.token },
      hello,
    ),
    true,
  );
  await writeFrame(socket, {
    attemptId,
    kind: "attach",
    token: bootstrap.token,
    v: SUPERVISOR_PROTOCOL_VERSION,
  });
  const event = parseSupervisorEvent(await reader.next());
  assert.ok(event);
  return {
    event,
    close() {
      reader.close();
      socket.destroy();
    },
    closed: () =>
      new Promise((resolve) => {
        if (socket.destroyed) resolve();
        else socket.once("close", resolve);
      }),
    async next() {
      const next = parseSupervisorEvent(await reader.next());
      assert.ok(next);
      return next;
    },
    rawSend: (bytes) =>
      new Promise((resolve, reject) => {
        socket.write(bytes, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    send: (frame) => writeFrame(socket, frame),
  };
}

function writeFrame(socket, frame) {
  return new Promise((resolve, reject) => {
    socket.write(encodeSupervisorControl(frame), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createLineReader(stream, maximum = 16_384) {
  let buffer = Buffer.alloc(0);
  let failure;
  const lines = [];
  const waiters = [];
  const settle = () => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (lines.length > 0) waiter.resolve(lines.shift());
      else if (failure) waiter.reject(failure);
      else {
        waiters.unshift(waiter);
        break;
      }
    }
  };
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.byteLength > maximum) stream.destroy();
        return;
      }
      const line = buffer.subarray(0, newline + 1);
      buffer = buffer.subarray(newline + 1);
      if (line.byteLength > maximum) {
        stream.destroy();
        return;
      }
      lines.push(Buffer.from(line));
      settle();
    }
  };
  const onClose = () => {
    failure ??= new Error("Direct supervisor test connection closed.");
    settle();
  };
  stream.on("data", onData);
  stream.once("close", onClose);
  stream.once("error", onClose);
  return {
    close() {
      stream.off("data", onData);
      stream.off("close", onClose);
      stream.off("error", onClose);
    },
    next() {
      if (lines.length > 0) return Promise.resolve(lines.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiters.push({ reject, resolve });
      });
    },
  };
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
