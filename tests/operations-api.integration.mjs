import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const persistPath = mkdtempSync(join(tmpdir(), "nexusos-operations-api-"));
const operationId = `opr_${"a".repeat(32)}`;
const runnerId = `rnr_${"b".repeat(32)}`;
const keyring =
  '{"activeKeyId":"integration-key-v1","keys":{"integration-key-v1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"schemaVersion":1}';
let server;
let serverOutput = "";

try {
  await command("npx", [
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
  server = spawn(
    "npx",
    ["vinext", "dev", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXUS_ALLOW_LOCAL_IDENTITY: "1",
        NEXUS_PERSIST_STATE_PATH: persistPath,
        NEXUS_PROMPT_CIPHER_KEYS: keyring,
        WRANGLER_LOG_PATH: ".wrangler/wrangler-operations-api.log",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);
  await healthy();

  const setup = await post("/api/setup", {
    workspaceName: "Operational Loop Integration",
    ownerName: "Operation Owner",
    project: {
      name: "NexusOS",
      objective: "Validate the bound operation lifecycle.",
    },
    team: {
      name: "Runtime",
      mission: "Execute bounded local operations.",
    },
  });
  assert.equal(setup.response.status, 201, JSON.stringify(setup.body));
  const organizationId = setup.body.organization.id;
  const ownerId = setup.body.currentPrincipal.id;
  const projectId = setup.body.projects[0].id;
  const teamId = setup.body.teams[0].id;

  const agent = await post("/api/workspace/agents", {
    teamId,
    connectionId: null,
    slug: "architect",
    name: "Architecture Agent",
    role: "Architecture reviewer",
    model: "gpt-5.6-sol",
    memoryScope: "project",
    autonomyLevel: "A0",
  });
  assert.equal(agent.response.status, 201, JSON.stringify(agent.body));
  const objective = await post("/api/workspace/objectives", {
    projectId,
    title: "Ship operation API",
    description: "Bind user work to one declared local model.",
    priority: "p0",
  });
  assert.equal(objective.response.status, 201, JSON.stringify(objective.body));
  const workItem = await post("/api/workspace/work-items", {
    projectId,
    objectiveId: objective.body.id,
    assigneeId: agent.body.principalId,
    kind: "story",
    title: "Review architecture",
    description: "Produce a bounded architecture assessment.",
    priority: "p0",
  });
  assert.equal(workItem.response.status, 201, JSON.stringify(workItem.body));
  await seedRunner(organizationId, ownerId);

  const createBody = {
    projectId,
    workItemId: workItem.body.id,
    agentId: agent.body.id,
    assignedRunnerId: runnerId,
    engine: "codex_cli",
    prompt: "Assess the architecture and return Markdown.",
  };
  const invalidReference = await operationRequest(
    { ...createBody, workItemId: "missing-work-item" },
    `opr_${"f".repeat(32)}`,
  );
  assert.equal(invalidReference.response.status, 422);
  assert.deepEqual(invalidReference.body, {
    error: "invalid_operation_reference",
  });
  const created = await operationRequest(createBody);
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.created, true);
  assert.equal(created.body.operation.agent.model, "gpt-5.6-sol");
  assert.equal(created.body.operation.run.status, "queued");
  assert.deepEqual(created.body.operation.publication, { state: "pending" });
  assertPrivate(created.response);

  const replay = await operationRequest(createBody);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.created, false);
  assert.equal(replay.body.operation.runId, created.body.operation.runId);

  const conflict = await operationRequest({
    ...createBody,
    prompt: "A different request must conflict.",
  });
  assert.equal(conflict.response.status, 409);
  assert.deepEqual(conflict.body, { error: "idempotency_key_reused" });

  const listedResponse = await fetch(`${baseUrl}/api/operations`);
  const listed = await listedResponse.json();
  assert.equal(listedResponse.status, 200);
  assert.equal(listed.operations.length, 1);
  assert.equal(listed.operations[0].id, operationId);
  assert.equal(listed.operations[0].agent.model, "gpt-5.6-sol");

  const publishPending = await fetch(
    `${baseUrl}/api/operations/${operationId}/publish`,
    { method: "POST" },
  );
  assert.equal(publishPending.status, 409);
  assert.deepEqual(await publishPending.json(), {
    error: "operation_not_publishable",
  });

  const [binding] = await query(
    `SELECT
       operation.agent_model,
       operation.run_id,
       run.engine,
       run.status,
       creation.creation_id
     FROM operations operation
     INNER JOIN runs run ON run.id = operation.run_id
     INNER JOIN engine_run_creations creation
       ON creation.run_id = operation.run_id
      AND creation.organization_id = operation.organization_id`,
  );
  assert.deepEqual(binding, {
    agent_model: "gpt-5.6-sol",
    run_id: created.body.operation.runId,
    engine: "codex_cli",
    status: "queued",
    creation_id: `ecr_${"a".repeat(32)}`,
  });

  const codexAnswer = [
    { type: "thread.started", thread_id: "thread-operation" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        id: "reason-operation",
        type: "reasoning",
        text: "This lifecycle detail must not be published.",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "message-operation",
        type: "agent_message",
        text: "# Architecture assessment\n\nThe bounded path is valid.",
      },
    },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 8 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  await completeRun(
    organizationId,
    created.body.operation.runId,
    codexAnswer,
  );
  const completedList = await fetch(`${baseUrl}/api/operations`);
  const completedBody = await completedList.json();
  assert.deepEqual(completedBody.operations[0].publication, {
    state: "eligible",
  });
  const publishedResponse = await fetch(
    `${baseUrl}/api/operations/${operationId}/publish`,
    { method: "POST", body: "{}" },
  );
  const published = await publishedResponse.json();
  assert.equal(publishedResponse.status, 201, JSON.stringify(published));
  assert.equal(published.published, true);
  assert.equal(published.operation.publication.state, "published");
  const [artifact] = await query(
    `SELECT payload.body_text, publication.operation_id, ledger.kind
     FROM operation_publications publication
     INNER JOIN artifact_versions version
       ON version.id = publication.artifact_version_id
     INNER JOIN artifact_payloads payload ON payload.id = version.content_ref
     INNER JOIN ledger_entries ledger
       ON ledger.payload_ref = publication.artifact_id
      AND ledger.run_id = '${created.body.operation.runId}'
     WHERE publication.operation_id = '${operationId}'`,
  );
  assert.deepEqual(artifact, {
    body_text: "# Architecture assessment\n\nThe bounded path is valid.",
    operation_id: operationId,
    kind: "artifact.registered",
  });
  const publishedReplay = await fetch(
    `${baseUrl}/api/operations/${operationId}/publish`,
    { method: "POST" },
  );
  assert.equal(publishedReplay.status, 200);
  assert.equal((await publishedReplay.json()).published, false);
  await assert.rejects(
    sql(
      `UPDATE operations SET agent_model = 'drifted-model'
       WHERE id = '${operationId}'`,
    ),
    /immutable_operation_binding/u,
  );
  await assert.rejects(
    sql(
      `DELETE FROM operation_publications
       WHERE operation_id = '${operationId}'`,
    ),
    /immutable_operation_publication/u,
  );

  const technical = await fetch(`${baseUrl}/api/runs/engine`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `ecr_${"c".repeat(32)}`,
    },
    body: JSON.stringify({
      assignedRunnerId: runnerId,
      engine: "claude_code_cli",
      prompt: "Technical compatibility request.",
    }),
  });
  assert.equal(technical.status, 201, await technical.text());
  const [unbound] = await query(
    `SELECT COUNT(*) AS count
     FROM runs run
     LEFT JOIN operations operation ON operation.run_id = run.id
     WHERE run.engine = 'claude_code_cli' AND operation.id IS NULL`,
  );
  assert.equal(unbound.count, 1);

  process.stdout.write(
    "Operations API integration passed binding, structured model, replay, listing and technical compatibility.\n",
  );
} finally {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  rmSync(persistPath, { recursive: true, force: true });
}

