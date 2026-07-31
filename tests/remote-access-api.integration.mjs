import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnIntegrationProcess,
  stopIntegrationProcess,
} from "./helpers/integration-process.mjs";

const projectRoot = process.cwd();
const statePath = mkdtempSync(join(tmpdir(), "nexusos-remote-access-"));
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const publicOrigin = "https://nexusos.remote.test";
const bootstrapToken = randomBytes(32).toString("base64url");
const bootstrapHash = createHash("sha256")
  .update(bootstrapToken, "utf8")
  .digest("base64url");
const suffix = crypto.randomUUID().slice(0, 8);
const runtimeEnv = {
  ...process.env,
  CI: "1",
  CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
  NEXUS_MESSAGE_INTEGRITY_KEY: randomBytes(48).toString("base64url"),
  NEXUS_PERSIST_STATE_PATH: statePath,
  NEXUS_PUBLIC_ORIGIN: publicOrigin,
  NEXUS_REMOTE_ACCESS: "1",
  NEXUS_REMOTE_BOOTSTRAP_TOKEN_SHA256: bootstrapHash,
  NEXUS_REMOTE_SESSION_TTL_SECONDS: "900",
  WRANGLER_LOG_PATH: ".wrangler/remote-access-integration.log",
};
let server;
let serverOutput = "";
let cookie = "";

