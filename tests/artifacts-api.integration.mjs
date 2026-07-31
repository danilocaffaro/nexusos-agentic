import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

  const targetArtifact = await (
    await request(`/api/work-items/${workItemId}/artifacts`, {
      method: "POST",
      body: JSON.stringify({
        title: "Checkout rollout replacement",
        content: "# Replacement\n\nCanonical rollout guidance.",
      }),
    })
  ).json();
  const thirdArtifact = await (
    await request(`/api/work-items/${workItemId}/artifacts`, {
      method: "POST",
      body: JSON.stringify({
        title: "Checkout rollout final",
        content: "# Final\n\nConsolidated operating guidance.",
      }),
    })
  ).json();
  const duplicateHeadArtifact = await (
    await request(`/api/work-items/${workItemId}/artifacts`, {
      method: "POST",
      body: JSON.stringify({
        title: "Byte-identical copy",
        content: concurrentDetail.versions[0].contentHash
          ? (
              await (
                await request(
                  `/api/artifacts/${created.id}/versions/3`,
                )
              ).json()
            ).content
          : "# unreachable",
      }),
    })
  ).json();
  const supersessionPath = `/api/artifacts/${created.id}/supersession`;
  const initialSupersessionState = await (
    await request(supersessionPath)
  ).json();
  assert.equal(initialSupersessionState.canGovern, true);
  assert.equal(initialSupersessionState.active, undefined);
  assert.equal(
    initialSupersessionState.candidates.some(
      (candidate) => candidate.artifactId === targetArtifact.id,
    ),
    true,
  );
  const memberSupersession = await request(supersessionPath, {
    method: "POST",
    headers: testIdentityHeaders(
      "principal-local-test-no-membership",
      organizationId,
    ),
    body: JSON.stringify({
      targetArtifactId: targetArtifact.id,
      sourceVersionNumber: 3,
      targetVersionNumber: 1,
      reasonCode: "replaced_by_revision",
    }),
  });
  assert.equal(memberSupersession.status, 403);
  assert.equal(
    (await memberSupersession.json()).error,
    "workspace_owner_required",
  );
  const staleSupersession = await request(supersessionPath, {
    method: "POST",
    body: JSON.stringify({
      targetArtifactId: targetArtifact.id,
      sourceVersionNumber: 2,
      targetVersionNumber: 1,
      reasonCode: "replaced_by_revision",
    }),
  });
  assert.equal(staleSupersession.status, 409);
  assert.equal(
    (await staleSupersession.json()).error,
    "supersession_head_moved",
  );
  const selfSupersession = await request(supersessionPath, {
    method: "POST",
    body: JSON.stringify({
      targetArtifactId: created.id,
      sourceVersionNumber: 3,
      targetVersionNumber: 3,
      reasonCode: "duplicate_output",
    }),
  });
  assert.equal(selfSupersession.status, 400);
  assert.equal(
    (await selfSupersession.json()).error,
    "supersession_self_reference",
  );
  const identicalSupersession = await request(supersessionPath, {
    method: "POST",
    body: JSON.stringify({
      targetArtifactId: duplicateHeadArtifact.id,
      sourceVersionNumber: 3,
      targetVersionNumber: 1,
      reasonCode: "duplicate_output",
    }),
  });
  assert.equal(identicalSupersession.status, 409);
  assert.equal(
    (await identicalSupersession.json()).error,
    "supersession_target_identical",
  );
  const sourceBeforeSupersession = await (
    await request(`/api/artifacts/${created.id}`)
  ).json();
  const declaredSupersessionResponse = await request(supersessionPath, {
    method: "POST",
    body: JSON.stringify({
      targetArtifactId: targetArtifact.id,
      sourceVersionNumber: 3,
      targetVersionNumber: 1,
      reasonCode: "replaced_by_revision",
    }),
  });
  assert.equal(declaredSupersessionResponse.status, 201);
  const declaredSupersession =
    (await declaredSupersessionResponse.json()).supersession;
  assert.equal(declaredSupersession.source.artifactId, created.id);
  assert.equal(
    declaredSupersession.target.artifactId,
    targetArtifact.id,
  );
  const sourceAfterSupersession = await (
    await request(`/api/artifacts/${created.id}`)
  ).json();
  assert.equal(
    sourceAfterSupersession.currentVersion,
    sourceBeforeSupersession.currentVersion,
  );
  assert.equal(
    sourceAfterSupersession.updatedAt,
    sourceBeforeSupersession.updatedAt,
  );
  const idempotentSupersession = await request(supersessionPath, {
    method: "POST",
    body: JSON.stringify({
      targetArtifactId: targetArtifact.id,
      sourceVersionNumber: 3,
      targetVersionNumber: 1,
      reasonCode: "replaced_by_revision",
    }),
  });
  assert.equal(idempotentSupersession.status, 200);
  assert.equal(
    (await idempotentSupersession.json()).supersession.id,
    declaredSupersession.id,
  );
  const conflictingSupersession = await request(supersessionPath, {
    method: "POST",
    body: JSON.stringify({
      targetArtifactId: thirdArtifact.id,
      sourceVersionNumber: 3,
      targetVersionNumber: 1,
      reasonCode: "scope_moved",
    }),
  });
  assert.equal(conflictingSupersession.status, 409);
  assert.equal(
    (await conflictingSupersession.json()).error,
    "supersession_exists",
  );
  const targetInboundState = await (
    await request(`/api/artifacts/${targetArtifact.id}/supersession`)
  ).json();
  assert.equal(targetInboundState.inbound.length, 1);
  assert.equal(targetInboundState.inbound[0].id, declaredSupersession.id);
  const targetHeadTwo = await (
    await request(`/api/artifacts/${targetArtifact.id}/versions`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 1,
        content: "# Replacement v2\n\nPublished after the supersession.",
      }),
    })
  ).json();
  assert.equal(targetHeadTwo.versionNumber, 2);
  const staleRelationState = await (
    await request(supersessionPath)
  ).json();
  assert.equal(staleRelationState.active.source.staleHead, false);
  assert.equal(staleRelationState.active.target.staleHead, true);
  const retractPath =
    `${supersessionPath}/${declaredSupersession.id}/retract`;
  const retractedSupersessionResponse = await request(retractPath, {
    method: "POST",
    body: JSON.stringify({
      expectedRelationId: declaredSupersession.id,
      retractionReasonCode: "no_longer_accurate",
    }),
  });
  assert.equal(retractedSupersessionResponse.status, 200);
  assert.equal(
    (await retractedSupersessionResponse.json()).supersession.status,
    "retracted",
  );
  const idempotentRetraction = await request(retractPath, {
    method: "POST",
    body: JSON.stringify({
      expectedRelationId: declaredSupersession.id,
      retractionReasonCode: "no_longer_accurate",
    }),
  });
  assert.equal(idempotentRetraction.status, 200);
  assert.equal((await idempotentRetraction.json()).created, false);
  const targetToThird = await request(
    `/api/artifacts/${targetArtifact.id}/supersession`,
    {
      method: "POST",
      body: JSON.stringify({
        targetArtifactId: thirdArtifact.id,
        sourceVersionNumber: 2,
        targetVersionNumber: 1,
        reasonCode: "scope_moved",
      }),
    },
  );
  assert.equal(targetToThird.status, 201);
  const thirdToSource = await request(
    `/api/artifacts/${thirdArtifact.id}/supersession`,
    {
      method: "POST",
      body: JSON.stringify({
        targetArtifactId: created.id,
        sourceVersionNumber: 1,
        targetVersionNumber: 3,
        reasonCode: "scope_moved",
      }),
    },
  );
  assert.equal(thirdToSource.status, 201);
  const recursiveCycle = await request(supersessionPath, {
    method: "POST",
    body: JSON.stringify({
      targetArtifactId: targetArtifact.id,
      sourceVersionNumber: 3,
      targetVersionNumber: 2,
      reasonCode: "scope_moved",
    }),
  });
  assert.equal(recursiveCycle.status, 409);
  assert.equal(
    (await recursiveCycle.json()).error,
    "supersession_cycle_rejected",
  );
  const supersessionLedgerState = await (
    await request("/api/governance/intents")
  ).json();
  const supersessionLedger = supersessionLedgerState.ledger.filter((entry) =>
    entry.payloadRef?.startsWith("nexus://artifact-supersession/"),
  );
  assert.equal(
    supersessionLedger.filter(
      (entry) => entry.kind === "supersession.declared",
    ).length,
    3,
  );
  assert.equal(
    supersessionLedger.filter(
      (entry) => entry.kind === "supersession.retracted",
    ).length,
    1,
  );
  assert.equal(
    supersessionLedger.filter(
      (entry) =>
        entry.payloadRef ===
        `nexus://artifact-supersession/${declaredSupersession.id}`,
    ).length,
    2,
  );
  assert.equal(supersessionLedgerState.verification.valid, true);

  const reviewPath = `/api/artifacts/${created.id}/versions/1/reviews`;
  const initialReviewStateResponse = await request(reviewPath);
  assert.equal(initialReviewStateResponse.status, 200);
  assert.equal(initialReviewStateResponse.headers.get("cache-control"), "no-store");
  const initialReviewState = await initialReviewStateResponse.json();
  assert.equal(initialReviewState.artifactId, created.id);
  assert.equal(initialReviewState.versionNumber, 1);
  assert.equal(initialReviewState.contentHash, initialVersion.contentHash);
  assert.equal(initialReviewState.selfReviewApproval, "independent_required");
  assert.equal(initialReviewState.myActiveReviewId, undefined);
  assert.deepEqual(initialReviewState.reviews, []);

  const unknownReviewField = await request(reviewPath, {
    method: "POST",
    body: JSON.stringify({
      verdict: "changes_requested",
      reasonCode: "needs_evidence",
      note: "This text must never be silently accepted",
    }),
  });
  assert.equal(unknownReviewField.status, 400);
  assert.equal(
    (await unknownReviewField.json()).error,
    "invalid_review_request",
  );
  const invalidReview = await request(reviewPath, {
    method: "POST",
    body: JSON.stringify({
      verdict: "approved",
      reasonCode: "needs_correction",
    }),
  });
  assert.equal(invalidReview.status, 400);
  assert.equal(
    (await invalidReview.json()).error,
    "invalid_review_reason",
  );
  const blockedProducerApproval = await request(reviewPath, {
    method: "POST",
    body: JSON.stringify({
      verdict: "approved",
      reasonCode: "accurate",
      soloOwnerAcknowledged: true,
    }),
  });
  assert.equal(blockedProducerApproval.status, 409);
  assert.equal(
    (await blockedProducerApproval.json()).error,
    "independent_artifact_reviewer_required",
  );
  const producerChangesResponse = await request(reviewPath, {
    method: "POST",
    body: JSON.stringify({
      verdict: "changes_requested",
      reasonCode: "needs_evidence",
    }),
  });
  assert.equal(producerChangesResponse.status, 201);
  const producerReview = (await producerChangesResponse.json()).review;
  assert.equal(producerReview.status, "active");
  assert.equal(producerReview.selfReviewPolicy, undefined);

  const peerInitialReviewState = await (
    await request(reviewPath, {
      headers: testIdentityHeaders(peerId, organizationId),
    })
  ).json();
  assert.equal(peerInitialReviewState.selfReviewApproval, "not_self");
  const peerApprovalResponse = await request(reviewPath, {
    method: "POST",
    headers: testIdentityHeaders(peerId, organizationId),
    body: JSON.stringify({
      verdict: "approved",
      reasonCode: "complete",
    }),
  });
  assert.equal(peerApprovalResponse.status, 201);
  const peerApproval = await peerApprovalResponse.json();
  assert.equal(peerApproval.review.verdict, "approved");
  const idempotentPeerApproval = await request(reviewPath, {
    method: "POST",
    headers: testIdentityHeaders(peerId, organizationId),
    body: JSON.stringify({
      verdict: "approved",
      reasonCode: "complete",
    }),
  });
  assert.equal(idempotentPeerApproval.status, 200);
  assert.equal(
    (await idempotentPeerApproval.json()).review.id,
    peerApproval.review.id,
  );
  const malformedIdempotentPeerApproval = await request(reviewPath, {
    method: "POST",
    headers: testIdentityHeaders(peerId, organizationId),
    body: JSON.stringify({
      verdict: "approved",
      reasonCode: "complete",
      expectedReviewId: 42,
    }),
  });
  assert.equal(malformedIdempotentPeerApproval.status, 400);
  assert.equal(
    (await malformedIdempotentPeerApproval.json()).error,
    "invalid_review_request",
  );

  const peerReReviewRace = await Promise.all([
    request(reviewPath, {
      method: "POST",
      headers: testIdentityHeaders(peerId, organizationId),
      body: JSON.stringify({
        verdict: "changes_requested",
        reasonCode: "outdated",
        expectedReviewId: peerApproval.review.id,
      }),
    }),
    request(reviewPath, {
      method: "POST",
      headers: testIdentityHeaders(peerId, organizationId),
      body: JSON.stringify({
        verdict: "changes_requested",
        reasonCode: "needs_correction",
        expectedReviewId: peerApproval.review.id,
      }),
    }),
  ]);
  assert.deepEqual(
    peerReReviewRace.map((response) => response.status).sort(),
    [201, 409],
  );
  assert.equal(
    (await peerReReviewRace
      .find((response) => response.status === 409)
      .json()).error,
    "review_conflict",
  );
  const peerWinningReview = await peerReReviewRace
    .find((response) => response.status === 201)
    .json();
  assert.equal(
    peerWinningReview.review.supersedesReviewId,
    peerApproval.review.id,
  );
  const reviewStateAfterRace = await (
    await request(reviewPath, {
      headers: testIdentityHeaders(peerId, organizationId),
    })
  ).json();
  assert.equal(
    reviewStateAfterRace.reviews.filter(
      (review) => review.status === "active",
    ).length,
    2,
  );
  assert.equal(
    reviewStateAfterRace.reviews.filter(
      (review) => review.status === "superseded",
    ).length,
    1,
  );
  assert.equal(
    reviewStateAfterRace.reviews.find(
      (review) => review.id === peerApproval.review.id,
    ).supersededBy.id,
    peerId,
  );
  assert.equal(
    reviewStateAfterRace.myActiveReviewId,
    peerWinningReview.review.id,
  );

  const crossTenantReviews = await request(reviewPath, {
    headers: testIdentityHeaders(otherOwnerId, otherOrganizationId),
  });
  assert.equal(crossTenantReviews.status, 404);
  const crossTenantReviewWrite = await request(reviewPath, {
    method: "POST",
    headers: testIdentityHeaders(otherOwnerId, otherOrganizationId),
    body: JSON.stringify({
      verdict: "changes_requested",
      reasonCode: "outdated",
    }),
  });
  assert.equal(crossTenantReviewWrite.status, 404);
  const nonmemberReviews = await request(reviewPath, {
    headers: testIdentityHeaders(
      "principal-local-test-no-membership",
      organizationId,
    ),
  });
  assert.equal(nonmemberReviews.status, 403);
  const nonmemberReviewWrite = await request(reviewPath, {
    method: "POST",
    headers: testIdentityHeaders(
      "principal-local-test-no-membership",
      organizationId,
    ),
    body: JSON.stringify({
      verdict: "changes_requested",
      reasonCode: "outdated",
    }),
  });
  assert.equal(nonmemberReviewWrite.status, 403);

  const reviewLedgerState = await (
    await request("/api/governance/intents")
  ).json();
  const reviewLedger = reviewLedgerState.ledger.filter((entry) =>
    entry.payloadRef?.startsWith("nexus://artifact-review/"),
  );
  assert.equal(
    reviewLedger.filter((entry) => entry.kind === "review.recorded").length,
    3,
  );
  assert.equal(
    reviewLedger.filter((entry) => entry.kind === "review.superseded").length,
    1,
  );
  assert.equal(
    reviewLedger.find((entry) => entry.kind === "review.superseded")
      .payloadRef,
    `nexus://artifact-review/${peerApproval.review.id}`,
  );
  assert.equal(reviewLedgerState.verification.valid, true);

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
  const initialEvidenceState = await (
    await request(
      `/api/governance/intents/${refreshedProposal.intent.id}/evidence`,
    )
  ).json();
  assert.deepEqual(initialEvidenceState.evidence, []);
  assert.equal(initialEvidenceState.frozen, false);
  const evidenceCandidate = initialEvidenceState.candidates.find(
    (candidate) =>
      candidate.artifactId === duplicateArtifact.id &&
      candidate.versionNumber === 1,
  );
  assert.ok(evidenceCandidate, "project-scoped immutable versions are attachable");
  const invalidOutcomeAttach = await request(
    `/api/governance/intents/${refreshedProposal.intent.id}/evidence`,
    {
      method: "POST",
      body: JSON.stringify({
        artifactVersionId: evidenceCandidate.artifactVersionId,
        relation: "outcome",
      }),
    },
  );
  assert.equal(invalidOutcomeAttach.status, 400);
  assert.equal(
    (await invalidOutcomeAttach.json()).error,
    "invalid_evidence_relation",
  );
  const crossTenantEvidence = await request(
    `/api/governance/intents/${refreshedProposal.intent.id}/evidence`,
    {
      headers: testIdentityHeaders(
        "principal-local-test-other-owner",
        "org-local-test-other",
      ),
    },
  );
  assert.equal(crossTenantEvidence.status, 404);
  const linkedEvidenceResponse = await request(
    `/api/governance/intents/${refreshedProposal.intent.id}/evidence`,
    {
      method: "POST",
      body: JSON.stringify({
        artifactVersionId: evidenceCandidate.artifactVersionId,
        relation: "basis",
      }),
    },
  );
  assert.equal(linkedEvidenceResponse.status, 201);
  const linkedEvidence = (await linkedEvidenceResponse.json()).evidence;
  assert.equal(linkedEvidence.contentHash, initialVersion.contentHash);
  assert.equal(linkedEvidence.relation, "basis");
  assert.equal("content" in linkedEvidence, false);
  const duplicateEvidence = await request(
    `/api/governance/intents/${refreshedProposal.intent.id}/evidence`,
    {
      method: "POST",
      body: JSON.stringify({
        artifactVersionId: evidenceCandidate.artifactVersionId,
        relation: "basis",
      }),
    },
  );
  assert.equal(duplicateEvidence.status, 409);
  assert.equal(
    (await duplicateEvidence.json()).error,
    "evidence_already_linked",
  );
  const supersedeRace = await Promise.all([
    request(
      `/api/governance/intents/${refreshedProposal.intent.id}/evidence/${linkedEvidence.id}/supersede`,
      { method: "POST" },
    ),
    request(
      `/api/governance/intents/${refreshedProposal.intent.id}/evidence/${linkedEvidence.id}/supersede`,
      { method: "POST" },
    ),
  ]);
  assert.deepEqual(
    supersedeRace.map((response) => response.status).sort(),
    [200, 409],
  );
  assert.equal(
    (await supersedeRace.find((response) => response.status === 200).json())
      .evidence.status,
    "superseded",
  );
  const relinkedEvidenceResponse = await request(
    `/api/governance/intents/${refreshedProposal.intent.id}/evidence`,
    {
      method: "POST",
      body: JSON.stringify({
        artifactVersionId: evidenceCandidate.artifactVersionId,
        relation: "basis",
      }),
    },
  );
  assert.equal(relinkedEvidenceResponse.status, 201);
  const relinkedEvidence = (await relinkedEvidenceResponse.json()).evidence;
  const reviewedEvidenceCandidate = initialEvidenceState.candidates.find(
    (candidate) =>
      candidate.artifactId === created.id &&
      candidate.versionNumber === 1,
  );
  assert.ok(
    reviewedEvidenceCandidate,
    "the reviewed immutable version must be attachable as decision basis",
  );
  const reviewedEvidenceResponse = await request(
    `/api/governance/intents/${refreshedProposal.intent.id}/evidence`,
    {
      method: "POST",
      body: JSON.stringify({
        artifactVersionId: reviewedEvidenceCandidate.artifactVersionId,
        relation: "basis",
      }),
    },
  );
  assert.equal(reviewedEvidenceResponse.status, 201);
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
  const frozenAttach = await request(
    `/api/governance/intents/${refreshedProposal.intent.id}/evidence`,
    {
      method: "POST",
      body: JSON.stringify({
        artifactVersionId: evidenceCandidate.artifactVersionId,
        relation: "basis",
      }),
    },
  );
  assert.equal(frozenAttach.status, 409);
  assert.equal((await frozenAttach.json()).error, "evidence_set_frozen");
  const frozenSupersede = await request(
    `/api/governance/intents/${refreshedProposal.intent.id}/evidence/${relinkedEvidence.id}/supersede`,
    { method: "POST" },
  );
  assert.equal(frozenSupersede.status, 409);
  assert.equal((await frozenSupersede.json()).error, "evidence_set_frozen");
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
  const evidenceAfterErasure = await (
    await request(
      `/api/governance/intents/${refreshedProposal.intent.id}/evidence`,
    )
  ).json();
  assert.equal(evidenceAfterErasure.frozen, true);
  const durableEvidence = evidenceAfterErasure.evidence.find(
    (evidence) => evidence.id === relinkedEvidence.id,
  );
  assert.ok(durableEvidence);
  assert.equal(durableEvidence.contentHash, initialVersion.contentHash);
  assert.equal(typeof durableEvidence.erasedAt, "string");
  assert.equal("content" in durableEvidence, false);
  const durableReviewState = await (
    await request(reviewPath, {
      headers: testIdentityHeaders(peerId, organizationId),
    })
  ).json();
  assert.equal(typeof durableReviewState.erasedAt, "string");
  assert.equal(durableReviewState.contentHash, initialVersion.contentHash);
  assert.equal(durableReviewState.reviews.length, 3);
  assert.equal(
    durableReviewState.reviews.some(
      (review) => review.id === producerReview.id,
    ),
    true,
  );
  const idempotentReviewAfterErasure = await request(reviewPath, {
    method: "POST",
    headers: testIdentityHeaders(peerId, organizationId),
    body: JSON.stringify({
      verdict: peerWinningReview.review.verdict,
      reasonCode: peerWinningReview.review.reasonCode,
    }),
  });
  assert.equal(idempotentReviewAfterErasure.status, 200);
  assert.equal(
    (await idempotentReviewAfterErasure.json()).review.id,
    peerWinningReview.review.id,
  );
  const reviewAfterErasure = await request(reviewPath, {
    method: "POST",
    headers: testIdentityHeaders(peerId, organizationId),
    body: JSON.stringify({
      verdict: "approved",
      reasonCode: "accurate",
    }),
  });
  assert.equal(reviewAfterErasure.status, 409);
  assert.equal(
    (await reviewAfterErasure.json()).error,
    "artifact_payload_erased",
  );
  const evidenceLedgerState = await (
    await request(
      `/api/governance/intents?intentId=${refreshedProposal.intent.id}`,
    )
  ).json();
  assert.equal(
    evidenceLedgerState.ledger.filter(
      (entry) =>
        entry.intentId === refreshedProposal.intent.id &&
        entry.kind === "evidence.linked",
    ).length,
    3,
  );
  assert.equal(
    evidenceLedgerState.ledger.filter(
      (entry) =>
        entry.intentId === refreshedProposal.intent.id &&
        entry.kind === "evidence.superseded",
    ).length,
    1,
  );
  assert.equal(evidenceLedgerState.verification.valid, true);

  const decisionPackagePath =
    `/api/governance/intents/${refreshedProposal.intent.id}/decision-package`;
  const decisionPackagePreviewResponse = await request(decisionPackagePath);
  assert.equal(decisionPackagePreviewResponse.status, 200);
  assert.equal(
    decisionPackagePreviewResponse.headers.get("cache-control"),
    "private, no-store",
  );
  assert.match(
    decisionPackagePreviewResponse.headers.get("vary") ?? "",
    /Authorization/,
  );
  const decisionPackagePreview = await decisionPackagePreviewResponse.json();
  assert.equal(decisionPackagePreview.specVersion, 1);
  assert.equal(decisionPackagePreview.intentStatus, "succeeded");
  assert.match(decisionPackagePreview.representationHash, /^[0-9a-f]{64}$/);
  assert.equal(
    decisionPackagePreview.packageId,
    `nexus:decision-package:v1:${refreshedProposal.intent.id}:sha256:${decisionPackagePreview.representationHash}`,
  );
  assert.equal(decisionPackagePreview.evidence.length, 3);
  assert.equal(decisionPackagePreview.reviews, 3);
  assert.equal(decisionPackagePreview.erasedBodies, 3);
  assert.equal(decisionPackagePreview.failedBodies, 0);
  assert.equal(decisionPackagePreview.omittedBodies, 0);
  assert.equal(decisionPackagePreview.ledgerEntryHashesValid, true);

  const secondPreview = await (await request(decisionPackagePath)).json();
  assert.equal(
    secondPreview.representationHash,
    decisionPackagePreview.representationHash,
    "the same frozen facts must render identical exact bytes",
  );
  assert.equal(secondPreview.byteSize, decisionPackagePreview.byteSize);

  const unrelatedIntentResponse = await request(
    "/api/governance/intents",
    {
      method: "POST",
      headers: {
        "idempotency-key": `decision-package-unrelated-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        summary: "Unrelated intent must not perturb another package",
      }),
    },
  );
  assert.equal(unrelatedIntentResponse.status, 201);
  const unrelatedIntent = await unrelatedIntentResponse.json();
  const ledgerAfterUnrelatedWrite = await (
    await request(
      `/api/governance/intents?intentId=${refreshedProposal.intent.id}`,
    )
  ).json();
  const previewAfterUnrelatedWrite = await (
    await request(decisionPackagePath)
  ).json();
  assert.equal(
    previewAfterUnrelatedWrite.representationHash,
    decisionPackagePreview.representationHash,
    "unrelated organization ledger writes must not perturb the package",
  );

  const markdownPath =
    `${decisionPackagePath}?format=markdown&expectedRepresentationHash=` +
    decisionPackagePreview.representationHash;
  const markdownResponse = await request(markdownPath, {
    headers: { "if-none-match": `"sha256-${decisionPackagePreview.representationHash}"` },
  });
  assert.equal(
    markdownResponse.status,
    200,
    "If-None-Match must not suppress a private governed export",
  );
  assert.equal(
    markdownResponse.headers.get("content-type"),
    "text/markdown; charset=utf-8",
  );
  assert.match(
    markdownResponse.headers.get("content-disposition") ?? "",
    /^attachment; filename="decision-package-/,
  );
  assert.equal(
    markdownResponse.headers.get("etag"),
    `"sha256-${decisionPackagePreview.representationHash}"`,
  );
  const markdownBytes = Buffer.from(await markdownResponse.arrayBuffer());
  const exactHash = createHash("sha256").update(markdownBytes).digest("hex");
  const exactDigest = createHash("sha256")
    .update(markdownBytes)
    .digest("base64");
  assert.equal(exactHash, decisionPackagePreview.representationHash);
  assert.equal(markdownBytes.byteLength, decisionPackagePreview.byteSize);
  assert.equal(
    markdownResponse.headers.get("repr-digest"),
    `sha-256=:${exactDigest}:`,
  );
  const markdown = markdownBytes.toString("utf8");
  assert.match(markdown, /^# NexusOS Decision Package/m);
  assert.match(markdown, /Content unavailable in package: .*erased/);
  assert.match(markdown, /Review window complete: .*3/);
  assert.match(markdown, /Sequence gaps, payload preimages/);
  assert.doesNotMatch(
    markdown,
    /Ship 10% → 40% → 100%/,
    "logically erased evidence bytes must not escape through the package",
  );

  const stalePackage = await request(
    `${decisionPackagePath}?format=markdown&expectedRepresentationHash=${"0".repeat(64)}`,
  );
  assert.equal(stalePackage.status, 409);
  const stalePackageBody = await stalePackage.json();
  assert.equal(stalePackageBody.error, "package_changed");
  assert.equal(
    stalePackageBody.representationHash,
    decisionPackagePreview.representationHash,
  );
  const malformedExpectedPackage = await request(
    `${decisionPackagePath}?format=markdown&expectedRepresentationHash=ABC`,
  );
  assert.equal(malformedExpectedPackage.status, 400);
  assert.equal(
    (await malformedExpectedPackage.json()).error,
    "invalid_expected_representation_hash",
  );
  const invalidFormatPackage = await request(
    `${decisionPackagePath}?format=html`,
  );
  assert.equal(invalidFormatPackage.status, 400);
  assert.equal(
    (await invalidFormatPackage.json()).error,
    "invalid_decision_package_format",
  );
  const nonmemberPackage = await request(decisionPackagePath, {
    headers: testIdentityHeaders(
      "principal-local-test-no-membership",
      organizationId,
    ),
  });
  assert.equal(nonmemberPackage.status, 403);
  assert.equal(
    (await nonmemberPackage.json()).error,
    "workspace_owner_required",
  );
  if (testPersistPath) {
    await runLocalD1(
      `INSERT INTO principals
         (id, organization_id, kind, external_id, display_name)
       VALUES
         ('principal-package-role', '${organizationId}', 'human',
          'package:role', 'Package role probe'),
         ('principal-package-agent', '${organizationId}', 'agent',
          'package:agent', 'Package agent probe'),
         ('principal-package-automation', '${organizationId}', 'automation',
          'package:automation', 'Package automation probe'),
         ('principal-package-policy', '${organizationId}', 'policy',
          'package:policy', 'Package policy probe'),
         ('principal-package-runner', '${organizationId}', 'runner',
          'package:runner', 'Package runner probe');
       INSERT INTO memberships
         (id, organization_id, principal_id, role)
       VALUES
         ('membership-package-role', '${organizationId}',
          'principal-package-role', 'member'),
         ('membership-package-agent', '${organizationId}',
          'principal-package-agent', 'owner'),
         ('membership-package-automation', '${organizationId}',
          'principal-package-automation', 'owner'),
         ('membership-package-policy', '${organizationId}',
          'principal-package-policy', 'owner'),
         ('membership-package-runner', '${organizationId}',
          'principal-package-runner', 'owner');`,
    );
    const assertPackageDenied = async (principalId, label) => {
      const response = await request(decisionPackagePath, {
        headers: testIdentityHeaders(principalId, organizationId),
      });
      assert.equal(response.status, 403, label);
      assert.equal(
        (await response.json()).error,
        "workspace_owner_required",
        label,
      );
    };
    await assertPackageDenied(
      "principal-package-role",
      "active member cannot bulk export",
    );
    await runLocalD1(
      `UPDATE memberships SET role = 'viewer'
       WHERE id = 'membership-package-role'`,
    );
    await assertPackageDenied(
      "principal-package-role",
      "active viewer cannot bulk export",
    );
    for (const membershipStatus of ["invited", "suspended"]) {
      await runLocalD1(
        `UPDATE memberships
         SET role = 'admin', status = '${membershipStatus}'
         WHERE id = 'membership-package-role'`,
      );
      await assertPackageDenied(
        "principal-package-role",
        `${membershipStatus} membership cannot bulk export`,
      );
    }
    await runLocalD1(
      `UPDATE memberships SET status = 'active'
       WHERE id = 'membership-package-role'`,
    );
    for (const principalStatus of ["disabled", "archived"]) {
      await runLocalD1(
        `UPDATE principals SET status = '${principalStatus}'
         WHERE id = 'principal-package-role'`,
      );
      await assertPackageDenied(
        "principal-package-role",
        `${principalStatus} principal cannot bulk export`,
      );
    }
    for (const kind of ["agent", "automation", "policy", "runner"]) {
      await assertPackageDenied(
        `principal-package-${kind}`,
        `${kind} principal cannot bulk export`,
      );
    }
  }
  const crossTenantPackage = await request(decisionPackagePath, {
    headers: testIdentityHeaders(otherOwnerId, otherOrganizationId),
  });
  assert.equal(crossTenantPackage.status, 404);
  assert.equal((await crossTenantPackage.json()).error, "intent_not_found");
  const undecidedPackage = await request(
    `/api/governance/intents/${unrelatedIntent.intent.id}/decision-package`,
  );
  assert.equal(undecidedPackage.status, 409);
  assert.equal((await undecidedPackage.json()).error, "decision_not_reached");

  const concurrentPackages = await Promise.all(
    Array.from({ length: 4 }, () => request(markdownPath)),
  );
  assert.deepEqual(
    concurrentPackages.map((response) => response.status),
    [200, 200, 200, 200],
  );
  await Promise.all(
    concurrentPackages.map((response) => response.arrayBuffer()),
  );

  const ledgerAfterPackageReads = await (
    await request(
      `/api/governance/intents?intentId=${refreshedProposal.intent.id}`,
    )
  ).json();
  assert.equal(
    ledgerAfterPackageReads.ledger.length,
    ledgerAfterUnrelatedWrite.ledger.length,
    "package reads must not append governance ledger entries",
  );

  const relevantSupersessionResponse = await request(supersessionPath, {
    method: "POST",
    body: JSON.stringify({
      targetArtifactId: duplicateHeadArtifact.id,
      sourceVersionNumber: 4,
      targetVersionNumber: 1,
      reasonCode: "scope_moved",
    }),
  });
  assert.equal(relevantSupersessionResponse.status, 201);
  const packageChangedAfterRelevantWrite = await request(markdownPath);
  assert.equal(packageChangedAfterRelevantWrite.status, 409);
  const changedPackageBody =
    await packageChangedAfterRelevantWrite.json();
  assert.equal(changedPackageBody.error, "package_changed");
  assert.notEqual(
    changedPackageBody.representationHash,
    decisionPackagePreview.representationHash,
    "an included supersession fact must change exact package bytes",
  );
  assert.equal(
    changedPackageBody.packageId,
    `nexus:decision-package:v1:${refreshedProposal.intent.id}:sha256:${changedPackageBody.representationHash}`,
  );
  const previewAfterRelevantWrite = await (
    await request(decisionPackagePath)
  ).json();
  assert.equal(
    previewAfterRelevantWrite.representationHash,
    changedPackageBody.representationHash,
  );
  assert.equal(
    previewAfterRelevantWrite.supersessions,
    decisionPackagePreview.supersessions + 1,
  );

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
      (entry) =>
        entry.intentId === refreshedProposal.intent.id &&
        !entry.kind.startsWith("evidence."),
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
    const soloReviewPath =
      `/api/artifacts/${soloArtifact.id}/versions/1/reviews`;
    const soloReviewState = await (await request(soloReviewPath)).json();
    assert.equal(soloReviewState.selfReviewApproval, "solo_owner_ack");
    const unacknowledgedSoloReview = await request(soloReviewPath, {
      method: "POST",
      body: JSON.stringify({
        verdict: "approved",
        reasonCode: "accurate",
      }),
    });
    assert.equal(unacknowledgedSoloReview.status, 409);
    assert.equal(
      (await unacknowledgedSoloReview.json()).error,
      "self_review_ack_required",
    );
    const acknowledgedSoloReview = await request(soloReviewPath, {
      method: "POST",
      body: JSON.stringify({
        verdict: "approved",
        reasonCode: "accurate",
        soloOwnerAcknowledged: true,
      }),
    });
    assert.equal(acknowledgedSoloReview.status, 201);
    assert.equal(
      (await acknowledgedSoloReview.json()).review.selfReviewPolicy,
      "solo_owner_ack",
    );
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
    await assert.rejects(
      runCommand("npx", [
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
      ]),
      /exited with 1/u,
    );
    const immutableRetryResponse = await request(
      `/api/artifacts/${expiringArtifact.id}/versions/1/erasure-intents`,
      {
        method: "POST",
        body: JSON.stringify({ reason: expiringReason }),
      },
    );
    assert.equal(immutableRetryResponse.status, 200);
    const immutableRetry = await immutableRetryResponse.json();
    assert.equal(
      immutableRetry.intent.id,
      expiringProposal.intent.id,
    );
    assert.equal(immutableRetry.created, false);
    await assert.rejects(
      runCommand("npx", [
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
         WHERE id = '${immutableRetry.intent.id}'`,
      ]),
      /exited with 1/u,
    );

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
    const corruptedVersionReview = await request(
      `/api/artifacts/${created.id}/versions/2/reviews`,
      {
        method: "POST",
        body: JSON.stringify({
          verdict: "changes_requested",
          reasonCode: "needs_correction",
        }),
      },
    );
    assert.equal(corruptedVersionReview.status, 503);
    assert.equal(
      (await corruptedVersionReview.json()).error,
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

async function runLocalD1(sql) {
  assert.ok(testPersistPath, "local D1 persistence is required");
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
    sql,
  ]);
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
