import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { writeEngineConfiguration } from "../runner/engine-config-store.mjs";
import { parseEngineReportBody } from "../runner/engine-report-contract.mjs";

const cli = new URL("../runner/nexus-runner.mjs", import.meta.url).pathname;

test("engines report dry-run needs no state and has no side effects", async () => {
  const absent = join(
    process.cwd(),
    `.engine-report-absent-${process.pid}-${Date.now()}`,
  );
  const result = await runCli([
    "engines",
    "report",
    "--dry-run",
    "--state-dir",
    absent,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const report = parseEngineReportBody(result.stdout.trimEnd());
  assert.ok(report);
  assert.deepEqual(
    report.engines.map(({ engine, readiness, reason, status }) => ({
      engine,
      readiness,
      reason,
      status,
    })),
    [
      {
        engine: "claude_code_cli",
        readiness: "attention_required",
        reason: "engine_not_configured",
        status: "unavailable",
      },
      {
        engine: "codex_cli",
        readiness: "attention_required",
        reason: "engine_not_configured",
        status: "unavailable",
      },
    ],
  );
  await assert.rejects(stat(absent), { code: "ENOENT" });

  const server = await runCli([
    "engines",
    "report",
    "--dry-run",
    "--server",
    "https://nexus.example",
  ]);
  assert.equal(server.code, 64);
  assert.match(server.stderr, /not used with --dry-run/u);
});

test("engines report dry-run probes a configured CLI without leaking paths", async (t) => {
  const fixture = await safeFixture(t);
  const executable = join(fixture.bin, "claude");
  await writeFile(
    executable,
    `#!/bin/sh
case "$1" in
  --version)
    printf '%s\\n' '2.1.219 (Claude Code)'
    ;;
  --help)
    printf '%s\\n' '--print --safe-mode --disable-slash-commands --no-chrome --no-session-persistence --permission-mode --tools --strict-mcp-config --mcp-config --settings --output-format'
    ;;
  auth)
    printf '%s\\n' '{"loggedIn":true}'
    ;;
  *)
    exit 64
    ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  await writeEngineConfiguration(fixture.stateDir, {
    engines: {
      claude_code_cli: { executablePath: executable },
    },
    schemaVersion: 1,
  });
  const before = await tree(fixture.root);
  const result = await runCli([
    "engines",
    "report",
    "--dry-run",
    "--state-dir",
    fixture.stateDir,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const report = parseEngineReportBody(result.stdout.trimEnd());
  assert.ok(report);
  assert.deepEqual(report.engines[0], {
    engine: "claude_code_cli",
    readiness: "ready",
    reason: "none",
    status: "available",
    version: "2.1.219 (Claude Code)",
  });
  assert.equal(result.stdout.includes(fixture.root), false);
  assert.equal(result.stderr.includes(fixture.root), false);
  assert.equal(result.stdout.includes("loggedIn"), false);
  assert.deepEqual(await tree(fixture.root), before);
});

test("engines report rejects a private cwd below an unsafe parent", async (t) => {
  const fixture = await safeFixture(t);
  const shared = join(fixture.root, "shared");
  const stateDir = join(shared, "state");
  await mkdir(shared, { mode: 0o770 });
  await chmod(shared, 0o770);
  await mkdir(stateDir, { mode: 0o700 });
  await writeEngineConfiguration(stateDir, {
    engines: {
      codex_cli: {
        executablePath: "/opt/nexus/definitely-missing-codex",
      },
    },
    schemaVersion: 1,
  });
  const result = await runCli([
    "engines",
    "report",
    "--dry-run",
    "--state-dir",
    stateDir,
  ]);
  assert.equal(result.code, 78);
  assert.match(result.stderr, /private engine probe directory/u);
  assert.equal(
    (await readdir(stateDir)).some((name) =>
      name.startsWith(".engine-probe-"),
    ),
    false,
  );
});

test("engines report delivery requires an enrolled runner", async () => {
  const result = await runCli(["engines", "report"]);
  assert.equal(result.code, 66);
  assert.match(result.stderr, /enroll/u);
});

async function safeFixture(t) {
  const root = await mkdtemp(join(process.cwd(), ".engine-report-cli-"));
  await chmod(root, 0o700);
  const bin = join(root, "bin");
  const stateDir = join(root, "state");
  await mkdir(bin, { mode: 0o700 });
  await mkdir(stateDir, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { bin, root, stateDir };
}

async function tree(root) {
  const result = [];
  async function visit(path, relative) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      const childRelative = join(relative, name);
      const metadata = await stat(child);
      result.push({
        path: childRelative,
        mode: metadata.mode & 0o777,
        size: metadata.size,
      });
      if (metadata.isDirectory()) await visit(child, childRelative);
      else result.at(-1).contents = await readFile(child, "utf8");
    }
  }
  await visit(root, "");
  return result;
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
