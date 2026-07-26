import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.NEXUS_ARTIFACT_TEST_PORT ?? "3914");
const externalBaseUrl = process.env.NEXUS_TEST_BASE_URL;
const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const testPersistPath = externalBaseUrl
  ? undefined
  : mkdtempSync(join(tmpdir(), "nexusos-artifact-integration-"));
let server;
let serverOutput = "";

const organizationId = "org-local-aurora";
const workItemId = "work-local-persistent-graph";
const peerId = "principal-local-test-peer";
const otherOrganizationId = "org-local-test-other";
const otherOwnerId = "principal-local-test-other-owner";

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
          WRANGLER_LOG_PATH: ".wrangler/wrangler-artifact-integration.log",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout.on("data", captureServerOutput);
    server.stderr.on("data", captureServerOutput);
    await waitForHealthyServer();
  }

  const emptyList = await request(
    `/api/work-items/${workItemId}/artifacts`,
  );
  assert.equal(emptyList.status, 200);
  assert.deepEqual((await emptyList.json()).artifacts, []);

  const initialContent = "# Rollout plan\n\nShip 10% → 40% → 100%.";
  const createdResponse = await request(
    `/api/work-items/${workItemId}/artifacts`,
    {
      method: "POST",
      body: JSON.stringify({
        title: "Checkout rollout plan",
        content: initialContent,
        note: "Initial evidence package",
      }),
    },
  );
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get("cache-control"), "no-store");
  const created = await createdResponse.json();
  assert.equal(created.currentVersion, 1);
  assert.equal(created.mediaType, "text/markdown");
  assert.equal(created.workItemId, workItemId);
  assert.equal(created.versions.length, 1);
  assert.match(created.currentContentHash, /^[0-9a-f]{64}$/);

  const listed = await (
    await request(`/api/work-items/${workItemId}/artifacts`)
  ).json();
  assert.equal(listed.artifacts.length, 1);
  assert.equal(listed.artifacts[0].id, created.id);
  assert.equal(listed.artifacts[0].createdBy.displayName, "Local owner");

  const peerDetailResponse = await request(`/api/artifacts/${created.id}`, {
    headers: testIdentityHeaders(peerId, organizationId),
  });
  assert.equal(peerDetailResponse.status, 200);
  assert.equal((await peerDetailResponse.json()).currentVersion, 1);

  const initialVersionResponse = await request(
    `/api/artifacts/${created.id}/versions/1`,
  );
  assert.equal(initialVersionResponse.status, 200);
  const initialVersion = await initialVersionResponse.json();
  assert.equal(initialVersion.content, initialContent);
  assert.equal(initialVersion.note, "Initial evidence package");
  assert.equal(initialVersion.erasedAt, null);

  const secondContent =
    "# Rollout plan\n\nShip 10% → 25% → 50% → 100% with rollback gates.";
  const appendedResponse = await request(
    `/api/artifacts/${created.id}/versions`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 1,
        content: secondContent,
        note: "Review feedback incorporated",
      }),
    },
  );
  assert.equal(appendedResponse.status, 201);
  const appended = await appendedResponse.json();
  assert.equal(appended.versionNumber, 2);
  assert.equal(appended.content, secondContent);
  assert.notEqual(appended.contentHash, initialVersion.contentHash);

  const versionedDetail = await (
    await request(`/api/artifacts/${created.id}`)
  ).json();
  assert.equal(versionedDetail.currentVersion, 2);
  assert.deepEqual(
    versionedDetail.versions.map((version) => version.versionNumber),
    [2, 1],
  );

  const staleAppend = await request(
    `/api/artifacts/${created.id}/versions`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 1,
        content: "# Stale write",
      }),
    },
  );
  assert.equal(staleAppend.status, 409);
  assert.equal(
    (await staleAppend.json()).error,
    "artifact_version_conflict",
  );
  assert.equal(
    (await (await request(`/api/artifacts/${created.id}`)).json())
      .currentVersion,
    2,
  );

  const concurrentResponses = await Promise.all([
    request(`/api/artifacts/${created.id}/versions`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 2,
        content: "# Concurrent candidate A",
        note: "Only one candidate may become v3",
      }),
    }),
    request(`/api/artifacts/${created.id}/versions`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 2,
        content: "# Concurrent candidate B",
        note: "Only one candidate may become v3",
      }),
    }),
  ]);
  assert.deepEqual(
    concurrentResponses.map((response) => response.status).sort(),
    [201, 409],
  );
  const concurrentDetail = await (
    await request(`/api/artifacts/${created.id}`)
  ).json();
  assert.equal(concurrentDetail.currentVersion, 3);
  assert.deepEqual(
    concurrentDetail.versions.map((version) => version.versionNumber),
    [3, 2, 1],
  );

  const oversized = await request(
    `/api/artifacts/${created.id}/versions`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 3,
        content: "x".repeat(256 * 1024 + 1),
      }),
    },
  );
  assert.equal(oversized.status, 413);
  assert.equal(
    (await oversized.json()).error,
    "artifact_content_too_large",
  );

  const invalidMedia = await request(
    `/api/work-items/${workItemId}/artifacts`,
    {
      method: "POST",
      body: JSON.stringify({
        title: "Binary claim",
        mediaType: "application/pdf",
        content: "not a PDF",
      }),
    },
  );
  assert.equal(invalidMedia.status, 400);
  assert.equal(
    (await invalidMedia.json()).error,
    "invalid_artifact_media_type",
  );

  const crossTenantDetail = await request(`/api/artifacts/${created.id}`, {
    headers: testIdentityHeaders(otherOwnerId, otherOrganizationId),
  });
  assert.equal(crossTenantDetail.status, 404);
  const crossTenantVersion = await request(
    `/api/artifacts/${created.id}/versions/1`,
    {
      headers: testIdentityHeaders(otherOwnerId, otherOrganizationId),
    },
  );
  assert.equal(crossTenantVersion.status, 404);
  const crossTenantList = await request(
    `/api/work-items/${workItemId}/artifacts`,
    {
      headers: testIdentityHeaders(otherOwnerId, otherOrganizationId),
    },
  );
  assert.equal(crossTenantList.status, 404);
  const crossTenantCreate = await request(
    `/api/work-items/${workItemId}/artifacts`,
    {
      method: "POST",
      headers: testIdentityHeaders(otherOwnerId, otherOrganizationId),
      body: JSON.stringify({
        title: "Cross-tenant write",
        content: "# Must not be created",
      }),
    },
  );
  assert.equal(crossTenantCreate.status, 404);
  const crossTenantAppend = await request(
    `/api/artifacts/${created.id}/versions`,
    {
      method: "POST",
      headers: testIdentityHeaders(otherOwnerId, otherOrganizationId),
      body: JSON.stringify({
        expectedVersion: 3,
        content: "# Must not be appended",
      }),
    },
  );
  assert.equal(crossTenantAppend.status, 404);

  const missingMembership = await request(`/api/artifacts/${created.id}`, {
    headers: testIdentityHeaders(
      "principal-local-test-no-membership",
      organizationId,
    ),
  });
  assert.equal(missingMembership.status, 403);
  assert.equal(
    (await missingMembership.json()).error,
    "workspace_membership_required",
  );

  if (testPersistPath) {
    assert.match(created.id, /^[0-9a-f-]+$/);
    await runCommand("npx", [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--config",
      "wrangler.local.jsonc",
      "--persist-to",
      testPersistPath,
      "--command",
      `DROP TRIGGER artifact_payloads_restrict_update;
       UPDATE artifact_payloads
       SET body_text = 'tampered'
       WHERE id = (
         SELECT content_ref FROM artifact_versions
         WHERE artifact_id = '${created.id}' AND version_number = 1
       )`,
    ]);
    const corruptedVersion = await request(
      `/api/artifacts/${created.id}/versions/1`,
    );
    assert.equal(corruptedVersion.status, 503);
    assert.equal(
      (await corruptedVersion.json()).error,
      "artifact_payload_unavailable",
    );
  } else {
    process.stdout.write(
      "Artifact integrity-tamper case skipped against external base URL\n",
    );
  }

  process.stdout.write("Artifacts API integration passed\n");
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
  if (testPersistPath) {
    rmSync(testPersistPath, { recursive: true, force: true });
  }
}

async function waitForHealthyServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(
        `Artifact server exited early (${server?.exitCode}).\n${serverOutput}`,
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
    `Artifact server was not healthy within 90 seconds.\n${serverOutput}`,
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
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function captureServerOutput(chunk) {
  serverOutput = `${serverOutput}${chunk}`.slice(-12_000);
}

function testIdentityHeaders(principalId, organizationIdValue) {
  return {
    "x-nexus-test-principal": principalId,
    "x-nexus-test-organization": organizationIdValue,
  };
}
