import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.NEXUS_RUN_TEST_PORT ?? "3916");
const externalBaseUrl = process.env.NEXUS_TEST_BASE_URL;
const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const testPersistPath = externalBaseUrl
  ? undefined
  : mkdtempSync(join(tmpdir(), "nexusos-run-integration-"));
let server;
let serverOutput = "";

const organizationId = "org-local-aurora";
const ownerId = "principal-local-owner";
const memberId = "principal-local-atlas";

try {
  if (!externalBaseUrl) {
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
      testPersistPath,
    ]);
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
          NEXUS_ALLOW_TEST_IDENTITIES: "1",
          NEXUS_PERSIST_STATE_PATH: testPersistPath,
          NEXUS_RUNNER_AUDIENCE: baseUrl,
          WRANGLER_LOG_PATH: ".wrangler/wrangler-run-integration.log",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout.on("data", captureServerOutput);
    server.stderr.on("data", captureServerOutput);
    await waitForHealthyServer();
  }

  const deniedCreate = await authenticatedRequest("/api/runs/diagnostic", {
    method: "POST",
    headers: identityHeaders(memberId, organizationId),
    body: "{}",
  });
  assert.equal(deniedCreate.status, 403);

  const createdResponse = await authenticatedRequest("/api/runs/diagnostic", {
    method: "POST",
    body: "{}",
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.run.id, /^run_[0-9a-f]{32}$/u);
  assert.equal(created.run.status, "queued");
  assert.equal(created.events[0].kind, "run.created");
  const runId = created.run.id;

  const runner = await enrollRunner("Diagnostic API runner");
  const operationId = `op_${"1".repeat(32)}`;
  const claimPath = `/api/runs/${runId}/lease/claim`;
  const claimBody = JSON.stringify({ operationId });
  const claimResponse = await fetch(
    `${baseUrl}${claimPath}`,
    await signedRunnerRequest({
      path: claimPath,
      domain: "nexus-runner-lease-claim-v1",
      runner,
      body: claimBody,
    }),
  );
  assert.equal(claimResponse.status, 200);
  const claimBytes = await claimResponse.text();
  const claim = JSON.parse(claimBytes);
  assert.equal(claim.runId, runId);
  assert.equal(claim.fence, 1);
  assert.match(claim.leaseId, /^lse_[0-9a-f]{32}$/u);

  const claimReplay = await fetch(
    `${baseUrl}${claimPath}`,
    await signedRunnerRequest({
      path: claimPath,
      domain: "nexus-runner-lease-claim-v1",
      runner,
      body: claimBody,
    }),
  );
  assert.equal(claimReplay.status, 200);
  assert.equal(claimReplay.headers.get("x-nexus-replay"), "1");
  assert.equal(await claimReplay.text(), claimBytes);

  const reusedNonce = randomBytes(16).toString("base64url");
  const firstNonceRequest = await signedRunnerRequest({
    path: claimPath,
    domain: "nexus-runner-lease-claim-v1",
    runner,
    body: claimBody,
    nonce: reusedNonce,
  });
  assert.equal(
    (
      await fetch(`${baseUrl}${claimPath}`, firstNonceRequest)
    ).headers.get("x-nexus-replay"),
    "1",
  );
  const changedNonceRequest = await signedRunnerRequest({
    path: claimPath,
    domain: "nexus-runner-lease-claim-v1",
    runner,
    body: JSON.stringify({ operationId: `op_${"2".repeat(32)}` }),
    nonce: reusedNonce,
  });
  const changedNonceResponse = await fetch(
    `${baseUrl}${claimPath}`,
    changedNonceRequest,
  );
  assert.equal(changedNonceResponse.status, 409);
  assert.deepEqual(await changedNonceResponse.json(), {
    error: "nonce_reused",
  });

  const renewPath = `/api/runs/${runId}/lease/renew`;
  const renewBody = JSON.stringify({
    fence: claim.fence,
    leaseId: claim.leaseId,
  });
  const renewResponse = await fetch(
    `${baseUrl}${renewPath}`,
    await signedRunnerRequest({
      path: renewPath,
      domain: "nexus-runner-lease-renew-v1",
      runner,
      body: renewBody,
    }),
  );
  assert.equal(renewResponse.status, 200);
  assert.equal((await renewResponse.json()).fence, 1);

  const completionOperationId = `op_${"3".repeat(32)}`;
  const completePath = `/api/runs/${runId}/complete`;
  const completeBody = JSON.stringify({
    fence: claim.fence,
    leaseId: claim.leaseId,
    operationId: completionOperationId,
    outcome: {
      status: "succeeded",
      summary: "Diagnostic lease completed without executing user work.",
    },
  });
  const completeResponse = await fetch(
    `${baseUrl}${completePath}`,
    await signedRunnerRequest({
      path: completePath,
      domain: "nexus-runner-run-complete-v1",
      runner,
      body: completeBody,
    }),
  );
  assert.equal(completeResponse.status, 200);
  const completionBytes = await completeResponse.text();
  assert.equal(JSON.parse(completionBytes).status, "completed");

  const completeReplay = await fetch(
    `${baseUrl}${completePath}`,
    await signedRunnerRequest({
      path: completePath,
      domain: "nexus-runner-run-complete-v1",
      runner,
      body: completeBody,
    }),
  );
  assert.equal(completeReplay.status, 200);
  assert.equal(completeReplay.headers.get("x-nexus-replay"), "1");
  assert.equal(await completeReplay.text(), completionBytes);

  const detailResponse = await authenticatedRequest(`/api/runs/${runId}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.run.status, "completed");
  assert.equal(detail.run.outcomeStatus, "succeeded");
  assert.equal(detail.run.leaseGeneration, 1);
  assert.ok(detail.run.replayCount >= 1);
  assert.deepEqual(
    detail.events.map((event) => event.kind),
    [
      "run.created",
      "lease.claimed",
      "lease.renewed",
      "run.completed",
    ],
  );

  const listed = await authenticatedRequest("/api/runs");
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).runs[0].id, runId);

  const cancelTarget = await (
    await authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    })
  ).json();
  const canceledResponse = await authenticatedRequest(
    `/api/runs/${cancelTarget.run.id}/cancel`,
    { method: "POST", body: "{}" },
  );
  assert.equal(canceledResponse.status, 200);
  assert.equal((await canceledResponse.json()).run.status, "canceled");

  const ledger = await authenticatedRequest("/api/governance/intents");
  assert.equal(ledger.status, 200);
  const ledgerKinds = (await ledger.json()).ledger.map((entry) => entry.kind);
  assert.ok(ledgerKinds.includes("run.requested"));
  assert.ok(ledgerKinds.includes("run.completed"));

  process.stdout.write(
    "Runs API integration passed: signed claim, nonce/operation replay, renew, completion, cancellation, ledger and tenant authority.\n",
  );
} finally {
  if (server) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  if (testPersistPath) {
    rmSync(testPersistPath, { recursive: true, force: true });
  }
}

async function enrollRunner(displayName) {
  const issued = await (
    await authenticatedRequest("/api/runners/enrollment-tokens", {
      method: "POST",
      body: JSON.stringify({ displayName }),
    })
  ).json();
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const publicKey = Buffer.from(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  ).toString("base64url");
  const path = "/api/runners/enroll";
  const body = JSON.stringify({ displayName });
  const request = await signedEnrollmentRequest({
    path,
    body,
    token: issued.token,
    publicKey,
    privateKey: keyPair.privateKey,
  });
  const response = await fetch(`${baseUrl}${path}`, request);
  assert.equal(response.status, 200);
  return {
    ...(await response.json()),
    keyPair,
    publicKey,
  };
}

async function signedEnrollmentRequest(input) {
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(16).toString("base64url");
  const signed = [
    "nexus-runner-enroll-v1",
    "POST",
    input.path,
    baseUrl,
    timestamp,
    nonce,
    `sha256:${createHash("sha256").update(input.body).digest("hex")}`,
  ].join("\n");
  const signature = Buffer.from(
    await webcrypto.subtle.sign(
      { name: "Ed25519" },
      input.privateKey,
      Buffer.from(signed),
    ),
  ).toString("base64url");
  return {
    method: "POST",
    body: input.body,
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-length": String(Buffer.byteLength(input.body)),
      "content-type": "application/json",
      "x-nexus-runner-key": input.publicKey,
      "x-nexus-signature": signature,
      "x-nexus-timestamp": timestamp,
      "x-nexus-nonce": nonce,
    },
  };
}

async function signedRunnerRequest(input) {
  const timestamp = new Date().toISOString();
  const nonce = input.nonce ?? randomBytes(16).toString("base64url");
  const signed = [
    input.domain,
    input.runner.runnerId,
    "POST",
    input.path,
    baseUrl,
    timestamp,
    nonce,
    `sha256:${createHash("sha256").update(input.body).digest("hex")}`,
  ].join("\n");
  const signature = Buffer.from(
    await webcrypto.subtle.sign(
      { name: "Ed25519" },
      input.runner.keyPair.privateKey,
      Buffer.from(signed),
    ),
  ).toString("base64url");
  return {
    method: "POST",
    body: input.body,
    headers: {
      "content-length": String(Buffer.byteLength(input.body)),
      "content-type": "application/json",
      "x-nexus-runner-id": input.runner.runnerId,
      "x-nexus-signature": signature,
      "x-nexus-timestamp": timestamp,
      "x-nexus-nonce": nonce,
    },
  };
}

function authenticatedRequest(path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...identityHeaders(ownerId, organizationId),
      ...init.headers,
    },
  });
}

function identityHeaders(principalId, tenantId) {
  return {
    "x-nexus-test-principal": principalId,
    "x-nexus-test-organization": tenantId,
  };
}

function captureServerOutput(chunk) {
  serverOutput += chunk.toString();
  if (serverOutput.length > 40_000) serverOutput = serverOutput.slice(-40_000);
}

async function waitForHealthyServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server?.exitCode !== null) {
      throw new Error(`Run integration server exited:\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/system/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Run integration server did not become healthy:\n${serverOutput}`);
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
