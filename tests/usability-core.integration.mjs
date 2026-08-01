import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = process.cwd();
const statePath = mkdtempSync(join(tmpdir(), "nexusos-usability-core-"));
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const launcherPath = join(projectRoot, "scripts", "usable-local.mjs");
const requestPaths = [];
let launcher;
let launcherOutput = "";

const suffix = crypto.randomUUID().slice(0, 8);
const records = {};
const artifactV2Content =
  "# Usability acceptance\n\nPersistence survived a safe restart.";
const intentSummary = `Usability restart proof ${suffix}`;
const intentIdempotencyKey = `usable-local:${suffix}`;

try {
  launcher = startLauncher();
  await waitForReady(launcher);

  const emptyWorkspace = await getJson("/api/workspace");
  assert.equal(emptyWorkspace.setupRequired, true);
  assert.deepEqual(emptyWorkspace.projects, []);
  assert.deepEqual(emptyWorkspace.teams, []);
  assert.deepEqual(emptyWorkspace.agents, []);
  assert.deepEqual(emptyWorkspace.connections, []);
  assert.deepEqual(emptyWorkspace.objectives, []);
  assert.deepEqual(emptyWorkspace.workItems, []);
  assert.notEqual(emptyWorkspace.organization.name, "Aurora Local");
  assert.equal(typeof emptyWorkspace.currentPrincipal.id, "string");
  const emptyConversations = await getJson("/api/conversations");
  assert.deepEqual(emptyConversations.conversations, []);

  const hostileExtraField = await request("/api/setup", {
    method: "POST",
    body: JSON.stringify({
      workspaceName: "Rejected workspace",
      ownerName: "Rejected owner",
      project: {
        name: "Rejected project",
        objective: "Must not mutate setup state.",
      },
      team: {
        name: "Rejected team",
        mission: "Must not mutate setup state.",
      },
      unexpected: true,
    }),
  });
  assert.equal(hostileExtraField.status, 400);
  assert.deepEqual(await hostileExtraField.json(), {
    error: "invalid_setup_body",
  });
  const hostileSlug = await request("/api/setup", {
    method: "POST",
    body: JSON.stringify({
      workspaceName: "🧨",
      ownerName: "Rejected owner",
      project: {
        name: "Rejected project",
        objective: "Must not mutate setup state.",
      },
      team: {
        name: "Rejected team",
        mission: "Must not mutate setup state.",
      },
    }),
  });
  assert.equal(hostileSlug.status, 400);
  assert.deepEqual(await hostileSlug.json(), {
    error: "invalid_workspaceName_slug",
  });
  const hostileControl = await request("/api/setup", {
    method: "POST",
    body: JSON.stringify({
      workspaceName: "Rejected workspace",
      ownerName: "Rejected\u0000owner",
      project: {
        name: "Rejected project",
        objective: "Must not mutate setup state.",
      },
      team: {
        name: "Rejected team",
        mission: "Must not mutate setup state.",
      },
    }),
  });
  assert.equal(hostileControl.status, 400);
  assert.deepEqual(await hostileControl.json(), {
    error: "invalid_ownerName",
  });
  assert.equal((await getJson("/api/workspace")).setupRequired, true);

  const setupInput = {
    workspaceName: `Operação Ágil ${suffix}`,
    ownerName: `Owner ${suffix}`,
    project: {
      name: `Projeto Inicial ${suffix}`,
      objective: "Establish a real project from a clean local database.",
    },
    team: {
      name: `Time Núcleo ${suffix}`,
      mission: "Own the first persisted NexusOS operating loop.",
    },
  };
  const setupRace = await Promise.all([
    request("/api/setup", {
      method: "POST",
      body: JSON.stringify(setupInput),
    }),
    request("/api/setup", {
      method: "POST",
      body: JSON.stringify(setupInput),
    }),
  ]);
  assert.deepEqual(
    setupRace.map((response) => response.status).sort(),
    [201, 409],
  );
  const setupSuccess = setupRace.find((response) => response.status === 201);
  const setupConflict = setupRace.find((response) => response.status === 409);
  assert.ok(setupSuccess);
  assert.ok(setupConflict);
  records.setup = await setupSuccess.json();
  assert.deepEqual(await setupConflict.json(), {
    error: "setup_already_completed",
  });
  assert.equal(records.setup.setupRequired, false);
  assert.equal(records.setup.organization.name, setupInput.workspaceName);
  assert.match(records.setup.organization.slug, /^operacao-agil-/u);
  assert.equal(records.setup.currentPrincipal.displayName, setupInput.ownerName);
  assert.equal(records.setup.currentPrincipal.role, "owner");
  assert.equal(records.setup.projects.length, 1);
  assert.equal(records.setup.projects[0].name, setupInput.project.name);
  assert.equal(records.setup.teams.length, 1);
  assert.equal(records.setup.teams[0].name, setupInput.team.name);
  assert.ok(
    records.setup.assignments.some(
      (assignment) =>
        assignment.team_id === records.setup.teams[0].id &&
        assignment.principal_id === records.setup.currentPrincipal.id,
    ),
  );
  assert.deepEqual(records.setup.agents, []);
  assert.deepEqual(records.setup.connections, []);

  const secondSetup = await request("/api/setup", {
    method: "POST",
    body: JSON.stringify(setupInput),
  });
  assert.equal(secondSetup.status, 409);
  assert.deepEqual(await secondSetup.json(), {
    error: "setup_already_completed",
  });
  const invalidRetry = await request("/api/setup", {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(invalidRetry.status, 409);
  assert.deepEqual(await invalidRetry.json(), {
    error: "setup_already_completed",
  });

  records.project = await postJson("/api/workspace/projects", {
    slug: `usable-project-${suffix}`,
    name: `Usable project ${suffix}`,
    objective: "Prove the local product journey across a safe restart.",
  });
  records.team = await postJson("/api/workspace/teams", {
    projectId: records.project.id,
    slug: `usable-team-${suffix}`,
    name: `Usable team ${suffix}`,
    mission: "Operate the persisted local acceptance journey.",
  });
  records.agent = await postJson("/api/workspace/agents", {
    teamId: records.team.id,
    connectionId: null,
    slug: `usable-agent-${suffix}`,
    name: `Usable agent ${suffix}`,
    role: "Acceptance witness",
    model: "Declared only; no LLM invoked",
    memoryScope: "project",
    autonomyLevel: "A0",
  });

  const localPrincipalId = records.setup.currentPrincipal.id;
  assert.equal(typeof localPrincipalId, "string");
  records.conversation = await postJson("/api/conversations", {
    kind: "direct",
    title: `Acceptance DM ${suffix}`,
    projectId: records.project.id,
    memberIds: [localPrincipalId, records.agent.principalId],
  });
  records.message = await postJson(
    `/api/conversations/${records.conversation.id}/messages`,
    {
      bodyText:
        "This is a persisted DM acceptance message. It does not invoke an LLM.",
    },
  );

  records.objective = await postJson("/api/workspace/objectives", {
    projectId: records.project.id,
    title: `Usability objective ${suffix}`,
    description: "Provide the work-item anchor required by artifacts.",
    priority: "p0",
  });
  records.workItem = await postJson("/api/workspace/work-items", {
    projectId: records.project.id,
    objectiveId: records.objective.id,
    assigneeId: records.agent.principalId,
    kind: "story",
    title: `Usability work item ${suffix}`,
    description: "Carry a versioned output through restart.",
    priority: "p0",
  });
  records.artifact = await postJson(
    `/api/work-items/${records.workItem.id}/artifacts`,
    {
      title: `Usability artifact ${suffix}`,
      mediaType: "text/markdown",
      note: "Initial acceptance version",
      content: "# Usability acceptance\n\nInitial persisted version.",
    },
  );
  records.artifactVersion = await postJson(
    `/api/artifacts/${records.artifact.id}/versions`,
    {
      expectedVersion: 1,
      note: "Restart proof",
      content: artifactV2Content,
    },
  );
  assert.equal(records.artifactVersion.versionNumber, 2);

  const proposalResponse = await request("/api/governance/intents", {
    method: "POST",
    headers: { "idempotency-key": intentIdempotencyKey },
    body: JSON.stringify({ summary: intentSummary }),
  });
  assert.equal(proposalResponse.status, 201);
  records.proposal = await proposalResponse.json();
  assert.equal(records.proposal.created, true);
  assert.equal(records.proposal.intent.status, "proposed");
  const initialGovernance = await getJson(
    `/api/governance/intents?intentId=${records.proposal.intent.id}`,
  );
  assert.equal(initialGovernance.verification.valid, true);
  assert.ok(
    initialGovernance.ledger.some(
      (entry) => entry.intentId === records.proposal.intent.id,
    ),
  );

  await stopLauncher(launcher, { exerciseEscalation: true });
  launcher = startLauncher();
  await waitForReady(launcher);

  const workspaceAfterRestart = await getJson("/api/workspace");
  assert.equal(workspaceAfterRestart.setupRequired, false);
  assert.equal(
    workspaceAfterRestart.organization.name,
    setupInput.workspaceName,
  );
  assert.equal(
    workspaceAfterRestart.currentPrincipal.displayName,
    setupInput.ownerName,
  );
  assert.equal(workspaceAfterRestart.currentPrincipal.role, "owner");
  assert.ok(
    workspaceAfterRestart.projects.some(
      (project) => project.id === records.project.id,
    ),
  );
  assert.ok(
    workspaceAfterRestart.teams.some((team) => team.id === records.team.id),
  );
  const persistedAgent = workspaceAfterRestart.agents.find(
    (agent) => agent.id === records.agent.id,
  );
  assert.equal(persistedAgent?.principal_id, records.agent.principalId);
  assert.deepEqual(persistedAgent?.teamIds, [records.team.id]);

  const conversationsAfterRestart = await getJson("/api/conversations");
  const persistedConversation = conversationsAfterRestart.conversations.find(
    (conversation) => conversation.id === records.conversation.id,
  );
  assert.equal(
    persistedConversation?.latestMessage?.bodyText,
    "This is a persisted DM acceptance message. It does not invoke an LLM.",
  );
  const messagesAfterRestart = await getJson(
    `/api/conversations/${records.conversation.id}/messages?afterSequence=0`,
  );
  assert.ok(
    messagesAfterRestart.messages.some(
      (message) => message.id === records.message.id,
    ),
  );

  const artifactAfterRestart = await getJson(
    `/api/artifacts/${records.artifact.id}`,
  );
  assert.equal(artifactAfterRestart.currentVersion, 2);
  const artifactVersionAfterRestart = await getJson(
    `/api/artifacts/${records.artifact.id}/versions/2`,
  );
  assert.equal(artifactVersionAfterRestart.content, artifactV2Content);

  const governanceAfterRestart = await getJson(
    `/api/governance/intents?intentId=${records.proposal.intent.id}`,
  );
  assert.equal(governanceAfterRestart.verification.valid, true);
  assert.ok(
    governanceAfterRestart.intents.some(
      (intent) => intent.id === records.proposal.intent.id,
    ),
  );
  assert.ok(
    governanceAfterRestart.ledger.some(
      (entry) => entry.intentId === records.proposal.intent.id,
    ),
  );

  const idempotentProposal = await request("/api/governance/intents", {
    method: "POST",
    headers: { "idempotency-key": intentIdempotencyKey },
    body: JSON.stringify({ summary: intentSummary }),
  });
  assert.equal(idempotentProposal.status, 200);
  const idempotentProposalBody = await idempotentProposal.json();
  assert.equal(idempotentProposalBody.created, false);
  assert.equal(
    idempotentProposalBody.intent.id,
    records.proposal.intent.id,
  );

  const runnersAfterRestart = await getJson("/api/runners");
  assert.equal(runnersAfterRestart.audience, baseUrl);
  assert.equal(
    requestPaths.some(
      (path) =>
        path.startsWith("/api/runs") ||
        path.startsWith("/api/providers/cli-session-observation"),
    ),
    false,
    "the usability acceptance must not invoke a runner or an LLM session",
  );

  process.stdout.write(
    "Usability core integration passed across a safe restart with no LLM invocation.\n",
  );
} finally {
  if (launcher?.exitCode === null) {
    await stopLauncher(launcher).catch(() => undefined);
  }
  rmSync(statePath, { recursive: true, force: true });
}

function startLauncher() {
  const child = spawn(
    process.execPath,
    [
      launcherPath,
      "--port",
      String(port),
      "--state-dir",
      statePath,
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NEXUS_ALLOW_TEST_IDENTITIES: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", captureLauncherOutput);
  child.stderr.on("data", captureLauncherOutput);
  return child;
}

async function waitForReady(child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `launcher exited early (${child.exitCode})\n${launcherOutput}`,
      );
    }
    try {
      const [healthResponse, workspaceResponse, runnersResponse] =
        await Promise.all([
          fetch(`${baseUrl}/api/system/health`),
          fetch(`${baseUrl}/api/workspace`),
          fetch(`${baseUrl}/api/runners`),
        ]);
      if (
        healthResponse.ok &&
        workspaceResponse.ok &&
        runnersResponse.ok
      ) {
        const [health, workspace, runners] = await Promise.all([
          healthResponse.json(),
          workspaceResponse.json(),
          runnersResponse.json(),
        ]);
        if (
          health.status === "ok" &&
          health.database === "ready" &&
          Array.isArray(workspace.projects) &&
          runners.audience === baseUrl
        ) {
          return;
        }
      }
    } catch {
      // Startup polling is expected to fail before the listener is ready.
    }
    await delay(250);
  }
  throw new Error(`launcher was not ready within 120 seconds\n${launcherOutput}`);
}

async function stopLauncher(child, { exerciseEscalation = false } = {}) {
  if (child.exitCode !== null) return;
  const exit = new Promise((resolveExit) =>
    child.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
  child.kill("SIGTERM");
  if (exerciseEscalation) {
    await waitForLauncherOutput(/NexusOS shutdown signal acknowledged\./u);
    // The server may finish between acknowledgement and delivery. Both a
    // handled escalation and an already-complete graceful stop are safe.
    child.kill("SIGTERM");
  }
  const result = await Promise.race([
    exit,
    delay(12_000).then(() => ({ timeout: true })),
  ]);
  if ("timeout" in result) {
    child.kill("SIGKILL");
    throw new Error(`launcher did not stop safely\n${launcherOutput}`);
  }
  assert.equal(result.signal, null);
  assert.equal(result.code, 143);
}

async function waitForLauncherOutput(pattern) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (pattern.test(launcherOutput)) return;
    await delay(10);
  }
  throw new Error(
    `launcher did not acknowledge the first shutdown signal\n${launcherOutput}`,
  );
}

async function request(path, init = {}) {
  requestPaths.push(path);
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function postJson(path, body) {
  const response = await request(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  assert.ok(
    response.ok,
    `${path} failed with ${response.status}: ${JSON.stringify(payload)}`,
  );
  return payload;
}

async function getJson(path) {
  const response = await request(path);
  const payload = await response.json().catch(() => ({}));
  assert.ok(
    response.ok,
    `${path} failed with ${response.status}: ${JSON.stringify(payload)}`,
  );
  return payload;
}

function captureLauncherOutput(chunk) {
  launcherOutput = `${launcherOutput}${chunk}`.slice(-40_000);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const selectedPort = address.port;
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return selectedPort;
}
