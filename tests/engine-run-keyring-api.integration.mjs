import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnIntegrationProcess,
  stopIntegrationProcess,
} from "./helpers/integration-process.mjs";

const port = Number(process.env.NEXUS_ENGINE_KEYRING_TEST_PORT ?? "3917");
const baseUrl = `http://127.0.0.1:${port}`;
const persistPath = mkdtempSync(
  join(tmpdir(), "nexusos-engine-keyring-integration-"),
);
let server;
let serverOutput = "";

try {
  await runCommand("npx", [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    "wrangler.local.jsonc",
    "--persist-to",
    persistPath,
  ]);
  server = spawnIntegrationProcess(
    "npx",
    [
      "vinext",
      "dev",
      "--port",
      String(port),
      "--hostname",
      "127.0.0.1",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXUS_PERSIST_STATE_PATH: persistPath,
        NEXUS_PROMPT_CIPHER_KEYS: "{\"malformed\":true}",
        WRANGLER_LOG_PATH: ".wrangler/wrangler-engine-keyring.log",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", captureServerOutput);
  server.stderr.on("data", captureServerOutput);
  await waitForHealthyServer();

  const before = await creationRowCounts();
  const prompt = "ENGINE-KEYRING-FAILURE-SENTINEL";
  const response = await fetch(`${baseUrl}/api/runs/engine`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `ecr_${"1".repeat(32)}`,
    },
    body: JSON.stringify({
      assignedRunnerId: `rnr_${"1".repeat(32)}`,
      engine: "claude_code_cli",
      prompt,
    }),
  });
  assert.equal(response.status, 503);
  const responseText = await response.text();
  assert.equal(responseText, '{"error":"prompt_cipher_key_unavailable"}');
  assert.equal(responseText.includes(prompt), false);
  assert.deepEqual(await creationRowCounts(), before);
  assert.equal(serverOutput.includes(prompt), false);

  process.stdout.write(
    "Engine keyring failure integration passed with zero creation rows.\n",
  );
} finally {
  await stopIntegrationProcess(server);
  rmSync(persistPath, { recursive: true, force: true });
}

async function creationRowCounts() {
  const [counts] = await queryLocalD1(
    `SELECT
       (SELECT COUNT(*) FROM engine_run_creations) AS resolutions,
       (SELECT COUNT(*) FROM runs) AS runs,
       (SELECT COUNT(*) FROM run_prompts) AS prompts,
       (SELECT COUNT(*) FROM run_events) AS events,
       (SELECT COUNT(*) FROM ledger_entries) AS ledger`,
  );
  return counts;
}

async function waitForHealthyServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(
        `Engine keyring server exited early (${server?.exitCode}).\n${serverOutput}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/system/health`);
      if (response.ok) return;
    } catch {
      // Startup polling is expected to fail until the server is listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Engine keyring server was not healthy within 90 seconds.\n${serverOutput}`,
  );
}

function captureServerOutput(chunk) {
  serverOutput = `${serverOutput}${chunk}`.slice(-40_000);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} failed (${code}):\n${output}`));
    });
  });
}

async function queryLocalD1(sql) {
  const result = await runCommandResult("npx", [
    "wrangler",
    "d1",
    "execute",
    "DB",
    "--local",
    "--config",
    "wrangler.local.jsonc",
    "--persist-to",
    persistPath,
    "--command",
    sql,
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout)[0]?.results ?? [];
}

function runCommandResult(command, args) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
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
    child.once("error", rejectResult);
    child.once("close", (code) => {
      resolveResult({ code, stdout, stderr });
    });
  });
}
