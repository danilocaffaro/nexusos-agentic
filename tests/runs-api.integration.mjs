import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.NEXUS_RUN_TEST_PORT ?? "3916");
const localLeaseTtlSeconds = 5;
const externalBaseUrl = process.env.NEXUS_TEST_BASE_URL;
const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const runnerCli = new URL("../runner/nexus-runner.mjs", import.meta.url)
  .pathname;
const leasePreflight = new URL(
  "../scripts/lease-preflight.mjs",
  import.meta.url,
).pathname;
const deadlineReconcileCli = new URL(
  "../scripts/deadline-reconcile.mjs",
  import.meta.url,
).pathname;
const retentionReconcileCli = new URL(
  "../scripts/retention-reconcile.mjs",
  import.meta.url,
).pathname;
const leaseIndexMigration = readFileSync(
  new URL("../drizzle/0021_wakeful_talkback.sql", import.meta.url),
  "utf8",
);
const engineControlMigration = readFileSync(
  new URL("../drizzle/0025_charming_forge.sql", import.meta.url),
  "utf8",
);
const promptUpdateTriggerMigration = engineControlMigration
  .split("--> statement-breakpoint")
  .find((statement) =>
    statement.includes(
      "CREATE TRIGGER `run_prompts_validate_before_update`",
    ),
  )
  ?.trim();
assert.ok(promptUpdateTriggerMigration);
const testPersistPath = externalBaseUrl
  ? undefined
  : mkdtempSync(join(tmpdir(), "nexusos-run-integration-"));
let runnerStatePath;
let server;
let serverOutput = "";

