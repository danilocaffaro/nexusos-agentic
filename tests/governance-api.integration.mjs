import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = Number(process.env.NEXUS_TEST_PORT ?? "3911");
const externalBaseUrl = process.env.NEXUS_TEST_BASE_URL;
const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${port}`;
let server;
let serverOutput = "";

try {
  if (!externalBaseUrl) {
    await runCommand("npm", ["run", "db:migrate:local"]);
    server = spawn(
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
        WRANGLER_LOG_PATH: ".wrangler/wrangler-integration.log",
      },
      stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout.on("data", captureServerOutput);
    server.stderr.on("data", captureServerOutput);
    await waitForHealthyServer();
  }

  const summary = `integration-${crypto.randomUUID()}`;
  const idempotencyKey = `integration:${crypto.randomUUID()}`;
  const missingKeyResponse = await request("/api/governance/intents", {
    method: "POST",
    body: JSON.stringify({ summary }),
  });
  assert.equal(missingKeyResponse.status, 400);

  const proposedResponse = await request("/api/governance/intents", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({ summary }),
  });
  assert.equal(proposedResponse.status, 201);
  const proposed = await proposedResponse.json();
  assert.equal(proposed.intent.status, "proposed");
  assert.equal(proposed.intent.parameters.summary, summary);
  assert.equal(proposed.created, true);

  const retriedProposalResponse = await request("/api/governance/intents", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({ summary }),
  });
  assert.equal(retriedProposalResponse.status, 200);
  const retriedProposal = await retriedProposalResponse.json();
  assert.equal(retriedProposal.intent.id, proposed.intent.id);
  assert.equal(retriedProposal.created, false);

  const conflictingRetry = await request("/api/governance/intents", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({ summary: `${summary}-changed` }),
  });
  assert.equal(conflictingRetry.status, 422);

  const intentId = proposed.intent.id;
  const mismatchedApproval = await request(
    `/api/governance/intents/${intentId}/approve`,
    {
      method: "POST",
      body: JSON.stringify({ parametersHash: "0".repeat(64) }),
    },
  );
  assert.equal(mismatchedApproval.status, 409);

  const approvedResponse = await request(
    `/api/governance/intents/${intentId}/approve`,
    {
      method: "POST",
      body: JSON.stringify({
        parametersHash: proposed.intent.parametersHash,
      }),
    },
  );
  assert.equal(approvedResponse.status, 200);
  const approved = await approvedResponse.json();
  assert.equal(approved.intent.status, "approved");

  const executedResponse = await request(
    `/api/governance/intents/${intentId}/execute`,
    { method: "POST" },
  );
  assert.equal(executedResponse.status, 200);
  const executed = await executedResponse.json();
  assert.equal(executed.intent.status, "succeeded");
  assert.equal(executed.receipt.kind, "simulated");

  const duplicateExecution = await request(
    `/api/governance/intents/${intentId}/execute`,
    { method: "POST" },
  );
  assert.equal(duplicateExecution.status, 409);

  const stateResponse = await request("/api/governance/intents");
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.verification.valid, true);
  assert.equal(
    state.intents.some(
      (intent) => intent.id === intentId && intent.status === "succeeded",
    ),
    true,
  );
  assert.equal(
    state.ledger.filter((entry) => entry.intentId === intentId).length,
    4,
  );

  process.stdout.write(
    `Governance API integration passed for intent ${intentId}\n`,
  );
} finally {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (server.exitCode === null) {
      server.kill("SIGKILL");
    }
  }
}

async function waitForHealthyServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(
        `Integration server exited early (${server?.exitCode}).\n${serverOutput}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/system/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Startup polling is expected to fail until the server begins listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Integration server was not healthy within 90 seconds.\n${serverOutput}`,
  );
}

async function request(path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

function captureServerOutput(chunk) {
  serverOutput = `${serverOutput}${chunk}`.slice(-12_000);
}
