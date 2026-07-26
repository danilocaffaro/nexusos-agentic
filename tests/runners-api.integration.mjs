import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.NEXUS_RUNNER_TEST_PORT ?? "3915");
const externalBaseUrl = process.env.NEXUS_TEST_BASE_URL;
const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const testPersistPath = externalBaseUrl
  ? undefined
  : mkdtempSync(join(tmpdir(), "nexusos-runner-integration-"));
let server;
let serverOutput = "";

const organizationId = "org-local-aurora";
const ownerId = "principal-local-owner";
const agentId = "principal-local-atlas";
const otherOrganizationId = "org-local-test-other";
const otherOwnerId = "principal-local-test-other-owner";
const displayName = "Local build runner";

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
          NEXUS_RUNNER_TEST_TOKEN_TTL_SECONDS: "6",
          WRANGLER_LOG_PATH: ".wrangler/wrangler-runner-integration.log",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout.on("data", captureServerOutput);
    server.stderr.on("data", captureServerOutput);
    await waitForHealthyServer();
  }

  const empty = await authenticatedRequest("/api/runners");
  assert.equal(empty.status, 200);
  const emptyRegistry = await empty.json();
  assert.deepEqual(emptyRegistry.runners, []);
  assert.equal(emptyRegistry.audience, baseUrl);

  const deniedIssue = await authenticatedRequest(
    "/api/runners/enrollment-tokens",
    {
      method: "POST",
      headers: identityHeaders(agentId, organizationId),
      body: JSON.stringify({ displayName }),
    },
  );
  assert.equal(deniedIssue.status, 403);

  const issuedResponse = await authenticatedRequest(
    "/api/runners/enrollment-tokens",
    {
      method: "POST",
      body: JSON.stringify({ displayName }),
    },
  );
  assert.equal(issuedResponse.status, 201);
  const issued = await issuedResponse.json();
  assert.match(issued.tokenId, /^[0-9a-f-]{36}$/);
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal("displayName" in issued, false);
  assert.ok(Date.parse(issued.expiresAt) > Date.now());

  const revokedTokenResponse = await authenticatedRequest(
    "/api/runners/enrollment-tokens",
    {
      method: "POST",
      body: JSON.stringify({ displayName: "Revoked before use" }),
    },
  );
  const revokedToken = await revokedTokenResponse.json();
  const revokeToken = await authenticatedRequest(
    `/api/runners/enrollment-tokens/${revokedToken.tokenId}/revoke`,
    { method: "POST", body: "{}" },
  );
  assert.equal(revokeToken.status, 200);

  const pair = await webcrypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const publicKey = base64url(
    new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey)),
  );
  const enrollmentBody = JSON.stringify({ displayName });
  const wrongAudience = await signedRequest({
    path: "/api/runners/enroll",
    domain: "nexus-runner-enroll-v1",
    audience: "https://evil.example",
    body: enrollmentBody,
    token: issued.token,
    publicKey,
    privateKey: pair.privateKey,
  });
  const wrongAudienceResponse = await fetch(
    `${baseUrl}/api/runners/enroll`,
    {
      ...wrongAudience,
      headers: {
        ...wrongAudience.headers,
        "x-forwarded-host": "evil.example",
      },
    },
  );
  assert.equal(wrongAudienceResponse.status, 403);
  for (const timestamp of [
    new Date(Date.now() - 61_000).toISOString(),
    new Date(Date.now() + 31_000).toISOString(),
  ]) {
    const skewed = await signedRequest({
      path: "/api/runners/enroll",
      domain: "nexus-runner-enroll-v1",
      body: enrollmentBody,
      token: issued.token,
      publicKey,
      privateKey: pair.privateKey,
      timestamp,
    });
    assert.equal(
      (await fetch(`${baseUrl}/api/runners/enroll`, skewed)).status,
      403,
    );
  }
  const enrollmentRequest = await signedRequest({
    path: "/api/runners/enroll",
    domain: "nexus-runner-enroll-v1",
    body: enrollmentBody,
    token: issued.token,
    publicKey,
    privateKey: pair.privateKey,
  });
  const paddedSignatureResponse = await fetch(
    `${baseUrl}/api/runners/enroll`,
    {
      ...enrollmentRequest,
      headers: {
        ...enrollmentRequest.headers,
        "x-nexus-signature":
          `${enrollmentRequest.headers["x-nexus-signature"]}=`,
      },
    },
  );
  assert.equal(paddedSignatureResponse.status, 403);
  const smallOrderResponse = await fetch(`${baseUrl}/api/runners/enroll`, {
    method: "POST",
    body: enrollmentBody,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${issued.token}`,
      "x-nexus-runner-key": base64url(
        Uint8Array.from([1, ...new Uint8Array(31)]),
      ),
      "x-nexus-signature": base64url(new Uint8Array(64)),
      "x-nexus-timestamp": new Date().toISOString(),
      "x-nexus-nonce": base64url(randomBytes(16)),
    },
  });
  assert.equal(smallOrderResponse.status, 403);
  assert.equal(
    (
      await fetch(`${baseUrl}/api/runners/enroll`, {
        method: "POST",
        body: "x".repeat(5000),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${issued.token}`,
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/runners/enroll?x=1`, enrollmentRequest)
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/runners/enroll`, {
        ...enrollmentRequest,
        body: `${enrollmentBody} `,
      })
    ).status,
    403,
  );
  const enrolledResponse = await fetch(`${baseUrl}/api/runners/enroll`, {
    ...enrollmentRequest,
    headers: {
      ...enrollmentRequest.headers,
      ...identityHeaders(agentId, organizationId),
    },
  });
  assert.equal(enrolledResponse.status, 200);
  const enrolledBytes = await enrolledResponse.text();
  const enrolled = JSON.parse(enrolledBytes);
  assert.match(enrolled.runnerId, /^rnr_[0-9a-f]{32}$/);
  assert.match(enrolled.principalId, /^prn_[0-9a-f]{32}$/);
  assert.equal(enrolled.trustProfile, "operator_trust");

  const retryResponse = await fetch(`${baseUrl}/api/runners/enroll`, {
    ...enrollmentRequest,
    headers: enrollmentRequest.headers,
  });
  assert.equal(retryResponse.status, 200);
  assert.equal(await retryResponse.text(), enrolledBytes);

  const otherPair = await webcrypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const otherPublicKey = base64url(
    new Uint8Array(
      await webcrypto.subtle.exportKey("raw", otherPair.publicKey),
    ),
  );
  const wrongKey = await signedRequest({
    path: "/api/runners/enroll",
    domain: "nexus-runner-enroll-v1",
    body: enrollmentBody,
    token: issued.token,
    publicKey: otherPublicKey,
    privateKey: otherPair.privateKey,
  });
  const unknownToken = await signedRequest({
    path: "/api/runners/enroll",
    domain: "nexus-runner-enroll-v1",
    body: enrollmentBody,
    token: base64url(randomBytes(32)),
    publicKey: otherPublicKey,
    privateKey: otherPair.privateKey,
  });
  const [wrongKeyResponse, unknownTokenResponse] = await Promise.all([
    fetch(`${baseUrl}/api/runners/enroll`, wrongKey),
    fetch(`${baseUrl}/api/runners/enroll`, unknownToken),
  ]);
  assert.equal(wrongKeyResponse.status, 403);
  assert.equal(unknownTokenResponse.status, 403);
  assert.equal(
    await wrongKeyResponse.text(),
    await unknownTokenResponse.text(),
  );

  const revokedEnrollment = await signedRequest({
    path: "/api/runners/enroll",
    domain: "nexus-runner-enroll-v1",
    body: JSON.stringify({ displayName: "Revoked before use" }),
    token: revokedToken.token,
    publicKey: otherPublicKey,
    privateKey: otherPair.privateKey,
  });
  assert.equal(
    (await fetch(`${baseUrl}/api/runners/enroll`, revokedEnrollment)).status,
    403,
  );

  const listedPending = await (
    await authenticatedRequest("/api/runners")
  ).json();
  assert.equal(listedPending.runners.length, 1);
  assert.equal(listedPending.runners[0].liveness, "pending");
  assert.equal(listedPending.runners[0].trustProfile, "operator_trust");
  assert.equal(listedPending.audience, baseUrl);
  assert.equal(listedPending.capabilities.execution, "roadmap");
  assert.equal(listedPending.capabilities.leases, "real");
  assert.equal(listedPending.capabilities.durableReplay, "real");
  assert.equal(listedPending.capabilities.streaming, "roadmap");
  assert.equal(JSON.stringify(listedPending).includes(issued.token), false);
  assert.equal(JSON.stringify(listedPending).includes("tokenHash"), false);

  const heartbeatBody = "{}";
  const heartbeatPath = `/api/runners/${enrolled.runnerId}/heartbeat`;
  const heartbeat = await signedRequest({
    path: heartbeatPath,
    domain: "nexus-runner-heartbeat-v1",
    body: heartbeatBody,
    publicKey,
    privateKey: pair.privateKey,
  });
  const firstHeartbeat = await fetch(`${baseUrl}${heartbeatPath}`, heartbeat);
  assert.equal(firstHeartbeat.status, 200);
  assert.equal(firstHeartbeat.headers.get("x-nexus-replay"), null);
  const firstHeartbeatBytes = await firstHeartbeat.text();
  const afterFirstHeartbeat = await (
    await authenticatedRequest("/api/runners")
  ).json();
  const firstLastSeen = afterFirstHeartbeat.runners[0].lastSeenAt;

  const replayHeartbeat = await fetch(`${baseUrl}${heartbeatPath}`, heartbeat);
  assert.equal(replayHeartbeat.status, 200);
  assert.equal(replayHeartbeat.headers.get("x-nexus-replay"), "1");
  assert.equal(await replayHeartbeat.text(), firstHeartbeatBytes);
  const afterReplayHeartbeat = await (
    await authenticatedRequest("/api/runners")
  ).json();
  assert.equal(afterReplayHeartbeat.runners[0].lastSeenAt, firstLastSeen);

  const concurrentHeartbeat = await signedRequest({
    path: heartbeatPath,
    domain: "nexus-runner-heartbeat-v1",
    body: heartbeatBody,
    publicKey,
    privateKey: pair.privateKey,
  });
  const concurrentHeartbeatResponses = await Promise.all([
    fetch(`${baseUrl}${heartbeatPath}`, concurrentHeartbeat),
    fetch(`${baseUrl}${heartbeatPath}`, concurrentHeartbeat),
  ]);
  assert.deepEqual(
    concurrentHeartbeatResponses.map((response) => response.status),
    [200, 200],
  );
  const concurrentReplayHeaders = concurrentHeartbeatResponses.map(
    (response) => response.headers.get("x-nexus-replay"),
  );
  assert.equal(
    concurrentReplayHeaders.filter((value) => value === null).length,
    1,
  );
  assert.equal(
    concurrentReplayHeaders.filter((value) => value === "1").length,
    1,
  );
  const oversizedHeartbeat = await signedRequest({
    path: heartbeatPath,
    domain: "nexus-runner-heartbeat-v1",
    body: "{ }",
    publicKey,
    privateKey: pair.privateKey,
  });
  assert.equal(
    (await fetch(`${baseUrl}${heartbeatPath}`, oversizedHeartbeat)).status,
    403,
  );

  const reusedNonce = await signedRequest({
    path: heartbeatPath,
    domain: "nexus-runner-heartbeat-v1",
    body: heartbeatBody,
    publicKey,
    privateKey: pair.privateKey,
    nonce: heartbeat.headers["x-nexus-nonce"],
    timestamp: new Date(
      Date.parse(heartbeat.headers["x-nexus-timestamp"]) + 1,
    ).toISOString(),
  });
  const changedReplay = await fetch(`${baseUrl}${heartbeatPath}`, reusedNonce);
  assert.equal(changedReplay.status, 409);
  assert.equal((await changedReplay.json()).error, "nonce_reused");

  const listedOnline = await (
    await authenticatedRequest("/api/runners")
  ).json();
  assert.equal(listedOnline.runners[0].liveness, "online");
  assert.ok(listedOnline.runners[0].lastSeenAt);

  const otherTenantList = await authenticatedRequest("/api/runners", {
    headers: identityHeaders(otherOwnerId, otherOrganizationId),
  });
  assert.equal(otherTenantList.status, 200);
  assert.deepEqual((await otherTenantList.json()).runners, []);

  const raceDisplayName = "Concurrent runner";
  const raceTokenResponse = await authenticatedRequest(
    "/api/runners/enrollment-tokens",
    {
      method: "POST",
      headers: identityHeaders(otherOwnerId, otherOrganizationId),
      body: JSON.stringify({ displayName: raceDisplayName }),
    },
  );
  assert.equal(raceTokenResponse.status, 201);
  const raceToken = await raceTokenResponse.json();
  const racePairs = await Promise.all(
    Array.from({ length: 8 }, () =>
      webcrypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"],
      ),
    ),
  );
  const raceRequests = await Promise.all(
    racePairs.map(async (racePair) => {
      const racePublicKey = base64url(
        new Uint8Array(
          await webcrypto.subtle.exportKey("raw", racePair.publicKey),
        ),
      );
      return signedRequest({
        path: "/api/runners/enroll",
        domain: "nexus-runner-enroll-v1",
        body: JSON.stringify({ displayName: raceDisplayName }),
        token: raceToken.token,
        publicKey: racePublicKey,
        privateKey: racePair.privateKey,
      });
    }),
  );
  const raceResponses = await Promise.all(
    raceRequests.map((raceRequest) =>
      fetch(`${baseUrl}/api/runners/enroll`, raceRequest),
    ),
  );
  assert.deepEqual(
    raceResponses.map((response) => response.status).sort(),
    [200, 403, 403, 403, 403, 403, 403, 403],
  );
  const raceList = await (
    await authenticatedRequest("/api/runners", {
      headers: identityHeaders(otherOwnerId, otherOrganizationId),
    })
  ).json();
  assert.equal(raceList.runners.length, 1);
  const raceGovernance = await (
    await authenticatedRequest("/api/governance/intents", {
      headers: identityHeaders(otherOwnerId, otherOrganizationId),
    })
  ).json();
  assert.equal(
    raceGovernance.ledger.filter(
      (entry) => entry.kind === "runner.enrolled",
    ).length,
    1,
  );
  assert.equal(raceGovernance.verification.valid, true);
  const raceWinnerIndex = raceResponses.findIndex(
    (response) => response.status === 200,
  );
  assert.notEqual(raceWinnerIndex, -1);
  const wrongRunnerKey = await signedRequest({
    path: heartbeatPath,
    domain: "nexus-runner-heartbeat-v1",
    body: heartbeatBody,
    privateKey: racePairs[raceWinnerIndex].privateKey,
  });
  assert.equal(
    (await fetch(`${baseUrl}${heartbeatPath}`, wrongRunnerKey)).status,
    403,
  );

  const consumedTokenRevoke = await authenticatedRequest(
    `/api/runners/enrollment-tokens/${issued.tokenId}/revoke`,
    { method: "POST", body: "{}" },
  );
  assert.equal(consumedTokenRevoke.status, 409);
  assert.equal(
    (await consumedTokenRevoke.json()).error,
    "runner_token_consumed",
  );

  const revokedRunner = await authenticatedRequest(
    `/api/runners/${enrolled.runnerId}/revoke`,
    { method: "POST", body: "{}" },
  );
  assert.equal(revokedRunner.status, 200);
  assert.ok((await revokedRunner.json()).revokedAt);

  const heartbeatAfterRevoke = await fetch(
    `${baseUrl}${heartbeatPath}`,
    heartbeat,
  );
  assert.equal(heartbeatAfterRevoke.status, 403);
  assert.equal(
    (await heartbeatAfterRevoke.json()).error,
    "runner_authentication_failed",
  );
  const listedRevoked = await (
    await authenticatedRequest("/api/runners")
  ).json();
  assert.equal(listedRevoked.runners[0].liveness, "revoked");
  const freshEnrollmentAfterRevoke = await signedRequest({
    path: "/api/runners/enroll",
    domain: "nexus-runner-enroll-v1",
    body: enrollmentBody,
    token: issued.token,
    publicKey,
    privateKey: pair.privateKey,
  });
  const enrollmentAfterRevoke = await fetch(
    `${baseUrl}/api/runners/enroll`,
    freshEnrollmentAfterRevoke,
  );
  assert.equal(enrollmentAfterRevoke.status, 403);

  const expiringTokenResponse = await authenticatedRequest(
    "/api/runners/enrollment-tokens",
    {
      method: "POST",
      body: JSON.stringify({ displayName: "Expiring runner" }),
    },
  );
  const expiringToken = await expiringTokenResponse.json();
  const expiringPair = await webcrypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const expiringPublicKey = base64url(
    new Uint8Array(
      await webcrypto.subtle.exportKey("raw", expiringPair.publicKey),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 6_100));
  const expiredEnrollment = await signedRequest({
    path: "/api/runners/enroll",
    domain: "nexus-runner-enroll-v1",
    body: JSON.stringify({ displayName: "Expiring runner" }),
    token: expiringToken.token,
    publicKey: expiringPublicKey,
    privateKey: expiringPair.privateKey,
  });
  assert.equal(
    (await fetch(`${baseUrl}/api/runners/enroll`, expiredEnrollment)).status,
    403,
  );

  const governance = await (
    await authenticatedRequest("/api/governance/intents")
  ).json();
  assert.deepEqual(
    governance.ledger
      .filter((entry) => entry.kind.startsWith("runner"))
      .map((entry) => entry.kind),
    [
      "runner_token.issued",
      "runner_token.issued",
      "runner_token.revoked",
      "runner.enrolled",
      "runner.revoked",
      "runner_token.issued",
    ],
  );
  assert.equal(governance.verification.valid, true);

  process.stdout.write("Runner API integration passed\n");
} finally {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  if (testPersistPath) {
    rmSync(testPersistPath, { recursive: true, force: true });
  }
}

