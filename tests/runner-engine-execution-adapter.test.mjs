import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  createEngineExecutionProcessAdapter,
  createEngineProcessAdapter,
} from "../runner/engine-adapters.mjs";

const supported = ["darwin", "linux"].includes(process.platform);

test(
  "execution profile is fixed and cannot promote or weaken the probe profile",
  { skip: !supported },
  async (t) => {
    const directory = await temporaryDirectory(t);
    const executable = await fakeExecutable(directory);
    const execution = createEngineExecutionProcessAdapter();
    const probe = createEngineProcessAdapter();
    const input = executionInput(directory, executable);
    await assert.rejects(
      Promise.resolve().then(() =>
        execution.runBounded({
          ...input,
          timeoutMs: 269_999,
        }, hooks()),
      ),
      /process input is invalid/u,
    );
    await assert.rejects(
      Promise.resolve().then(() =>
        execution.runBounded({
          ...input,
          argv: ["--forbidden"],
        }, hooks()),
      ),
      /process input is invalid/u,
    );
    await assert.rejects(
      Promise.resolve().then(() =>
        execution.runBounded({
          ...input,
          timeoutMs: 600_001,
        }, hooks()),
      ),
      /process input is invalid/u,
    );
    await assert.rejects(
      Promise.resolve().then(() =>
        probe.runBounded(
          {
            ...input,
            argv: ["--version"],
            maxStderrBytes: 16 * 1_024,
            maxStdoutBytes: 16 * 1_024,
            timeoutMs: 5_000,
          },
          hooks(),
        ),
      ),
      /process input is invalid/u,
    );
    await assert.rejects(
      Promise.resolve().then(() =>
        execution.runBounded({
          ...input,
          maxStdoutBytes: 16 * 1_024,
          maxStderrBytes: 16 * 1_024,
          timeoutMs: 5_000,
        }, hooks()),
      ),
      /process input is invalid/u,
    );
    await assert.rejects(
      Promise.resolve().then(() =>
        probe.runBounded(input),
      ),
      /process input is invalid/u,
    );
  },
);