try {
  await runCommand(process.execPath, [
    join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    "wrangler.local.jsonc",
    "--persist-to",
    statePath,
  ], runtimeEnv);
  await runCommand(
    process.execPath,
    [join(projectRoot, "node_modules", "vinext", "dist", "cli.js"), "build"],
    runtimeEnv,
  );
  server = spawnIntegrationProcess(
    process.execPath,
    [
      join(projectRoot, "node_modules", "vite", "bin", "vite.js"),
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: projectRoot,
      env: runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", captureServerOutput);
  server.stderr.on("data", captureServerOutput);
  await waitForHealthyServer();

  const status = await getJson("/api/auth/status");
  assert.equal(status.mode, "remote");
  assert.equal(status.activationRequired, true);
  assert.equal(status.authenticated, false);
  assert.equal((await request("/api/workspace")).status, 401);

  const crossOriginActivation = await postJson(
    "/api/auth/activate",
    activationBody(),
    {
      origin: publicOrigin,
      "sec-fetch-site": "cross-site",
    },
  );
  assert.equal(crossOriginActivation.status, 403);
  assert.match(await crossOriginActivation.text(), /forbidden|csrf/iu);

  const activation = await postJson(
    "/api/auth/activate",
    activationBody(),
  );
  assert.equal(activation.status, 201);
  cookie = sessionCookie(activation);
  const activated = await activation.json();
  assert.equal(activated.authenticated, true);
  assert.equal(activated.principal.kind, "human");

  const reuse = await postJson(
    "/api/auth/activate",
    activationBody(),
  );
  assert.equal(reuse.status, 409);
  assert.equal(
    (await reuse.json()).error,
    "activation_already_completed",
  );

  const initialWorkspace = await getJson("/api/workspace", true);
  assert.equal(initialWorkspace.setupRequired, true);
  const setupResponse = await postJson(
    "/api/setup",
    {
      workspaceName: `Remote ${suffix}`,
      ownerName: `Remote owner ${suffix}`,
      project: {
        name: `Remote project ${suffix}`,
        objective: "Validate authenticated remote operation.",
      },
      team: {
        name: `Remote team ${suffix}`,
        mission: "Validate secure message and file exchange.",
      },
    },
    {},
    true,
  );
  assert.equal(setupResponse.status, 201);
  const workspace = await setupResponse.json();
  const project = workspace.projects[0];
  const team = workspace.teams[0];
  const owner = workspace.currentPrincipal;

  const agentResponse = await postJson(
    "/api/workspace/agents",
    {
      teamId: team.id,
      connectionId: null,
      slug: `remote-agent-${suffix}`,
      name: `Remote agent ${suffix}`,
      role: "Remote acceptance",
      model: "No LLM invoked",
      memoryScope: "project",
      autonomyLevel: "A0",
    },
    {},
    true,
  );
  assert.equal(agentResponse.status, 201);
  const agent = await agentResponse.json();

  const conversationResponse = await postJson(
    "/api/conversations",
    {
      kind: "direct",
      title: `Remote DM ${suffix}`,
      projectId: project.id,
      memberIds: [owner.id, agent.principalId],
    },
    {},
    true,
  );
  assert.equal(conversationResponse.status, 201);
  const conversation = await conversationResponse.json();

  const forbiddenFile = await request(
    `/api/conversations/${conversation.id}/files`,
    {
      method: "POST",
      headers: mutationHeaders({
        cookie,
        "content-type": "image/svg+xml",
        "x-nexus-file-name": encodeURIComponent("unsafe.svg"),
      }),
      body: "<svg><script>alert(1)</script></svg>",
    },
  );
  assert.equal(forbiddenFile.status, 415);
  assert.equal(
    (await forbiddenFile.json()).error,
    "file_type_not_allowed",
  );

  const fileBody = "NexusOS remote authenticated file exchange.\n";
  const upload = await request(
    `/api/conversations/${conversation.id}/files`,
    {
      method: "POST",
      headers: mutationHeaders({
        cookie,
        "content-type": "text/plain",
        "x-nexus-file-name": encodeURIComponent("acceptance.txt"),
      }),
      body: fileBody,
    },
  );
  assert.equal(upload.status, 201);
  const attachment = await upload.json();
  assert.equal(attachment.byteSize, Buffer.byteLength(fileBody));
  assert.equal(attachment.scanStatus, "not_scanned");

  const messageResponse = await postJson(
    `/api/conversations/${conversation.id}/messages`,
    {
      bodyText: "Authenticated message with an immutable file binding.",
      attachmentIds: [attachment.id],
    },
    {},
    true,
  );
  assert.equal(messageResponse.status, 201);
  const message = await messageResponse.json();
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].id, attachment.id);

  const messages = await getJson(
    `/api/conversations/${conversation.id}/messages?afterSequence=0`,
    true,
  );
  assert.equal(messages.messages.length, 1);
  assert.equal(messages.messages[0].attachments[0].id, attachment.id);

  const download = await request(`/api/files/${attachment.id}`, {
    headers: { cookie },
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.match(
    download.headers.get("content-disposition") ?? "",
    /^attachment;/u,
  );
  assert.equal(await download.text(), fileBody);

  const logout = await postJson("/api/auth/logout", {}, {}, true);
  assert.equal(logout.status, 204);
  cookie = "";
  assert.equal((await request(`/api/files/${attachment.id}`)).status, 401);

  const wrongLogin = await postJson("/api/auth/login", {
    login: "owner",
    passphrase: "wrong-password-is-long-enough",
  });
  assert.equal(wrongLogin.status, 401);
  const login = await postJson("/api/auth/login", {
    login: "owner",
    passphrase: "correct horse battery remote staple",
  });
  assert.equal(login.status, 200);
  cookie = sessionCookie(login);
  assert.equal((await getJson("/api/auth/status", true)).authenticated, true);

  process.stdout.write(
    "Remote access integration passed activation, session, CSRF, DM and file exchange.\n",
  );
} finally {
  await stopIntegrationProcess(server);
  rmSync(statePath, { recursive: true, force: true });
}

function activationBody() {
  return {
    bootstrapToken,
    login: "owner",
    displayName: `Remote owner ${suffix}`,
    passphrase: "correct horse battery remote staple",
  };
}

async function getJson(path, authenticated = false) {
  const response = await request(path, {
    headers: authenticated && cookie ? { cookie } : {},
  });
  if (response.status !== 200) {
    assert.fail(`${path}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function postJson(
  path,
  body,
  extraHeaders = {},
  authenticated = false,
) {
  return request(path, {
    method: "POST",
    headers: mutationHeaders({
      ...(authenticated && cookie ? { cookie } : {}),
      ...extraHeaders,
    }),
    body: JSON.stringify(body),
  });
}

function mutationHeaders(extra = {}) {
  return {
    "content-type": "application/json",
    origin: publicOrigin,
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    cache: "no-store",
    redirect: "manual",
    ...options,
  });
}

function sessionCookie(response) {
  const value = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.match(value, /^__Host-nexus_session=[A-Za-z0-9_-]{43}$/u);
  return value;
}

async function waitForHealthyServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Remote server exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`);
      if (response.ok) return;
    } catch {
      // Retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Remote server readiness timed out.\n${serverOutput}`);
}

function captureServerOutput(chunk) {
  serverOutput += chunk.toString();
  if (serverOutput.length > 32_000) serverOutput = serverOutput.slice(-32_000);
}

function runCommand(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env,
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
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with ${code}:\n${output}`));
    });
  });
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const selected = typeof address === "object" ? address.port : 0;
      probe.close((error) => {
        if (error) reject(error);
        else resolve(selected);
      });
    });
  });
}