const organizationId = "org-local-aurora";
const ownerId = "principal-local-owner";
const memberId = "principal-local-atlas";
const adminId = "principal-local-test-peer";
const otherOrganizationId = "org-local-test-other";
const otherOwnerId = "principal-local-test-other-owner";
const testPromptCipherKey = Buffer.alloc(32, 7).toString("base64url");
const testPromptCipherKeyring = JSON.stringify({
  activeKeyId: "integration-key-v1",
  keys: { "integration-key-v1": testPromptCipherKey },
  schemaVersion: 1,
});

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
          NEXUS_PROMPT_CIPHER_KEYS: testPromptCipherKeyring,
          NEXUS_RUNNER_AUDIENCE: baseUrl,
          NEXUS_RUNNER_TEST_LEASE_TTL_SECONDS: String(localLeaseTtlSeconds),
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
  const createdBytes = await createdResponse.text();
  const created = JSON.parse(createdBytes);
  assert.equal(createdBytes, JSON.stringify(created));
  assert.deepEqual(Object.keys(created.run), [
    "id",
    "organizationId",
    "requestedBy",
    "kind",
    "status",
    "version",
    "leaseGeneration",
    "claimCount",
    "maxClaims",
    "deadlineAt",
    "replayCount",
    "createdAt",
    "updatedAt",
  ]);
  assert.match(created.run.id, /^run_[0-9a-f]{32}$/u);
  assert.equal(created.run.status, "queued");
  assert.equal(created.events[0].kind, "run.created");
  const runId = created.run.id;

  const runner = await enrollRunner("Diagnostic API runner");
  if (testPersistPath) {
    await assertFrozenUnassignedCreation(created);
    await exerciseAssignedRunCreation(runner);
    await exerciseDeadlineReconciliation();
    await exerciseEngineRunCreation(runner);
    await exerciseEngineCompletion(runner);
  }
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
  assert.equal(
    claimBytes,
    JSON.stringify({
      cancelRequested: false,
      expiresAt: claim.expiresAt,
      fence: claim.fence,
      leaseId: claim.leaseId,
      runId,
    }),
  );
  if (testPersistPath) {
    const [unassignedClaimEvent] = await queryLocalD1(
      `SELECT metadata_json
       FROM run_events
       WHERE run_id = '${runId}' AND kind = 'lease.claimed'`,
    );
    assert.equal(
      unassignedClaimEvent.metadata_json,
      `{"leaseId":"${claim.leaseId}","operationId":"${operationId}"}`,
    );
  }

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
  const completion = JSON.parse(completionBytes);
  assert.equal(completion.status, "completed");
  assert.equal(completion.late, false);

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
  if (testPersistPath) {
    await exerciseAssignedClaimAdmission(runner);
  }

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
  await waitPastLeaseExpiry(staleClaim.expiresAt);
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
  await waitPastLeaseExpiry(expiredForeignAClaim.expiresAt);
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
  const expiringCancelClaim = await expiringCancelClaimResponse.json();
  const requestedCancel = await authenticatedRequest(
    `/api/runs/${expiringCancelTarget.run.id}/cancel`,
    { method: "POST", body: "{}" },
  );
  assert.equal((await requestedCancel.json()).run.status, "leased");
  await waitPastLeaseExpiry(expiringCancelClaim.expiresAt);
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
    await runLocalD1("DROP INDEX run_leases_active_runner_uidx");
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
      error: "run_unavailable",
    });
    const reconciled = await runLeasePreflightApply();
    assert.equal(reconciled.duplicateRunnersBefore, 1);
    assert.equal(reconciled.leasesReconciled, 1);
    assert.equal(reconciled.eventsAppended, 1);
    assert.equal(reconciled.duplicateRunnersAfter, 0);
    await runLocalD1(leaseIndexMigration);
    const [restoredIndex] = await queryLocalD1(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'index'
         AND name = 'run_leases_active_runner_uidx'`,
    );
    assert.deepEqual(restoredIndex, { count: 1 });

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
  const contentionRunAClaimResponse = await fetch(
    `${baseUrl}${contentionRunAClaimPath}`,
    await signedRunnerRequest({
      path: contentionRunAClaimPath,
      domain: "nexus-runner-lease-claim-v1",
      runner: contentionRunner,
      body: JSON.stringify({
        operationId: `op_${"5".repeat(32)}`,
      }),
    }),
  );
  assert.equal(contentionRunAClaimResponse.status, 200);
  const contentionRunAClaim = await contentionRunAClaimResponse.json();
  await waitPastLeaseExpiry(contentionRunAClaim.expiresAt);
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

async function exerciseAssignedClaimAdmission(runner) {
  const warmPolicy = await authenticatedRequest(
    "/api/runner-admission-policy",
  );
  assert.equal(warmPolicy.status, 200);
  assert.equal((await warmPolicy.json()).policy.source, "default");
  const otherRunner = await enrollRunner("Assignment mismatch runner");

  const assignmentRun = await seedAssignedRun(runner.runnerId);
  const assignmentPath =
    `/api/runs/${assignmentRun.runId}/lease/claim`;
  const wrongRequest = await signedRunnerRequest({
    path: assignmentPath,
    domain: "nexus-runner-lease-claim-v1",
    runner: otherRunner,
    body: JSON.stringify({ operationId: `op_${"4".repeat(32)}` }),
  });
  const wrongBefore = await claimMutationState(
    assignmentRun.runId,
    otherRunner.runnerId,
  );
  const wrongResponse = await fetch(
    `${baseUrl}${assignmentPath}`,
    wrongRequest,
  );
  assert.equal(wrongResponse.status, 409);
  assert.deepEqual(await wrongResponse.json(), {
    error: "run_assignment_mismatch",
  });
  assert.deepEqual(
    await claimMutationState(assignmentRun.runId, otherRunner.runnerId),
    wrongBefore,
  );

  const assignmentOperationId = `op_${"5".repeat(32)}`;
  const assignmentClaim = await claimRun(
    assignmentRun.runId,
    runner,
    assignmentOperationId,
  );
  await completeClaim(
    assignmentRun.runId,
    runner,
    assignmentClaim,
    `op_${"6".repeat(32)}`,
  );
  const assignmentLease = await admissionLeaseState(
    assignmentRun.runId,
  );
  assert.deepEqual(
    {
      admission_basis: assignmentLease.admission_basis,
      admission_policy_source: assignmentLease.admission_policy_source,
      admission_policy_version: assignmentLease.admission_policy_version,
      admission_freshness_seconds:
        assignmentLease.admission_freshness_seconds,
      admission_required_capability:
        assignmentLease.admission_required_capability,
      admission_report_id: assignmentLease.admission_report_id,
      admission_report_received_at:
        assignmentLease.admission_report_received_at,
    },
    {
      admission_basis: "assignment_only",
      admission_policy_source: null,
      admission_policy_version: null,
      admission_freshness_seconds: null,
      admission_required_capability: null,
      admission_report_id: null,
      admission_report_received_at: null,
    },
  );
  assert.equal(
    assignmentLease.metadata_json,
    JSON.stringify({
      admissionBasis: "assignment_only",
      assignedRunnerId: runner.runnerId,
      leaseId: assignmentClaim.leaseId,
      operationId: assignmentOperationId,
    }),
  );

  const defaultRun = await seedAssignedRun(
    runner.runnerId,
    "bubblewrap",
  );
  const defaultPath = `/api/runs/${defaultRun.runId}/lease/claim`;
  const defaultOperationId = `op_${"7".repeat(32)}`;
  const fixedNonce = randomBytes(16).toString("base64url");
  const defaultRequest = await signedRunnerRequest({
    path: defaultPath,
    domain: "nexus-runner-lease-claim-v1",
    runner,
    body: JSON.stringify({ operationId: defaultOperationId }),
    nonce: fixedNonce,
  });
  const missingBefore = await claimMutationState(
    defaultRun.runId,
    runner.runnerId,
  );
  const missingResponse = await fetch(
    `${baseUrl}${defaultPath}`,
    defaultRequest,
  );
  assert.equal(missingResponse.status, 409);
  assert.deepEqual(await missingResponse.json(), {
    error: "capability_declaration_mismatch",
  });
  assert.deepEqual(
    await claimMutationState(defaultRun.runId, runner.runnerId),
    missingBefore,
  );

  const available = await submitCapabilityReport(runner, "available");
  const defaultClaimResponse = await fetch(
    `${baseUrl}${defaultPath}`,
    defaultRequest,
  );
  assert.equal(defaultClaimResponse.status, 200);
  const defaultClaim = await readLeaseClaim(
    defaultClaimResponse,
    defaultRun.runId,
  );

  const denyAllPolicy = await authenticatedRequest(
    "/api/runner-admission-policy",
    {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: 0,
        capabilityFreshnessSeconds: 3_600,
        engineFreshnessSeconds: 86_400,
        allowedCapabilities: [],
      }),
    },
  );
  assert.equal(denyAllPolicy.status, 200);
  assert.equal((await denyAllPolicy.json()).policy.version, 1);
  const noReportRunner = await enrollRunner(
    "No-report assigned creation runner",
  );
  const noEligibilityAtCreation = await createAssignedRun(
    noReportRunner.runnerId,
    "bubblewrap",
  );
  assert.equal(noEligibilityAtCreation.response.status, 201);
  assert.equal(
    noEligibilityAtCreation.detail.run.requiredCapability,
    "bubblewrap",
  );
  await renewClaim(defaultRun.runId, runner, defaultClaim);
  await completeClaim(
    defaultRun.runId,
    runner,
    defaultClaim,
    `op_${"8".repeat(32)}`,
  );
  const defaultLease = await admissionLeaseState(defaultRun.runId);
  assert.deepEqual(
    {
      admission_basis: defaultLease.admission_basis,
      admission_policy_source: defaultLease.admission_policy_source,
      admission_policy_version: defaultLease.admission_policy_version,
      admission_freshness_seconds:
        defaultLease.admission_freshness_seconds,
      admission_required_capability:
        defaultLease.admission_required_capability,
      admission_report_id: defaultLease.admission_report_id,
      admission_report_received_at:
        defaultLease.admission_report_received_at,
    },
    {
      admission_basis: "capability_declaration",
      admission_policy_source: "default",
      admission_policy_version: 0,
      admission_freshness_seconds: 86_400,
      admission_required_capability: "bubblewrap",
      admission_report_id: available.reportId,
      admission_report_received_at: available.receivedAt,
    },
  );
  assert.equal(
    defaultLease.metadata_json,
    capabilityClaimMetadata({
      runnerId: runner.runnerId,
      claim: defaultClaim,
      operationId: defaultOperationId,
      policySource: "default",
      policyVersion: 0,
      freshnessSeconds: 86_400,
      report: available,
    }),
  );

  const configuredRun = await seedAssignedRun(
    runner.runnerId,
    "bubblewrap",
  );
  const configuredPath =
    `/api/runs/${configuredRun.runId}/lease/claim`;
  const configuredOperationId = `op_${"9".repeat(32)}`;
  const configuredRequest = await signedRunnerRequest({
    path: configuredPath,
    domain: "nexus-runner-lease-claim-v1",
    runner,
    body: JSON.stringify({ operationId: configuredOperationId }),
  });
  const denyAllBefore = await claimMutationState(
    configuredRun.runId,
    runner.runnerId,
  );
  const configuredDenied = await fetch(
    `${baseUrl}${configuredPath}`,
    configuredRequest,
  );
  assert.equal(configuredDenied.status, 409);
  assert.deepEqual(await configuredDenied.json(), {
    error: "capability_declaration_mismatch",
  });
  assert.deepEqual(
    await claimMutationState(configuredRun.runId, runner.runnerId),
    denyAllBefore,
  );

  const allowPolicy = await authenticatedRequest(
    "/api/runner-admission-policy",
    {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: 1,
        capabilityFreshnessSeconds: 3_600,
        engineFreshnessSeconds: 86_400,
        allowedCapabilities: ["bubblewrap"],
      }),
    },
  );
  assert.equal(allowPolicy.status, 200);
  assert.equal((await allowPolicy.json()).policy.version, 2);
  const configuredClaimResponse = await fetch(
    `${baseUrl}${configuredPath}`,
    configuredRequest,
  );
  assert.equal(configuredClaimResponse.status, 200);
  const configuredClaim = await readLeaseClaim(
    configuredClaimResponse,
    configuredRun.runId,
  );
  await completeClaim(
    configuredRun.runId,
    runner,
    configuredClaim,
    `op_${"a".repeat(32)}`,
  );
  const configuredLease = await admissionLeaseState(configuredRun.runId);
  assert.equal(configuredLease.admission_policy_source, "configured");
  assert.equal(configuredLease.admission_policy_version, 2);
  assert.equal(configuredLease.admission_freshness_seconds, 3_600);
  assert.equal(configuredLease.admission_report_id, available.reportId);
  assert.equal(
    configuredLease.metadata_json,
    capabilityClaimMetadata({
      runnerId: runner.runnerId,
      claim: configuredClaim,
      operationId: configuredOperationId,
      policySource: "configured",
      policyVersion: 2,
      freshnessSeconds: 3_600,
      report: available,
    }),
  );

  const unknown = await submitCapabilityReport(runner, "unknown");
  const shadowedRun = await seedAssignedRun(
    runner.runnerId,
    "bubblewrap",
  );
  const shadowedPath =
    `/api/runs/${shadowedRun.runId}/lease/claim`;
  const shadowedOperationId = `op_${"b".repeat(32)}`;
  const shadowedRequest = await signedRunnerRequest({
    path: shadowedPath,
    domain: "nexus-runner-lease-claim-v1",
    runner,
    body: JSON.stringify({ operationId: shadowedOperationId }),
  });
  const shadowedDenied = await fetch(
    `${baseUrl}${shadowedPath}`,
    shadowedRequest,
  );
  assert.equal(shadowedDenied.status, 409);
  assert.deepEqual(await shadowedDenied.json(), {
    error: "capability_declaration_mismatch",
  });
  const restored = await submitCapabilityReport(runner, "available");
  assert.notEqual(restored.reportId, unknown.reportId);
  const restoredResponse = await fetch(
    `${baseUrl}${shadowedPath}`,
    shadowedRequest,
  );
  assert.equal(restoredResponse.status, 200);
  const restoredClaim = await readLeaseClaim(
    restoredResponse,
    shadowedRun.runId,
  );
  await completeClaim(
    shadowedRun.runId,
    runner,
    restoredClaim,
    `op_${"c".repeat(32)}`,
  );
  const restoredLease = await admissionLeaseState(shadowedRun.runId);
  assert.equal(restoredLease.admission_report_id, restored.reportId);
  assert.equal(
    JSON.parse(restoredLease.metadata_json).admissionReportId,
    restored.reportId,
  );
}

async function seedAssignedRun(runnerId, requiredCapability) {
  const created = await createAssignedRun(runnerId, requiredCapability);
  assert.equal(created.response.status, 201);
  return { runId: created.detail.run.id };
}

async function exerciseAssignedRunCreation(runner) {
  for (const body of [
    "{}",
    "null",
    "[]",
    JSON.stringify({ assignedRunnerId: runner.runnerId, extra: true }),
    JSON.stringify({
      assignedRunnerId: runner.runnerId,
      requiredCapability: null,
    }),
    JSON.stringify({
      assignedRunnerId: runner.runnerId,
      requiredCapability: "sandboxed",
    }),
  ]) {
    const invalid = await authenticatedRequest(
      "/api/runs/diagnostic/assigned",
      { method: "POST", body },
    );
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), {
      error: "invalid_assigned_run_request",
    });
  }

  const denied = await createAssignedRun(
    runner.runnerId,
    undefined,
    identityHeaders(memberId, organizationId),
  );
  assert.equal(denied.response.status, 403);
  assert.deepEqual(denied.detail, {
    error: "workspace_owner_required",
  });

  const missingId = `rnr_${"f".repeat(32)}`;
  const missing = await createAssignedRun(missingId);
  assert.equal(missing.response.status, 404);
  assert.deepEqual(missing.detail, { error: "runner_not_found" });

  const crossTenantRunner = await enrollRunner(
    "Cross-tenant assigned runner",
    identityHeaders(otherOwnerId, otherOrganizationId),
  );
  const crossTenant = await createAssignedRun(crossTenantRunner.runnerId);
  assert.equal(crossTenant.response.status, 404);
  assert.deepEqual(crossTenant.detail, missing.detail);

  const revokedRunner = await enrollRunner("Revoked assigned runner");
  const revoke = await authenticatedRequest(
    `/api/runners/${revokedRunner.runnerId}/revoke`,
    { method: "POST", body: "{}" },
  );
  assert.equal(revoke.status, 200);
  const inactive = await createAssignedRun(revokedRunner.runnerId);
  assert.equal(inactive.response.status, 409);
  assert.deepEqual(inactive.detail, { error: "runner_not_active" });

  const ownerCreated = await createAssignedRun(
    runner.runnerId,
    "bubblewrap",
  );
  assert.equal(ownerCreated.response.status, 201);
  assert.equal(ownerCreated.detail.run.assignedRunnerId, runner.runnerId);
  assert.equal(ownerCreated.detail.run.requiredCapability, "bubblewrap");
  assert.equal("expired" in ownerCreated.detail.run, false);
  await assertAssignedCreationLedger(ownerCreated.detail);

  const adminCreated = await createAssignedRun(
    runner.runnerId,
    undefined,
    identityHeaders(adminId, organizationId),
  );
  assert.equal(adminCreated.response.status, 201);
  assert.equal(adminCreated.detail.run.requestedBy, adminId);
  assert.equal(adminCreated.detail.run.assignedRunnerId, runner.runnerId);
  assert.equal("requiredCapability" in adminCreated.detail.run, false);

  const listed = await authenticatedRequest("/api/runs");
  assert.equal(listed.status, 200);
  const listedAssigned = (await listed.json()).runs.find(
    (run) => run.id === ownerCreated.detail.run.id,
  );
  assert.equal(listedAssigned.assignedRunnerId, runner.runnerId);
  assert.equal(listedAssigned.requiredCapability, "bubblewrap");

  const expiredRunId = await seedExpiredAssignedRun(runner.runnerId);
  const beforeRead = await runReadPurityState(expiredRunId);
  const expiredRead = await authenticatedRequest(`/api/runs/${expiredRunId}`);
  assert.equal(expiredRead.status, 200);
  const expiredDetail = await expiredRead.json();
  assert.equal(expiredDetail.run.status, "queued");
  assert.equal(expiredDetail.run.expired, true);
  assert.equal(expiredDetail.run.assignedRunnerId, runner.runnerId);
  assert.deepEqual(await runReadPurityState(expiredRunId), beforeRead);
  const beforeListRead = await runReadPurityState(expiredRunId);
  const expiredListRead = await authenticatedRequest("/api/runs");
  assert.equal(expiredListRead.status, 200);
  const listedExpired = (await expiredListRead.json()).runs.find(
    (run) => run.id === expiredRunId,
  );
  assert.equal(listedExpired.status, "queued");
  assert.equal(listedExpired.expired, true);
  assert.deepEqual(
    await runReadPurityState(expiredRunId),
    beforeListRead,
  );
  const canceled = await authenticatedRequest(
    `/api/runs/${expiredRunId}/cancel`,
    { method: "POST", body: "{}" },
  );
  assert.equal(canceled.status, 200);
  assert.equal((await canceled.json()).run.status, "canceled");
}

async function createAssignedRun(
  assignedRunnerId,
  requiredCapability,
  headers,
) {
  const response = await authenticatedRequest(
    "/api/runs/diagnostic/assigned",
    {
      method: "POST",
      ...(headers ? { headers } : {}),
      body: JSON.stringify({
        assignedRunnerId,
        ...(requiredCapability ? { requiredCapability } : {}),
      }),
    },
  );
  return { response, detail: await response.json() };
}

async function exerciseEngineRunCreation(runner) {
  const wrongPromptRunner = await enrollRunner(
    "Same-tenant wrong prompt runner",
  );
  const crossTenantPromptRunner = await enrollRunner(
    "Cross-tenant prompt runner",
    identityHeaders(otherOwnerId, otherOrganizationId),
  );
  const prompt = `ENGINE-PROMPT-SENTINEL-${randomBytes(12).toString("hex")}`;
  const body = JSON.stringify({
    assignedRunnerId: runner.runnerId,
    engine: "claude_code_cli",
    prompt,
  });
  const creationId = `ecr_${randomBytes(16).toString("hex")}`;
  const denied = await authenticatedRequest("/api/runs/engine", {
    method: "POST",
    headers: identityHeaders(memberId, organizationId),
    body,
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    error: "workspace_owner_required",
  });

  const missing = await authenticatedRequest("/api/runs/engine", {
    method: "POST",
    body: JSON.stringify({
      assignedRunnerId: `rnr_${"f".repeat(32)}`,
      engine: "claude_code_cli",
      prompt,
    }),
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "runner_not_found" });

  const response = await authenticatedRequest("/api/runs/engine", {
    method: "POST",
    headers: { "idempotency-key": creationId },
    body,
  });
  assert.equal(
    response.status,
    201,
    await response.clone().text(),
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const responseText = await response.text();
  assertEngineReadHasNoProtectedMaterial(responseText, [prompt]);
  const resolution = JSON.parse(responseText);
  assert.deepEqual(resolution, {
    creationId,
    state: "created",
    runId: resolution.runId,
  });
  assert.match(resolution.runId, /^run_[0-9a-f]{32}$/u);
  const queuedReadPath = `/api/runs/engine/${resolution.runId}`;
  const queuedReadResponse = await authenticatedRequest(queuedReadPath);
  assert.equal(queuedReadResponse.status, 200);
  assert.equal(
    queuedReadResponse.headers.get("cache-control"),
    "private, no-store",
  );
  const queuedReadText = await queuedReadResponse.text();
  assertEngineReadHasNoProtectedMaterial(queuedReadText, [prompt]);
  const queuedRead = JSON.parse(queuedReadText);
  assert.deepEqual(Object.keys(queuedRead), [
    "run",
    "events",
    "eventsTruncated",
  ]);
  assert.deepEqual(Object.keys(queuedRead.run), [
    "id",
    "organizationId",
    "requestedBy",
    "kind",
    "engine",
    "assignedRunnerId",
    "status",
    "overdue",
    "deadlineState",
    "version",
    "leaseGeneration",
    "claimCount",
    "maxClaims",
    "deadlineAt",
    "createdAt",
    "updatedAt",
  ]);
  const promptSha256 = createHash("sha256")
    .update(prompt)
    .digest("hex");
  const promptBytes = Buffer.byteLength(prompt);
  const detail = {
    events: queuedRead.events,
    run: {
      ...queuedRead.run,
      promptBytes,
      promptSha256,
      promptRef: undefined,
    },
  };
  assert.equal(queuedRead.run.id, resolution.runId);
  assert.equal(queuedRead.run.kind, "engine_prompt");
  assert.equal(queuedRead.run.engine, "claude_code_cli");
  assert.equal(queuedRead.run.status, "queued");
  assert.equal(queuedRead.run.overdue, false);
  assert.equal(queuedRead.run.deadlineState, "pending");
  assert.equal(queuedRead.run.assignedRunnerId, runner.runnerId);
  assert.equal(
    Date.parse(queuedRead.run.deadlineAt) -
      Date.parse(queuedRead.run.createdAt),
    20 * 60_000,
  );
  assert.deepEqual(queuedRead.events, [
    {
      sequence: 1,
      kind: "run.created",
      actorId: ownerId,
      occurredAt: queuedRead.run.createdAt,
      metadata: {
        engine: "claude_code_cli",
        promptBytes,
        promptSha256,
      },
    },
  ]);
  assert.equal(queuedRead.eventsTruncated, false);

  const unauthorizedRead = await authenticatedRequest(queuedReadPath, {
    headers: identityHeaders(
      "principal-without-workspace-membership",
      organizationId,
    ),
  });
  assert.equal(unauthorizedRead.status, 403);
  assert.deepEqual(await unauthorizedRead.json(), {
    error: "workspace_membership_required",
  });
  const crossTenantRead = await authenticatedRequest(queuedReadPath, {
    headers: identityHeaders(otherOwnerId, otherOrganizationId),
  });
  assert.equal(crossTenantRead.status, 404);
  assert.deepEqual(await crossTenantRead.json(), {
    error: "run_not_found",
  });

  const [stored] = await queryLocalD1(
    `SELECT
       run.kind, run.engine, run.status, run.max_claims,
       run.assigned_runner_id, run.required_capability,
       prompt.prompt_ref, prompt.cipher_version, prompt.key_id,
       length(prompt.iv) AS iv_bytes,
       length(prompt.ciphertext) AS ciphertext_bytes,
       length(prompt.tag) AS tag_bytes,
       hex(prompt.ciphertext) AS ciphertext_hex,
       prompt.prompt_sha256, prompt.prompt_bytes, prompt.erased_at,
       event.metadata_json, ledger.payload_hash,
       (SELECT COUNT(*) FROM runs item
        WHERE item.id = run.id) AS run_rows,
       (SELECT COUNT(*) FROM run_prompts item
        WHERE item.run_id = run.id) AS prompt_rows,
       (SELECT COUNT(*) FROM run_events item
        WHERE item.run_id = run.id) AS event_rows,
       (SELECT COUNT(*) FROM ledger_entries item
        WHERE item.run_id = run.id AND item.kind = 'run.requested')
         AS ledger_rows
     FROM runs run
     INNER JOIN run_prompts prompt ON prompt.run_id = run.id
     INNER JOIN run_events event
       ON event.run_id = run.id AND event.sequence = 1
     INNER JOIN ledger_entries ledger
       ON ledger.run_id = run.id AND ledger.kind = 'run.requested'
     WHERE run.id = '${detail.run.id}'`,
  );
  assert.deepEqual(
    {
      kind: stored.kind,
      engine: stored.engine,
      status: stored.status,
      maxClaims: stored.max_claims,
      assignedRunnerId: stored.assigned_runner_id,
      requiredCapability: stored.required_capability,
      cipherVersion: stored.cipher_version,
      keyId: stored.key_id,
      ivBytes: stored.iv_bytes,
      ciphertextBytes: stored.ciphertext_bytes,
      tagBytes: stored.tag_bytes,
      promptSha256: stored.prompt_sha256,
      promptBytes: stored.prompt_bytes,
      erasedAt: stored.erased_at,
      runRows: stored.run_rows,
      promptRows: stored.prompt_rows,
      eventRows: stored.event_rows,
      ledgerRows: stored.ledger_rows,
    },
    {
      kind: "engine_prompt",
      engine: "claude_code_cli",
      status: "queued",
      maxClaims: 2,
      assignedRunnerId: runner.runnerId,
      requiredCapability: null,
      cipherVersion: 1,
      keyId: "integration-key-v1",
      ivBytes: 12,
      ciphertextBytes: promptBytes,
      tagBytes: 16,
      promptSha256,
      promptBytes,
      erasedAt: null,
      runRows: 1,
      promptRows: 1,
      eventRows: 1,
      ledgerRows: 1,
    },
  );
  assert.match(stored.prompt_ref, /^prm_[0-9a-f]{32}$/u);
  detail.run.promptRef = stored.prompt_ref;
  assert.notEqual(
    stored.ciphertext_hex.toLowerCase(),
    Buffer.from(prompt).toString("hex"),
  );
  assert.equal(
    stored.metadata_json,
    JSON.stringify({
      engine: detail.run.engine,
      promptBytes: detail.run.promptBytes,
      promptSha256: detail.run.promptSha256,
    }),
  );
  assert.equal(
    stored.payload_hash,
    canonicalSha256({
      assignedRunnerId: runner.runnerId,
      deadlineAt: detail.run.deadlineAt,
      engine: detail.run.engine,
      kind: "engine_prompt",
      maxClaims: 2,
      promptBytes: detail.run.promptBytes,
      promptSha256: detail.run.promptSha256,
      runId: detail.run.id,
    }),
  );

  const replayBefore = await engineCreationPersistenceCounts(
    resolution.runId,
    creationId,
  );
  const replayResponse = await authenticatedRequest("/api/runs/engine", {
    method: "POST",
    headers: { "idempotency-key": creationId },
    body,
  });
  assert.equal(replayResponse.status, 200);
  assert.equal(await replayResponse.text(), responseText);
  assert.deepEqual(
    await engineCreationPersistenceCounts(resolution.runId, creationId),
    replayBefore,
  );

  for (const mismatchedBody of [
    JSON.stringify({
      assignedRunnerId: wrongPromptRunner.runnerId,
      engine: "claude_code_cli",
      prompt,
    }),
    JSON.stringify({
      assignedRunnerId: runner.runnerId,
      engine: "codex_cli",
      prompt,
    }),
    JSON.stringify({
      assignedRunnerId: runner.runnerId,
      engine: "claude_code_cli",
      prompt: `${prompt}-changed`,
    }),
  ]) {
    const mismatched = await authenticatedRequest("/api/runs/engine", {
      method: "POST",
      headers: { "idempotency-key": creationId },
      body: mismatchedBody,
    });
    assert.equal(mismatched.status, 422);
    assert.deepEqual(await mismatched.json(), {
      error: "engine_run_creation_key_reused",
    });
  }

  const createdReconciliation = await authenticatedRequest(
    `/api/runs/engine/creations/${creationId}/reconcile`,
    { method: "POST", body: "{}" },
  );
  assert.equal(createdReconciliation.status, 200);
  assert.equal(
    createdReconciliation.headers.get("cache-control"),
    "private, no-store",
  );
  assert.deepEqual(await createdReconciliation.json(), resolution);

  const missingHeader = await fetch(`${baseUrl}/api/runs/engine`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...identityHeaders(ownerId, organizationId),
    },
    body,
  });
  assert.equal(missingHeader.status, 400);
  assert.deepEqual(await missingHeader.json(), {
    error: "invalid_engine_run_creation_id",
  });
  for (const invalidKey of ["", `ecr_${"A".repeat(32)}`]) {
    const invalidHeader = await authenticatedRequest("/api/runs/engine", {
      method: "POST",
      headers: { "idempotency-key": invalidKey },
      body,
    });
    assert.equal(invalidHeader.status, 400);
    assert.deepEqual(await invalidHeader.json(), {
      error: "invalid_engine_run_creation_id",
    });
  }

  const notCreatedId = `ecr_${randomBytes(16).toString("hex")}`;
  const notCreatedPath =
    `/api/runs/engine/creations/${notCreatedId}/reconcile`;
  const notCreated = await authenticatedRequest(notCreatedPath, {
    method: "POST",
    body: "{}",
  });
  assert.equal(notCreated.status, 200);
  assert.equal(notCreated.headers.get("cache-control"), "private, no-store");
  const notCreatedResolution = await notCreated.json();
  assert.deepEqual(Object.keys(notCreatedResolution), [
    "creationId",
    "state",
    "notCreatedProofId",
    "confirmedAt",
  ]);
  assert.equal(notCreatedResolution.creationId, notCreatedId);
  assert.equal(
    notCreatedResolution.state,
    "confirmed_not_created",
  );
  assert.match(
    notCreatedResolution.notCreatedProofId,
    /^ncp_[0-9a-f]{32}$/u,
  );
  const beforeLateCreate = await globalEngineCreationCounts();
  const lateCreate = await authenticatedRequest("/api/runs/engine", {
    method: "POST",
    headers: { "idempotency-key": notCreatedId },
    body,
  });
  assert.equal(lateCreate.status, 409);
  assert.deepEqual(await lateCreate.json(), notCreatedResolution);
  assert.deepEqual(await globalEngineCreationCounts(), beforeLateCreate);

  const crossTenantReconciliation = await authenticatedRequest(
    notCreatedPath,
    {
      method: "POST",
      headers: identityHeaders(otherOwnerId, otherOrganizationId),
      body: "{}",
    },
  );
  assert.equal(crossTenantReconciliation.status, 200);
  const crossTenantResolution = await crossTenantReconciliation.json();
  assert.equal(crossTenantResolution.creationId, notCreatedId);
  assert.equal(
    crossTenantResolution.state,
    "confirmed_not_created",
  );
  assert.notEqual(
    crossTenantResolution.notCreatedProofId,
    notCreatedResolution.notCreatedProofId,
  );

  const racedCreationId = `ecr_${randomBytes(16).toString("hex")}`;
  const racedPosts = await Promise.all([
    authenticatedRequest("/api/runs/engine", {
      method: "POST",
      headers: { "idempotency-key": racedCreationId },
      body,
    }),
    authenticatedRequest("/api/runs/engine", {
      method: "POST",
      headers: { "idempotency-key": racedCreationId },
      body,
    }),
  ]);
  assert.deepEqual(
    racedPosts.map((candidate) => candidate.status).sort(),
    [200, 201],
  );
  const racedResolutions = await Promise.all(
    racedPosts.map((candidate) => candidate.json()),
  );
  assert.equal(
    racedResolutions[0].runId,
    racedResolutions[1].runId,
  );
  assert.equal(
    (
      await engineCreationPersistenceCounts(
        racedResolutions[0].runId,
        racedCreationId,
      )
    ).resolutions,
    1,
  );

  await exerciseEngineCreationReconcileRace(body, "create");
  await exerciseEngineCreationReconcileRace(body, "reconcile");

  const lostResponseCreationId =
    `ecr_${randomBytes(16).toString("hex")}`;
  const lostResponseController = new AbortController();
  const intentionallyLostResponse = authenticatedRequest(
    "/api/runs/engine",
    {
      method: "POST",
      headers: { "idempotency-key": lostResponseCreationId },
      body,
      signal: lostResponseController.signal,
    },
  )
    .then(async (candidate) => {
      await candidate.body?.cancel();
      return candidate.status;
    })
    .catch(() => 0);
  await waitForEngineCreationResolution(lostResponseCreationId);
  lostResponseController.abort();
  await intentionallyLostResponse;
  const recoveredAfterLostResponse = await authenticatedRequest(
    "/api/runs/engine",
    {
      method: "POST",
      headers: { "idempotency-key": lostResponseCreationId },
      body,
    },
  );
  assert.equal(recoveredAfterLostResponse.status, 200);
  const recoveredResolution = await recoveredAfterLostResponse.json();
  assert.equal(recoveredResolution.creationId, lostResponseCreationId);
  assert.equal(recoveredResolution.state, "created");

  const attentionReport = await submitEngineReport(runner, {
    claudeReady: false,
  });
  const claimPath =
    `/api/runs/${detail.run.id}/engine-lease/claim`;
  const claimOperationId = `op_${randomBytes(16).toString("hex")}`;
  const claimBody = JSON.stringify({
    engine: "claude_code_cli",
    operationId: claimOperationId,
  });
  const attentionClaim = await fetch(
    `${baseUrl}${claimPath}`,
    await signedRunnerRequest({
      path: claimPath,
      domain: "nexus-runner-engine-lease-claim-v1",
      runner,
      body: claimBody,
    }),
  );
  assert.equal(attentionClaim.status, 409);
  assert.deepEqual(await attentionClaim.json(), {
    error: "engine_inventory_mismatch",
  });

  const wrongEngineClaim = await fetch(
    `${baseUrl}${claimPath}`,
    await signedRunnerRequest({
      path: claimPath,
      domain: "nexus-runner-engine-lease-claim-v1",
      runner,
      body: JSON.stringify({
        engine: "codex_cli",
        operationId: `op_${randomBytes(16).toString("hex")}`,
      }),
    }),
  );
  assert.equal(wrongEngineClaim.status, 409);
  assert.deepEqual(await wrongEngineClaim.json(), {
    error: "engine_mismatch",
  });

  const readyReport = await submitEngineReport(runner, {
    claudeReady: true,
  });
  assert.notEqual(readyReport.reportId, attentionReport.reportId);
  const claimResponse = await fetch(
    `${baseUrl}${claimPath}`,
    await signedRunnerRequest({
      path: claimPath,
      domain: "nexus-runner-engine-lease-claim-v1",
      runner,
      body: claimBody,
    }),
  );
  assert.equal(claimResponse.status, 200);
  const claimText = await claimResponse.text();
  const claim = JSON.parse(claimText);
  assert.equal(claimText, JSON.stringify(claim));
  assert.deepEqual(Object.keys(claim), [
    "cancelRequested",
    "expiresAt",
    "fence",
    "job",
    "leaseId",
    "runId",
  ]);
  assert.deepEqual(Object.keys(claim.job), [
    "deadlineAt",
    "engine",
    "engineVersion",
    "outputBounds",
    "promptBytes",
    "promptRef",
    "promptSha256",
    "timeoutMs",
  ]);
  assert.equal(claim.cancelRequested, false);
  assert.equal(claim.fence, 1);
  assert.equal(claim.runId, detail.run.id);
  assert.equal(claim.job.deadlineAt, detail.run.deadlineAt);
  assert.equal(claim.job.engine, "claude_code_cli");
  assert.equal(claim.job.engineVersion, "2.1.219");
  assert.deepEqual(claim.job.outputBounds, {
    stderrBytes: 65_536,
    stdoutBytes: 262_144,
  });
  assert.equal(claim.job.promptBytes, detail.run.promptBytes);
  assert.equal(claim.job.promptRef, detail.run.promptRef);
  assert.equal(claim.job.promptSha256, detail.run.promptSha256);
  assert.equal(claim.job.timeoutMs, 600_000);

  const promptPath = `/api/runs/${detail.run.id}/prompt`;
  const promptReadBody = JSON.stringify({
    fence: claim.fence,
    leaseId: claim.leaseId,
    promptRef: detail.run.promptRef,
  });
  const promptReadInit = await signedRunnerRequest({
    path: promptPath,
    domain: "nexus-runner-engine-prompt-read-v1",
    runner,
    body: promptReadBody,
  });
  const promptRead = await fetch(`${baseUrl}${promptPath}`, promptReadInit);
  const promptReadText = await promptRead.text();
  assert.equal(
    promptRead.status,
    200,
    `${promptReadText}\n${serverOutput}`,
  );
  assert.equal(
    promptRead.headers.get("content-type"),
    "application/octet-stream",
  );
  assert.equal(promptRead.headers.get("cache-control"), "no-store");
  assert.equal(promptRead.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    promptRead.headers.get("x-nexus-prompt-ref"),
    detail.run.promptRef,
  );
  assert.equal(
    promptRead.headers.get("x-nexus-prompt-sha256"),
    detail.run.promptSha256,
  );
  assert.equal(
    promptRead.headers.get("x-nexus-prompt-bytes"),
    String(detail.run.promptBytes),
  );
  assert.equal(promptRead.headers.get("x-nexus-replay"), null);
  assert.equal(promptReadText, prompt);

  const promptReplay = await fetch(
    `${baseUrl}${promptPath}`,
    promptReadInit,
  );
  assert.equal(promptReplay.status, 200);
  assert.equal(promptReplay.headers.get("x-nexus-replay"), "1");
  assert.equal(await promptReplay.text(), prompt);

  const concurrentPromptReadInit = await signedRunnerRequest({
    path: promptPath,
    domain: "nexus-runner-engine-prompt-read-v1",
    runner,
    body: promptReadBody,
  });
  const concurrentPromptReads = await Promise.all(
    [0, 1].map(async () => {
      const response = await fetch(
        `${baseUrl}${promptPath}`,
        concurrentPromptReadInit,
      );
      return {
        status: response.status,
        replay: response.headers.get("x-nexus-replay"),
        body: await response.text(),
      };
    }),
  );
  assert.deepEqual(
    concurrentPromptReads.map((candidate) => candidate.status),
    [200, 200],
  );
  assert.deepEqual(
    concurrentPromptReads.map((candidate) => candidate.body),
    [prompt, prompt],
  );
  assert.deepEqual(
    concurrentPromptReads
      .map((candidate) => candidate.replay ?? "")
      .sort(),
    ["", "1"],
  );

  const promptSentinel = JSON.stringify({
    promptRef: detail.run.promptRef,
  });
  const [promptReadState] = await queryLocalD1(
    `SELECT
       nonce.response_status, nonce.response_body,
       (SELECT COUNT(*) FROM runner_lease_nonces item
        WHERE item.runner_id = '${runner.runnerId}'
          AND item.response_body = '${promptSentinel}')
         AS prompt_nonce_rows,
       (SELECT COUNT(*) FROM run_events event
        WHERE event.run_id = '${detail.run.id}') AS event_rows,
       (SELECT COUNT(*) FROM ledger_entries ledger
        WHERE ledger.run_id = '${detail.run.id}') AS ledger_rows
     FROM runner_lease_nonces nonce
     WHERE nonce.runner_id = '${runner.runnerId}'
       AND nonce.response_body = '${promptSentinel}'
     LIMIT 1`,
  );
  assert.deepEqual(promptReadState, {
    response_status: 200,
    response_body: promptSentinel,
    prompt_nonce_rows: 2,
    event_rows: 2,
    ledger_rows: 1,
  });
  assert.equal(promptReadState.response_body.includes(prompt), false);

  const conflictingPromptRead = await fetch(
    `${baseUrl}${promptPath}`,
    await signedRunnerRequest({
      path: promptPath,
      domain: "nexus-runner-engine-prompt-read-v1",
      runner,
      nonce: promptReadInit.headers["x-nexus-nonce"],
      body: JSON.stringify({
        fence: claim.fence,
        leaseId: claim.leaseId,
        promptRef: `prm_${"f".repeat(32)}`,
      }),
    }),
  );
  assert.equal(conflictingPromptRead.status, 409);
  assert.deepEqual(await conflictingPromptRead.json(), {
    error: "nonce_reused",
  });

  const unavailablePromptRead = await fetch(
    `${baseUrl}${promptPath}`,
    await signedRunnerRequest({
      path: promptPath,
      domain: "nexus-runner-engine-prompt-read-v1",
      runner,
      body: JSON.stringify({
        fence: claim.fence,
        leaseId: claim.leaseId,
        promptRef: `prm_${"e".repeat(32)}`,
      }),
    }),
  );
  assert.equal(unavailablePromptRead.status, 404);
  assert.deepEqual(await unavailablePromptRead.json(), {
    error: "prompt_unavailable",
  });

  const supersededPromptRead = await fetch(
    `${baseUrl}${promptPath}`,
    await signedRunnerRequest({
      path: promptPath,
      domain: "nexus-runner-engine-prompt-read-v1",
      runner,
      body: JSON.stringify({
        fence: claim.fence + 1,
        leaseId: claim.leaseId,
        promptRef: detail.run.promptRef,
      }),
    }),
  );
  assert.equal(supersededPromptRead.status, 409);
  assert.deepEqual(await supersededPromptRead.json(), {
    error: "lease_superseded",
  });

  const wrongLeasePromptRead = await fetch(
    `${baseUrl}${promptPath}`,
    await signedRunnerRequest({
      path: promptPath,
      domain: "nexus-runner-engine-prompt-read-v1",
      runner,
      body: JSON.stringify({
        fence: claim.fence,
        leaseId: `lse_${"d".repeat(32)}`,
        promptRef: detail.run.promptRef,
      }),
    }),
  );
  assert.equal(wrongLeasePromptRead.status, 409);
  assert.deepEqual(await wrongLeasePromptRead.json(), {
    error: "lease_superseded",
  });

  for (const deniedRunner of [
    wrongPromptRunner,
    crossTenantPromptRunner,
  ]) {
    const denied = await fetch(
      `${baseUrl}${promptPath}`,
      await signedRunnerRequest({
        path: promptPath,
        domain: "nexus-runner-engine-prompt-read-v1",
        runner: deniedRunner,
        body: promptReadBody,
      }),
    );
    assert.equal(denied.status, 409);
    assert.deepEqual(await denied.json(), {
      error: "run_unavailable",
    });
  }
  const deniedRunnerState = await queryLocalD1(
    `SELECT id, last_seen_at,
       (SELECT COUNT(*) FROM runner_lease_nonces nonce
        WHERE nonce.runner_id = runners.id
          AND nonce.response_body = '${promptSentinel}') AS prompt_nonces
     FROM runners
     WHERE id IN (
       '${wrongPromptRunner.runnerId}',
       '${crossTenantPromptRunner.runnerId}'
     )
     ORDER BY id`,
  );
  assert.equal(deniedRunnerState.length, 2);
  assert.equal(
    deniedRunnerState.every(
      (candidate) =>
        candidate.last_seen_at === null &&
        candidate.prompt_nonces === 0,
    ),
    true,
  );

  const wrongDomainPromptRead = await fetch(
    `${baseUrl}${promptPath}`,
    await signedRunnerRequest({
      path: promptPath,
      domain: "nexus-runner-engine-lease-claim-v1",
      runner,
      body: promptReadBody,
    }),
  );
  assert.equal(wrongDomainPromptRead.status, 403);
  assert.deepEqual(await wrongDomainPromptRead.json(), {
    error: "runner_rejected",
  });

  const noncanonicalPromptRead = await fetch(
    `${baseUrl}${promptPath}`,
    await signedRunnerRequest({
      path: promptPath,
      domain: "nexus-runner-engine-prompt-read-v1",
      runner,
      body: JSON.stringify({
        promptRef: detail.run.promptRef,
        leaseId: claim.leaseId,
        fence: claim.fence,
      }),
    }),
  );
  assert.equal(noncanonicalPromptRead.status, 403);
  assert.deepEqual(await noncanonicalPromptRead.json(), {
    error: "runner_rejected",
  });

  const queryPromptRead = await fetch(
    `${baseUrl}${promptPath}?probe=1`,
    promptReadInit,
  );
  assert.equal(queryPromptRead.status, 403);
  assert.deepEqual(await queryPromptRead.json(), {
    error: "runner_rejected",
  });

  const missingLengthHeaders = {
    ...promptReadInit.headers,
  };
  delete missingLengthHeaders["content-length"];
  const missingLengthPromptRead = await fetch(
    `${baseUrl}${promptPath}`,
    {
      ...promptReadInit,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(promptReadBody));
          controller.close();
        },
      }),
      duplex: "half",
      headers: missingLengthHeaders,
    },
  );
  assert.equal(missingLengthPromptRead.status, 403);
  assert.deepEqual(await missingLengthPromptRead.json(), {
    error: "runner_rejected",
  });

  const operationReplay = await fetch(
    `${baseUrl}${claimPath}`,
    await signedRunnerRequest({
      path: claimPath,
      domain: "nexus-runner-engine-lease-claim-v1",
      runner,
      body: claimBody,
    }),
  );
  assert.equal(operationReplay.status, 200);
  assert.equal(operationReplay.headers.get("x-nexus-replay"), "1");
  assert.equal(await operationReplay.text(), claimText);

  const operationConflict = await fetch(
    `${baseUrl}${claimPath}`,
    await signedRunnerRequest({
      path: claimPath,
      domain: "nexus-runner-engine-lease-claim-v1",
      runner,
      body: JSON.stringify({
        engine: "codex_cli",
        operationId: claimOperationId,
      }),
    }),
  );
  assert.equal(operationConflict.status, 409);
  assert.deepEqual(await operationConflict.json(), {
    error: "operation_conflict",
  });

  const [claimedState] = await queryLocalD1(
    `SELECT
       run.status, run.claim_count, run.lease_generation,
       lease.admission_basis, lease.admission_policy_source,
       lease.admission_policy_version, lease.admission_freshness_seconds,
       lease.admission_required_capability, lease.admission_report_id,
       lease.admission_report_received_at, lease.admission_engine,
       lease.admission_engine_report_id,
       lease.admission_engine_report_received_at,
       lease.admission_engine_version, event.metadata_json,
       operation.response_body
     FROM runs run
     INNER JOIN run_leases lease ON lease.id = run.current_lease_id
     INNER JOIN run_events event
       ON event.run_id = run.id AND event.kind = 'lease.claimed'
      AND event.fence = lease.fence
     INNER JOIN runner_operations operation
       ON operation.run_id = run.id AND operation.fence = lease.fence
     WHERE run.id = '${detail.run.id}'`,
  );
  assert.deepEqual(
    {
      status: claimedState.status,
      claimCount: claimedState.claim_count,
      leaseGeneration: claimedState.lease_generation,
      admissionBasis: claimedState.admission_basis,
      policySource: claimedState.admission_policy_source,
      policyVersion: claimedState.admission_policy_version,
      freshnessSeconds: claimedState.admission_freshness_seconds,
      requiredCapability: claimedState.admission_required_capability,
      capabilityReportId: claimedState.admission_report_id,
      capabilityReportReceivedAt:
        claimedState.admission_report_received_at,
      engine: claimedState.admission_engine,
      engineReportId: claimedState.admission_engine_report_id,
      engineReportReceivedAt:
        claimedState.admission_engine_report_received_at,
      engineVersion: claimedState.admission_engine_version,
    },
    {
      status: "leased",
      claimCount: 1,
      leaseGeneration: 1,
      admissionBasis: "engine_inventory",
      policySource: "default",
      policyVersion: 0,
      freshnessSeconds: 86_400,
      requiredCapability: null,
      capabilityReportId: null,
      capabilityReportReceivedAt: null,
      engine: "claude_code_cli",
      engineReportId: readyReport.reportId,
      engineReportReceivedAt: readyReport.receivedAt,
      engineVersion: "2.1.219",
    },
  );
  assert.deepEqual(JSON.parse(claimedState.metadata_json), {
    admissionBasis: "engine_inventory",
    admissionEngine: "claude_code_cli",
    admissionEngineReportId: readyReport.reportId,
    admissionEngineReportReceivedAt: readyReport.receivedAt,
    admissionEngineVersion: "2.1.219",
    admissionFreshnessSeconds: 86_400,
    admissionPolicySource: "default",
    admissionPolicyVersion: 0,
    assignedRunnerId: runner.runnerId,
    leaseId: claim.leaseId,
    operationId: claimOperationId,
  });
  assert.equal(claimedState.response_body, claimText);

  const renewPath = `/api/runs/${detail.run.id}/lease/renew`;
  const renewResponse = await fetch(
    `${baseUrl}${renewPath}`,
    await signedRunnerRequest({
      path: renewPath,
      domain: "nexus-runner-lease-renew-v1",
      runner,
      body: JSON.stringify({
        fence: claim.fence,
        leaseId: claim.leaseId,
      }),
    }),
  );
  assert.equal(renewResponse.status, 200);
  const renewal = await renewResponse.json();
  assert.equal(renewal.runId, detail.run.id);
  assert.equal(renewal.fence, 1);
  assert.ok(renewal.expiresAt > claim.expiresAt);
  assert.ok(renewal.expiresAt <= detail.run.deadlineAt);
  const [renewedState] = await queryLocalD1(
    `SELECT
       lease.renew_count,
       (SELECT COUNT(*) FROM run_events event
        WHERE event.run_id = run.id AND event.kind = 'lease.renewed')
         AS renewed_event_rows
     FROM runs run
     INNER JOIN run_leases lease ON lease.id = run.current_lease_id
     WHERE run.id = '${detail.run.id}'`,
  );
  assert.deepEqual(renewedState, {
    renew_count: 1,
    renewed_event_rows: 1,
  });

  await runLocalD1(
    `DROP TRIGGER run_prompts_validate_before_update;
     UPDATE run_prompts
     SET prompt_sha256 = '${"0".repeat(64)}'
     WHERE run_id = '${detail.run.id}';`,
  );
  const corruptPromptReadInit = await signedRunnerRequest({
    path: promptPath,
    domain: "nexus-runner-engine-prompt-read-v1",
    runner,
    body: promptReadBody,
  });
  const corruptPromptRead = await fetch(
    `${baseUrl}${promptPath}`,
    corruptPromptReadInit,
  );
  assert.equal(corruptPromptRead.status, 503);
  assert.equal(
    corruptPromptRead.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(corruptPromptRead.headers.get("x-nexus-prompt-ref"), null);
  assert.equal(corruptPromptRead.headers.get("x-nexus-prompt-sha256"), null);
  assert.equal(corruptPromptRead.headers.get("x-nexus-prompt-bytes"), null);
  const corruptPromptBody = await corruptPromptRead.text();
  assert.equal(
    corruptPromptBody,
    '{"error":"prompt_cipher_key_unavailable"}',
  );
  assert.equal(corruptPromptBody.includes(prompt), false);
  const corruptPromptReplay = await fetch(
    `${baseUrl}${promptPath}`,
    corruptPromptReadInit,
  );
  assert.equal(corruptPromptReplay.status, 503);
  assert.equal(
    await corruptPromptReplay.text(),
    '{"error":"prompt_cipher_key_unavailable"}',
  );
  await runLocalD1(promptUpdateTriggerMigration);
  const [restoredPromptTrigger] = await queryLocalD1(
    `SELECT COUNT(*) AS count
     FROM sqlite_master
     WHERE type = 'trigger'
       AND name = 'run_prompts_validate_before_update'`,
  );
  assert.deepEqual(restoredPromptTrigger, { count: 1 });

  const diagnosticClaimPath =
    `/api/runs/${detail.run.id}/lease/claim`;
  const diagnosticClaim = await fetch(
    `${baseUrl}${diagnosticClaimPath}`,
    await signedRunnerRequest({
      path: diagnosticClaimPath,
      domain: "nexus-runner-lease-claim-v1",
      runner,
      body: JSON.stringify({
        operationId: `op_${randomBytes(16).toString("hex")}`,
      }),
    }),
  );
  assert.equal(diagnosticClaim.status, 409);
  assert.deepEqual(await diagnosticClaim.json(), {
    error: "run_unavailable",
  });
  const diagnosticCompletePath = `/api/runs/${detail.run.id}/complete`;
  const diagnosticComplete = await fetch(
    `${baseUrl}${diagnosticCompletePath}`,
    await signedRunnerRequest({
      path: diagnosticCompletePath,
      domain: "nexus-runner-run-complete-v1",
      runner,
      body: JSON.stringify({
        fence: claim.fence,
        leaseId: claim.leaseId,
        operationId: `op_${randomBytes(16).toString("hex")}`,
        outcome: {
          status: "succeeded",
          summary: "Cross-kind completion must stay closed.",
        },
      }),
    }),
  );
  assert.equal(diagnosticComplete.status, 409);
  assert.deepEqual(await diagnosticComplete.json(), {
    error: "run_unavailable",
  });

  const diagnosticForEngine = await (
    await authenticatedRequest("/api/runs/diagnostic", {
      method: "POST",
      body: "{}",
    })
  ).json();
  const engineAgainstDiagnosticPath =
    `/api/runs/${diagnosticForEngine.run.id}/engine-lease/claim`;
  const engineAgainstDiagnostic = await fetch(
    `${baseUrl}${engineAgainstDiagnosticPath}`,
    await signedRunnerRequest({
      path: engineAgainstDiagnosticPath,
      domain: "nexus-runner-engine-lease-claim-v1",
      runner,
      body: JSON.stringify({
        engine: "claude_code_cli",
        operationId: `op_${randomBytes(16).toString("hex")}`,
      }),
    }),
  );
  assert.equal(engineAgainstDiagnostic.status, 409);
  assert.deepEqual(await engineAgainstDiagnostic.json(), {
    error: "run_unavailable",
  });
  const promptAgainstDiagnosticPath =
    `/api/runs/${diagnosticForEngine.run.id}/prompt`;
  const promptAgainstDiagnostic = await fetch(
    `${baseUrl}${promptAgainstDiagnosticPath}`,
    await signedRunnerRequest({
      path: promptAgainstDiagnosticPath,
      domain: "nexus-runner-engine-prompt-read-v1",
      runner,
      body: JSON.stringify({
        fence: claim.fence,
        leaseId: claim.leaseId,
        promptRef: detail.run.promptRef,
      }),
    }),
  );
  assert.equal(promptAgainstDiagnostic.status, 409);
  assert.deepEqual(await promptAgainstDiagnostic.json(), {
    error: "run_unavailable",
  });

  const diagnosticList = await authenticatedRequest("/api/runs");
  assert.equal(diagnosticList.status, 200);
  assert.equal(
    (await diagnosticList.json()).runs.some(
      (candidate) => candidate.id === detail.run.id,
    ),
    false,
  );
  const diagnosticDetail = await authenticatedRequest(
    `/api/runs/${detail.run.id}`,
  );
  assert.equal(diagnosticDetail.status, 404);
  const diagnosticCancel = await authenticatedRequest(
    `/api/runs/${detail.run.id}/cancel`,
    { method: "POST", body: "{}" },
  );
  assert.equal(diagnosticCancel.status, 404);

  const concurrent = await Promise.all(
    ["claude_code_cli", "codex_cli"].map((engine, index) =>
      authenticatedRequest("/api/runs/engine", {
        method: "POST",
        headers: identityHeaders(adminId, organizationId),
        body: JSON.stringify({
          assignedRunnerId: runner.runnerId,
          engine,
          prompt: `concurrent-engine-prompt-${index}`,
        }),
      }),
    ),
  );
  assert.deepEqual(
    concurrent.map((candidate) => candidate.status),
    [201, 201],
  );
  const concurrentDetails = await Promise.all(
    concurrent.map((candidate) => candidate.json()),
  );
  assert.equal(
    concurrentDetails.every(
      (candidate) =>
        candidate.state === "created" &&
        /^ecr_[0-9a-f]{32}$/u.test(candidate.creationId) &&
        /^run_[0-9a-f]{32}$/u.test(candidate.runId),
    ),
    true,
  );
  const firstEnginePageResponse = await authenticatedRequest(
    "/api/runs/engine?limit=1",
  );
  assert.equal(firstEnginePageResponse.status, 200);
  const firstEnginePageText = await firstEnginePageResponse.text();
  assertEngineReadHasNoProtectedMaterial(firstEnginePageText, [
    prompt,
    "concurrent-engine-prompt-0",
    "concurrent-engine-prompt-1",
  ]);
  const firstEnginePage = JSON.parse(firstEnginePageText);
  assert.deepEqual(Object.keys(firstEnginePage), ["runs", "nextCursor"]);
  assert.equal(firstEnginePage.runs.length, 1);
  assert.equal(typeof firstEnginePage.nextCursor, "string");
  const secondEnginePageResponse = await authenticatedRequest(
    `/api/runs/engine?limit=1&cursor=${
      encodeURIComponent(firstEnginePage.nextCursor)
    }`,
  );
  assert.equal(secondEnginePageResponse.status, 200);
  const secondEnginePage = await secondEnginePageResponse.json();
  assert.equal(secondEnginePage.runs.length, 1);
  assert.notEqual(
    secondEnginePage.runs[0].id,
    firstEnginePage.runs[0].id,
  );
  assert.equal(
    secondEnginePage.runs[0].organizationId,
    organizationId,
  );
  for (const path of [
    "/api/runs/engine?limit=0",
    "/api/runs/engine?limit=51",
    "/api/runs/engine?limit=01",
    "/api/runs/engine?cursor=invalid",
    "/api/runs/engine?limit=1&limit=2",
    "/api/runs/engine?unknown=1",
  ]) {
    const invalidPage = await authenticatedRequest(path);
    assert.equal(invalidPage.status, 400);
    assert.deepEqual(await invalidPage.json(), {
      error: "invalid_engine_run_page",
    });
  }
  const crossTenantRegistry = await authenticatedRequest(
    "/api/runs/engine?limit=50",
    {
      headers: identityHeaders(otherOwnerId, otherOrganizationId),
    },
  );
  assert.equal(crossTenantRegistry.status, 200);
  assert.deepEqual(await crossTenantRegistry.json(), { runs: [] });
  const concurrentRows = await queryLocalD1(
    `SELECT
       run.id, run.requested_by, ledger.sequence,
       ledger.previous_hash, ledger.hash
     FROM runs run
     INNER JOIN run_prompts prompt ON prompt.run_id = run.id
     INNER JOIN run_events event
       ON event.run_id = run.id AND event.sequence = 1
     INNER JOIN ledger_entries ledger
       ON ledger.run_id = run.id AND ledger.kind = 'run.requested'
     WHERE run.id IN (
       '${concurrentDetails[0].runId}',
       '${concurrentDetails[1].runId}'
     )
     ORDER BY ledger.sequence`,
  );
  assert.equal(concurrentRows.length, 2);
  assert.deepEqual(
    new Set(concurrentRows.map((row) => row.id)),
    new Set(concurrentDetails.map((candidate) => candidate.runId)),
  );
  assert.equal(
    concurrentRows.every((row) => row.requested_by === adminId),
    true,
  );
  assert.equal(
    concurrentRows[1].sequence,
    concurrentRows[0].sequence + 1,
  );
  assert.equal(concurrentRows[1].previous_hash, concurrentRows[0].hash);

  const raceRunner = await enrollRunner("Engine claim race runner");
  await submitEngineReport(raceRunner, { claudeReady: true });
  const raceCreatedResponse = await authenticatedRequest(
    "/api/runs/engine",
    {
      method: "POST",
      body: JSON.stringify({
        assignedRunnerId: raceRunner.runnerId,
        engine: "claude_code_cli",
        prompt: "engine claim race prompt",
      }),
    },
  );
  assert.equal(raceCreatedResponse.status, 201);
  const raceRun = await engineRunInternalFixture(
    await raceCreatedResponse.json(),
  );
  const racePath =
    `/api/runs/${raceRun.run.id}/engine-lease/claim`;
  const raceResponses = await Promise.all(
    [0, 1].map(async (index) => {
      const body = JSON.stringify({
        engine: "claude_code_cli",
        operationId:
          `op_${String(index + 1).repeat(32)}`,
      });
      const response = await fetch(
        `${baseUrl}${racePath}`,
        await signedRunnerRequest({
          path: racePath,
          domain: "nexus-runner-engine-lease-claim-v1",
          runner: raceRunner,
          body,
        }),
      );
      return {
        status: response.status,
        body: await response.json(),
      };
    }),
  );
  assert.deepEqual(
    raceResponses.map((candidate) => candidate.status).sort(),
    [200, 409],
  );
  const raceDenied = raceResponses.find(
    (candidate) => candidate.status === 409,
  );
  assert.ok(raceDenied);
  assert.deepEqual(raceDenied.body, { error: "run_unavailable" });
  const [raceState] = await queryLocalD1(
    `SELECT
       run.claim_count,
       (SELECT COUNT(*) FROM run_leases lease
        WHERE lease.run_id = run.id) AS lease_rows,
       (SELECT COUNT(*) FROM runner_operations operation
        WHERE operation.run_id = run.id) AS operation_rows,
       (SELECT COUNT(*) FROM run_events event
        WHERE event.run_id = run.id AND event.kind = 'lease.claimed')
         AS claimed_event_rows
     FROM runs run
     WHERE run.id = '${raceRun.run.id}'`,
  );
  assert.deepEqual(raceState, {
    claim_count: 1,
    lease_rows: 1,
    operation_rows: 1,
    claimed_event_rows: 1,
  });
  const raceClaim = raceResponses.find(
    (candidate) => candidate.status === 200,
  )?.body;
  assert.ok(raceClaim);
  const manualRenewedAt = new Date().toISOString();
  await runLocalD1(
    `UPDATE run_leases
     SET expires_at = '${raceRun.run.deadlineAt}',
         renewed_at = '${manualRenewedAt}',
         renew_count = renew_count + 1,
         updated_at = '${manualRenewedAt}'
     WHERE id = '${raceClaim.leaseId}'
       AND run_id = '${raceRun.run.id}';`,
  );
  const deadlineRenewPath =
    `/api/runs/${raceRun.run.id}/lease/renew`;
  const deadlineRenew = await fetch(
    `${baseUrl}${deadlineRenewPath}`,
    await signedRunnerRequest({
      path: deadlineRenewPath,
      domain: "nexus-runner-lease-renew-v1",
      runner: raceRunner,
      body: JSON.stringify({
        fence: raceClaim.fence,
        leaseId: raceClaim.leaseId,
      }),
    }),
  );
  assert.equal(deadlineRenew.status, 409);
  assert.deepEqual(await deadlineRenew.json(), {
    error: "engine_deadline_insufficient",
  });
  const [deadlineRenewState] = await queryLocalD1(
    `SELECT
       lease.renew_count,
       (SELECT COUNT(*) FROM run_events event
        WHERE event.run_id = run.id AND event.kind = 'lease.renewed')
         AS renewed_event_rows,
       (SELECT COUNT(*) FROM runner_lease_nonces nonce
        WHERE nonce.runner_id = '${raceRunner.runnerId}')
         AS nonce_rows
     FROM runs run
     INNER JOIN run_leases lease ON lease.id = run.current_lease_id
     WHERE run.id = '${raceRun.run.id}'`,
  );
  assert.deepEqual(deadlineRenewState, {
    renew_count: 1,
    renewed_event_rows: 0,
    nonce_rows: 1,
  });

  const shadowRunner = await enrollRunner(
    "Engine inventory shadow runner",
  );
  await submitEngineReport(shadowRunner, { claudeReady: true });
  const shadowReport = await submitEngineReport(shadowRunner, {
    claudeReady: false,
  });
  const shadowCreated = await authenticatedRequest("/api/runs/engine", {
    method: "POST",
    body: JSON.stringify({
      assignedRunnerId: shadowRunner.runnerId,
      engine: "claude_code_cli",
      prompt: "latest engine report must be authoritative",
    }),
  });
  assert.equal(shadowCreated.status, 201);
  const shadowRun = await shadowCreated.json();
  const shadowPath =
    `/api/runs/${shadowRun.runId}/engine-lease/claim`;
  const shadowClaim = await fetch(
    `${baseUrl}${shadowPath}`,
    await signedRunnerRequest({
      path: shadowPath,
      domain: "nexus-runner-engine-lease-claim-v1",
      runner: shadowRunner,
      body: JSON.stringify({
        engine: "claude_code_cli",
        operationId: `op_${randomBytes(16).toString("hex")}`,
      }),
    }),
  );
  assert.equal(shadowClaim.status, 409);
  assert.deepEqual(await shadowClaim.json(), {
    error: "engine_inventory_mismatch",
  });
  const [shadowState] = await queryLocalD1(
    `SELECT
       (SELECT report_id FROM runner_engine_reports
        WHERE runner_id = '${shadowRunner.runnerId}'
        ORDER BY received_at DESC, report_id DESC LIMIT 1)
         AS latest_report_id,
       run.claim_count,
       (SELECT COUNT(*) FROM run_leases lease
        WHERE lease.run_id = run.id) AS lease_rows
     FROM runs run
     WHERE run.id = '${shadowRun.runId}'`,
  );
  assert.deepEqual(shadowState, {
    latest_report_id: shadowReport.reportId,
    claim_count: 0,
    lease_rows: 0,
  });
  assert.equal(serverOutput.includes(prompt), false);
  await waitPastLeaseExpiry(renewal.expiresAt);
  const expiredPromptReplay = await fetch(
    `${baseUrl}${promptPath}`,
    promptReadInit,
  );
  assert.equal(expiredPromptReplay.status, 410);
  assert.deepEqual(await expiredPromptReplay.json(), {
    error: "lease_expired",
  });
  const cancelRequestedAt = new Date().toISOString();
  await runLocalD1(
    `UPDATE runs
     SET cancel_requested_at = '${cancelRequestedAt}',
         cancel_requested_by = '${ownerId}',
         version = version + 1,
         updated_at = '${cancelRequestedAt}'
     WHERE id = '${detail.run.id}';`,
  );
  const canceledPromptRead = await fetch(
    `${baseUrl}${promptPath}`,
    await signedRunnerRequest({
      path: promptPath,
      domain: "nexus-runner-engine-prompt-read-v1",
      runner,
      body: promptReadBody,
    }),
  );
  assert.equal(canceledPromptRead.status, 409);
  assert.deepEqual(await canceledPromptRead.json(), {
    error: "run_unavailable",
  });
  const [expiredReplayState] = await queryLocalD1(
    `SELECT COUNT(*) AS nonce_rows
     FROM runner_lease_nonces
     WHERE response_body = '${promptSentinel}'`,
  );
  assert.equal(expiredReplayState.nonce_rows, 3);
  await exerciseRevokedPromptRead();
  const overdueSeed = await seedDueEngineRun(runner.runnerId);
  const overdueReadResponse = await authenticatedRequest(
    `/api/runs/engine/${overdueSeed.runId}`,
  );
  assert.equal(overdueReadResponse.status, 200);
  const overdueReadText = await overdueReadResponse.text();
  assertEngineReadHasNoProtectedMaterial(overdueReadText, [
    overdueSeed.promptRef,
    "integration-key-v1",
  ]);
  const overdueRead = JSON.parse(overdueReadText);
  assert.equal(overdueRead.run.status, "queued");
  assert.equal(overdueRead.run.overdue, true);
  assert.equal(
    overdueRead.run.deadlineState,
    "overdue_awaiting_reconciliation",
  );
  const overdueRegistryResponse = await authenticatedRequest(
    "/api/runs/engine?limit=50",
  );
  assert.equal(overdueRegistryResponse.status, 200);
  const overdueRegistry = await overdueRegistryResponse.json();
  const listedOverdue = overdueRegistry.runs.find(
    (candidate) => candidate.id === overdueSeed.runId,
  );
  assert.equal(listedOverdue.status, "queued");
  assert.equal(listedOverdue.overdue, true);
  assert.equal(
    listedOverdue.deadlineState,
    "overdue_awaiting_reconciliation",
  );

  const canceledSeed = await seedCanceledEngineRun(runner.runnerId);
  const canceledReadResponse = await authenticatedRequest(
    `/api/runs/engine/${canceledSeed.runId}`,
  );
  assert.equal(canceledReadResponse.status, 200);
  const canceledReadText = await canceledReadResponse.text();
  assertEngineReadHasNoProtectedMaterial(canceledReadText, [
    canceledSeed.promptRef,
    "integration-key-v1",
  ]);
  const canceledRead = JSON.parse(canceledReadText);
  assert.equal(canceledRead.run.status, "canceled");
  assert.equal(canceledRead.run.overdue, false);
  assert.equal(canceledRead.run.deadlineState, "settled");
  assert.equal(canceledRead.eventsTruncated, false);
  assert.equal(canceledRead.events.at(-1).kind, "run.canceled");
  assert.equal("receipt" in canceledRead, false);
}

async function exerciseEngineCompletion(runner) {
  const prompt = `COMPLETION-PROMPT-SENTINEL-${randomBytes(8).toString("hex")}`;
  const createdResponse = await authenticatedRequest("/api/runs/engine", {
    method: "POST",
    body: JSON.stringify({
      assignedRunnerId: runner.runnerId,
      engine: "claude_code_cli",
      prompt,
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const claimPath =
    `/api/runs/${created.runId}/engine-lease/claim`;
  const claimResponse = await fetch(
    `${baseUrl}${claimPath}`,
    await signedRunnerRequest({
      path: claimPath,
      domain: "nexus-runner-engine-lease-claim-v1",
      runner,
      body: JSON.stringify({
        engine: "claude_code_cli",
        operationId: `op_${randomBytes(16).toString("hex")}`,
      }),
    }),
  );
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json();

  const output = Buffer.from(
    `ENGINE-OUTPUT-SENTINEL-${randomBytes(8).toString("hex")}`,
  );
  const emptySha256 = createHash("sha256").update("").digest("hex");
  const observedAt = new Date().toISOString();
  const operationId = `op_${randomBytes(16).toString("hex")}`;
  const receipt = {
    cancelRequested: false,
    engine: "claude_code_cli",
    engineVersion: claim.job.engineVersion,
    exitCode: 0,
    finishedAt: observedAt,
    reason: "none",
    startedAt: observedAt,
    status: "succeeded",
    stderr: {
      bytes: 0,
      excerptBase64Url: "",
      sha256: emptySha256,
      truncated: false,
    },
    stdout: {
      bytes: output.byteLength,
      excerptBase64Url: output.toString("base64url"),
      sha256: createHash("sha256").update(output).digest("hex"),
      truncated: false,
    },
    summary: "completed",
    timedOut: false,
  };
  for (const [expectedError, rejectedReceipt] of [
    [
      "engine_mismatch",
      { ...receipt, engine: "codex_cli" },
    ],
    [
      "engine_version_mismatch",
      { ...receipt, engineVersion: "0.0.0" },
    ],
    [
      "cancellation_not_requested",
      {
        ...receipt,
        cancelRequested: true,
        exitCode: null,
        reason: "cancel_requested",
        status: "canceled",
        summary: "cancel_requested",
      },
    ],
  ]) {
    const rejectedBody = JSON.stringify({
      fence: claim.fence,
      leaseId: claim.leaseId,
      operationId: `op_${randomBytes(16).toString("hex")}`,
      receipt: rejectedReceipt,
    });
    const rejectedPath =
      `/api/runs/${created.runId}/engine-complete`;
    const rejected = await fetch(
      `${baseUrl}${rejectedPath}`,
      await signedRunnerRequest({
        path: rejectedPath,
        domain: "nexus-runner-engine-complete-v1",
        runner,
        body: rejectedBody,
      }),
    );
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), { error: expectedError });
  }
  const [rejectedState] = await queryLocalD1(
    `SELECT
       run.status,
       (SELECT COUNT(*) FROM run_engine_excerpts excerpt
        WHERE excerpt.run_id = run.id) AS excerpts,
       (SELECT COUNT(*) FROM run_engine_receipts receipt
        WHERE receipt.run_id = run.id) AS receipts
     FROM runs run
     WHERE run.id = '${created.runId}'`,
  );
  assert.deepEqual(rejectedState, {
    status: "leased",
    excerpts: 0,
    receipts: 0,
  });
  const body = JSON.stringify({
    fence: claim.fence,
    leaseId: claim.leaseId,
    operationId,
    receipt,
  });
  const completionPath =
    `/api/runs/${created.runId}/engine-complete`;
  const completionInit = await signedRunnerRequest({
    path: completionPath,
    domain: "nexus-runner-engine-complete-v1",
    runner,
    body,
  });
  const [completion, ...snapshotReads] = await Promise.all([
    fetch(`${baseUrl}${completionPath}`, completionInit),
    ...Array.from({ length: 8 }, () =>
      authenticatedRequest(`/api/runs/engine/${created.runId}`),
    ),
  ]);
  for (const snapshotResponse of snapshotReads) {
    assert.equal(snapshotResponse.status, 200);
    const snapshotText = await snapshotResponse.text();
    assertEngineReadHasNoProtectedMaterial(snapshotText, [
      prompt,
      output.toString(),
      testPromptCipherKey,
      "integration-key-v1",
    ]);
    const snapshot = JSON.parse(snapshotText);
    assert.equal(snapshot.eventsTruncated, false);
    assert.equal(
      snapshot.events.every(
        (event, index) => event.sequence === index + 1,
      ),
      true,
    );
    if (snapshot.run.status === "leased") {
      assert.equal(snapshot.run.currentLease.status, "active");
      assert.equal(snapshot.events.at(-1).kind, "lease.claimed");
      assert.equal("receipt" in snapshot, false);
    } else {
      assert.equal(snapshot.run.status, "completed");
      assert.equal(snapshot.run.currentLease.status, "released");
      assert.equal(snapshot.events.at(-1).kind, "run.completed");
      assert.equal(snapshot.receipt.operationId, operationId);
      assert.equal(
        snapshot.receipt.excerptStorageState,
        "stored_encrypted",
      );
      assert.equal("erasedAt" in snapshot.receipt, false);
    }
  }
  const completionText = await completion.text();
  assert.equal(completion.status, 200, `${completionText}\n${serverOutput}`);
  const completionBody = JSON.parse(completionText);
  assert.deepEqual(completionBody, {
    late: false,
    recordedAt: completionBody.recordedAt,
    runId: created.runId,
    status: "completed",
  });
  assert.equal(completionText, JSON.stringify(completionBody));
  assert.equal(completionText.includes(output.toString()), false);

  const nonceReplay = await fetch(
    `${baseUrl}${completionPath}`,
    completionInit,
  );
  assert.equal(nonceReplay.status, 200);
  assert.equal(nonceReplay.headers.get("x-nexus-replay"), "1");
  assert.equal(await nonceReplay.text(), completionText);

  const operationReplay = await fetch(
    `${baseUrl}${completionPath}`,
    await signedRunnerRequest({
      path: completionPath,
      domain: "nexus-runner-engine-complete-v1",
      runner,
      body,
    }),
  );
  assert.equal(operationReplay.status, 200);
  assert.equal(operationReplay.headers.get("x-nexus-replay"), "1");
  assert.equal(await operationReplay.text(), completionText);

  const conflict = await fetch(
    `${baseUrl}${completionPath}`,
    await signedRunnerRequest({
      path: completionPath,
      domain: "nexus-runner-engine-complete-v1",
      runner,
      body: JSON.stringify({
        fence: claim.fence,
        leaseId: claim.leaseId,
        operationId,
        receipt: {
          ...receipt,
          finishedAt: new Date(Date.parse(observedAt) + 1).toISOString(),
        },
      }),
    }),
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    error: "operation_conflict",
  });

  const [stored] = await queryLocalD1(
    `SELECT
       run.status, run.version, run.outcome_status, run.outcome_summary,
       run.completed_operation_id, run.recorded_at,
       lease.status AS lease_status, lease.ended_reason, lease.ended_at,
       receipt.excerpt_ref, receipt.excerpt_sha256,
       receipt.receipt_sha256, receipt.timed_out,
       receipt.cancel_requested, receipt.stdout_excerpt_bytes,
       receipt.stderr_excerpt_bytes, excerpt.ciphertext,
       hex(excerpt.ciphertext) AS ciphertext_hex,
       completed.metadata_json,
       operation.response_body, operation.replay_count,
       ledger.payload_hash,
       (SELECT COUNT(*) FROM run_engine_excerpts item
        WHERE item.run_id = run.id) AS excerpt_rows,
       (SELECT COUNT(*) FROM run_engine_receipts item
        WHERE item.run_id = run.id) AS receipt_rows,
       (SELECT COUNT(*) FROM run_events event
        WHERE event.run_id = run.id) AS event_rows,
       (SELECT COUNT(*) FROM ledger_entries item
        WHERE item.run_id = run.id) AS ledger_rows,
       (SELECT COUNT(*) FROM runner_lease_nonces nonce
        WHERE nonce.runner_id = '${runner.runnerId}'
          AND nonce.response_body = operation.response_body)
         AS completion_nonce_rows
     FROM runs run
     INNER JOIN run_leases lease ON lease.id = run.current_lease_id
     INNER JOIN run_engine_receipts receipt ON receipt.run_id = run.id
     INNER JOIN run_engine_excerpts excerpt ON excerpt.run_id = run.id
     INNER JOIN run_events completed
       ON completed.run_id = run.id AND completed.kind = 'run.completed'
     INNER JOIN runner_operations operation
       ON operation.run_id = run.id
      AND operation.operation_id = run.completed_operation_id
     INNER JOIN ledger_entries ledger
       ON ledger.run_id = run.id AND ledger.kind = 'run.completed'
     WHERE run.id = '${created.runId}'`,
  );
  const framed = Buffer.concat([
    Buffer.from([output.byteLength >>> 8, output.byteLength & 0xff]),
    output,
  ]);
  const excerptSha256 = createHash("sha256")
    .update(framed)
    .digest("hex");
  const receiptSha256 = canonicalSha256({
    cancelRequested: false,
    engine: receipt.engine,
    engineVersion: receipt.engineVersion,
    excerptRef: stored.excerpt_ref,
    excerptSha256,
    exitCode: 0,
    fence: claim.fence,
    finishedAt: observedAt,
    leaseId: claim.leaseId,
    operationId,
    organizationId,
    reason: "none",
    recordedAt: completionBody.recordedAt,
    runId: created.runId,
    startedAt: observedAt,
    status: "succeeded",
    stderrBytes: 0,
    stderrExcerptBytes: 0,
    stderrSha256: emptySha256,
    stderrTruncated: false,
    stdoutBytes: output.byteLength,
    stdoutExcerptBytes: output.byteLength,
    stdoutSha256: receipt.stdout.sha256,
    stdoutTruncated: false,
    timedOut: false,
  });
  assert.deepEqual(
    {
      status: stored.status,
      outcomeStatus: stored.outcome_status,
      outcomeSummary: stored.outcome_summary,
      operationId: stored.completed_operation_id,
      recordedAt: stored.recorded_at,
      leaseStatus: stored.lease_status,
      endedReason: stored.ended_reason,
      endedAt: stored.ended_at,
      excerptSha256: stored.excerpt_sha256,
      receiptSha256: stored.receipt_sha256,
      timedOut: stored.timed_out,
      cancelRequested: stored.cancel_requested,
      stdoutExcerptBytes: stored.stdout_excerpt_bytes,
      stderrExcerptBytes: stored.stderr_excerpt_bytes,
      excerptRows: stored.excerpt_rows,
      receiptRows: stored.receipt_rows,
      eventRows: stored.event_rows,
      ledgerRows: stored.ledger_rows,
      completionNonceRows: stored.completion_nonce_rows,
      replayCount: stored.replay_count,
      responseBody: stored.response_body,
    },
    {
      status: "completed",
      outcomeStatus: "succeeded",
      outcomeSummary: "completed",
      operationId,
      recordedAt: completionBody.recordedAt,
      leaseStatus: "released",
      endedReason: "engine_complete",
      endedAt: completionBody.recordedAt,
      excerptSha256,
      receiptSha256,
      timedOut: 0,
      cancelRequested: 0,
      stdoutExcerptBytes: output.byteLength,
      stderrExcerptBytes: 0,
      excerptRows: 1,
      receiptRows: 1,
      eventRows: 4,
      ledgerRows: 2,
      completionNonceRows: 2,
      replayCount: 1,
      responseBody: completionText,
    },
  );
  assert.notEqual(
    stored.ciphertext_hex.toLowerCase(),
    framed.toString("hex"),
    "encrypted excerpt must not equal plaintext",
  );
  assert.deepEqual(JSON.parse(stored.metadata_json), {
    engine: receipt.engine,
    engineVersion: receipt.engineVersion,
    operationId,
    outcomeStatus: "succeeded",
    reason: "none",
    receiptSha256,
    stderrBytes: 0,
    stdoutBytes: output.byteLength,
  });
  assert.equal(
    stored.payload_hash,
    canonicalSha256({
      engine: receipt.engine,
      engineVersion: receipt.engineVersion,
      fence: claim.fence,
      operationId,
      outcomeStatus: "succeeded",
      reason: "none",
      receiptSha256,
      runId: created.runId,
      stderrBytes: 0,
      stdoutBytes: output.byteLength,
    }),
  );
  assert.equal(stored.response_body.includes(output.toString()), false);
  assert.equal(serverOutput.includes(output.toString()), false);
  assert.equal(serverOutput.includes(prompt), false);

  const completedReadResponse = await authenticatedRequest(
    `/api/runs/engine/${created.runId}`,
  );
  assert.equal(completedReadResponse.status, 200);
  const completedReadText = await completedReadResponse.text();
  assertEngineReadHasNoProtectedMaterial(completedReadText, [
    prompt,
    output.toString(),
    stored.excerpt_ref,
    testPromptCipherKey,
    "integration-key-v1",
  ]);
  const completedRead = JSON.parse(completedReadText);
  assert.deepEqual(Object.keys(completedRead), [
    "run",
    "events",
    "eventsTruncated",
    "receipt",
  ]);
  assert.deepEqual(Object.keys(completedRead.run), [
    "id",
    "organizationId",
    "requestedBy",
    "kind",
    "engine",
    "assignedRunnerId",
    "status",
    "overdue",
    "deadlineState",
    "version",
    "leaseGeneration",
    "claimCount",
    "maxClaims",
    "deadlineAt",
    "outcomeStatus",
    "outcomeSummary",
    "completedOperationId",
    "recordedAt",
    "currentLease",
    "createdAt",
    "updatedAt",
  ]);
  assert.equal(completedRead.run.status, "completed");
  assert.equal(completedRead.run.overdue, false);
  assert.equal(completedRead.run.deadlineState, "settled");
  assert.equal(completedRead.run.currentLease.status, "released");
  assert.equal(
    completedRead.run.currentLease.endedReason,
    "engine_complete",
  );
  assert.equal(completedRead.eventsTruncated, false);
  assert.equal(completedRead.events.at(-1).kind, "run.completed");
  assert.deepEqual(Object.keys(completedRead.receipt), [
    "operationId",
    "leaseId",
    "fence",
    "engine",
    "engineVersion",
    "status",
    "reason",
    "exitCode",
    "timedOut",
    "cancelRequested",
    "startedAt",
    "finishedAt",
    "stdout",
    "stderr",
    "receiptSha256",
    "recordedAt",
    "excerptStorageState",
  ]);
  assert.equal(completedRead.receipt.operationId, operationId);
  assert.equal(completedRead.receipt.receiptSha256, receiptSha256);
  assert.equal(completedRead.receipt.status, "succeeded");
  assert.equal(completedRead.receipt.reason, "none");
  assert.equal(completedRead.receipt.stdout.bytes, output.byteLength);
  assert.equal(completedRead.receipt.stdout.sha256, receipt.stdout.sha256);
  assert.equal(
    completedRead.receipt.stdout.excerptBytes,
    output.byteLength,
  );
  assert.equal(completedRead.receipt.stderr.bytes, 0);
  assert.equal(
    completedRead.receipt.excerptStorageState,
    "stored_encrypted",
  );
  assert.equal("erasedAt" in completedRead.receipt, false);

  const erasedAt = new Date(
    Date.parse(completionBody.recordedAt) + 30 * 24 * 60 * 60_000,
  ).toISOString();
  await runLocalD1(
    `UPDATE run_engine_excerpts
     SET key_id = NULL, iv = NULL, ciphertext = NULL, tag = NULL,
         erased_at = '${erasedAt}'
     WHERE run_id = '${created.runId}'`,
  );
  const erasedReadResponse = await authenticatedRequest(
    `/api/runs/engine/${created.runId}`,
  );
  assert.equal(erasedReadResponse.status, 200);
  const erasedReadText = await erasedReadResponse.text();
  assertEngineReadHasNoProtectedMaterial(erasedReadText, [
    prompt,
    output.toString(),
    stored.excerpt_ref,
    testPromptCipherKey,
    "integration-key-v1",
  ]);
  const erasedRead = JSON.parse(erasedReadText);
  assert.equal(erasedRead.receipt.excerptStorageState, "erased");
  assert.equal(erasedRead.receipt.erasedAt, erasedAt);
}

async function exerciseRevokedPromptRead() {
  const runner = await enrollRunner("Revoked prompt-read runner");
  await submitEngineReport(runner, { claudeReady: true });
  const prompt = `REVOKED-PROMPT-SENTINEL-${randomBytes(8).toString("hex")}`;
  const creationId = `ecr_${randomBytes(16).toString("hex")}`;
  const creationBody = JSON.stringify({
    assignedRunnerId: runner.runnerId,
    engine: "claude_code_cli",
    prompt,
  });
  const created = await authenticatedRequest("/api/runs/engine", {
    method: "POST",
    headers: { "idempotency-key": creationId },
    body: creationBody,
  });
  assert.equal(created.status, 201);
  const detail = await created.json();
  const claimPath = `/api/runs/${detail.runId}/engine-lease/claim`;
  const claim = await fetch(
    `${baseUrl}${claimPath}`,
    await signedRunnerRequest({
      path: claimPath,
      domain: "nexus-runner-engine-lease-claim-v1",
      runner,
      body: JSON.stringify({
        engine: "claude_code_cli",
        operationId: `op_${randomBytes(16).toString("hex")}`,
      }),
    }),
  );
  assert.equal(claim.status, 200);
  const lease = await claim.json();
  const revoke = await authenticatedRequest(
    `/api/runners/${runner.runnerId}/revoke`,
    { method: "POST", body: "{}" },
  );
  assert.equal(revoke.status, 200);

  const revokedReplay = await authenticatedRequest("/api/runs/engine", {
    method: "POST",
    headers: { "idempotency-key": creationId },
    body: creationBody,
  });
  assert.equal(revokedReplay.status, 200);
  assert.deepEqual(await revokedReplay.json(), detail);

  const promptPath = `/api/runs/${detail.runId}/prompt`;
  const sentinel = JSON.stringify({ promptRef: lease.job.promptRef });
  const denied = await fetch(
    `${baseUrl}${promptPath}`,
    await signedRunnerRequest({
      path: promptPath,
      domain: "nexus-runner-engine-prompt-read-v1",
      runner,
      body: JSON.stringify({
        fence: lease.fence,
        leaseId: lease.leaseId,
        promptRef: lease.job.promptRef,
      }),
    }),
  );
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "runner_rejected" });
  const [state] = await queryLocalD1(
    `SELECT
       (SELECT COUNT(*) FROM runner_lease_nonces nonce
        WHERE nonce.runner_id = '${runner.runnerId}'
          AND nonce.response_body = '${sentinel}') AS prompt_nonces,
       (SELECT COUNT(*) FROM run_events event
        WHERE event.run_id = '${detail.runId}'
          AND event.kind = 'lease.revoked') AS revocation_events`,
  );
  assert.deepEqual(state, {
    prompt_nonces: 0,
    revocation_events: 1,
  });
  assert.equal(serverOutput.includes(prompt), false);
}

async function exerciseDeadlineReconciliation() {
  const runner = await enrollRunner("Deadline reconciliation runner");
  await submitEngineReport(runner, { claudeReady: true });
  const queuedResponse = await authenticatedRequest("/api/runs/engine", {
    method: "POST",
    body: JSON.stringify({
      assignedRunnerId: runner.runnerId,
      engine: "claude_code_cli",
      prompt: "queued deadline reconciliation prompt",
    }),
  });
  assert.equal(queuedResponse.status, 201);
  const queued = await engineRunInternalFixture(
    await queuedResponse.json(),
  );
  const leasedResponse = await authenticatedRequest("/api/runs/engine", {
    method: "POST",
    body: JSON.stringify({
      assignedRunnerId: runner.runnerId,
      engine: "claude_code_cli",
      prompt: "leased deadline reconciliation prompt",
    }),
  });
  assert.equal(leasedResponse.status, 201);
  const leased = await engineRunInternalFixture(
    await leasedResponse.json(),
  );
  const claimPath = `/api/runs/${leased.run.id}/engine-lease/claim`;
  const claim = await fetch(
    `${baseUrl}${claimPath}`,
    await signedRunnerRequest({
      path: claimPath,
      domain: "nexus-runner-engine-lease-claim-v1",
      runner,
      body: JSON.stringify({
        engine: "claude_code_cli",
        operationId: `op_${randomBytes(16).toString("hex")}`,
      }),
    }),
  );
  assert.equal(claim.status, 200);
  const lease = await claim.json();
  const overdueRun = await seedDueEngineRun(runner.runnerId);
  const overdueHealth = await fetch(`${baseUrl}/api/system/health`);
  assert.equal(overdueHealth.status, 200);
  const overdueHealthBody = await overdueHealth.json();
  assert.deepEqual(overdueHealthBody.deadlineReconciliation, {
    overdue: true,
  });
  assert.deepEqual(overdueHealthBody.promptRetention, { overdue: false });
  const observedAt = new Date(
    Math.max(
      Date.parse(queued.run.deadlineAt),
      Date.parse(leased.run.deadlineAt),
    ),
  ).toISOString();

  const rejected = await fetch(
    `${baseUrl}/api/system/deadlines/reconcile`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), {
    error: "local_operator_rejected",
  });

  const concurrent = await Promise.all([
    localDeadlineReconcile(observedAt),
    localDeadlineReconcile(observedAt),
  ]);
  assert.deepEqual(
    concurrent.map((response) => response.status),
    [200, 200],
  );
  const results = await Promise.all(
    concurrent.map((response) => response.json()),
  );
  assert.equal(
    results.reduce((total, result) => total + result.expired, 0),
    3,
  );
  assert.equal(
    results.every((result) => result.failures.length === 0),
    true,
  );
  assert.equal(
    results.every((result) => result.limit === 100),
    true,
  );
  assert.equal(
    results.every((result) => result.truncated === false),
    true,
  );

  const retentionAt = new Date(
    Date.parse(observedAt) + 30 * 24 * 60 * 60_000,
  ).toISOString();
  const beforeRetention = await localRetentionReconcile(
    new Date(Date.parse(retentionAt) - 1).toISOString(),
  );
  assert.equal(beforeRetention.status, 200);
  assert.equal((await beforeRetention.json()).erased, 0);
  const overdueRetentionHealth = await fetch(
    `${baseUrl}/api/system/health`,
    {
      headers: {
        "x-nexus-test-now": new Date(
          Date.parse(retentionAt) + 10 * 60_000,
        ).toISOString(),
      },
    },
  );
  assert.equal(overdueRetentionHealth.status, 200);
  assert.deepEqual(
    (await overdueRetentionHealth.json()).promptRetention,
    { overdue: true },
  );
  const retentionResponses = await Promise.all([
    localRetentionReconcile(retentionAt),
    localRetentionReconcile(retentionAt),
  ]);
  assert.deepEqual(
    retentionResponses.map((response) => response.status),
    [200, 200],
  );
  const retentionResults = await Promise.all(
    retentionResponses.map((response) => response.json()),
  );
  assert.equal(
    retentionResults.reduce((total, result) => total + result.erased, 0),
    3,
  );
  assert.equal(
    retentionResults.every((result) => result.failures.length === 0),
    true,
  );
  assert.equal(
    retentionResults.every(
      (result) => result.limit === 100 && result.truncated === false,
    ),
    true,
  );

  const rows = await queryLocalD1(
    `SELECT
       run.id, run.status, run.version, run.current_lease_id,
       run.recorded_at, run.deadline_at,
       operation.operation_id, operation.actor_id,
       operation.lease_id, operation.fence, operation.reason,
       event.sequence AS event_sequence, event.metadata_json,
       ledger.sequence AS ledger_sequence,
       ledger.previous_hash, ledger.hash, ledger.payload_hash,
       lease.status AS lease_status,
       lease.ended_reason, lease.ended_at
     FROM runs run
     INNER JOIN run_deadline_operations operation
       ON operation.run_id = run.id
     INNER JOIN run_events event
       ON event.run_id = run.id AND event.kind = 'run.expired'
     INNER JOIN ledger_entries ledger
       ON ledger.run_id = run.id AND ledger.kind = 'run.expired'
     LEFT JOIN run_leases lease ON lease.id = operation.lease_id
     WHERE run.id IN ('${queued.run.id}', '${leased.run.id}')
     ORDER BY ledger.sequence`,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    new Set(rows.map((row) => row.id)),
    new Set([queued.run.id, leased.run.id]),
  );
  for (const row of rows) {
    const source = row.id === queued.run.id ? queued : leased;
    assert.equal(row.status, "expired");
    assert.equal(row.current_lease_id, null);
    assert.equal(row.recorded_at, observedAt);
    assert.equal(row.operation_id, `op_${row.id.slice(4)}`);
    assert.equal(row.reason, "engine_deadline_exhausted");
    assert.equal(
      row.metadata_json,
      JSON.stringify({
        deadlineAt: source.run.deadlineAt,
        operationId: row.operation_id,
        reason: "engine_deadline_exhausted",
      }),
    );
    assert.equal(
      row.payload_hash,
      canonicalSha256({
        deadlineAt: source.run.deadlineAt,
        operationId: row.operation_id,
        reason: "engine_deadline_exhausted",
        runId: row.id,
      }),
    );
  }
  const queuedRow = rows.find((row) => row.id === queued.run.id);
  assert.equal(queuedRow.version, 2);
  assert.equal(queuedRow.operation_id, `op_${queued.run.id.slice(4)}`);
  assert.equal(queuedRow.lease_id, null);
  assert.equal(queuedRow.fence, null);
  assert.equal(queuedRow.event_sequence, 2);
  assert.equal(queuedRow.lease_status, null);
  const leasedRow = rows.find((row) => row.id === leased.run.id);
  assert.equal(leasedRow.version, 4);
  assert.equal(leasedRow.operation_id, `op_${leased.run.id.slice(4)}`);
  assert.equal(leasedRow.lease_id, lease.leaseId);
  assert.equal(leasedRow.fence, lease.fence);
  assert.equal(leasedRow.event_sequence, 3);
  assert.equal(leasedRow.lease_status, "revoked");
  assert.equal(leasedRow.ended_reason, "deadline_exhausted");
  assert.equal(leasedRow.ended_at, observedAt);
  assert.equal(
    rows[1].ledger_sequence,
    rows[0].ledger_sequence + 1,
  );
  assert.equal(rows[1].previous_hash, rows[0].hash);
  for (const source of [queued, leased]) {
    const expiredReadResponse = await authenticatedRequest(
      `/api/runs/engine/${source.run.id}`,
    );
    assert.equal(expiredReadResponse.status, 200);
    const expiredReadText = await expiredReadResponse.text();
    assertEngineReadHasNoProtectedMaterial(expiredReadText, [
      source.run.promptRef,
      "integration-key-v1",
    ]);
    const expiredRead = JSON.parse(expiredReadText);
    assert.equal(expiredRead.run.status, "expired");
    assert.equal(expiredRead.run.overdue, false);
    assert.equal(expiredRead.run.deadlineState, "settled");
    assert.equal(expiredRead.run.currentLease, undefined);
    assert.equal(expiredRead.eventsTruncated, false);
    assert.equal(expiredRead.events.at(-1).kind, "run.expired");
    assert.equal("receipt" in expiredRead, false);
  }
  const erasedPrompts = await queryLocalD1(
    `SELECT
       run_id, prompt_ref, prompt_sha256, prompt_bytes, erased_at,
       key_id, iv, ciphertext, tag
     FROM run_prompts
     WHERE run_id IN (
       '${queued.run.id}', '${leased.run.id}', '${overdueRun.runId}'
     )
     ORDER BY run_id`,
  );
  assert.equal(erasedPrompts.length, 3);
  assert.deepEqual(
    new Set(erasedPrompts.map((row) => row.prompt_ref)),
    new Set([
      queued.run.promptRef,
      leased.run.promptRef,
      overdueRun.promptRef,
    ]),
  );
  for (const prompt of erasedPrompts) {
    assert.equal(prompt.erased_at, retentionAt);
    assert.equal(prompt.key_id, null);
    assert.equal(prompt.iv, null);
    assert.equal(prompt.ciphertext, null);
    assert.equal(prompt.tag, null);
    assert.match(prompt.prompt_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(prompt.prompt_bytes > 0, true);
  }

  const replay = await localDeadlineReconcile(observedAt);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    expired: 0,
    failures: [],
    limit: 100,
    mode: "scheduled",
    observedAt,
    scanned: 0,
    skipped: 0,
    truncated: false,
  });
  const localCli = await runCommandResult(
    process.execPath,
    [deadlineReconcileCli],
    { NEXUS_LOCAL_OPERATOR_URL: baseUrl },
  );
  assert.equal(localCli.code, 0, localCli.stderr);
  assert.equal(localCli.stderr, "");
  const localCliResult = JSON.parse(localCli.stdout);
  assert.deepEqual(
    {
      expired: localCliResult.expired,
      failures: localCliResult.failures,
      limit: localCliResult.limit,
      mode: localCliResult.mode,
      scanned: localCliResult.scanned,
      skipped: localCliResult.skipped,
      truncated: localCliResult.truncated,
    },
    {
      expired: 0,
      failures: [],
      limit: 100,
      mode: "scheduled",
      scanned: 0,
      skipped: 0,
      truncated: false,
    },
  );
  const retentionReplay = await localRetentionReconcile(retentionAt);
  assert.equal(retentionReplay.status, 200);
  assert.deepEqual(await retentionReplay.json(), {
    erased: 0,
    failures: [],
    limit: 100,
    mode: "scheduled",
    observedAt: retentionAt,
    scanned: 0,
    skipped: 0,
    truncated: false,
  });
  const retentionCli = await runCommandResult(
    process.execPath,
    [retentionReconcileCli],
    { NEXUS_LOCAL_OPERATOR_URL: baseUrl },
  );
  assert.equal(retentionCli.code, 0, retentionCli.stderr);
  assert.equal(retentionCli.stderr, "");
  const retentionCliResult = JSON.parse(retentionCli.stdout);
  assert.deepEqual(
    {
      erased: retentionCliResult.erased,
      failures: retentionCliResult.failures,
      limit: retentionCliResult.limit,
      mode: retentionCliResult.mode,
      scanned: retentionCliResult.scanned,
      skipped: retentionCliResult.skipped,
      truncated: retentionCliResult.truncated,
    },
    {
      erased: 0,
      failures: [],
      limit: 100,
      mode: "scheduled",
      scanned: 0,
      skipped: 0,
      truncated: false,
    },
  );
  const healthyAfterReconcile = await fetch(`${baseUrl}/api/system/health`);
  assert.equal(healthyAfterReconcile.status, 200);
  const healthyAfterReconcileBody = await healthyAfterReconcile.json();
  assert.deepEqual(healthyAfterReconcileBody.deadlineReconciliation, {
    overdue: false,
  });
  assert.deepEqual(healthyAfterReconcileBody.promptRetention, {
    overdue: false,
  });
  const healthyAfterRetention = await fetch(
    `${baseUrl}/api/system/health`,
    {
      headers: {
        "x-nexus-test-now": new Date(
          Date.parse(retentionAt) + 10 * 60_000,
        ).toISOString(),
      },
    },
  );
  assert.equal(healthyAfterRetention.status, 200);
  assert.deepEqual(
    (await healthyAfterRetention.json()).promptRetention,
    { overdue: false },
  );

  const postExpiryClaim = await fetch(
    `${baseUrl}${claimPath}`,
    await signedRunnerRequest({
      path: claimPath,
      domain: "nexus-runner-engine-lease-claim-v1",
      runner,
      body: JSON.stringify({
        engine: "claude_code_cli",
        operationId: `op_${randomBytes(16).toString("hex")}`,
      }),
    }),
  );
  assert.equal(postExpiryClaim.status, 409);
  assert.deepEqual(await postExpiryClaim.json(), {
    error: "run_unavailable",
  });
  const renewPath = `/api/runs/${leased.run.id}/lease/renew`;
  const postExpiryRenew = await fetch(
    `${baseUrl}${renewPath}`,
    await signedRunnerRequest({
      path: renewPath,
      domain: "nexus-runner-lease-renew-v1",
      runner,
      body: JSON.stringify({
        fence: lease.fence,
        leaseId: lease.leaseId,
      }),
    }),
  );
  assert.equal(postExpiryRenew.status, 409);
  const promptPath = `/api/runs/${leased.run.id}/prompt`;
  const postExpiryPrompt = await fetch(
    `${baseUrl}${promptPath}`,
    await signedRunnerRequest({
      path: promptPath,
      domain: "nexus-runner-engine-prompt-read-v1",
      runner,
      body: JSON.stringify({
        fence: lease.fence,
        leaseId: lease.leaseId,
        promptRef: leased.run.promptRef,
      }),
    }),
  );
  assert.equal(postExpiryPrompt.status, 409);
  assert.deepEqual(await postExpiryPrompt.json(), {
    error: "run_unavailable",
  });

  const [proofCounts] = await queryLocalD1(
    `SELECT
       (SELECT COUNT(*) FROM run_deadline_operations operation
        WHERE operation.run_id IN (
          '${queued.run.id}', '${leased.run.id}'
        )) AS operations,
       (SELECT COUNT(*) FROM run_events event
        WHERE event.run_id IN (
          '${queued.run.id}', '${leased.run.id}'
        ) AND event.kind = 'run.expired') AS events,
       (SELECT COUNT(*) FROM ledger_entries ledger
        WHERE ledger.run_id IN (
          '${queued.run.id}', '${leased.run.id}'
        ) AND ledger.kind = 'run.expired') AS ledger_entries`,
  );
  assert.deepEqual(proofCounts, {
    operations: 2,
    events: 2,
    ledger_entries: 2,
  });
  const [overdueProof] = await queryLocalD1(
    `SELECT
       run.status,
       (SELECT COUNT(*) FROM run_deadline_operations operation
        WHERE operation.run_id = run.id) AS operations,
       (SELECT COUNT(*) FROM run_events event
        WHERE event.run_id = run.id
          AND event.kind = 'run.expired') AS events,
       (SELECT COUNT(*) FROM ledger_entries ledger
        WHERE ledger.run_id = run.id
          AND ledger.kind = 'run.expired') AS ledger_entries
     FROM runs run
     WHERE run.id = '${overdueRun.runId}'`,
  );
  assert.deepEqual(overdueProof, {
    status: "expired",
    operations: 1,
    events: 1,
    ledger_entries: 1,
  });
  await exerciseRetentionFailurePath(runner.runnerId);
  await exerciseDeadlineBacklogPriority(runner.runnerId);
}

async function exerciseRetentionFailurePath(runnerId) {
  const candidate = await seedDueEngineRun(runnerId);
  const expiry = await localDeadlineReconcile(candidate.deadlineAt);
  assert.equal(expiry.status, 200);
  assert.equal((await expiry.json()).expired, 1);
  const retentionAt = new Date(
    Date.parse(candidate.deadlineAt) + 30 * 24 * 60 * 60_000,
  ).toISOString();
  await runLocalD1(
    `CREATE TRIGGER test_prompt_retention_failure
     BEFORE UPDATE ON run_prompts
     WHEN OLD.run_id = '${candidate.runId}'
     BEGIN
       SELECT RAISE(ABORT, 'forced_prompt_retention_failure');
     END;`,
  );
  const failed = await localRetentionReconcile(retentionAt);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), {
    erased: 0,
    failures: [
      {
        code: "prompt_retention_failed",
        runId: candidate.runId,
      },
    ],
    limit: 100,
    mode: "scheduled",
    observedAt: retentionAt,
    scanned: 1,
    skipped: 0,
    truncated: false,
  });
  await runLocalD1("DROP TRIGGER test_prompt_retention_failure;");
  const recovered = await localRetentionReconcile(retentionAt);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).erased, 1);
}

async function exerciseDeadlineBacklogPriority(runnerId) {
  const healthy = await seedDueEngineRun(runnerId);
  const poisonOrganizationId = "org-deadline-poison";
  const poisonOwnerId = "principal-deadline-poison-owner";
  const poisonRunnerPrincipalId = "principal-deadline-poison-runner";
  const poisonRunnerId = "runner-deadline-poison";
  const poisonCreatedAt = new Date(
    Date.parse(healthy.deadlineAt) - 80 * 60_000,
  ).toISOString();
  const poisonDeadlineAt = new Date(
    Date.parse(poisonCreatedAt) + 20 * 60_000,
  ).toISOString();
  await runLocalD1(
    `INSERT INTO organizations (id, slug, name)
     VALUES (
       '${poisonOrganizationId}', 'deadline-poison',
       'Deadline poison fixture'
     );
     INSERT INTO principals (
       id, organization_id, kind, display_name
     ) VALUES (
       '${poisonOwnerId}', '${poisonOrganizationId}', 'human',
       'Deadline poison owner'
     );
     INSERT INTO memberships (
       id, organization_id, principal_id, role
     ) VALUES (
       'membership-deadline-poison', '${poisonOrganizationId}',
       '${poisonOwnerId}', 'owner'
     );
     INSERT INTO principals (
       id, organization_id, kind, external_id, display_name
     ) VALUES (
       '${poisonRunnerPrincipalId}', '${poisonOrganizationId}', 'runner',
       '${poisonRunnerId}', 'Deadline poison runner'
     );
     INSERT INTO runner_enrollment_tokens (
       id, organization_id, token_hash, issued_by, display_name,
       issued_at, expires_at
     ) VALUES (
       'token-deadline-poison', '${poisonOrganizationId}',
       '${"d".repeat(64)}', '${poisonOwnerId}', 'Deadline poison runner',
       '${poisonCreatedAt}', '${healthy.deadlineAt}'
     );
     INSERT INTO runners (
       id, organization_id, principal_id, enrollment_token_id,
       display_name, public_key, enrolled_at
     ) VALUES (
       '${poisonRunnerId}', '${poisonOrganizationId}',
       '${poisonRunnerPrincipalId}', 'token-deadline-poison',
       'Deadline poison runner', '${"A".repeat(43)}',
       '${poisonCreatedAt}'
     );
     WITH RECURSIVE sequence(value) AS (
       VALUES(0)
       UNION ALL
       SELECT value + 1 FROM sequence WHERE value < 99
     )
     INSERT INTO runs (
       id, organization_id, requested_by, kind, status, version,
       lease_generation, claim_count, max_claims, deadline_at, engine,
       assigned_runner_id, required_capability, created_at, updated_at
     )
     SELECT
       'run_f' || printf('%031x', value),
       '${poisonOrganizationId}', '${poisonOwnerId}', 'engine_prompt',
       'queued', 1, 0, 0, 2, '${poisonDeadlineAt}', 'claude_code_cli',
       '${poisonRunnerId}', NULL, '${poisonCreatedAt}', '${poisonCreatedAt}'
     FROM sequence;
     INSERT INTO run_prompts (
       run_id, organization_id, prompt_ref, cipher_version, key_id,
       iv, ciphertext, tag, prompt_sha256, prompt_bytes, created_at
     )
     SELECT
       run.id, run.organization_id,
       replace(run.id, 'run_f', 'prm_e'), 1, 'integration-key-v1',
       X'010101010101010101010101', X'02',
       X'03030303030303030303030303030303',
       '${"e".repeat(64)}', 1, run.created_at
     FROM runs run
     WHERE run.organization_id = '${poisonOrganizationId}';
     DROP TRIGGER organization_system_principals_prevent_delete;
     DELETE FROM organization_system_principals
     WHERE organization_id = '${poisonOrganizationId}'
       AND purpose = 'deadline_reconciler';
     CREATE TRIGGER organization_system_principals_prevent_delete
     BEFORE DELETE ON organization_system_principals
     BEGIN
       SELECT RAISE(ABORT, 'organization_system_principal_is_immutable');
     END;`,
  );
  const reconciliation = await localDeadlineReconcile(healthy.deadlineAt);
  assert.equal(reconciliation.status, 503);
  const result = await reconciliation.json();
  assert.equal(result.expired, 1);
  assert.equal(result.failures.length, 99);
  assert.equal(
    result.failures.every(
      (failure) => failure.code === "deadline_actor_unavailable",
    ),
    true,
  );
  assert.equal(result.limit, 100);
  assert.equal(result.scanned, 100);
  assert.equal(result.truncated, true);
  const [priorityState] = await queryLocalD1(
    `SELECT
       (SELECT status FROM runs WHERE id = '${healthy.runId}')
         AS healthy_status,
       (SELECT COUNT(*) FROM runs
        WHERE organization_id = '${poisonOrganizationId}'
          AND status = 'queued') AS poisoned_queued`,
  );
  assert.deepEqual(priorityState, {
    healthy_status: "expired",
    poisoned_queued: 100,
  });
  await runLocalD1(
    `INSERT INTO organization_system_principals (
       organization_id, purpose, principal_id, created_at
     )
     SELECT
       principal.organization_id, 'deadline_reconciler',
       principal.id, principal.created_at
     FROM principals principal
     WHERE principal.organization_id = '${poisonOrganizationId}'
       AND principal.kind = 'automation'
       AND principal.external_id = 'system:deadline-reconciler:v1'
       AND principal.status = 'active';`,
  );
}

function localDeadlineReconcile(observedAt) {
  return fetch(`${baseUrl}/api/system/deadlines/reconcile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nexus-local-operator": "deadline-reconcile-v1",
      "x-nexus-test-now": observedAt,
    },
    body: "{}",
  });
}

