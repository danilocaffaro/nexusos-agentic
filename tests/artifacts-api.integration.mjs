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

  const duplicateArtifactResponse = await request(
    `/api/work-items/${workItemId}/artifacts`,
    {
      method: "POST",
      body: JSON.stringify({
        title: "Same content, second artifact",
        content: initialContent,
        note: "Must reuse the organization-scoped live payload",
      }),
    },
  );
  assert.equal(duplicateArtifactResponse.status, 201);
  const duplicateArtifact = await duplicateArtifactResponse.json();
  const initialImpactResponse = await request(
    `/api/artifacts/${created.id}/versions/1/erasure-intents`,
  );
  assert.equal(initialImpactResponse.status, 200);
  const initialImpact = await initialImpactResponse.json();
  assert.equal(initialImpact.referenceCount, 2);
  assert.equal(initialImpact.livePayloadCount, 1);
  assert.deepEqual(
    new Set(initialImpact.versions.map((version) => version.artifactId)),
    new Set([created.id, duplicateArtifact.id]),
  );

  const invalidErasureReason = await request(
    `/api/artifacts/${created.id}/versions/1/erasure-intents`,
    {
      method: "POST",
      body: JSON.stringify({ reason: "short" }),
    },
  );
  assert.equal(invalidErasureReason.status, 400);
  assert.equal(
    (await invalidErasureReason.json()).error,
    "invalid_artifact_erasure_reason",
  );
  const crossTenantErasureImpact = await request(
    `/api/artifacts/${created.id}/versions/1/erasure-intents`,
    {
      headers: testIdentityHeaders(otherOwnerId, otherOrganizationId),
    },
  );
  assert.equal(crossTenantErasureImpact.status, 404);
  const crossTenantErasureProposal = await request(
    `/api/artifacts/${created.id}/versions/1/erasure-intents`,
    {
      method: "POST",
      headers: testIdentityHeaders(otherOwnerId, otherOrganizationId),
      body: JSON.stringify({
        reason: "A different tenant must never propose this erasure",
      }),
    },
  );
  assert.equal(crossTenantErasureProposal.status, 404);
  const nonmemberErasureProposal = await request(
    `/api/artifacts/${created.id}/versions/1/erasure-intents`,
    {
      method: "POST",
      headers: testIdentityHeaders(
        "principal-local-test-no-membership",
        organizationId,
      ),
      body: JSON.stringify({
        reason: "A nonmember must never propose artifact erasure",
      }),
    },
  );
  assert.equal(nonmemberErasureProposal.status, 403);
  const nonmemberErasureImpact = await request(
    `/api/artifacts/${created.id}/versions/1/erasure-intents`,
    {
      headers: testIdentityHeaders(
        "principal-local-test-no-membership",
        organizationId,
      ),
    },
  );
  assert.equal(nonmemberErasureImpact.status, 403);

  const erasureReason =
    "The published rollout details have reached their approved retention limit.";
  const erasureProposalResponse = await request(
    `/api/artifacts/${created.id}/versions/1/erasure-intents`,
    {
      method: "POST",
      body: JSON.stringify({ reason: erasureReason }),
    },
  );
  assert.equal(erasureProposalResponse.status, 201);
  const erasureProposal = await erasureProposalResponse.json();
  assert.equal(erasureProposal.intent.status, "proposed");
  assert.equal(
    erasureProposal.intent.actionType,
    "nexus.artifact.erase_payload",
  );
  assert.equal(erasureProposal.intent.parameters.referenceCount, 2);
  assert.equal(erasureProposal.intent.parameters.reason, erasureReason);
  assert.equal(erasureProposal.intent.proposerId, "principal-local-owner");
  assert.equal(erasureProposal.intent.proposerKind, "human");
  assert.equal(erasureProposal.intent.separationOfDuties, true);
  assert.equal(erasureProposal.intent.selfApprovalPolicy, undefined);
  assert.equal(erasureProposal.impact.livePayloadCount, 1);
  const retriedErasureProposal = await request(
    `/api/artifacts/${created.id}/versions/1/erasure-intents`,
    {
      method: "POST",
      body: JSON.stringify({ reason: erasureReason }),
    },
  );
  assert.equal(retriedErasureProposal.status, 200);
  assert.equal(
    (await retriedErasureProposal.json()).intent.id,
    erasureProposal.intent.id,
  );
  const requesterAttention = await (await request("/api/attention")).json();
  assert.equal(
    requesterAttention.items.some(
      (item) => item.intent.id === erasureProposal.intent.id,
    ),
    false,
    "the requester must not receive an approval task when a peer is eligible",
  );
  const erasureAttention = await (
    await request("/api/attention", {
      headers: testIdentityHeaders(peerId, organizationId),
    })
  ).json();
  assert.equal(
    erasureAttention.items.some(
      (item) => item.intent.id === erasureProposal.intent.id,
    ),
    true,
  );
  const unapprovedErasureExecution = await request(
    `/api/governance/intents/${erasureProposal.intent.id}/execute`,
    { method: "POST" },
  );
  assert.equal(unapprovedErasureExecution.status, 409);
  assert.equal(
    (await unapprovedErasureExecution.json()).error,
    "invalid_state",
  );
  const nonmemberApproval = await request(
    `/api/governance/intents/${erasureProposal.intent.id}/approve`,
    {
      method: "POST",
      headers: testIdentityHeaders(
        "principal-local-test-no-membership",
        organizationId,
      ),
      body: JSON.stringify({
        parametersHash: erasureProposal.intent.parametersHash,
      }),
    },
  );
  assert.equal(nonmemberApproval.status, 403);
  const selfApprovalResponse = await request(
    `/api/governance/intents/${erasureProposal.intent.id}/approve`,
    {
      method: "POST",
      body: JSON.stringify({
        parametersHash: erasureProposal.intent.parametersHash,
      }),
    },
  );
  assert.equal(selfApprovalResponse.status, 409);
  assert.equal(
    (await selfApprovalResponse.json()).error,
    "separation_of_duties",
  );
  const approvedErasureResponse = await request(
    `/api/governance/intents/${erasureProposal.intent.id}/approve`,
    {
      method: "POST",
      headers: testIdentityHeaders(peerId, organizationId),
      body: JSON.stringify({
        parametersHash: erasureProposal.intent.parametersHash,
      }),
    },
  );
  assert.equal(approvedErasureResponse.status, 200);

  const appendDuringApproval = await request(
    `/api/artifacts/${created.id}/versions`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 3,
        content: initialContent,
        note: "Grows the approved blast radius before execution",
      }),
    },
  );
  assert.equal(appendDuringApproval.status, 201);
  assert.equal((await appendDuringApproval.json()).versionNumber, 4);
  const staleErasureExecutions = await Promise.all([
    request(
      `/api/governance/intents/${erasureProposal.intent.id}/execute`,
      { method: "POST" },
    ),
    request(
      `/api/governance/intents/${erasureProposal.intent.id}/execute`,
      { method: "POST" },
    ),
  ]);
  assert.deepEqual(
    staleErasureExecutions.map((response) => response.status),
    [409, 409],
  );
  const stateAfterStaleErasure = await (
    await request(
      `/api/governance/intents?intentId=${erasureProposal.intent.id}`,
    )
  ).json();
  assert.equal(
    stateAfterStaleErasure.intents.find(
      (intent) => intent.id === erasureProposal.intent.id,
    )?.status,
    "failed",
  );
  assert.equal(
    stateAfterStaleErasure.ledger.filter(
      (entry) =>
        entry.intentId === erasureProposal.intent.id &&
        entry.kind === "effect.failed",
    ).length,
    1,
    "concurrent stale executors must record the terminal failure once",
  );
  assert.equal(
    (await (
      await request(`/api/artifacts/${created.id}/versions/1`)
    ).json()).content,
    initialContent,
    "a stale blast radius must erase nothing",
  );

  const refreshedProposalResponse = await request(
    `/api/artifacts/${duplicateArtifact.id}/versions/1/erasure-intents`,
    {
      method: "POST",
      body: JSON.stringify({ reason: erasureReason }),
    },
  );
  assert.equal(refreshedProposalResponse.status, 201);
  const refreshedProposal = await refreshedProposalResponse.json();
  assert.equal(refreshedProposal.intent.parameters.referenceCount, 3);
  const refreshedApproval = await request(
    `/api/governance/intents/${refreshedProposal.intent.id}/approve`,
    {
      method: "POST",
      headers: testIdentityHeaders(peerId, organizationId),
      body: JSON.stringify({
        parametersHash: refreshedProposal.intent.parametersHash,
      }),
    },
  );
  assert.equal(refreshedApproval.status, 200);
  const erasureExecutions = await Promise.all([
    request(
      `/api/governance/intents/${refreshedProposal.intent.id}/execute`,
      { method: "POST" },
    ),
    request(
      `/api/governance/intents/${refreshedProposal.intent.id}/execute`,
      { method: "POST" },
    ),
  ]);
  assert.deepEqual(
    erasureExecutions.map((response) => response.status).sort(),
    [200, 409],
    "a concurrent execution race must have exactly one winner",
  );
  const erasureExecution = erasureExecutions.find(
    (response) => response.status === 200,
  );
  assert.ok(erasureExecution);
  const erasureResult = await erasureExecution.json();
  assert.equal(erasureResult.intent.status, "succeeded");
  assert.equal(erasureResult.receipt.kind, "artifact_erasure");
  assert.equal(erasureResult.receipt.affectedVersions, 3);
  assert.equal(erasureResult.receipt.erasedPayloadRows, 1);
  assert.equal(erasureResult.receipt.erasure, "logical_unavailability");
  for (const [artifactId, versionNumber] of [
    [created.id, 1],
    [created.id, 4],
    [duplicateArtifact.id, 1],
  ]) {
    const erased = await (
      await request(
        `/api/artifacts/${artifactId}/versions/${versionNumber}`,
      )
    ).json();
    assert.equal(erased.content, null);
    assert.equal(typeof erased.erasedAt, "string");
    assert.equal(erased.contentHash, initialVersion.contentHash);
  }
  const duplicateSuccessfulErasure = await request(
    `/api/artifacts/${created.id}/versions/1/erasure-intents`,
    {
      method: "POST",
      body: JSON.stringify({ reason: erasureReason }),
    },
  );
  assert.equal(duplicateSuccessfulErasure.status, 409);
  assert.equal(
    (await duplicateSuccessfulErasure.json()).error,
    "artifact_already_erased",
  );

  const reappendedAfterErasure = await request(
    `/api/artifacts/${created.id}/versions`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 4,
        content: initialContent,
        note: "Fresh payload after logical erasure",
      }),
    },
  );
  assert.equal(reappendedAfterErasure.status, 201);
  assert.equal((await reappendedAfterErasure.json()).versionNumber, 5);
  const readableFreshVersion = await (
    await request(`/api/artifacts/${created.id}/versions/5`)
  ).json();
  assert.equal(readableFreshVersion.content, initialContent);
  assert.equal(readableFreshVersion.erasedAt, null);
  const postErasureImpact = await (
    await request(
      `/api/artifacts/${created.id}/versions/5/erasure-intents`,
    )
  ).json();
  assert.equal(postErasureImpact.referenceCount, 4);
  assert.equal(postErasureImpact.livePayloadCount, 1);
  const governanceAfterErasure = await (
    await request("/api/governance/intents")
  ).json();
  assert.equal(governanceAfterErasure.verification.valid, true);
  assert.equal(
    governanceAfterErasure.ledger.filter(
      (entry) => entry.intentId === refreshedProposal.intent.id,
    ).length,
    4,
    "a concurrent loser must not duplicate effect ledger entries",
  );

  if (testPersistPath) {
    const soloArtifact = await (
      await request(`/api/work-items/${workItemId}/artifacts`, {
        method: "POST",
        body: JSON.stringify({
          title: "Solo owner commit proof",
          content: `# Solo owner\n\n${crypto.randomUUID()}`,
          note: "No eligible approval peer at proposal or commit",
        }),
      })
    ).json();
    const staleSoloArtifact = await (
      await request(`/api/work-items/${workItemId}/artifacts`, {
        method: "POST",
        body: JSON.stringify({
          title: "Solo owner stale-policy proof",
          content: `# Peer appeared\n\n${crypto.randomUUID()}`,
          note: "An approval peer becomes active before commit",
        }),
      })
    ).json();
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
      `UPDATE memberships
       SET status = 'suspended'
       WHERE id = 'membership-local-test-peer'`,
    ]);
    const soloReason =
      "The sole owner accepts the explicitly disclosed local approval exception.";
    const soloProposal = await (
      await request(
        `/api/artifacts/${soloArtifact.id}/versions/1/erasure-intents`,
        {
          method: "POST",
          body: JSON.stringify({ reason: soloReason }),
        },
      )
    ).json();
    assert.equal(soloProposal.intent.separationOfDuties, false);
    assert.equal(soloProposal.intent.selfApprovalPolicy, "solo_owner");
    const soloApproval = await request(
      `/api/governance/intents/${soloProposal.intent.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          parametersHash: soloProposal.intent.parametersHash,
          soloOwnerAcknowledged: true,
        }),
      },
    );
    assert.equal(soloApproval.status, 200);

    const staleSoloReason =
      "The commit-time guard must detect an approver activated after proposal.";
    const staleSoloProposal = await (
      await request(
        `/api/artifacts/${staleSoloArtifact.id}/versions/1/erasure-intents`,
        {
          method: "POST",
          body: JSON.stringify({ reason: staleSoloReason }),
        },
      )
    ).json();
    assert.equal(staleSoloProposal.intent.separationOfDuties, false);
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
      `UPDATE memberships
       SET status = 'active'
       WHERE id = 'membership-local-test-peer'`,
    ]);
    const staleSoloApproval = await request(
      `/api/governance/intents/${staleSoloProposal.intent.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          parametersHash: staleSoloProposal.intent.parametersHash,
          soloOwnerAcknowledged: true,
        }),
      },
    );
    assert.equal(staleSoloApproval.status, 409);
    assert.equal(
      (await staleSoloApproval.json()).error,
      "solo_owner_peer_exists",
    );
    const stateAfterStaleSolo = await (
      await request(
        `/api/governance/intents?intentId=${staleSoloProposal.intent.id}`,
      )
    ).json();
    assert.equal(
      stateAfterStaleSolo.intents.find(
        (intent) => intent.id === staleSoloProposal.intent.id,
      )?.status,
      "proposed",
    );
    assert.equal(
      stateAfterStaleSolo.ledger.filter(
        (entry) => entry.intentId === staleSoloProposal.intent.id,
      ).length,
      1,
      "the rejected solo commit must persist neither approval nor ledger event",
    );
    const peerApprovalAfterStaleSolo = await request(
      `/api/governance/intents/${staleSoloProposal.intent.id}/approve`,
      {
        method: "POST",
        headers: testIdentityHeaders(peerId, organizationId),
        body: JSON.stringify({
          parametersHash: staleSoloProposal.intent.parametersHash,
        }),
      },
    );
    assert.equal(peerApprovalAfterStaleSolo.status, 200);

    const expiringArtifact = await (
      await request(`/api/work-items/${workItemId}/artifacts`, {
        method: "POST",
        body: JSON.stringify({
          title: "Expiry retry proof",
          content: `# Expiry retry\n\n${crypto.randomUUID()}`,
          note: "Exercises terminal-safe semantic idempotency",
        }),
      })
    ).json();
    const expiringReason =
      "The approval window elapsed before this governed effect could start.";
    const expiringProposal = await (
      await request(
        `/api/artifacts/${expiringArtifact.id}/versions/1/erasure-intents`,
        {
          method: "POST",
          body: JSON.stringify({ reason: expiringReason }),
        },
      )
    ).json();
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
      `UPDATE action_intents
       SET expires_at = '2000-01-01T00:00:00.000Z'
       WHERE id = '${expiringProposal.intent.id}'`,
    ]);
    const replacementResponse = await request(
      `/api/artifacts/${expiringArtifact.id}/versions/1/erasure-intents`,
      {
        method: "POST",
        body: JSON.stringify({ reason: expiringReason }),
      },
    );
    assert.equal(replacementResponse.status, 201);
    const replacement = await replacementResponse.json();
    assert.notEqual(replacement.intent.id, expiringProposal.intent.id);
    assert.equal(
      replacement.intent.supersedesIntentId,
      expiringProposal.intent.id,
    );
    const expiryState = await (
      await request(
        `/api/governance/intents?intentId=${expiringProposal.intent.id}`,
      )
    ).json();
    assert.equal(
      expiryState.intents.find(
        (intent) => intent.id === expiringProposal.intent.id,
      )?.status,
      "expired",
    );
    assert.equal(expiryState.verification.valid, true);
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
      `UPDATE action_intents
       SET parameters_json = '{}'
       WHERE id = '${replacement.intent.id}'`,
    ]);
    const mismatchedParameterExecution = await request(
      `/api/governance/intents/${replacement.intent.id}/execute`,
      { method: "POST" },
    );
    assert.equal(mismatchedParameterExecution.status, 422);
    assert.equal(
      (await mismatchedParameterExecution.json()).error,
      "parameters_hash_mismatch",
    );
    const restoredParameters = JSON.stringify(
      replacement.intent.parameters,
    ).replaceAll("'", "''");
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
      `UPDATE action_intents
       SET parameters_json = '${restoredParameters}'
       WHERE id = '${replacement.intent.id}'`,
    ]);

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
         WHERE artifact_id = '${created.id}' AND version_number = 2
       )`,
    ]);
    const corruptedVersion = await request(
      `/api/artifacts/${created.id}/versions/2`,
    );
    assert.equal(corruptedVersion.status, 503);
    assert.equal(
      (await corruptedVersion.json()).error,
      "artifact_payload_unavailable",
    );
    const collisionAppend = await request(
      `/api/artifacts/${created.id}/versions`,
      {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: 5,
          content: secondContent,
          note: "A forged hash hit must fail closed",
        }),
      },
    );
    assert.equal(collisionAppend.status, 503);
    assert.equal(
      (await collisionAppend.json()).error,
      "artifact_content_hash_conflict",
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