async function signedRequest(input) {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const nonce = input.nonce ?? base64url(randomBytes(16));
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  const value = [
    input.domain,
    "POST",
    input.path,
    input.audience ?? baseUrl,
    timestamp,
    nonce,
    `sha256:${bodyHash}`,
  ].join("\n");
  const signature = base64url(
    new Uint8Array(
      await webcrypto.subtle.sign(
        { name: "Ed25519" },
        input.privateKey,
        new TextEncoder().encode(value),
      ),
    ),
  );
  return {
    method: "POST",
    body: input.body,
    headers: {
      "content-type": "application/json",
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input.publicKey
        ? { "x-nexus-runner-key": input.publicKey }
        : {}),
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
      ...(init.headers ?? {}),
    },
  });
}

function identityHeaders(principalId, organizationIdValue) {
  return {
    "x-nexus-test-principal": principalId,
    "x-nexus-test-organization": organizationIdValue,
  };
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function waitForHealthyServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(
        `Runner server exited early (${server?.exitCode}).\n${serverOutput}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/system/health`);
      if (response.ok) return;
    } catch {
      // Startup polling is expected to fail until the server listens.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Runner server was not healthy within 90 seconds.\n${serverOutput}`,
  );
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
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function captureServerOutput(chunk) {
  serverOutput = `${serverOutput}${chunk}`.slice(-16_000);
}