async function seedRunner(organizationId, ownerId) {
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  await sql(
    `INSERT INTO principals (
       id, organization_id, kind, external_id, display_name
     ) VALUES (
       'principal-operation-runner', '${organizationId}', 'runner',
       '${runnerId}', 'Operation runner'
     );
     INSERT INTO runner_enrollment_tokens (
       id, organization_id, token_hash, issued_by, display_name,
       issued_at, expires_at
     ) VALUES (
       'token-operation-runner', '${organizationId}', '${"d".repeat(64)}',
       '${ownerId}', 'Operation runner', '${issuedAt}', '${expiresAt}'
     );
     INSERT INTO runners (
       id, organization_id, principal_id, enrollment_token_id,
       display_name, public_key, enrolled_at
     ) VALUES (
       '${runnerId}', '${organizationId}', 'principal-operation-runner',
       'token-operation-runner', 'Operation runner', '${"A".repeat(43)}',
       '${issuedAt}'
     );`,
  );
}

async function completeRun(organizationId, runId, stdout) {
  const stdoutBytes = new TextEncoder().encode(stdout);
  const stderrBytes = new Uint8Array();
  const framed = new Uint8Array(2 + stdoutBytes.byteLength);
  framed[0] = (stdoutBytes.byteLength >> 8) & 0xff;
  framed[1] = stdoutBytes.byteLength & 0xff;
  framed.set(stdoutBytes, 2);
  const excerptRef = `exc_${runId.slice(4)}`;
  const envelope = await encrypt(framed, {
    organizationId,
    payloadRef: excerptRef,
    runId,
  });
  const recordedAt = new Date().toISOString();
  await sql(
    `PRAGMA foreign_keys = OFF;
     DROP TRIGGER runs_validate_before_update;
     DROP TRIGGER run_leases_validate_before_insert;
     DROP TRIGGER run_leases_attach_after_insert;
     DROP TRIGGER runner_operations_validate_before_insert;
     DROP TRIGGER run_engine_excerpts_validate_before_insert;
     DROP TRIGGER run_engine_receipts_validate_before_insert;
     UPDATE runs
       SET status = 'completed', outcome_status = 'succeeded',
           updated_at = '${recordedAt}'
       WHERE id = '${runId}';
     INSERT INTO run_leases (
       id, organization_id, run_id, runner_id, fence, status,
       issued_at, expires_at, renew_count, ended_at, ended_reason
     ) VALUES (
       'lse_${runId.slice(4)}', '${organizationId}', '${runId}',
       '${runnerId}', 1, 'released', '${recordedAt}', '${recordedAt}',
       0, '${recordedAt}', 'engine_complete'
     );
     INSERT INTO runner_operations (
       run_id, operation_id, request_hash, fence, response_status,
       response_body, replay_count, applied_at
     ) VALUES (
       '${runId}', 'op_${runId.slice(4)}', '${"b".repeat(64)}', 1,
       200, '{}', 0, '${recordedAt}'
     );
     INSERT INTO run_engine_excerpts (
       run_id, organization_id, excerpt_ref, cipher_version, key_id,
       iv, ciphertext, tag, stdout_excerpt_bytes, stderr_excerpt_bytes,
       excerpt_sha256, created_at
     ) VALUES (
       '${runId}', '${organizationId}', '${excerptRef}', 1,
       'integration-key-v1', ${blob(envelope.iv)},
       ${blob(envelope.ciphertext)}, ${blob(envelope.tag)},
       ${stdoutBytes.byteLength}, 0, '${sha256(framed)}', '${recordedAt}'
     );
     INSERT INTO run_engine_receipts (
       run_id, organization_id, operation_id, excerpt_ref, excerpt_sha256,
       lease_id, fence, engine, engine_version, status, reason, exit_code,
       timed_out, cancel_requested, started_at, finished_at, stdout_bytes,
       stdout_sha256, stdout_truncated, stdout_excerpt_bytes, stderr_bytes,
       stderr_sha256, stderr_truncated, stderr_excerpt_bytes, receipt_sha256,
       recorded_at
     ) VALUES (
       '${runId}', '${organizationId}', 'op_${runId.slice(4)}',
       '${excerptRef}', '${sha256(framed)}', 'lse_${runId.slice(4)}', 1,
       'codex_cli', '0.116.0', 'succeeded', 'none', 0, 0, 0,
       '${recordedAt}', '${recordedAt}', ${stdoutBytes.byteLength},
       '${sha256(stdoutBytes)}', 0, ${stdoutBytes.byteLength}, 0,
       '${sha256(stderrBytes)}', 0, 0, '${"e".repeat(64)}', '${recordedAt}'
     );`,
  );
}

