import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.NEXUS_PRESENCE_TEST_PORT ?? "3912");
const externalBaseUrl = process.env.NEXUS_TEST_BASE_URL;
const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const testPersistPath = externalBaseUrl
  ? undefined
  : mkdtempSync(join(tmpdir(), "nexusos-presence-integration-"));
let server;
let serverOutput = "";

const ownerId = "principal-local-owner";
const organizationId = "org-local-aurora";
const peerId = "principal-local-test-peer";
const otherOrganizationId = "org-local-test-other";
const otherOwnerId = "principal-local-test-other-owner";
const roomId = "conversation-local-team-room";
const directId = "conversation-local-owner-atlas";
const archivedRoomId = "conversation-local-test-archived";
const firstSessionKey = "presence-session-first-123";
const secondSessionKey = "presence-session-second-12";

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
          NEXUS_PRESENCE_TTL_SECONDS: "6",
          NEXUS_PERSIST_STATE_PATH: testPersistPath,
          WRANGLER_LOG_PATH: ".wrangler/wrangler-presence-integration.log",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout.on("data", captureServerOutput);
    server.stderr.on("data", captureServerOutput);
    await waitForHealthyServer();
  }

  const initialRosterResponse = await request("/api/presence");
  assert.equal(initialRosterResponse.status, 200);
  const initialRoster = await initialRosterResponse.json();
  assert.equal(
    initialRoster.entries.find((entry) => entry.principalId === ownerId)
      ?.status,
    "offline",
  );
  assert.equal(
    initialRoster.entries.find((entry) => entry.principalId !== ownerId)
      ?.room,
    null,
  );
  assert.equal(
    initialRoster.entries.some(
      (entry) => entry.principalId === "principal-local-test-no-membership",
    ),
    false,
    "a human without active workspace membership is not rostered",
  );

  for (const [body, expectedError] of [
    [
      {
        sessionKey: "short",
        status: "available",
        roomConversationId: null,
      },
      "presence_invalid_session",
    ],
    [
      {
        sessionKey: firstSessionKey,
        status: "offline",
        roomConversationId: null,
      },
      "presence_invalid_status",
    ],
    [
      {
        sessionKey: firstSessionKey,
        fencingToken: "1",
        status: "available",
        roomConversationId: null,
      },
      "presence_invalid_session",
    ],
  ]) {
    const invalidCommand = await putSession(body);
    assert.equal(invalidCommand.status, 400);
    assert.equal((await invalidCommand.json()).error, expectedError);
  }

  const invalidDirectPresence = await putSession({
    sessionKey: firstSessionKey,
    status: "available",
    roomConversationId: directId,
  });
  assert.equal(invalidDirectPresence.status, 400);
  assert.equal(
    (await invalidDirectPresence.json()).error,
    "presence_invalid_room",
  );
  const invalidArchivedPresence = await putSession({
    sessionKey: firstSessionKey,
    status: "available",
    roomConversationId: archivedRoomId,
  });
  assert.equal(invalidArchivedPresence.status, 400);

  const claimedResponse = await putSession({
    sessionKey: firstSessionKey,
    status: "available",
    roomConversationId: roomId,
  });
  assert.equal(claimedResponse.status, 200);
  const claimed = await claimedResponse.json();
  assert.equal(claimed.fencingToken, 1);
  assert.equal(claimed.roomCleared, false);
  assert.ok(claimed.ttlSeconds >= 1 && claimed.ttlSeconds <= 300);
  assert.ok(
    claimed.heartbeatSeconds >= 1 &&
      claimed.heartbeatSeconds <= claimed.ttlSeconds / 2,
  );

  const peerRoster = await (
    await request("/api/presence", {
      headers: testIdentityHeaders(peerId, organizationId),
    })
  ).json();
  assert.deepEqual(
    peerRoster.entries.find((entry) => entry.principalId === ownerId)?.room,
    {
      conversationId: roomId,
      title: "Checkout Evolution · Sala operacional",
    },
    "an active room member can see the subject location",
  );

  const otherTenantRoster = await (
    await request("/api/presence", {
      headers: testIdentityHeaders(otherOwnerId, otherOrganizationId),
    })
  ).json();
  assert.equal(
    otherTenantRoster.entries.some((entry) => entry.principalId === ownerId),
    false,
    "presence roster must not leak another tenant",
  );

  const archiveRoom = await request(
    `/api/conversations/${roomId}/archive`,
    {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1 }),
    },
  );
  assert.equal(archiveRoom.status, 200);
  const clearedRoomResponse = await putSession({
    sessionKey: firstSessionKey,
    fencingToken: claimed.fencingToken,
    status: "dnd",
    roomConversationId: roomId,
  });
  assert.equal(clearedRoomResponse.status, 200);
  const clearedRoom = await clearedRoomResponse.json();
  assert.equal(clearedRoom.roomCleared, true);
  const rosterAfterRoomArchive = await (
    await request("/api/presence")
  ).json();
  const ownerAfterRoomArchive = rosterAfterRoomArchive.entries.find(
    (entry) => entry.principalId === ownerId,
  );
  assert.equal(ownerAfterRoomArchive.status, "dnd");
  assert.equal(ownerAfterRoomArchive.room, null);

  const takeoverResponse = await putSession({
    sessionKey: secondSessionKey,
    status: "focus",
    roomConversationId: null,
  });
  assert.equal(takeoverResponse.status, 200);
  const takeover = await takeoverResponse.json();
  assert.equal(takeover.fencingToken, claimed.fencingToken + 1);

  const staleHeartbeat = await putSession({
    sessionKey: firstSessionKey,
    fencingToken: claimed.fencingToken,
    status: "available",
    roomConversationId: null,
  });
  assert.equal(staleHeartbeat.status, 409);
  assert.equal(
    (await staleHeartbeat.json()).error,
    "presence_stale_session",
  );
  const staleRelease = await deleteSession({
    sessionKey: firstSessionKey,
    fencingToken: claimed.fencingToken,
  });
  assert.equal(staleRelease.status, 204);
  assert.equal(await staleRelease.text(), "");
  assert.equal(staleRelease.headers.get("cache-control"), "no-store");
  const rosterAfterStaleRelease = await (
    await request("/api/presence")
  ).json();
  assert.equal(
    rosterAfterStaleRelease.entries.find(
      (entry) => entry.principalId === ownerId,
    )?.status,
    "focus",
    "a stale tab cannot release the current lease",
  );

  const renewedResponse = await putSession({
    sessionKey: secondSessionKey,
    fencingToken: takeover.fencingToken,
    status: "available",
    roomConversationId: null,
  });
  assert.equal(renewedResponse.status, 200);
  assert.equal((await renewedResponse.json()).fencingToken, 2);
  const releaseResponse = await deleteSession({
    sessionKey: secondSessionKey,
    fencingToken: takeover.fencingToken,
  });
  assert.equal(releaseResponse.status, 204);
  assert.equal(
    (
      await (await request("/api/presence")).json()
    ).entries.find((entry) => entry.principalId === ownerId)?.status,
    "offline",
  );

  if (!externalBaseUrl) {
    const expiringSessionKey = "presence-session-expiring-1";
    const expiringResponse = await putSession({
      sessionKey: expiringSessionKey,
      status: "available",
      roomConversationId: null,
    });
    assert.equal(expiringResponse.status, 200);
    const expiring = await expiringResponse.json();
    assert.equal(expiring.fencingToken, 1);
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    const expiredRoster = await (await request("/api/presence")).json();
    assert.equal(
      expiredRoster.entries.find((entry) => entry.principalId === ownerId)
        ?.status,
      "offline",
    );
    const afterCleanupResponse = await putSession({
      sessionKey: "presence-session-after-cleanup",
      status: "available",
      roomConversationId: null,
    });
    assert.equal(afterCleanupResponse.status, 200);
    const afterCleanup = await afterCleanupResponse.json();
    assert.equal(
      afterCleanup.fencingToken,
      1,
      "the expired row was deleted rather than retained as history",
    );
    assert.equal(
      (
        await deleteSession({
          sessionKey: "presence-session-after-cleanup",
          fencingToken: afterCleanup.fencingToken,
        })
      ).status,
      204,
    );

    const raceSessionKey = "presence-session-cleanup-race";
    const raceClaimResponse = await putSession({
      sessionKey: raceSessionKey,
      status: "available",
      roomConversationId: null,
    });
    assert.equal(raceClaimResponse.status, 200);
    const raceClaim = await raceClaimResponse.json();
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    const [racingRosterResponse, racingReclaimResponse] = await Promise.all([
      request("/api/presence"),
      putSession({
        sessionKey: "presence-session-cleanup-winner",
        fencingToken: raceClaim.fencingToken,
        status: "focus",
        roomConversationId: null,
      }),
    ]);
    assert.equal(racingRosterResponse.status, 200);
    assert.equal(
      racingReclaimResponse.status,
      200,
      "cleanup racing an expired re-claim must not create a false stale session",
    );
    const racingReclaim = await racingReclaimResponse.json();
    assert.ok([1, 2].includes(racingReclaim.fencingToken));
    await deleteSession({
      sessionKey: "presence-session-cleanup-winner",
      fencingToken: racingReclaim.fencingToken,
    });
  }

  process.stdout.write("Presence API integration passed\n");
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

function putSession(body) {
  return request("/api/presence/session", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function deleteSession(body) {
  return request("/api/presence/session", {
    method: "DELETE",
    body: JSON.stringify(body),
  });
}

async function waitForHealthyServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(
        `Presence server exited early (${server?.exitCode}).\n${serverOutput}`,
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
    `Presence server was not healthy within 90 seconds.\n${serverOutput}`,
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
