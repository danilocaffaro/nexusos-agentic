import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceScript = fileURLToPath(
  new URL("../scripts/local-engine-ready.mjs", import.meta.url),
);
const RUN_ID = `run_${"a".repeat(32)}`;
const TOKEN = "enr_test_secret_must_never_be_logged";

test("guided bootstrap keeps private state local, reports readiness, and starts only the explicit run", async (t) => {
  const fixture = await createFixture(t);
  const result = await runBootstrap(
    fixture,
    [
      "--engine",
      "claude_code_cli",
      "--path",
      fixture.enginePath,
      "--server",
      "http://127.0.0.1:3002",
      "--name",
      "acceptance-runner",
      "--token-stdin",
      "--run",
      RUN_ID,
    ],
    TOKEN,
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Claude Code CLI: available\/ready/u);
  assert.match(result.stdout, new RegExp(`Iniciando somente ${RUN_ID}`, "u"));
  assert.equal(result.stdout.includes(TOKEN), false);
  assert.equal(result.stderr.includes(TOKEN), false);
  assert.equal(result.stdout.includes(fixture.enginePath), false);
  assert.equal(result.stderr.includes(fixture.enginePath), false);

  const calls = await readCalls(fixture);
  assert.deepEqual(
    calls.map((call) => call.slice(0, 2)),
    [
      ["enroll", "--server"],
      ["engines", "set"],
      ["engines", "report"],
      ["heartbeat", "--server"],
      ["report-capabilities", "--server"],
      ["engines", "report"],
      ["serve", "--server"],
    ],
  );
  assert.equal(
    calls.some((call) => call.includes(TOKEN)),
    false,
    "the enrollment token must never enter argv",
  );
  const serve = calls.at(-1);
  assert.ok(serve.includes("--run"));
  assert.ok(serve.includes(RUN_ID));
  assert.ok(serve.includes("--engine"));
  assert.ok(serve.includes("claude_code_cli"));
  assert.equal((await stat(fixture.privateRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(fixture.stateDir)).mode & 0o777, 0o700);
  await assert.rejects(stat(join(fixture.home, ".nexusos")), {
    code: "ENOENT",
  });

  const second = await runBootstrap(fixture, [
    "--engine",
    "claude_code_cli",
    "--path",
    fixture.enginePath,
  ]);
  assert.equal(second.code, 0, second.stderr);
  const secondCalls = await readCalls(fixture);
  assert.equal(
    secondCalls.filter((call) => call[0] === "enroll").length,
    1,
    "an existing project-local enrollment must be reused",
  );
});

test("bootstrap fails closed on CLI auth attention before publishing or serving", async (t) => {
  const fixture = await createFixture(t, {
    readiness: "attention_required",
    reason: "engine_auth_attention_required",
  });
  const result = await runBootstrap(
    fixture,
    [
      "--engine",
      "claude_code_cli",
      "--path",
      fixture.enginePath,
      "--token-stdin",
    ],
    TOKEN,
  );

  assert.equal(result.code, 77);
  assert.match(result.stdout, /attention_required/u);
  assert.match(result.stderr, /login requer atenção/u);
  assert.equal(result.stdout.includes(TOKEN), false);
  assert.equal(result.stderr.includes(TOKEN), false);
  const calls = await readCalls(fixture);
  assert.deepEqual(
    calls.map((call) => call.slice(0, 2)),
    [
      ["enroll", "--server"],
      ["engines", "set"],
      ["engines", "report"],
    ],
  );
});

test("bootstrap rejects secret argv and never repeats the rejected value", async (t) => {
  const fixture = await createFixture(t);
  const result = await runBootstrap(fixture, [
    "--engine",
    "claude_code_cli",
    "--path",
    fixture.enginePath,
    "--token",
    TOKEN,
  ]);
  assert.equal(result.code, 64);
  assert.match(result.stderr, /Opção não suportada/u);
  assert.equal(result.stdout.includes(TOKEN), false);
  assert.equal(result.stderr.includes(TOKEN), false);
  await assert.rejects(readFile(fixture.callLog), { code: "ENOENT" });
});

test("bootstrap rejects a symlinked private root without chmodding its target", async (t) => {
  const fixture = await createFixture(t);
  const target = join(fixture.root, "foreign-state-target");
  await mkdir(target, { mode: 0o755 });
  await symlink(target, fixture.privateRoot);
  const result = await runBootstrap(fixture, [
    "--engine",
    "claude_code_cli",
    "--path",
    fixture.enginePath,
  ]);
  assert.equal(result.code, 78);
  assert.match(result.stderr, /inválido ou inseguro/u);
  assert.equal((await stat(target)).mode & 0o777, 0o755);
  await assert.rejects(readFile(fixture.callLog), { code: "ENOENT" });
});

async function createFixture(t, engineEvidence = {}) {
  const root = await mkdtemp(join(tmpdir(), "nexus-local-engine-ready-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const scripts = join(root, "scripts");
  const runner = join(root, "runner");
  const home = join(root, "home");
  await mkdir(scripts);
  await mkdir(runner);
  await mkdir(home);
  await copyFile(sourceScript, join(scripts, "local-engine-ready.mjs"));
  const enginePath = join(root, "engine-fixture");
  await writeFile(enginePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(enginePath, 0o700);
  const callLog = join(root, "runner-calls.jsonl");
  await writeFile(
    join(runner, "nexus-runner.mjs"),
    fakeRunnerSource({
      readiness: engineEvidence.readiness ?? "ready",
      reason: engineEvidence.reason ?? "none",
    }),
    { mode: 0o700 },
  );
  return {
    callLog,
    enginePath,
    home,
    privateRoot: join(root, ".nexusos"),
    root,
    script: join(scripts, "local-engine-ready.mjs"),
    stateDir: join(root, ".nexusos", "local-runner"),
  };
}

function fakeRunnerSource({ readiness, reason }) {
  const status = readiness === "ready" ? "available" : "available";
  return `#!/usr/bin/env node
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
await appendFile(process.env.FAKE_RUNNER_LOG, JSON.stringify(args) + "\\n");
const stateIndex = args.indexOf("--state-dir");
const stateDir = stateIndex === -1 ? "" : args[stateIndex + 1];
if (args[0] === "enroll") {
  let token = "";
  for await (const chunk of process.stdin) token += chunk.toString("utf8");
  if (!token.trim()) process.exit(64);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  await writeFile(join(stateDir, "runner.json"), "{}\\n", { mode: 0o600 });
  process.stdout.write('{"status":"enrolled"}\\n');
} else if (
  args[0] === "engines" &&
  args[1] === "report" &&
  args.includes("--dry-run")
) {
  process.stdout.write(JSON.stringify({
    collectedAt: "2026-07-30T00:00:00.000Z",
    engines: [
      {
        engine: "claude_code_cli",
        readiness: ${JSON.stringify(readiness)},
        reason: ${JSON.stringify(reason)},
        status: ${JSON.stringify(status)},
        version: "2.1.219 (Claude Code)"
      },
      {
        engine: "codex_cli",
        readiness: "attention_required",
        reason: "engine_not_configured",
        status: "unavailable"
      }
    ],
    reportId: "egr_00000000000000000000000000000000",
    schemaVersion: 1,
    truncated: false
  }) + "\\n");
} else if (args[0] === "serve") {
  process.stdout.write('{"status":"started"}\\n{"status":"stopped"}\\n');
} else {
  process.stdout.write('{"status":"ok"}\\n');
}
`;
}

async function runBootstrap(fixture, argumentsList, input = "") {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [fixture.script, ...argumentsList], {
      cwd: fixture.root,
      env: {
        ...process.env,
        FAKE_RUNNER_LOG: fixture.callLog,
        HOME: fixture.home,
      },
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
    child.once("error", rejectRun);
    child.once("close", (code) => {
      resolveRun({ code, stderr, stdout });
    });
    child.stdin.end(input ? `${input}\n` : "");
  });
}

async function readCalls(fixture) {
  return (await readFile(fixture.callLog, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