function localRetentionReconcile(observedAt) {
  return fetch(`${baseUrl}/api/system/retention/reconcile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nexus-local-operator": "retention-reconcile-v1",
      "x-nexus-test-now": observedAt,
    },
    body: "{}",
  });
}

async function seedDueEngineRun(runnerId) {
  const runId = `run_${randomBytes(16).toString("hex")}`;
  const promptRef = `prm_${randomBytes(16).toString("hex")}`;
  const createdAt = new Date(Date.now() - 35 * 60_000).toISOString();
  const deadlineAt = new Date(Date.parse(createdAt) + 20 * 60_000)
    .toISOString();
  const promptSha256 = "c".repeat(64);
  await runLocalD1(
    `INSERT INTO runs (
       id, organization_id, requested_by, kind, status, version,
       lease_generation, claim_count, max_claims, deadline_at, engine,
       assigned_runner_id, required_capability, created_at, updated_at
     ) VALUES (
       '${runId}', '${organizationId}', '${ownerId}', 'engine_prompt',
       'queued', 1, 0, 0, 2, '${deadlineAt}', 'claude_code_cli',
       '${runnerId}', NULL, '${createdAt}', '${createdAt}'
     );
     INSERT INTO run_prompts (
       run_id, organization_id, prompt_ref, cipher_version, key_id,
       iv, ciphertext, tag, prompt_sha256, prompt_bytes, created_at
     ) VALUES (
       '${runId}', '${organizationId}', '${promptRef}', 1,
       'integration-key-v1',
       X'010101010101010101010101', X'02',
       X'03030303030303030303030303030303',
       '${promptSha256}', 1, '${createdAt}'
     );
     INSERT INTO run_events (
       organization_id, run_id, sequence, kind, actor_id,
       occurred_at, metadata_json
     ) VALUES (
       '${organizationId}', '${runId}', 1, 'run.created', '${ownerId}',
       '${createdAt}',
       '{"engine":"claude_code_cli","promptBytes":1,"promptSha256":"${promptSha256}"}'
     )`,
  );
  return { deadlineAt, promptRef, promptSha256, runId };
}

async function seedCanceledEngineRun(runnerId) {
  const seeded = await seedDueEngineRun(runnerId);
  const canceledAt = new Date().toISOString();
  await runLocalD1(
    `UPDATE runs
     SET status = 'canceled',
         cancel_requested_at = '${canceledAt}',
         cancel_requested_by = '${ownerId}',
         recorded_at = '${canceledAt}',
         version = version + 1,
         updated_at = '${canceledAt}'
     WHERE id = '${seeded.runId}';
     INSERT INTO run_events (
       organization_id, run_id, sequence, kind, actor_id,
       occurred_at, metadata_json
     ) VALUES (
       '${organizationId}', '${seeded.runId}', 2, 'run.canceled',
       '${ownerId}', '${canceledAt}', '{"requested":true}'
     )`,
  );
  return { ...seeded, canceledAt };
}

async function submitEngineReport(runner, input) {
  const reportId = `egr_${randomBytes(16).toString("hex")}`;
  const path = `/api/runners/${runner.runnerId}/engine-reports`;
  const body = JSON.stringify({
    collectedAt: new Date().toISOString(),
    engines: [
      input.claudeReady
        ? {
            engine: "claude_code_cli",
            readiness: "ready",
            reason: "none",
            status: "available",
            version: "2.1.219",
          }
        : {
            engine: "claude_code_cli",
            readiness: "attention_required",
            reason: "engine_not_configured",
            status: "unavailable",
          },
      {
        engine: "codex_cli",
        readiness: "attention_required",
        reason: "engine_not_configured",
        status: "unavailable",
      },
    ],
    reportId,
    schemaVersion: 1,
    truncated: false,
  });
  const response = await fetch(
    `${baseUrl}${path}`,
    await signedRunnerRequest({
      path,
      domain: "nexus-runner-engine-report-v1",
      runner,
      body,
    }),
  );
  assert.equal(response.status, 201);
  const acknowledgement = await response.json();
  assert.equal(acknowledgement.reportId, reportId);
  return acknowledgement;
}

async function assertFrozenUnassignedCreation(detail) {
  const [state] = await queryLocalD1(
    `SELECT run.deadline_at, event.metadata_json, ledger.payload_hash
     FROM runs run
     INNER JOIN run_events event
       ON event.run_id = run.id AND event.sequence = 1
     INNER JOIN ledger_entries ledger
       ON ledger.run_id = run.id AND ledger.kind = 'run.requested'
     WHERE run.id = '${detail.run.id}'`,
  );
  assert.equal(
    state.metadata_json,
    JSON.stringify({
      deadlineAt: detail.run.deadlineAt,
      kind: "diagnostic",
    }),
  );
  assert.equal(
    state.payload_hash,
    canonicalSha256({
      deadlineAt: detail.run.deadlineAt,
      kind: "diagnostic",
      maxClaims: 5,
      runId: detail.run.id,
    }),
  );
}

async function assertAssignedCreationLedger(detail) {
  const [state] = await queryLocalD1(
    `SELECT event.metadata_json, ledger.payload_hash
     FROM run_events event
     INNER JOIN ledger_entries ledger
       ON ledger.run_id = event.run_id AND ledger.kind = 'run.requested'
     WHERE event.run_id = '${detail.run.id}' AND event.sequence = 1`,
  );
  assert.equal(
    state.metadata_json,
    JSON.stringify({
      assignedRunnerId: detail.run.assignedRunnerId,
      deadlineAt: detail.run.deadlineAt,
      kind: "diagnostic",
      requiredCapability: detail.run.requiredCapability,
    }),
  );
  assert.equal(
    state.payload_hash,
    canonicalSha256({
      assignedRunnerId: detail.run.assignedRunnerId,
      deadlineAt: detail.run.deadlineAt,
      kind: "diagnostic",
      maxClaims: 5,
      requiredCapability: detail.run.requiredCapability,
      runId: detail.run.id,
    }),
  );
}

async function seedExpiredAssignedRun(runnerId) {
  const runId = `run_${randomBytes(16).toString("hex")}`;
  const createdAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const deadlineAt = new Date(Date.now() - 5 * 60_000).toISOString();
  await runLocalD1(
    `INSERT INTO runs (
       id, organization_id, requested_by, kind, status, version,
       lease_generation, claim_count, max_claims, deadline_at,
       assigned_runner_id, created_at, updated_at
     ) VALUES (
       '${runId}', '${organizationId}', '${ownerId}', 'diagnostic',
       'queued', 1, 0, 0, 5, '${deadlineAt}', '${runnerId}',
       '${createdAt}', '${createdAt}'
     );
     INSERT INTO run_events (
       organization_id, run_id, sequence, kind, actor_id,
       occurred_at, metadata_json
     ) VALUES (
       '${organizationId}', '${runId}', 1, 'run.created', '${ownerId}',
       '${createdAt}',
       '{"assignedRunnerId":"${runnerId}","deadlineAt":"${deadlineAt}","kind":"diagnostic"}'
     )`,
  );
  return runId;
}

async function runReadPurityState(runId) {
  const [state] = await queryLocalD1(
    `SELECT
       run.status, run.version, run.updated_at,
       (SELECT COUNT(*) FROM run_events event
        WHERE event.run_id = run.id) AS event_count,
       (SELECT COUNT(*) FROM ledger_entries ledger
        WHERE ledger.run_id = run.id) AS ledger_count
     FROM runs run
     WHERE run.id = '${runId}'`,
  );
  return state;
}

function canonicalSha256(value) {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

async function submitCapabilityReport(runner, status) {
  const reportId = `cap_${randomBytes(16).toString("hex")}`;
  const body = JSON.stringify({
    capabilities: [
      {
        capability: "bubblewrap",
        detection: status === "available" ? "binary_version" : "none",
        reasonCode: status === "available" ? "none" : "unknown",
        status,
      },
    ],
    collectedAt: new Date().toISOString(),
    platform: {
      arch: process.arch,
      nodeVersion: process.version,
      os: process.platform,
    },
    reportId,
    schemaVersion: 1,
    truncated: false,
  });
  const path =
    `/api/runners/${runner.runnerId}/capability-reports`;
  const response = await fetch(
    `${baseUrl}${path}`,
    await signedRunnerRequest({
      path,
      domain: "nexus-runner-capability-report-v1",
      runner,
      body,
    }),
  );
  assert.equal(response.status, 201);
  return response.json();
}

async function claimRun(runId, runner, operationId) {
  const path = `/api/runs/${runId}/lease/claim`;
  const response = await fetch(
    `${baseUrl}${path}`,
    await signedRunnerRequest({
      path,
      domain: "nexus-runner-lease-claim-v1",
      runner,
      body: JSON.stringify({ operationId }),
    }),
  );
  assert.equal(response.status, 200);
  return readLeaseClaim(response, runId);
}

async function readLeaseClaim(response, runId) {
  const bytes = await response.text();
  const claim = JSON.parse(bytes);
  assert.equal(
    bytes,
    JSON.stringify({
      cancelRequested: claim.cancelRequested,
      expiresAt: claim.expiresAt,
      fence: claim.fence,
      leaseId: claim.leaseId,
      runId,
    }),
  );
  return claim;
}

async function renewClaim(runId, runner, claim) {
  const path = `/api/runs/${runId}/lease/renew`;
  const response = await fetch(
    `${baseUrl}${path}`,
    await signedRunnerRequest({
      path,
      domain: "nexus-runner-lease-renew-v1",
      runner,
      body: JSON.stringify({
        fence: claim.fence,
        leaseId: claim.leaseId,
      }),
    }),
  );
  assert.equal(response.status, 200);
}

async function completeClaim(
  runId,
  runner,
  claim,
  operationId,
) {
  const path = `/api/runs/${runId}/complete`;
  const response = await fetch(
    `${baseUrl}${path}`,
    await signedRunnerRequest({
      path,
      domain: "nexus-runner-run-complete-v1",
      runner,
      body: JSON.stringify({
        fence: claim.fence,
        leaseId: claim.leaseId,
        operationId,
        outcome: {
          status: "succeeded",
          summary: "Claim-time admission integration completed.",
        },
      }),
    }),
  );
  assert.equal(response.status, 200);
}

async function claimMutationState(runId, runnerId) {
  const [state] = await queryLocalD1(
    `SELECT
       run.claim_count,
       (SELECT COUNT(*) FROM run_leases lease
        WHERE lease.run_id = run.id) AS lease_count,
       (SELECT COUNT(*) FROM runner_operations operation
        WHERE operation.run_id = run.id) AS operation_count,
       (SELECT COUNT(*) FROM runner_lease_nonces nonce
        WHERE nonce.runner_id = '${runnerId}') AS runner_nonce_count
     FROM runs run
     WHERE run.id = '${runId}'`,
  );
  return state;
}

async function admissionLeaseState(runId) {
  const [state] = await queryLocalD1(
    `SELECT
       lease.admission_basis, lease.admission_policy_source,
       lease.admission_policy_version, lease.admission_freshness_seconds,
       lease.admission_required_capability, lease.admission_report_id,
       lease.admission_report_received_at, event.metadata_json
     FROM runs run
     INNER JOIN run_leases lease ON lease.id = run.current_lease_id
     INNER JOIN run_events event
       ON event.run_id = run.id
      AND event.fence = lease.fence
      AND event.kind = 'lease.claimed'
     WHERE run.id = '${runId}'`,
  );
  assert.ok(state);
  return state;
}

function capabilityClaimMetadata(input) {
  return JSON.stringify({
    admissionBasis: "capability_declaration",
    admissionFreshnessSeconds: input.freshnessSeconds,
    admissionPolicySource: input.policySource,
    admissionPolicyVersion: input.policyVersion,
    admissionReportId: input.report.reportId,
    admissionReportReceivedAt: input.report.receivedAt,
    admissionRequiredCapability: "bubblewrap",
    assignedRunnerId: input.runnerId,
    leaseId: input.claim.leaseId,
    operationId: input.operationId,
  });
}

async function enrollRunner(displayName, issuerHeaders) {
  const issued = await (
    await authenticatedRequest("/api/runners/enrollment-tokens", {
      method: "POST",
      ...(issuerHeaders ? { headers: issuerHeaders } : {}),
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
  const headers = {
    "content-type": "application/json",
    ...identityHeaders(ownerId, organizationId),
    ...init.headers,
  };
  if (
    path === "/api/runs/engine" &&
    init.method === "POST" &&
    !("idempotency-key" in headers)
  ) {
    headers["idempotency-key"] =
      `ecr_${randomBytes(16).toString("hex")}`;
  }
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
}

function identityHeaders(principalId, tenantId) {
  return {
    "x-nexus-test-principal": principalId,
    "x-nexus-test-organization": tenantId,
  };
}

function assertEngineReadHasNoProtectedMaterial(text, secrets = []) {
  for (const field of [
    "promptRef",
    "excerptRef",
    "ciphertext",
    "iv",
    "tag",
    "keyId",
  ]) {
    assert.equal(
      text.includes(`"${field}"`),
      false,
      `engine read must not expose ${field}`,
    );
  }
  for (const secret of secrets) {
    assert.equal(
      text.includes(secret),
      false,
      "engine read must not expose protected material",
    );
  }
}

function captureServerOutput(chunk) {
  serverOutput += chunk.toString();
  if (serverOutput.length > 40_000) serverOutput = serverOutput.slice(-40_000);
}

async function waitPastLeaseExpiry(expiresAt) {
  const expiresAtMs = Date.parse(expiresAt);
  assert.ok(Number.isFinite(expiresAtMs), "lease expiry must be canonical");
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, expiresAtMs - Date.now() + 100)),
  );
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

async function engineCreationPersistenceCounts(runId, creationId) {
  const [counts] = await queryLocalD1(
    `SELECT
       (SELECT COUNT(*) FROM engine_run_creations
        WHERE organization_id = '${organizationId}'
          AND requested_by = '${ownerId}'
          AND creation_id = '${creationId}') AS resolutions,
       (SELECT COUNT(*) FROM runs
        WHERE id = '${runId}') AS runs,
       (SELECT COUNT(*) FROM run_prompts
        WHERE run_id = '${runId}') AS prompts,
       (SELECT COUNT(*) FROM run_events
        WHERE run_id = '${runId}') AS events,
       (SELECT COUNT(*) FROM ledger_entries
        WHERE run_id = '${runId}') AS ledger`,
  );
  return counts;
}

async function waitForEngineCreationResolution(creationId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await queryLocalD1(
      `SELECT state
       FROM engine_run_creations
       WHERE organization_id = '${organizationId}'
         AND requested_by = '${ownerId}'
         AND creation_id = '${creationId}'`,
    );
    if (row?.state === "created") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("engine creation resolution was not committed");
}

async function engineRunInternalFixture(resolution) {
  assert.equal(resolution.state, "created");
  const response = await authenticatedRequest(
    `/api/runs/engine/${resolution.runId}`,
  );
  assert.equal(response.status, 200);
  const detail = await response.json();
  const [prompt] = await queryLocalD1(
    `SELECT prompt_ref
     FROM run_prompts
     WHERE run_id = '${resolution.runId}'`,
  );
  return {
    ...detail,
    run: {
      ...detail.run,
      promptRef: prompt.prompt_ref,
    },
  };
}

async function globalEngineCreationCounts() {
  const [counts] = await queryLocalD1(
    `SELECT
       (SELECT COUNT(*) FROM engine_run_creations) AS resolutions,
       (SELECT COUNT(*) FROM runs
        WHERE kind = 'engine_prompt') AS runs,
       (SELECT COUNT(*) FROM run_prompts) AS prompts,
       (SELECT COUNT(*) FROM run_events event
        INNER JOIN runs run ON run.id = event.run_id
        WHERE run.kind = 'engine_prompt') AS events,
       (SELECT COUNT(*) FROM ledger_entries
        WHERE kind = 'run.requested') AS ledger`,
  );
  return counts;
}

async function exerciseEngineCreationReconcileRace(body, winner) {
  const creationId = `ecr_${randomBytes(16).toString("hex")}`;
  const reconcilePath =
    `/api/runs/engine/creations/${creationId}/reconcile`;
  const raceHeader = {
    "x-nexus-test-engine-creation-race-winner": winner,
  };
  const before = await globalEngineCreationCounts();
  const [createResponse, reconcileResponse] = await Promise.all([
    authenticatedRequest("/api/runs/engine", {
      method: "POST",
      headers: {
        ...raceHeader,
        "idempotency-key": creationId,
      },
      body,
    }),
    authenticatedRequest(reconcilePath, {
      method: "POST",
      headers: raceHeader,
      body: "{}",
    }),
  ]);
  assert.deepEqual(
    [createResponse.status, reconcileResponse.status],
    winner === "create" ? [201, 200] : [409, 200],
  );
  const [createResolution, reconcileResolution] = await Promise.all([
    createResponse.json(),
    reconcileResponse.json(),
  ]);
  assert.deepEqual(createResolution, reconcileResolution);
  assert.equal(createResolution.creationId, creationId);
  assert.equal(
    createResolution.state,
    winner === "create" ? "created" : "confirmed_not_created",
  );

  const after = await globalEngineCreationCounts();
  const expectedDelta = winner === "create" ? 1 : 0;
  assert.deepEqual(
    {
      resolutions: after.resolutions - before.resolutions,
      runs: after.runs - before.runs,
      prompts: after.prompts - before.prompts,
      events: after.events - before.events,
      ledger: after.ledger - before.ledger,
    },
    {
      resolutions: 1,
      runs: expectedDelta,
      prompts: expectedDelta,
      events: expectedDelta,
      ledger: expectedDelta,
    },
  );
  const [stored] = await queryLocalD1(
    `SELECT state, run_id, reconciliation_id
     FROM engine_run_creations
     WHERE organization_id = '${organizationId}'
       AND requested_by = '${ownerId}'
       AND creation_id = '${creationId}'`,
  );
  assert.equal(stored.state, createResolution.state);
  if (winner === "create") {
    assert.equal(stored.run_id, createResolution.runId);
    assert.equal(stored.reconciliation_id, null);
  } else {
    assert.equal(stored.run_id, null);
    assert.equal(
      stored.reconciliation_id,
      createResolution.notCreatedProofId,
    );
  }
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

async function runLeasePreflightApply() {
  assert.ok(testPersistPath, "local D1 persistence is required");
  const result = await runCommandResult(process.execPath, [
    leasePreflight,
    "--local",
    "--persist-to",
    testPersistPath,
    "--apply",
  ]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
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

function runCommandResult(command, args, extraEnv = {}) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
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