async function encrypt(plaintext, context) {
  const key = await webcrypto.subtle.importKey(
    "raw",
    new Uint8Array(32),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = new Uint8Array(12).fill(7);
  const additionalData = new TextEncoder().encode(
    `${context.runId}|${context.organizationId}|${context.payloadRef}`,
  );
  const combined = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      key,
      plaintext,
    ),
  );
  return {
    iv,
    ciphertext: combined.slice(0, -16),
    tag: combined.slice(-16),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function blob(bytes) {
  return `X'${Buffer.from(bytes).toString("hex")}'`;
}

async function operationRequest(body, selectedOperationId = operationId) {
  const response = await fetch(`${baseUrl}/api/operations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": selectedOperationId,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function post(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function assertPrivate(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

async function healthy() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`Server exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/system/health`);
      if (response.ok) return;
    } catch {
      // Expected while the development server starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server startup timed out.\n${serverOutput}`);
}

function capture(chunk) {
  serverOutput = `${serverOutput}${chunk}`.slice(-40_000);
}

async function query(statement) {
  const output = await command("npx", [
    "wrangler",
    "d1",
    "execute",
    "DB",
    "--local",
    "--config",
    "wrangler.local.jsonc",
    "--persist-to",
    persistPath,
    "--json",
    "--command",
    statement,
  ]);
  return JSON.parse(output)[0].results;
}

function sql(statement) {
  return command("npx", [
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
    statement,
  ]);
}

function command(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: ".wrangler/wrangler-operations-cli.log",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${executable} failed (${code}):\n${output}`));
    });
  });
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const selected = typeof address === "object" && address
        ? address.port
        : 0;
      listener.close((error) =>
        error ? reject(error) : resolve(selected),
      );
    });
  });
}
