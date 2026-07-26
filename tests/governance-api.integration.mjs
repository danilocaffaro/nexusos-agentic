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

  const initialWorkspaceResponse = await request("/api/workspace");
  assert.equal(initialWorkspaceResponse.status, 200);
  const initialWorkspace = await initialWorkspaceResponse.json();
  assert.equal(
    initialWorkspace.projects.some(
      (project) => project.slug === "nexus-commerce",
    ),
    true,
  );
  assert.equal(
    initialWorkspace.agents.some((agent) => agent.slug === "atlas"),
    true,
  );

  const workspaceSuffix = crypto.randomUUID().slice(0, 8);
  const secretConnectionResponse = await request(
    "/api/workspace/connections",
    {
      method: "POST",
      body: JSON.stringify({
        provider: "Anthropic",
        authMethod: "cli",
        label: `unsafe-${workspaceSuffix}`,
        metadata: { access_token: "must-not-persist" },
      }),
    },
  );
  assert.equal(secretConnectionResponse.status, 400);

  const connectionResponse = await request("/api/workspace/connections", {
    method: "POST",
    body: JSON.stringify({
      provider: "Anthropic",
      authMethod: "cli",
      label: `integration-${workspaceSuffix}`,
      metadata: { cliPath: "claude", poolLabel: "integration" },
    }),
  });
  assert.equal(connectionResponse.status, 201);
  const connection = await connectionResponse.json();

  const firstProjectResponse = await request("/api/workspace/projects", {
    method: "POST",
    body: JSON.stringify({
      slug: `project-a-${workspaceSuffix}`,
      name: `Project A ${workspaceSuffix}`,
      objective: "Validate persistent hybrid-team workspace behavior",
    }),
  });
  assert.equal(firstProjectResponse.status, 201);
  const firstProject = await firstProjectResponse.json();

  const secondProjectResponse = await request("/api/workspace/projects", {
    method: "POST",
    body: JSON.stringify({
      slug: `project-b-${workspaceSuffix}`,
      name: `Project B ${workspaceSuffix}`,
      objective: "Validate project-scoped team slugs",
    }),
  });
  assert.equal(secondProjectResponse.status, 201);
  const secondProject = await secondProjectResponse.json();

  const teamPayload = {
    slug: `shared-team-${workspaceSuffix}`,
    name: `Integration Team ${workspaceSuffix}`,
    mission: "Exercise workspace isolation and optimistic concurrency",
  };
  const firstTeamResponse = await request("/api/workspace/teams", {
    method: "POST",
    body: JSON.stringify({
      ...teamPayload,
      projectId: firstProject.id,
    }),
  });
  assert.equal(firstTeamResponse.status, 201);
  const firstTeam = await firstTeamResponse.json();

  const duplicateTeamResponse = await request("/api/workspace/teams", {
    method: "POST",
    body: JSON.stringify({
      ...teamPayload,
      projectId: firstProject.id,
    }),
  });
  assert.equal(duplicateTeamResponse.status, 409);

  const secondTeamResponse = await request("/api/workspace/teams", {
    method: "POST",
    body: JSON.stringify({
      ...teamPayload,
      projectId: secondProject.id,
    }),
  });
  assert.equal(secondTeamResponse.status, 201);

  const agentPayload = {
    teamId: firstTeam.id,
    connectionId: connection.id,
    slug: `agent-${workspaceSuffix}`,
    name: `Integration Agent ${workspaceSuffix}`,
    role: "Workspace verifier",
    model: "Claude Opus",
    memoryScope: "project",
    autonomyLevel: "A1",
  };
  const agentResponse = await request("/api/workspace/agents", {
    method: "POST",
    body: JSON.stringify(agentPayload),
  });
  assert.equal(agentResponse.status, 201);
  const agent = await agentResponse.json();

  const duplicateAgentResponse = await request("/api/workspace/agents", {
    method: "POST",
    body: JSON.stringify({
      ...agentPayload,
      name: `${agentPayload.name} duplicate`,
    }),
  });
  assert.equal(duplicateAgentResponse.status, 409);

  const workspaceAfterDuplicate = await (
    await request("/api/workspace")
  ).json();
  assert.equal(
    workspaceAfterDuplicate.agents.filter(
      (candidate) => candidate.slug === agentPayload.slug,
    ).length,
    1,
  );

  const agentUpdateResponse = await request(
    `/api/workspace/agents/${agent.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: 1,
        role: "Senior workspace verifier",
      }),
    },
  );
  assert.equal(
    agentUpdateResponse.status,
    200,
    agentUpdateResponse.status === 200
      ? undefined
      : await agentUpdateResponse.text(),
  );
  const updatedAgent = await agentUpdateResponse.json();
  assert.equal(updatedAgent.version, 2);

  const staleAgentUpdate = await request(
    `/api/workspace/agents/${agent.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: 1, role: "Stale writer" }),
    },
  );
  assert.equal(staleAgentUpdate.status, 409);

  const blockedConnectionArchive = await request(
    `/api/workspace/connections/${connection.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: 1, status: "archived" }),
    },
  );
  assert.equal(blockedConnectionArchive.status, 409);

  const blockedProjectArchive = await request(
    `/api/workspace/projects/${firstProject.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: 1, status: "archived" }),
    },
  );
  assert.equal(blockedProjectArchive.status, 409);

  const blockedTeamArchive = await request(
    `/api/workspace/teams/${firstTeam.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: 1, status: "archived" }),
    },
  );
  assert.equal(blockedTeamArchive.status, 409);

  const agentArchive = await request(`/api/workspace/agents/${agent.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedVersion: 2, status: "archived" }),
  });
  assert.equal(agentArchive.status, 200);

  const teamArchive = await request(`/api/workspace/teams/${firstTeam.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedVersion: 1, status: "archived" }),
  });
  assert.equal(teamArchive.status, 200);

  const projectArchive = await request(
    `/api/workspace/projects/${firstProject.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: 1, status: "archived" }),
    },
  );
  assert.equal(projectArchive.status, 200);

  const connectionArchive = await request(
    `/api/workspace/connections/${connection.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: 1, status: "archived" }),
    },
  );
  assert.equal(connectionArchive.status, 200);

  process.stdout.write(
    `Governance and workspace API integration passed for intent ${intentId}\n`,
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
