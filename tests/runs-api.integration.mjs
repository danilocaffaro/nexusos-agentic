import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.NEXUS_RUN_TEST_PORT ?? "3916");
const externalBaseUrl = process.env.NEXUS_TEST_BASE_URL;
const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const runnerCli = new URL("../runner/nexus-runner.mjs", import.meta.url)
  .pathname;
const testPersistPath = externalBaseUrl
  ? undefined
  : mkdtempSync(join(tmpdir(), "nexusos-run-integration-"));
let runnerStatePath;
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
          NEXUS_RUNNER_TEST_LEASE_TTL_SECONDS: "2",
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

  const busyTarget = await (
    await authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    })
  ).json();
  const busyClaimPath = `/api/runs/${busyTarget.run.id}/lease/claim`;
  const busyClaimBody = JSON.stringify({
    operationId: `op_${"a".repeat(32)}`,
  });
  const busyResponse = await fetch(
    `${baseUrl}${busyClaimPath}`,
    await signedRunnerRequest({
      path: busyClaimPath,
      domain: "nexus-runner-lease-claim-v1",
      runner,
      body: busyClaimBody,
    }),
  );
  assert.equal(busyResponse.status, 409);
  assert.deepEqual(await busyResponse.json(), { error: "runner_busy" });

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

  const releasedBusyResponse = await fetch(
    `${baseUrl}${busyClaimPath}`,
    await signedRunnerRequest({
      path: busyClaimPath,
      domain: "nexus-runner-lease-claim-v1",
      runner,
      body: busyClaimBody,
    }),
  );
  assert.equal(releasedBusyResponse.status, 200);
  const releasedBusyClaim = await releasedBusyResponse.json();
  const busyCompletePath = `/api/runs/${busyTarget.run.id}/complete`;
  const busyCompleteResponse = await fetch(
    `${baseUrl}${busyCompletePath}`,
    await signedRunnerRequest({
      path: busyCompletePath,
      domain: "nexus-runner-run-complete-v1",
      runner,
      body: JSON.stringify({
        fence: releasedBusyClaim.fence,
        leaseId: releasedBusyClaim.leaseId,
        operationId: `op_${"b".repeat(32)}`,
        outcome: {
          status: "succeeded",
          summary: "Runner resumed the pending busy claim.",
        },
      }),
    }),
  );
  assert.equal(busyCompleteResponse.status, 200);

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
      "lease.released",
      "run.completed",
    ],
  );

  const listed = await authenticatedRequest("/api/runs");
  assert.equal(listed.status, 200);
  const listedRunIds = (await listed.json()).runs.map((run) => run.id);
  assert.ok(listedRunIds.includes(runId));
  assert.ok(listedRunIds.includes(busyTarget.run.id));

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

  const successor = await enrollRunner("Diagnostic successor runner");
  const staleTarget = await (
    await authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    })
  ).json();
  const staleClaimPath =
    `/api/runs/${staleTarget.run.id}/lease/claim`;
  const staleClaimBody = JSON.stringify({
    operationId: `op_${"4".repeat(32)}`,
  });
  const staleClaim = await (
    await fetch(
      `${baseUrl}${staleClaimPath}`,
      await signedRunnerRequest({
        path: staleClaimPath,
        domain: "nexus-runner-lease-claim-v1",
        runner,
        body: staleClaimBody,
      }),
    )
  ).json();
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const successorClaimBody = JSON.stringify({
    operationId: `op_${"5".repeat(32)}`,
  });
  const successorClaimResponse = await fetch(
    `${baseUrl}${staleClaimPath}`,
    await signedRunnerRequest({
      path: staleClaimPath,
      domain: "nexus-runner-lease-claim-v1",
      runner: successor,
      body: successorClaimBody,
    }),
  );
  assert.equal(successorClaimResponse.status, 200);
  const successorClaim = await successorClaimResponse.json();
  assert.equal(successorClaim.fence, staleClaim.fence + 1);

  const staleCompletePath =
    `/api/runs/${staleTarget.run.id}/complete`;
  const staleCompleteBody = JSON.stringify({
    fence: staleClaim.fence,
    leaseId: staleClaim.leaseId,
    operationId: `op_${"6".repeat(32)}`,
    outcome: {
      status: "succeeded",
      summary: "A stale runner must never overwrite its successor.",
    },
  });
  const staleCompleteResponse = await fetch(
    `${baseUrl}${staleCompletePath}`,
    await signedRunnerRequest({
      path: staleCompletePath,
      domain: "nexus-runner-run-complete-v1",
      runner,
      body: staleCompleteBody,
    }),
  );
  assert.equal(staleCompleteResponse.status, 409);
  assert.deepEqual(await staleCompleteResponse.json(), {
    error: "lease_superseded",
  });

  const successorCompleteBody = JSON.stringify({
    fence: successorClaim.fence,
    leaseId: successorClaim.leaseId,
    operationId: `op_${"7".repeat(32)}`,
    outcome: {
      status: "succeeded",
      summary: "The current fence owns the diagnostic outcome.",
    },
  });
  const successorCompleteResponse = await fetch(
    `${baseUrl}${staleCompletePath}`,
    await signedRunnerRequest({
      path: staleCompletePath,
      domain: "nexus-runner-run-complete-v1",
      runner: successor,
      body: successorCompleteBody,
    }),
  );
  assert.equal(successorCompleteResponse.status, 200);
  const fencedDetail = await (
    await authenticatedRequest(`/api/runs/${staleTarget.run.id}`)
  ).json();
  assert.equal(fencedDetail.run.outcomeSummary, "The current fence owns the diagnostic outcome.");
  assert.ok(
    fencedDetail.events.some(
      (event) =>
        event.kind === "lease.superseded" &&
        event.fence === staleClaim.fence,
    ),
  );

  const expiredForeignA = await (
    await authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    })
  ).json();
  const expiredForeignAPath =
    `/api/runs/${expiredForeignA.run.id}/lease/claim`;
  const expiredForeignAClaim = await (
    await fetch(
      `${baseUrl}${expiredForeignAPath}`,
      await signedRunnerRequest({
        path: expiredForeignAPath,
        domain: "nexus-runner-lease-claim-v1",
        runner: successor,
        body: JSON.stringify({ operationId: `op_${"c".repeat(32)}` }),
      }),
    )
  ).json();
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const expiredForeignB = await (
    await authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    })
  ).json();
  const expiredForeignBPath =
    `/api/runs/${expiredForeignB.run.id}/lease/claim`;
  const expiredForeignBResponse = await fetch(
    `${baseUrl}${expiredForeignBPath}`,
    await signedRunnerRequest({
      path: expiredForeignBPath,
      domain: "nexus-runner-lease-claim-v1",
      runner: successor,
      body: JSON.stringify({ operationId: `op_${"d".repeat(32)}` }),
    }),
  );
  assert.equal(expiredForeignBResponse.status, 200);
  const expiredForeignBClaim = await expiredForeignBResponse.json();
  const expiredForeignADetail = await (
    await authenticatedRequest(`/api/runs/${expiredForeignA.run.id}`)
  ).json();
  const foreignSuperseded = expiredForeignADetail.events.at(-1);
  assert.equal(foreignSuperseded.kind, "lease.superseded");
  assert.equal(foreignSuperseded.fence, expiredForeignAClaim.fence);
  assert.deepEqual(foreignSuperseded.metadata, {
    leaseId: expiredForeignAClaim.leaseId,
    runnerId: successor.runnerId,
    fence: expiredForeignAClaim.fence,
    reason: "expired",
  });
  assert.equal(expiredForeignADetail.run.status, "queued");
  assert.equal(expiredForeignADetail.run.currentLeaseId, undefined);

  const expiredForeignBCompletePath =
    `/api/runs/${expiredForeignB.run.id}/complete`;
  const expiredForeignBComplete = await fetch(
    `${baseUrl}${expiredForeignBCompletePath}`,
    await signedRunnerRequest({
      path: expiredForeignBCompletePath,
      domain: "nexus-runner-run-complete-v1",
      runner: successor,
      body: JSON.stringify({
        fence: expiredForeignBClaim.fence,
        leaseId: expiredForeignBClaim.leaseId,
        operationId: `op_${"e".repeat(32)}`,
        outcome: {
          status: "succeeded",
          summary: "Cross-run expiry converged atomically.",
        },
      }),
    }),
  );
  assert.equal(expiredForeignBComplete.status, 200);

  const expiringCancelTarget = await (
    await authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    })
  ).json();
  const expiringCancelClaimPath =
    `/api/runs/${expiringCancelTarget.run.id}/lease/claim`;
  const expiringCancelClaimResponse = await fetch(
    `${baseUrl}${expiringCancelClaimPath}`,
    await signedRunnerRequest({
      path: expiringCancelClaimPath,
      domain: "nexus-runner-lease-claim-v1",
      runner: successor,
      body: JSON.stringify({ operationId: `op_${"8".repeat(32)}` }),
    }),
  );
  assert.equal(expiringCancelClaimResponse.status, 200);
  const requestedCancel = await authenticatedRequest(
    `/api/runs/${expiringCancelTarget.run.id}/cancel`,
    { method: "POST", body: "{}" },
  );
  assert.equal((await requestedCancel.json()).run.status, "leased");
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const convergedCancel = await authenticatedRequest(
    `/api/runs/${expiringCancelTarget.run.id}/cancel`,
    { method: "POST", body: "{}" },
  );
  assert.equal(convergedCancel.status, 200);
  const convergedCancelDetail = await convergedCancel.json();
  assert.equal(convergedCancelDetail.run.status, "canceled");
  assert.deepEqual(
    convergedCancelDetail.events.slice(-2).map((event) => event.kind),
    ["lease.released", "run.canceled"],
  );

  const revokedTarget = await (
    await authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    })
  ).json();
  const revokedClaimPath =
    `/api/runs/${revokedTarget.run.id}/lease/claim`;
  const revokedClaimBody = JSON.stringify({
    operationId: `op_${"9".repeat(32)}`,
  });
  const revokedClaimResponse = await fetch(
    `${baseUrl}${revokedClaimPath}`,
    await signedRunnerRequest({
      path: revokedClaimPath,
      domain: "nexus-runner-lease-claim-v1",
      runner,
      body: revokedClaimBody,
    }),
  );
  assert.equal(revokedClaimResponse.status, 200);
  const revokeRunnerResponse = await authenticatedRequest(
    `/api/runners/${runner.runnerId}/revoke`,
    { method: "POST", body: "{}" },
  );
  assert.equal(revokeRunnerResponse.status, 200);
  const revokeRunnerBody = await revokeRunnerResponse.json();
  const revokeRunnerReplay = await authenticatedRequest(
    `/api/runners/${runner.runnerId}/revoke`,
    { method: "POST", body: "{}" },
  );
  assert.equal(revokeRunnerReplay.status, 200);
  assert.deepEqual(await revokeRunnerReplay.json(), revokeRunnerBody);
  const revokedReplay = await fetch(
    `${baseUrl}${revokedClaimPath}`,
    await signedRunnerRequest({
      path: revokedClaimPath,
      domain: "nexus-runner-lease-claim-v1",
      runner,
      body: revokedClaimBody,
    }),
  );
  assert.equal(revokedReplay.status, 403);
  assert.deepEqual(await revokedReplay.json(), { error: "runner_rejected" });
  const revokedDetail = await (
    await authenticatedRequest(`/api/runs/${revokedTarget.run.id}`)
  ).json();
  assert.equal(revokedDetail.run.status, "queued");
  assert.equal(revokedDetail.run.currentLeaseId, undefined);
  assert.equal(revokedDetail.events.at(-1).kind, "lease.revoked");
  if (testPersistPath) {
    const [revocationState] = await queryLocalD1(
      `SELECT
         runner.status,
         principal.status AS principal_status,
         (SELECT COUNT(*) FROM run_leases lease
          WHERE lease.runner_id = runner.id
            AND lease.status = 'active') AS active_leases,
         (SELECT COUNT(*) FROM ledger_entries ledger
          WHERE ledger.organization_id = runner.organization_id
            AND ledger.kind = 'runner.revoked'
            AND ledger.payload_ref =
              'nexus://runners/' || runner.id) AS ledger_entries
       FROM runners runner
       INNER JOIN principals principal ON principal.id = runner.principal_id
       WHERE runner.id = '${runner.runnerId}'`,
    );
    assert.deepEqual(revocationState, {
      status: "revoked",
      principal_status: "disabled",
      active_leases: 0,
      ledger_entries: 1,
    });

    const legacyRunner = await enrollRunner("Legacy duplicate runner");
    const legacyRunA = await (
      await authenticatedRequest("/api/runs/diagnostic", {
        method: "POST",
        body: "{}",
      })
    ).json();
    const legacyRunB = await (
      await authenticatedRequest("/api/runs/diagnostic", {
        method: "POST",
        body: "{}",
      })
    ).json();
    const legacyRunAPath =
      `/api/runs/${legacyRunA.run.id}/lease/claim`;
    assert.equal(
      (
        await fetch(
          `${baseUrl}${legacyRunAPath}`,
          await signedRunnerRequest({
            path: legacyRunAPath,
            domain: "nexus-runner-lease-claim-v1",
            runner: legacyRunner,
            body: JSON.stringify({
              operationId: `op_${"f".repeat(32)}`,
            }),
          }),
        )
      ).status,
      200,
    );
    const legacyIssuedAt = new Date().toISOString();
    const legacyExpiresAt = new Date(
      Date.parse(legacyIssuedAt) + 60_000,
    ).toISOString();
    await runLocalD1(
      `INSERT INTO run_leases (
         id, organization_id, run_id, runner_id, fence, status,
         issued_at, expires_at, renew_count, created_at, updated_at
       ) VALUES (
         'lse_${"f".repeat(32)}',
         '${organizationId}',
         '${legacyRunB.run.id}',
         '${legacyRunner.runnerId}',
         1,
         'active',
         '${legacyIssuedAt}',
         '${legacyExpiresAt}',
         0,
         '${legacyIssuedAt}',
         '${legacyIssuedAt}'
       )`,
    );
    const legacyConflict = await authenticatedRequest(
      `/api/runners/${legacyRunner.runnerId}/revoke`,
      { method: "POST", body: "{}" },
    );
    assert.equal(legacyConflict.status, 409);
    assert.deepEqual(await legacyConflict.json(), {
      error: "runner_conflict",
    });
    const [legacyState] = await queryLocalD1(
      `SELECT
         runner.status,
         (SELECT COUNT(*) FROM run_leases lease
          WHERE lease.runner_id = runner.id
            AND lease.status = 'active') AS active_leases
       FROM runners runner
       WHERE runner.id = '${legacyRunner.runnerId}'`,
    );
    assert.deepEqual(legacyState, {
      status: "active",
      active_leases: 2,
    });
    const legacyClaimPath =
      `/api/runs/${legacyRunB.run.id}/lease/claim`;
    const legacyClaimConflict = await fetch(
      `${baseUrl}${legacyClaimPath}`,
      await signedRunnerRequest({
        path: legacyClaimPath,
        domain: "nexus-runner-lease-claim-v1",
        runner: legacyRunner,
        body: JSON.stringify({
          operationId: `op_${"1".repeat(32)}`,
        }),
      }),
    );
    assert.equal(legacyClaimConflict.status, 409);
    assert.deepEqual(await legacyClaimConflict.json(), {
      error: "runner_conflict",
    });

    const residualRunner = await enrollRunner(
      "Already revoked residual runner",
    );
    const residualRun = await (
      await authenticatedRequest("/api/runs/diagnostic", {
        method: "POST",
        body: "{}",
      })
    ).json();
    const residualClaimPath =
      `/api/runs/${residualRun.run.id}/lease/claim`;
    const residualClaim = await (
      await fetch(
        `${baseUrl}${residualClaimPath}`,
        await signedRunnerRequest({
          path: residualClaimPath,
          domain: "nexus-runner-lease-claim-v1",
          runner: residualRunner,
          body: JSON.stringify({
            operationId: `op_${"2".repeat(32)}`,
          }),
        }),
      )
    ).json();
    const seededRevokedAt = new Date().toISOString();
    await runLocalD1(
      `UPDATE principals
       SET status = 'disabled', updated_at = '${seededRevokedAt}'
       WHERE id = '${residualRunner.principalId}';
       UPDATE runners
       SET status = 'revoked',
           revoked_at = '${seededRevokedAt}',
           revoked_by = '${ownerId}',
           updated_at = '${seededRevokedAt}'
       WHERE id = '${residualRunner.runnerId}'`,
    );
    const healedResidual = await authenticatedRequest(
      `/api/runners/${residualRunner.runnerId}/revoke`,
      { method: "POST", body: "{}" },
    );
    assert.equal(healedResidual.status, 200);
    assert.deepEqual(await healedResidual.json(), {
      runnerId: residualRunner.runnerId,
      revokedAt: seededRevokedAt,
    });
    const residualDetail = await (
      await authenticatedRequest(`/api/runs/${residualRun.run.id}`)
    ).json();
    assert.equal(residualDetail.run.status, "queued");
    assert.equal(residualDetail.run.currentLeaseId, undefined);
    const residualEvent = residualDetail.events.at(-1);
    assert.equal(residualEvent.kind, "lease.revoked");
    assert.deepEqual(residualEvent.metadata, {
      leaseId: residualClaim.leaseId,
      runnerId: residualRunner.runnerId,
      fence: residualClaim.fence,
      reason: "runner_revoked",
    });
  }

  const concurrentRunner = await enrollRunner(
    "Concurrent cross-run claim runner",
  );
  const concurrentRuns = await Promise.all([
    authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    }).then((response) => response.json()),
    authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    }).then((response) => response.json()),
  ]);
  const concurrentClaims = await Promise.all(
    concurrentRuns.map(async (target, index) => {
      const path = `/api/runs/${target.run.id}/lease/claim`;
      return fetch(
        `${baseUrl}${path}`,
        await signedRunnerRequest({
          path,
          domain: "nexus-runner-lease-claim-v1",
          runner: concurrentRunner,
          body: JSON.stringify({
            operationId: `op_${String(index + 3).repeat(32)}`,
          }),
        }),
      );
    }),
  );
  assert.deepEqual(
    concurrentClaims.map((response) => response.status).sort(),
    [200, 409],
  );
  const concurrentConflict = concurrentClaims.find(
    (response) => response.status === 409,
  );
  assert.deepEqual(await concurrentConflict.json(), {
    error: "runner_busy",
  });
  assert.equal(
    (
      await authenticatedRequest(
        `/api/runners/${concurrentRunner.runnerId}/revoke`,
        { method: "POST", body: "{}" },
      )
    ).status,
    200,
  );

  const contentionRunner = await enrollRunner("Event head contention runner");
  const contentionRunA = await (
    await authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    })
  ).json();
  const contentionRunB = await (
    await authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    })
  ).json();
  const contentionRunAClaimPath =
    `/api/runs/${contentionRunA.run.id}/lease/claim`;
  assert.equal(
    (
      await fetch(
        `${baseUrl}${contentionRunAClaimPath}`,
        await signedRunnerRequest({
          path: contentionRunAClaimPath,
          domain: "nexus-runner-lease-claim-v1",
          runner: contentionRunner,
          body: JSON.stringify({
            operationId: `op_${"5".repeat(32)}`,
          }),
        }),
      )
    ).status,
    200,
  );
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const contentionRunBClaimPath =
    `/api/runs/${contentionRunB.run.id}/lease/claim`;
  const [contentionClaim, contentionCancel] = await Promise.all([
    fetch(
      `${baseUrl}${contentionRunBClaimPath}`,
      await signedRunnerRequest({
        path: contentionRunBClaimPath,
        domain: "nexus-runner-lease-claim-v1",
        runner: contentionRunner,
        body: JSON.stringify({
          operationId: `op_${"6".repeat(32)}`,
        }),
      }),
    ),
    authenticatedRequest(`/api/runs/${contentionRunA.run.id}/cancel`, {
      method: "POST",
      body: "{}",
    }),
  ]);
  assert.equal(contentionClaim.status, 200);
  assert.equal(contentionCancel.status, 200);
  const contentionRunADetail = await (
    await authenticatedRequest(`/api/runs/${contentionRunA.run.id}`)
  ).json();
  assert.equal(contentionRunADetail.run.status, "canceled");
  assert.deepEqual(
    contentionRunADetail.events.map((event) => event.sequence),
    contentionRunADetail.events.map((_, index) => index + 1),
  );
  assert.equal(
    (
      await authenticatedRequest(
        `/api/runners/${contentionRunner.runnerId}/revoke`,
        { method: "POST", body: "{}" },
      )
    ).status,
    200,
  );

  const racingRunner = await enrollRunner("Claim revoke race runner");
  const racingRun = await (
    await authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    })
  ).json();
  const racingClaimPath = `/api/runs/${racingRun.run.id}/lease/claim`;
  const [racingClaim, racingRevoke] = await Promise.all([
    fetch(
      `${baseUrl}${racingClaimPath}`,
      await signedRunnerRequest({
        path: racingClaimPath,
        domain: "nexus-runner-lease-claim-v1",
        runner: racingRunner,
        body: JSON.stringify({
          operationId: `op_${"0".repeat(32)}`,
        }),
      }),
    ),
    authenticatedRequest(`/api/runners/${racingRunner.runnerId}/revoke`, {
      method: "POST",
      body: "{}",
    }),
  ]);
  assert.equal(racingRevoke.status, 200);
  assert.ok([200, 403].includes(racingClaim.status));
  if (racingClaim.status === 403) {
    assert.deepEqual(await racingClaim.json(), {
      error: "runner_rejected",
    });
  }
  if (testPersistPath) {
    const [racingState] = await queryLocalD1(
      `SELECT
         runner.status,
         (SELECT COUNT(*) FROM run_leases lease
          WHERE lease.runner_id = runner.id
            AND lease.status = 'active') AS active_leases
       FROM runners runner
       WHERE runner.id = '${racingRunner.runnerId}'`,
    );
    assert.deepEqual(racingState, {
      status: "revoked",
      active_leases: 0,
    });
  }

  const ledger = await authenticatedRequest("/api/governance/intents");
  assert.equal(ledger.status, 200);
  const ledgerKinds = (await ledger.json()).ledger.map((entry) => entry.kind);
  assert.ok(ledgerKinds.includes("run.requested"));
  assert.ok(ledgerKinds.includes("run.completed"));

  const cliRun = await (
    await authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    })
  ).json();
  const cliDisplayName = "Real CLI diagnostic runner";
  const cliToken = await (
    await authenticatedRequest("/api/runners/enrollment-tokens", {
      method: "POST",
      body: JSON.stringify({ displayName: cliDisplayName }),
    })
  ).json();
  runnerStatePath = mkdtempSync(join(tmpdir(), "nexusos-real-cli-runner-"));
  const cliEnrollment = await runRunnerCli(
    [
      "enroll",
      "--server",
      baseUrl,
      "--name",
      cliDisplayName,
      "--token-stdin",
      "--state-dir",
      runnerStatePath,
    ],
    `${cliToken.token}\n`,
  );
  assert.equal(cliEnrollment.code, 0, cliEnrollment.stderr);
  const cliDiagnostic = await runRunnerCli(
    [
      "diagnose",
      "--run",
      cliRun.run.id,
      "--state-dir",
      runnerStatePath,
    ],
    "",
    {
      NEXUS_RUNNER_TEST: "1",
      NEXUS_RUNNER_TEST_HOLD_MS: "70",
      NEXUS_RUNNER_TEST_RENEW_MS: "20",
    },
  );
  assert.equal(cliDiagnostic.code, 0, cliDiagnostic.stderr);
  const cliOutput = cliDiagnostic.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(cliOutput[0].status, "leased");
  assert.deepEqual(cliOutput.at(-1), {
    status: "completed",
    runId: cliRun.run.id,
    fence: 1,
    late: false,
    durableReplay: true,
  });
  const cliDetail = await (
    await authenticatedRequest(`/api/runs/${cliRun.run.id}`)
  ).json();
  assert.equal(cliDetail.run.status, "completed");
  assert.ok(
    cliDetail.events.filter((event) => event.kind === "lease.renewed")
      .length >= 2,
  );

  process.stdout.write(
    "Runs API integration passed: signed replay, renew, fenced reassignment, revocation, cancel convergence, real CLI, ledger and tenant authority.\n",
  );
} finally {
  if (server) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  if (testPersistPath) {
    rmSync(testPersistPath, { recursive: true, force: true });
  }
  if (runnerStatePath) {
    rmSync(runnerStatePath, { recursive: true, force: true });
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

async function runLocalD1(sql) {
  assert.ok(testPersistPath, "local D1 persistence is required");
  const result = await runCommandResult("npx", [
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
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
}

async function queryLocalD1(sql) {
  assert.ok(testPersistPath, "local D1 persistence is required");
  const result = await runCommandResult("npx", [
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
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout)[0]?.results ?? [];
}

function runCommandResult(command, args) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectResult);
    child.once("close", (code) => {
      resolveResult({ code, stdout, stderr });
    });
  });
}

function runRunnerCli(args, input = "", extraEnv = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [runnerCli, ...args], {
      env: { PATH: process.env.PATH, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
