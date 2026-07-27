import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import test from "node:test";

const cli = new URL("../runner/nexus-runner.mjs", import.meta.url).pathname;

test("engines set, inspect and remove retain canonical local state", async (t) => {
  const stateDir = await fixture(t);
  const empty = await runCli([
    "engines",
    "inspect",
    "--state-dir",
    stateDir,
  ]);
  assert.equal(empty.code, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), {
    engines: {},
    schemaVersion: 1,
  });

  const codex = await runCli([
    "engines",
    "set",
    "--engine",
    "codex_cli",
    "--path",
    "/opt/nexus/bin/codex",
    "--state-dir",
    stateDir,
  ]);
  assert.equal(codex.code, 0, codex.stderr);
  assert.equal(
    JSON.parse(codex.stdout).engines.codex_cli.executablePath,
    "/opt/nexus/bin/codex",
  );
  const claude = await runCli([
    "engines",
    "set",
    "--engine",
    "claude_code_cli",
    "--path",
    "/opt/nexus/bin/claude",
    "--state-dir",
    stateDir,
  ]);
  assert.equal(claude.code, 0, claude.stderr);

  const path = join(stateDir, "engines.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(
    await readFile(path, "utf8"),
    '{"engines":{"claude_code_cli":{"executablePath":"/opt/nexus/bin/claude"},"codex_cli":{"executablePath":"/opt/nexus/bin/codex"}},"schemaVersion":1}\n',
  );
  const inspected = await runCli([
    "engines",
    "inspect",
    "--state-dir",
    stateDir,
  ]);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.deepEqual(
    Object.keys(JSON.parse(inspected.stdout).engines),
    ["claude_code_cli", "codex_cli"],
  );

  for (const engine of ["codex_cli", "claude_code_cli"]) {
    const removed = await runCli([
      "engines",
      "remove",
      "--engine",
      engine,
      "--state-dir",
      stateDir,
    ]);
    assert.equal(removed.code, 0, removed.stderr);
  }
  assert.equal(
    await readFile(path, "utf8"),
    '{"engines":{},"schemaVersion":1}\n',
  );
});

test("engines commands reject invalid input without disclosing it", async (t) => {
  const stateDir = await fixture(t);
  const privatePath = "relative/operator@example.com";
  const invalidPath = await runCli([
    "engines",
    "set",
    "--engine",
    "codex_cli",
    "--path",
    privatePath,
    "--state-dir",
    stateDir,
  ]);
  assert.equal(invalidPath.code, 64);
  assert.equal(invalidPath.stderr.includes(privatePath), false);

  const invalidEngine = await runCli([
    "engines",
    "set",
    "--engine",
    "open_code",
    "--path",
    "/opt/nexus/bin/open-code",
    "--state-dir",
    stateDir,
  ]);
  assert.equal(invalidEngine.code, 64);
  assert.equal(invalidEngine.stderr.includes("/opt/nexus"), false);

  const invalidCommand = await runCli(["engines", "probe"]);
  assert.equal(invalidCommand.code, 64);
});

test("engines commands share the runner state lock and fail closed", async (t) => {
  const stateDir = await fixture(t);
  const initial = await runCli([
    "engines",
    "inspect",
    "--state-dir",
    stateDir,
  ]);
  assert.equal(initial.code, 0, initial.stderr);
  await writeFile(
    join(stateDir, "outbox.lock"),
    `${JSON.stringify({
      pid: process.pid,
      startedAt: "2026-07-26T12:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
  const locked = await runCli([
    "engines",
    "inspect",
    "--state-dir",
    stateDir,
  ]);
  assert.equal(locked.code, 3);
  assert.match(locked.stderr, /Another runner process/u);

  await rm(join(stateDir, "outbox.lock"));
  await writeFile(
    join(stateDir, "engines.json"),
    '{"engines":{},"schemaVersion":1}\n',
    { mode: 0o644 },
  );
  const unsafe = await runCli([
    "engines",
    "inspect",
    "--state-dir",
    stateDir,
  ]);
  assert.equal(unsafe.code, 78);
  assert.match(unsafe.stderr, /invalid or unsafe/u);
  assert.equal(unsafe.stderr.includes(stateDir), false);
});

test("engines commands keep internal failures in the locked exit set", async (t) => {
  const stateDir = await fixture(t);
  const notDirectory = join(stateDir, "not-a-directory");
  await writeFile(notDirectory, "occupied", { mode: 0o600 });
  const invalidState = await runCli([
    "engines",
    "inspect",
    "--state-dir",
    notDirectory,
  ]);
  assert.equal(invalidState.code, 78);

  const absent = join(
    process.cwd(),
    `.engine-home-failure-${process.pid}-${Date.now()}`,
  );
  const invalidHome = await runCli(
    [
      "engines",
      "report",
      "--dry-run",
      "--state-dir",
      absent,
    ],
    { HOME: "/" },
  );
  assert.equal(invalidHome.code, 78);
  assert.equal(invalidHome.code === 1 || invalidHome.code === 73, false);
});

async function fixture(t) {
  const stateDir = await mkdtemp(
    join(process.cwd(), ".nexus-engine-cli-"),
  );
  await chmod(stateDir, 0o700);
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

function runCli(args, extraEnvironment = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH, ...extraEnvironment },
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