test(
  "execution waits for durable authorization before writing bounded stdin",
  { skip: !supported },
  async (t) => {
    const directory = await temporaryDirectory(t);
    const executable = await fakeExecutable(directory);
    const adapter = createEngineExecutionProcessAdapter();
    let observed;
    let authorize;
    const authorization = new Promise((resolve) => {
      authorize = resolve;
    });
    let hookEntered = false;
    const pending = adapter.runBounded(
      executionInput(directory, executable),
      {
        async beforeInput(value) {
          observed = value;
          hookEntered = true;
          await authorization;
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(hookEntered, true);
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    authorize();
    const result = await pending;
    assert.equal(Number.isSafeInteger(observed.childPid), true);
    assert.match(observed.startedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(result.startedAt, observed.startedAt);
    assert.equal(result.exitCode, 0);
    assert.equal(result.canceled, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.overflowed, false);
    assert.equal(result.stdout.toString("utf8"), "payload");
    assert.equal(result.stderr.toString("utf8"), "warn");
    assert.deepEqual(Object.keys(result).sort(), [
      "canceled",
      "exitCode",
      "overflowed",
      "startedAt",
      "stderr",
      "stdout",
      "timedOut",
    ]);
  },
);

test(
  "execution enforces exact stream bounds and kills on the next byte",
  { skip: !supported },
  async (t) => {
    const directory = await temporaryDirectory(t);
    const executable = await fakeExecutable(directory);
    const adapter = createEngineExecutionProcessAdapter();
    const exact = await adapter.runBounded(
      executionInput(
        directory,
        executable,
        Buffer.from(
          JSON.stringify({
            stderrBytes: 65_536,
            stdoutBytes: 262_144,
          }),
        ),
      ),
      hooks(),
    );
    assert.equal(exact.overflowed, false);
    assert.equal(exact.stdout.byteLength, 262_144);
    assert.equal(exact.stderr.byteLength, 65_536);

    const stdoutOverflow = await adapter.runBounded(
      executionInput(
        directory,
        executable,
        Buffer.from(
          JSON.stringify({
            stderrBytes: 0,
            stdoutBytes: 262_145,
          }),
        ),
      ),
      hooks(),
    );
    assert.equal(stdoutOverflow.overflowed, true);
    assert.equal(stdoutOverflow.stdout.byteLength, 262_144);

    const stderrOverflow = await adapter.runBounded(
      executionInput(
        directory,
        executable,
        Buffer.from(
          JSON.stringify({
            stderrBytes: 65_537,
            stdoutBytes: 0,
          }),
        ),
      ),
      hooks(),
    );
    assert.equal(stderrOverflow.overflowed, true);
    assert.equal(stderrOverflow.stderr.byteLength, 65_536);
  },
);

test(
  "abort cancels and reaps a real engine group",
  { skip: !supported },
  async (t) => {
    const directory = await temporaryDirectory(t);
    const executable = await fakeExecutable(directory);
    const controller = new AbortController();
    const adapter = createEngineExecutionProcessAdapter();
    let childPid;
    const pending = adapter.runBounded(
      {
        ...executionInput(
          directory,
          executable,
          Buffer.from(JSON.stringify({ sleep: true })),
        ),
        signal: controller.signal,
      },
      {
        beforeInput(value) {
          childPid = value.childPid;
          setTimeout(() => controller.abort(), 25);
        },
      },
    );
    const result = await pending;
    assert.equal(result.canceled, true);
    assert.equal(Number.isSafeInteger(childPid), true);
    assert.match(result.startedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false);
    assert.throws(
      () => process.kill(-childPid, 0),
      (error) => error?.code === "ESRCH",
    );
  },
);

test(
  "pre-abort, spawn failure and hook rejection stay closed and settle",
  { skip: !supported },
  async (t) => {
    const directory = await temporaryDirectory(t);
    const executable = await fakeExecutable(directory);
    const adapter = createEngineExecutionProcessAdapter();

    const preAbort = new AbortController();
    preAbort.abort();
    let preAbortHook = false;
    const canceled = await adapter.runBounded(
      {
        ...executionInput(directory, executable),
        signal: preAbort.signal,
      },
      {
        beforeInput() {
          preAbortHook = true;
        },
      },
    );
    assert.equal(preAbortHook, false);
    assert.equal(canceled.canceled, true);
    assert.equal(canceled.startedAt, null);

    let missingHook = false;
    const missing = await adapter.runBounded(
      executionInput(directory, join(directory, "missing")),
      {
        beforeInput() {
          missingHook = true;
        },
      },
    );
    assert.equal(missingHook, false);
    assert.equal(missing.errorCode, "ENOENT");
    assert.equal(missing.startedAt, null);

    const rejected = await adapter.runBounded(
      executionInput(directory, executable),
      {
        beforeInput() {
          throw new Error("private durable write failure");
        },
      },
    );
    assert.equal(rejected.errorCode, "EIO");
    assert.match(rejected.startedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(rejected.stdout.byteLength, 0);
  },
);

test(
  "abort settles a hook that never authorizes input",
  { skip: !supported },
  async (t) => {
    const directory = await temporaryDirectory(t);
    const executable = await fakeExecutable(directory);
    const controller = new AbortController();
    const adapter = createEngineExecutionProcessAdapter();
    const pending = adapter.runBounded(
      {
        ...executionInput(directory, executable),
        signal: controller.signal,
      },
      {
        beforeInput() {
          setTimeout(() => controller.abort(), 25);
          return new Promise(() => undefined);
        },
      },
    );
    const result = await pending;
    assert.equal(result.canceled, true);
    assert.equal(result.timedOut, false);
  },
);

function executionInput(directory, executable, stdin = Buffer.from("payload")) {
  return {
    argv: [],
    cwd: directory,
    env: {
      HOME: directory,
      LANG: "C",
      LC_ALL: "C",
      PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`,
      TERM: "dumb",
      TMPDIR: directory,
    },
    executableRealPath: executable,
    maxStderrBytes: 65_536,
    maxStdoutBytes: 262_144,
    stdin,
    timeoutMs: 270_000,
  };
}

function hooks() {
  return { beforeInput: () => undefined };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "nexus-execution-adapter-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

async function fakeExecutable(directory) {
  const executable = join(directory, "fake-engine");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks);
  let scenario;
  try {
    scenario = JSON.parse(input.toString("utf8"));
  } catch {}
  if (scenario?.sleep) {
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 1000);
    return;
  }
  if (scenario && "stdoutBytes" in scenario) {
    process.stdout.write(Buffer.alloc(scenario.stdoutBytes, 0x6f));
  } else {
    process.stdout.write(input);
  }
  if (scenario && "stderrBytes" in scenario) {
    process.stderr.write(Buffer.alloc(scenario.stderrBytes, 0x65));
  } else {
    process.stderr.write("warn");
  }
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return executable;
}
