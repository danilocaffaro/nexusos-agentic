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
const memberId = "principal-policy-member";
const adminId = "principal-policy-admin";
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
  assert.deepEqual(emptyRegistry.admissionPolicy, {
    version: 0,
    source: "default",
    capabilityFreshnessSeconds: 86400,
    allowedCapabilities: [
      "node_permission_model",
      "bubblewrap",
      "landlock",
      "seccomp",
      "user_namespace",
      "docker",
      "podman",
    ],
  });

  const unauthenticatedPolicy = await fetch(
    `${baseUrl}/api/runner-admission-policy`,
  );
  assert.equal(
    unauthenticatedPolicy.status,
    externalBaseUrl ? 401 : 200,
  );
  const policyRowsBeforeDefaultRead = testPersistPath
    ? await queryLocalD1(
        `SELECT
           (SELECT count(*) FROM runner_admission_policies) AS policies,
           (SELECT count(*) FROM runner_admission_policy_versions) AS versions,
           (SELECT count(*) FROM runner_admission_policy_capabilities) AS capabilities,
           (SELECT count(*) FROM ledger_entries
            WHERE kind = 'runner_policy.updated') AS ledger`,
      )
    : [];
  const defaultPolicyResponse = await authenticatedRequest(
    "/api/runner-admission-policy",
  );
  assert.equal(defaultPolicyResponse.status, 200);
  assert.deepEqual(await defaultPolicyResponse.json(), {
    policy: {
      version: 0,
      source: "default",
      capabilityFreshnessSeconds: 86400,
      allowedCapabilities: [
        "node_permission_model",
        "bubblewrap",
        "landlock",
        "seccomp",
        "user_namespace",
        "docker",
        "podman",
      ],
    },
    viewerCanEditPolicy: true,
  });
  if (testPersistPath) {
    assert.deepEqual(
      await queryLocalD1(
        `SELECT
           (SELECT count(*) FROM runner_admission_policies) AS policies,
           (SELECT count(*) FROM runner_admission_policy_versions) AS versions,
           (SELECT count(*) FROM runner_admission_policy_capabilities) AS capabilities,
           (SELECT count(*) FROM ledger_entries
            WHERE kind = 'runner_policy.updated') AS ledger`,
      ),
      policyRowsBeforeDefaultRead,
    );
    await runLocalD1(
      `INSERT INTO principals (
         id, organization_id, kind, display_name
       ) VALUES
         ('${memberId}', '${organizationId}', 'human', 'Policy member'),
         ('${adminId}', '${organizationId}', 'human', 'Policy admin');
       INSERT INTO memberships (
         id, organization_id, principal_id, role
       ) VALUES
         ('membership-policy-member', '${organizationId}', '${memberId}', 'member'),
         ('membership-policy-admin', '${organizationId}', '${adminId}', 'admin');`,
    );
    assert.deepEqual(
      await queryLocalD1(
        `SELECT json_extract(
           '{"leaseId":"lease_policy_smoke"}', '$.leaseId'
         ) AS lease_id`,
      ),
      [{ lease_id: "lease_policy_smoke" }],
    );
  }
  if (testPersistPath) {
    const memberPolicyRead = await authenticatedRequest(
      "/api/runner-admission-policy",
      { headers: identityHeaders(memberId, organizationId) },
    );
    assert.equal(memberPolicyRead.status, 200);
    assert.equal(
      (await memberPolicyRead.json()).viewerCanEditPolicy,
      false,
    );
    const adminPolicyRead = await authenticatedRequest(
      "/api/runner-admission-policy",
      { headers: identityHeaders(adminId, organizationId) },
    );
    assert.equal(adminPolicyRead.status, 200);
    assert.equal(
      (await adminPolicyRead.json()).viewerCanEditPolicy,
      true,
    );
    const memberPolicyWrite = await authenticatedRequest(
      "/api/runner-admission-policy",
      {
        method: "PUT",
        headers: identityHeaders(memberId, organizationId),
        body: JSON.stringify({
          expectedVersion: 0,
          capabilityFreshnessSeconds: 86400,
          allowedCapabilities: [],
        }),
      },
    );
    assert.equal(memberPolicyWrite.status, 403);
    assert.deepEqual(await memberPolicyWrite.json(), {
      error: "workspace_owner_required",
    });
  }
  const invalidPolicyWrite = await authenticatedRequest(
    "/api/runner-admission-policy",
    {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: 0,
        capabilityFreshnessSeconds: 3599,
        allowedCapabilities: [],
      }),
    },
  );
  assert.equal(invalidPolicyWrite.status, 400);
  assert.deepEqual(await invalidPolicyWrite.json(), {
    error: "invalid_admission_policy",
  });
  const nonObjectPolicyWrite = await authenticatedRequest(
    "/api/runner-admission-policy",
    {
      method: "PUT",
      body: "[]",
    },
  );
  assert.equal(nonObjectPolicyWrite.status, 400);
  assert.deepEqual(await nonObjectPolicyWrite.json(), {
    error: "invalid_admission_policy",
  });

  const createPolicyBody = JSON.stringify({
    expectedVersion: 0,
    capabilityFreshnessSeconds: 86400,
    allowedCapabilities: ["podman", "bubblewrap"],
  });
  const concurrentPolicyWrites = await Promise.all([
    authenticatedRequest("/api/runner-admission-policy", {
      method: "PUT",
      body: createPolicyBody,
    }),
    authenticatedRequest("/api/runner-admission-policy", {
      method: "PUT",
      body: createPolicyBody,
    }),
  ]);
  assert.deepEqual(
    concurrentPolicyWrites.map((response) => response.status).sort(),
    [200, 409],
  );
  const createdPolicyResponse = concurrentPolicyWrites.find(
    (response) => response.status === 200,
  );
  const conflictedPolicyResponse = concurrentPolicyWrites.find(
    (response) => response.status === 409,
  );
  assert.ok(createdPolicyResponse);
  assert.ok(conflictedPolicyResponse);
  const createdPolicy = await createdPolicyResponse.json();
  assert.deepEqual(createdPolicy.policy.allowedCapabilities, [
    "bubblewrap",
    "podman",
  ]);
  assert.equal(createdPolicy.policy.version, 1);
  assert.equal(createdPolicy.policy.source, "configured");
  assert.equal(createdPolicy.viewerCanEditPolicy, true);
  assert.equal(createdPolicy.policy.updatedBy, ownerId);
  assert.match(
    createdPolicy.policy.updatedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
  assert.deepEqual(await conflictedPolicyResponse.json(), {
    error: "policy_version_conflict",
  });

  let policySnapshotAfterCreate = [];
  if (testPersistPath) {
    policySnapshotAfterCreate = await queryLocalD1(
      `SELECT 'head' AS row_type, version, capability_freshness_seconds,
              updated_by AS value
       FROM runner_admission_policies
       WHERE organization_id = '${organizationId}'
       UNION ALL
       SELECT 'capability', version, 0, capability
       FROM runner_admission_policy_capabilities
       WHERE organization_id = '${organizationId}'
       UNION ALL
       SELECT 'ledger', sequence, 0, payload_hash
       FROM ledger_entries
       WHERE organization_id = '${organizationId}'
         AND kind = 'runner_policy.updated'
       ORDER BY row_type, version, value`,
    );
    assert.equal(
      policySnapshotAfterCreate.filter(
        (row) => row.row_type === "head",
      ).length,
      1,
    );
    assert.equal(
      policySnapshotAfterCreate.filter(
        (row) => row.row_type === "capability",
      ).length,
      2,
    );
    const policyLedger = policySnapshotAfterCreate.find(
      (row) => row.row_type === "ledger",
    );
    assert.ok(policyLedger);
    assert.equal(
      policyLedger.value,
      createHash("sha256")
        .update(
          JSON.stringify({
            allowedCapabilities: ["bubblewrap", "podman"],
            capabilityFreshnessSeconds: 86400,
            organizationId,
            version: 1,
          }),
        )
        .digest("hex"),
    );
  }

  const stalePolicyWrite = await authenticatedRequest(
    "/api/runner-admission-policy",
    {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: 0,
        capabilityFreshnessSeconds: 7200,
        allowedCapabilities: [],
      }),
    },
  );
  assert.equal(stalePolicyWrite.status, 409);
  if (testPersistPath) {
    assert.deepEqual(
      await queryLocalD1(
        `SELECT 'head' AS row_type, version, capability_freshness_seconds,
                updated_by AS value
         FROM runner_admission_policies
         WHERE organization_id = '${organizationId}'
         UNION ALL
         SELECT 'capability', version, 0, capability
         FROM runner_admission_policy_capabilities
         WHERE organization_id = '${organizationId}'
         UNION ALL
         SELECT 'ledger', sequence, 0, payload_hash
         FROM ledger_entries
         WHERE organization_id = '${organizationId}'
           AND kind = 'runner_policy.updated'
         ORDER BY row_type, version, value`,
      ),
      policySnapshotAfterCreate,
    );
  }

  const denyAllPolicyResponse = await authenticatedRequest(
    "/api/runner-admission-policy",
    {
      method: "PUT",
      ...(testPersistPath
        ? { headers: identityHeaders(adminId, organizationId) }
        : {}),
      body: JSON.stringify({
        expectedVersion: 1,
        capabilityFreshnessSeconds: 3600,
        allowedCapabilities: [],
      }),
    },
  );
  assert.equal(denyAllPolicyResponse.status, 200);
  const denyAllPolicy = await denyAllPolicyResponse.json();
  assert.equal(denyAllPolicy.policy.version, 2);
  assert.equal(denyAllPolicy.viewerCanEditPolicy, true);
  assert.equal(
    denyAllPolicy.policy.updatedBy,
    testPersistPath ? adminId : ownerId,
  );
  assert.deepEqual(denyAllPolicy.policy.allowedCapabilities, []);
  assert.ok(
    denyAllPolicy.policy.updatedAt > createdPolicy.policy.updatedAt,
  );
  const configuredPolicyRead = await authenticatedRequest(
    "/api/runner-admission-policy",
  );
  assert.equal(configuredPolicyRead.status, 200);
  assert.deepEqual(
    await configuredPolicyRead.json(),
    denyAllPolicy,
  );
  if (testPersistPath) {
    const sealedInsert = await runLocalD1Result(
      `INSERT INTO runner_admission_policy_capabilities (
         organization_id, version, capability
       ) VALUES ('${organizationId}', 2, 'docker')`,
    );
    assert.notEqual(sealedInsert.code, 0);
    assert.match(
      sealedInsert.stderr,
      /invalid_runner_admission_policy_capability/,
    );
    assert.deepEqual(
      await queryLocalD1(
        `SELECT version, capability_freshness_seconds
         FROM runner_admission_policy_versions
         WHERE organization_id = '${organizationId}'
         ORDER BY version`,
      ),
      [
        { version: 1, capability_freshness_seconds: 86400 },
        { version: 2, capability_freshness_seconds: 3600 },
      ],
    );
    assert.equal(
      (
        await queryLocalD1(
          `SELECT count(*) AS count
           FROM ledger_entries
           WHERE organization_id = '${organizationId}'
             AND kind = 'runner_policy.updated'`,
        )
      )[0].count,
      2,
    );
  }

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
  assert.equal(listedPending.capabilities.identity, "real");
  assert.equal(listedPending.capabilities.heartbeat, "real");
  assert.equal(listedPending.capabilities.execution, "roadmap");
  assert.equal(listedPending.capabilities.sandbox, "roadmap");
  assert.equal(listedPending.capabilities.leases, "real");
  assert.equal(listedPending.capabilities.durableReplay, "real");
  assert.equal(listedPending.capabilities.capabilityProfiles, "real");
  assert.equal(listedPending.capabilities.streaming, "roadmap");
  assert.equal(listedPending.runners[0].declaredCapabilities, null);
  assert.deepEqual(listedPending.admissionPolicy, denyAllPolicy.policy);
  assert.match(
    listedPending.runners[0].declarationAdmission.evaluatedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
  assert.equal(
    listedPending.runners[0].declarationAdmission.freshnessState,
    "absent",
  );
  assert.equal(
    listedPending.runners[0].declarationAdmission.reportId,
    null,
  );
  assert.equal(
    listedPending.runners[0].declarationAdmission.freshUntil,
    null,
  );
  assert.equal(
    listedPending.runners[0].declarationAdmission.capabilities.length,
    7,
  );
  assert.ok(
    listedPending.runners[0].declarationAdmission.capabilities.every(
      (capability) =>
        capability.allowed === false &&
        capability.declarationSatisfied === false &&
        capability.reason === "capability_disallowed",
    ),
  );
  assert.equal(
    Object.hasOwn(
      listedPending.runners[0].declarationAdmission,
      "eligible",
    ),
    false,
  );
  assert.match(
    listedPending.capabilityDisclosure,
    /operator-controlled host/u,
  );
  assert.equal(JSON.stringify(listedPending).includes(issued.token), false);
  assert.equal(JSON.stringify(listedPending).includes("tokenHash"), false);

  if (testPersistPath) {
    const emptyHistoryResponse = await authenticatedRequest(
      `/api/runners/${enrolled.runnerId}/capability-reports`,
    );
    assert.equal(emptyHistoryResponse.status, 200);
    assert.deepEqual((await emptyHistoryResponse.json()).reports, []);

    await runLocalD1(
      `WITH RECURSIVE sequence(value) AS (
         VALUES(1)
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 51
       )
       INSERT INTO runner_capability_reports (
         organization_id, runner_id, report_id, request_hash,
         declaration_hash, schema_version, platform_os, platform_arch,
         node_version, collected_at, received_at, truncated,
         response_status, response_body
       )
       SELECT
         '${organizationId}', '${enrolled.runnerId}',
         'cap_' || printf('%032x', value),
         printf('%064x', value),
         printf('%064x', value + 100),
         1, 'darwin', 'arm64', 'v22.14.0',
         '2026-07-25T12:00:00.000Z',
         CASE
           WHEN value = 1 THEN '2026-07-26T12:03:00.000Z'
           ELSE '2026-07-26T12:04:00.000Z'
         END,
         0, 201, '{"accepted":true}'
       FROM sequence;
       INSERT INTO runner_capability_evidence (
         runner_id, report_id, position, capability, status,
         detection, reason_code, version
       )
       SELECT
         runner_id, report_id, 0, 'node_permission_model', 'available',
         'node_flag', 'none', 'v22.14.0'
       FROM runner_capability_reports
       WHERE runner_id = '${enrolled.runnerId}';`,
    );
    const replaceAttempt = await runLocalD1Result(
      `INSERT OR REPLACE INTO runner_capability_evidence (
         runner_id, report_id, position, capability, status,
         detection, reason_code, version
       ) VALUES (
         '${enrolled.runnerId}', 'cap_${"1".padStart(32, "0")}', 0,
         'node_permission_model', 'unknown', 'none', 'unknown', NULL
       )`,
    );
    assert.notEqual(replaceAttempt.code, 0);
    assert.match(
      `${replaceAttempt.stdout}\n${replaceAttempt.stderr}`,
      /capability_evidence_already_exists/u,
    );

    const beforeCapabilityReads = await queryLocalD1(
      `SELECT
         (SELECT COUNT(*) FROM runner_capability_reports) AS reports,
         (SELECT COUNT(*) FROM runner_capability_evidence) AS evidence,
         (SELECT COUNT(*) FROM runner_capability_nonces) AS nonces,
         (SELECT COALESCE(SUM(replay_count), 0)
            FROM runner_capability_reports) AS replays,
         (SELECT COUNT(*) FROM runner_admission_policies) AS policies,
         (SELECT COUNT(*) FROM runner_admission_policy_versions) AS policy_versions,
         (SELECT COUNT(*) FROM runner_admission_policy_capabilities) AS policy_capabilities,
         (SELECT COUNT(*) FROM ledger_entries) AS ledger,
         (SELECT COUNT(*) FROM run_events) AS run_events`,
    );
    const historyResponse = await authenticatedRequest(
      `/api/runners/${enrolled.runnerId}/capability-reports`,
    );
    assert.equal(historyResponse.status, 200);
    const historyText = await historyResponse.text();
    const history = JSON.parse(historyText);
    assert.equal(history.runnerId, enrolled.runnerId);
    assert.equal(history.reports.length, 50);
    assert.ok(history.nextCursor);
    assert.equal(history.reports[0].trust, "hostReported");
    assert.equal(
      history.reports[0].reportId,
      `cap_${(51).toString(16).padStart(32, "0")}`,
    );
    assert.equal(history.reports[0].capabilities.length, 1);
    assert.equal(history.reports[0].capabilities[0].status, "available");
    for (const forbidden of [
      "requestHash",
      "request_hash",
      "declarationHash",
      "declaration_hash",
      "responseBody",
      "response_body",
      "responseStatus",
      "response_status",
    ]) {
      assert.equal(historyText.includes(forbidden), false);
    }
    const finalHistory = await (
      await authenticatedRequest(
        `/api/runners/${enrolled.runnerId}/capability-reports?cursor=${encodeURIComponent(history.nextCursor)}`,
      )
    ).json();
    assert.equal(finalHistory.reports.length, 1);
    assert.equal(finalHistory.nextCursor, null);
    assert.equal(
      finalHistory.reports[0].reportId,
      `cap_${"1".padStart(32, "0")}`,
    );
    assert.equal(
      (
        await authenticatedRequest(
          `/api/runners/${enrolled.runnerId}/capability-reports?cursor=invalid`,
        )
      ).status,
      400,
    );
    const unexpectedQuery = await authenticatedRequest(
      `/api/runners/${enrolled.runnerId}/capability-reports?unexpected=1`,
    );
    assert.equal(unexpectedQuery.status, 400);
    assert.equal(
      (await unexpectedQuery.json()).error,
      "unexpected_query_parameter",
    );
    assert.equal(
      (
        await authenticatedRequest(
          `/api/runners/${enrolled.runnerId}/capability-reports`,
          {
            headers: identityHeaders(
              otherOwnerId,
              otherOrganizationId,
            ),
          },
        )
      ).status,
      404,
    );
    const afterCapabilityReads = await queryLocalD1(
      `SELECT
         (SELECT COUNT(*) FROM runner_capability_reports) AS reports,
         (SELECT COUNT(*) FROM runner_capability_evidence) AS evidence,
         (SELECT COUNT(*) FROM runner_capability_nonces) AS nonces,
         (SELECT COALESCE(SUM(replay_count), 0)
            FROM runner_capability_reports) AS replays,
         (SELECT COUNT(*) FROM runner_admission_policies) AS policies,
         (SELECT COUNT(*) FROM runner_admission_policy_versions) AS policy_versions,
         (SELECT COUNT(*) FROM runner_admission_policy_capabilities) AS policy_capabilities,
         (SELECT COUNT(*) FROM ledger_entries) AS ledger,
         (SELECT COUNT(*) FROM run_events) AS run_events`,
    );
    assert.deepEqual(afterCapabilityReads, beforeCapabilityReads);

    const listedDeclared = await (
      await authenticatedRequest("/api/runners")
    ).json();
    assert.equal(
      listedDeclared.runners[0].declaredCapabilities.reportId,
      `cap_${(51).toString(16).padStart(32, "0")}`,
    );
    assert.equal(
      listedDeclared.runners[0].declaredCapabilities.trust,
      "hostReported",
    );
    assert.equal(
      listedDeclared.capabilities.capabilityProfiles,
      "real",
    );
    assert.equal(
      listedDeclared.runners[0].declarationAdmission.reportId,
      `cap_${(51).toString(16).padStart(32, "0")}`,
    );
    assert.equal(
      listedDeclared.runners[0].declarationAdmission.reportReceivedAt,
      "2026-07-26T12:04:00.000Z",
    );
    assert.equal(
      listedDeclared.runners[0].declarationAdmission.freshUntil,
      "2026-07-26T13:04:00.000Z",
    );
    assert.equal(
      listedDeclared.runners[0].declarationAdmission.capabilities.length,
      7,
    );
    assert.deepEqual(
      listedDeclared.runners[0].declarationAdmission.capabilities[0],
      {
        capability: "node_permission_model",
        allowed: false,
        declaredStatus: "available",
        declarationSatisfied: false,
        reason: "capability_disallowed",
      },
    );
    assert.equal(
      JSON.stringify(listedDeclared).includes('"eligible"'),
      false,
    );
    assert.deepEqual(
      await queryLocalD1(
        `SELECT
           (SELECT COUNT(*) FROM runner_capability_reports) AS reports,
           (SELECT COUNT(*) FROM runner_capability_evidence) AS evidence,
           (SELECT COUNT(*) FROM runner_capability_nonces) AS nonces,
           (SELECT COALESCE(SUM(replay_count), 0)
              FROM runner_capability_reports) AS replays,
           (SELECT COUNT(*) FROM runner_admission_policies) AS policies,
           (SELECT COUNT(*) FROM runner_admission_policy_versions) AS policy_versions,
           (SELECT COUNT(*) FROM runner_admission_policy_capabilities) AS policy_capabilities,
           (SELECT COUNT(*) FROM ledger_entries) AS ledger,
           (SELECT COUNT(*) FROM run_events) AS run_events`,
      ),
      beforeCapabilityReads,
    );
  }

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
  const otherTenantRegistry = await otherTenantList.json();
  assert.deepEqual(otherTenantRegistry.runners, []);
  assert.equal(otherTenantRegistry.admissionPolicy.source, "default");
  assert.equal(otherTenantRegistry.admissionPolicy.version, 0);

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

  const capabilityRunnerId = raceList.runners[0].id;
  const capabilityPrivateKey =
    racePairs[raceWinnerIndex].privateKey;
  const capabilityPath =
    `/api/runners/${capabilityRunnerId}/capability-reports`;
  const oldReportId = `cap_${(1000).toString(16).padStart(32, "0")}`;
  const oldReportBody = capabilityReportBody({
    reportId: oldReportId,
    collectedAt: "2026-06-01T00:00:00.000Z",
  });
  const oldOperationHash = createHash("sha256")
    .update(
      [
        "nexus.runner.operation.v1",
        "nexus-runner-capability-report-v1",
        capabilityRunnerId,
        capabilityPath,
        createHash("sha256").update(oldReportBody).digest("hex"),
      ].join("\n"),
    )
    .digest("hex");
  if (testPersistPath) {
    await runLocalD1(
      `WITH RECURSIVE sequence(value) AS (
         VALUES(1000)
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 1100
       )
       INSERT INTO runner_capability_reports (
         organization_id, runner_id, report_id, request_hash,
         declaration_hash, schema_version, platform_os, platform_arch,
         node_version, collected_at, received_at, truncated,
         response_status, response_body
       )
       SELECT
         '${otherOrganizationId}', '${capabilityRunnerId}',
         'cap_' || printf('%032x', value),
         CASE
           WHEN value = 1000 THEN '${oldOperationHash}'
           ELSE printf('%064x', value + 5000)
         END,
         printf('%064x', value + 7000),
         1, 'darwin', 'arm64', 'v22.14.0',
         '2026-06-01T00:00:00.000Z',
         strftime(
           '%Y-%m-%dT%H:%M:%fZ',
           '2026-06-01T00:00:00.000Z',
           '+' || (value - 1000) || ' seconds'
         ),
         0, 201, '{}'
       FROM sequence;
       INSERT INTO runner_capability_evidence (
         runner_id, report_id, position, capability, status,
         detection, reason_code, version
       ) VALUES (
         '${capabilityRunnerId}', '${oldReportId}', 0,
         'node_permission_model', 'unknown', 'none',
         'probe_disabled', NULL
       );
       WITH RECURSIVE sequence(value) AS (
         VALUES(1)
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 101
       )
       INSERT INTO runner_capability_nonces (
         organization_id, runner_id, nonce, request_hash,
         response_status, response_body, occurred_at, expires_at
       )
       SELECT
         '${otherOrganizationId}', '${capabilityRunnerId}',
         printf('%021dA', value), printf('%064x', value + 9000),
         201, '{}', '2026-06-01T00:00:00.000Z',
         '2026-06-01T00:15:00.000Z'
       FROM sequence;`,
    );
  }

  const freshReportId = `cap_${"f".repeat(32)}`;
  const freshReportBody = capabilityReportBody({
    reportId: freshReportId,
    collectedAt: new Date().toISOString(),
  });
  const freshReportNonce = base64url(randomBytes(16));
  const freshReportRequest = await signedRequest({
    path: capabilityPath,
    domain: "nexus-runner-capability-report-v1",
    keyId: capabilityRunnerId,
    body: freshReportBody,
    nonce: freshReportNonce,
    privateKey: capabilityPrivateKey,
  });
  const freshReportResponse = await fetch(
    `${baseUrl}${capabilityPath}`,
    freshReportRequest,
  );
  assert.equal(freshReportResponse.status, 201);
  assert.equal(freshReportResponse.headers.get("x-nexus-replay"), null);
  const freshReportBytes = await freshReportResponse.text();
  assert.equal(JSON.parse(freshReportBytes).reportId, freshReportId);

  if (testPersistPath) {
    const maintenance = await queryLocalD1(
      `SELECT
         (SELECT COUNT(*) FROM runner_capability_reports
          WHERE organization_id = '${otherOrganizationId}'
            AND runner_id = '${capabilityRunnerId}'
            AND compacted_at IS NOT NULL) AS compacted,
         (SELECT COUNT(*) FROM runner_capability_nonces
          WHERE organization_id = '${otherOrganizationId}'
            AND runner_id = '${capabilityRunnerId}'
            AND expires_at <= '2026-06-01T00:15:00.000Z') AS expired`,
    );
    assert.deepEqual(maintenance, [{ compacted: 100, expired: 1 }]);
  }

  const exactReportReplay = await fetch(
    `${baseUrl}${capabilityPath}`,
    freshReportRequest,
  );
  assert.equal(exactReportReplay.status, 201);
  assert.equal(exactReportReplay.headers.get("x-nexus-replay"), "1");
  assert.equal(await exactReportReplay.text(), freshReportBytes);

  const changedNonceReport = await signedRequest({
    path: capabilityPath,
    domain: "nexus-runner-capability-report-v1",
    keyId: capabilityRunnerId,
    body: capabilityReportBody({
      reportId: freshReportId,
      collectedAt: JSON.parse(freshReportBody).collectedAt,
      status: "unavailable",
      reasonCode: "not_found",
    }),
    nonce: freshReportNonce,
    privateKey: capabilityPrivateKey,
  });
  const changedNonceResponse = await fetch(
    `${baseUrl}${capabilityPath}`,
    changedNonceReport,
  );
  assert.equal(changedNonceResponse.status, 409);
  assert.deepEqual(await changedNonceResponse.json(), {
    error: "nonce_reused",
  });

  if (testPersistPath) {
    await runLocalD1(
      `DELETE FROM runner_capability_nonces
       WHERE runner_id = '${capabilityRunnerId}'
         AND nonce = '${freshReportNonce}'`,
    );
  }
  const semanticReportReplay = await fetch(
    `${baseUrl}${capabilityPath}`,
    await signedRequest({
      path: capabilityPath,
      domain: "nexus-runner-capability-report-v1",
      keyId: capabilityRunnerId,
      body: freshReportBody,
      privateKey: capabilityPrivateKey,
    }),
  );
  assert.equal(semanticReportReplay.status, 201);
  assert.equal(semanticReportReplay.headers.get("x-nexus-replay"), "1");
  assert.equal(await semanticReportReplay.text(), freshReportBytes);

  const reportConflict = await fetch(
    `${baseUrl}${capabilityPath}`,
    await signedRequest({
      path: capabilityPath,
      domain: "nexus-runner-capability-report-v1",
      keyId: capabilityRunnerId,
      body: capabilityReportBody({
        reportId: freshReportId,
        collectedAt: JSON.parse(freshReportBody).collectedAt,
        status: "unavailable",
        reasonCode: "not_found",
      }),
      privateKey: capabilityPrivateKey,
    }),
  );
  assert.equal(reportConflict.status, 409);
  assert.deepEqual(await reportConflict.json(), {
    error: "report_conflict",
  });

  const duplicateReportId = `cap_${"e".repeat(32)}`;
  const duplicateReportBody = capabilityReportBody({
    reportId: duplicateReportId,
    collectedAt: new Date().toISOString(),
  });
  const duplicateRequests = await Promise.all(
    [0, 1].map(() =>
      signedRequest({
        path: capabilityPath,
        domain: "nexus-runner-capability-report-v1",
        keyId: capabilityRunnerId,
        body: duplicateReportBody,
        privateKey: capabilityPrivateKey,
      }),
    ),
  );
  const duplicateResponses = await Promise.all(
    duplicateRequests.map((request) =>
      fetch(`${baseUrl}${capabilityPath}`, request),
    ),
  );
  assert.deepEqual(
    duplicateResponses.map((response) => response.status),
    [201, 201],
  );
  const duplicateReplayHeaders = duplicateResponses.map((response) =>
    response.headers.get("x-nexus-replay"),
  );
  assert.equal(
    duplicateReplayHeaders.filter((value) => value === null).length,
    1,
  );
  assert.equal(
    duplicateReplayHeaders.filter((value) => value === "1").length,
    1,
  );
  const duplicateBodies = await Promise.all(
    duplicateResponses.map((response) => response.text()),
  );
  assert.equal(duplicateBodies[0], duplicateBodies[1]);
  assert.equal(
    JSON.parse(duplicateBodies[0]).reportId,
    duplicateReportId,
  );
  if (testPersistPath) {
    assert.deepEqual(
      await queryLocalD1(
        `SELECT COUNT(*) AS count
         FROM runner_capability_reports
         WHERE runner_id = '${capabilityRunnerId}'
           AND report_id = '${duplicateReportId}'`,
      ),
      [{ count: 1 }],
    );
  }

  const fakeRunnerId = `rnr_${"0".repeat(32)}`;
  const mismatchedPath = `/api/runners/${fakeRunnerId}/capability-reports`;
  assert.equal(
    (
      await fetch(
        `${baseUrl}${mismatchedPath}`,
        await signedRequest({
          path: mismatchedPath,
          domain: "nexus-runner-capability-report-v1",
          keyId: capabilityRunnerId,
          body: capabilityReportBody({
            reportId: `cap_${"d".repeat(32)}`,
            collectedAt: new Date().toISOString(),
          }),
          privateKey: capabilityPrivateKey,
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(
        `${baseUrl}${capabilityPath}?unexpected=1`,
        freshReportRequest,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}${capabilityPath}`, {
        method: "POST",
        body: "x".repeat(4_097),
        headers: {
          "content-type": "application/json",
          "x-nexus-runner-id": capabilityRunnerId,
        },
      })
    ).status,
    403,
  );

  if (testPersistPath) {
    const beforeHorizon = await queryLocalD1(
      `SELECT
         (SELECT replay_count FROM runner_capability_reports
          WHERE runner_id = '${capabilityRunnerId}'
            AND report_id = '${oldReportId}') AS replays,
         (SELECT COUNT(*) FROM runner_capability_nonces
          WHERE runner_id = '${capabilityRunnerId}') AS nonces`,
    );
    const horizonResponse = await fetch(
      `${baseUrl}${capabilityPath}`,
      await signedRequest({
        path: capabilityPath,
        domain: "nexus-runner-capability-report-v1",
        keyId: capabilityRunnerId,
        body: oldReportBody,
        privateKey: capabilityPrivateKey,
      }),
    );
    assert.equal(horizonResponse.status, 410);
    assert.deepEqual(await horizonResponse.json(), {
      error: "report_horizon_exceeded",
    });
    assert.deepEqual(
      await queryLocalD1(
        `SELECT
           (SELECT replay_count FROM runner_capability_reports
            WHERE runner_id = '${capabilityRunnerId}'
              AND report_id = '${oldReportId}') AS replays,
           (SELECT COUNT(*) FROM runner_capability_nonces
            WHERE runner_id = '${capabilityRunnerId}') AS nonces`,
      ),
      beforeHorizon,
    );
  }

  const postReportGovernance = await (
    await authenticatedRequest("/api/governance/intents", {
      headers: identityHeaders(otherOwnerId, otherOrganizationId),
    })
  ).json();
  assert.equal(
    postReportGovernance.ledger.length,
    raceGovernance.ledger.length,
  );

  const revokeCapabilityRunner = await authenticatedRequest(
    `/api/runners/${capabilityRunnerId}/revoke`,
    {
      method: "POST",
      headers: identityHeaders(otherOwnerId, otherOrganizationId),
      body: "{}",
    },
  );
  assert.equal(revokeCapabilityRunner.status, 200);
  const replayAfterCapabilityRevoke = await fetch(
    `${baseUrl}${capabilityPath}`,
    freshReportRequest,
  );
  assert.equal(replayAfterCapabilityRevoke.status, 403);
  assert.deepEqual(await replayAfterCapabilityRevoke.json(), {
    error: "runner_rejected",
  });

  const enginePath =
    `/api/runners/${enrolled.runnerId}/engine-reports`;
  const oldestEngineReportId = `egr_${(1).toString(16).padStart(32, "0")}`;
  const oldestEngineBody = engineReportBody({
    reportId: oldestEngineReportId,
    collectedAt: "2026-06-01T00:00:00.000Z",
  });
  const oldestEngineOperationHash = createHash("sha256")
    .update(
      [
        "nexus.runner.operation.v1",
        "nexus-runner-engine-report-v1",
        enrolled.runnerId,
        enginePath,
        createHash("sha256").update(oldestEngineBody).digest("hex"),
      ].join("\n"),
    )
    .digest("hex");
  let futureEngineReceivedAt;
  if (testPersistPath) {
    futureEngineReceivedAt = new Date(Date.now() + 10_000).toISOString();
    await runLocalD1(
      `WITH RECURSIVE sequence(value) AS (
         VALUES(1)
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 51
       )
       INSERT INTO runner_engine_reports (
         organization_id, runner_id, report_id, request_hash,
         declaration_hash, schema_version, collected_at, received_at,
         truncated, response_status, response_body
       )
       SELECT
         '${organizationId}', '${enrolled.runnerId}',
         'egr_' || printf('%032x', value),
         CASE
           WHEN value = 1 THEN '${oldestEngineOperationHash}'
           ELSE printf('%064x', value + 11000)
         END,
         printf('%064x', value + 13000),
         1, '2026-06-01T00:00:00.000Z',
         strftime(
           '%Y-%m-%dT%H:%M:%fZ',
           '2026-06-01T00:00:00.000Z',
           '+' || (value - 1) || ' seconds'
         ),
         0, 201, '{}'
       FROM sequence
       ORDER BY value;
       WITH RECURSIVE sequence(value) AS (
         VALUES(1)
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 51
       )
       INSERT INTO runner_engine_evidence (
         runner_id, report_id, position, engine, status, readiness,
         reason, version
       )
       SELECT
         '${enrolled.runnerId}', 'egr_' || printf('%032x', value), 0,
         'claude_code_cli', 'available', 'ready', 'none',
         '2.1.219 (Claude Code)'
       FROM sequence
       ORDER BY value;
       WITH RECURSIVE sequence(value) AS (
         VALUES(1)
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value < 51
       )
       INSERT INTO runner_engine_evidence (
         runner_id, report_id, position, engine, status, readiness,
         reason, version
       )
       SELECT
         '${enrolled.runnerId}', 'egr_' || printf('%032x', value), 1,
         'codex_cli', 'unavailable', 'attention_required',
         'engine_not_configured', NULL
       FROM sequence
       ORDER BY value;
       INSERT INTO runner_engine_reports (
         organization_id, runner_id, report_id, request_hash,
         declaration_hash, schema_version, collected_at, received_at,
         truncated, response_status, response_body
       ) VALUES (
         '${organizationId}', '${enrolled.runnerId}',
         'egr_${"9".repeat(32)}', '${"8".repeat(64)}',
         '${"7".repeat(64)}', 1, '${futureEngineReceivedAt}',
         '${futureEngineReceivedAt}', 0, 201, '{}'
       );
       INSERT INTO runner_engine_evidence (
         runner_id, report_id, position, engine, status, readiness,
         reason, version
       ) VALUES (
         '${enrolled.runnerId}', 'egr_${"9".repeat(32)}', 0,
         'claude_code_cli', 'available', 'ready', 'none',
         '2.1.219 (Claude Code)'
       );
       INSERT INTO runner_engine_evidence (
         runner_id, report_id, position, engine, status, readiness,
         reason, version
       ) VALUES (
         '${enrolled.runnerId}', 'egr_${"9".repeat(32)}', 1,
         'codex_cli', 'unavailable', 'attention_required',
         'engine_not_configured', NULL
       );`,
    );
  }

  const crossDomainNonce = base64url(randomBytes(16));
  const enrolledCapabilityPath =
    `/api/runners/${enrolled.runnerId}/capability-reports`;
  const crossDomainCapabilityBody = capabilityReportBody({
    reportId: `cap_${"a".repeat(32)}`,
    collectedAt: new Date().toISOString(),
  });
  const crossDomainCapabilityResponse = await fetch(
    `${baseUrl}${enrolledCapabilityPath}`,
    await signedRequest({
      path: enrolledCapabilityPath,
      domain: "nexus-runner-capability-report-v1",
      keyId: enrolled.runnerId,
      body: crossDomainCapabilityBody,
      nonce: crossDomainNonce,
      privateKey: pair.privateKey,
    }),
  );
  assert.equal(crossDomainCapabilityResponse.status, 201);

  const liveEngineReportId = `egr_${"f".repeat(32)}`;
  const liveEngineBody = engineReportBody({
    reportId: liveEngineReportId,
    collectedAt: new Date().toISOString(),
  });
  const crossDomainEngineResponse = await fetch(
    `${baseUrl}${enginePath}`,
    await signedRequest({
      path: enginePath,
      domain: "nexus-runner-engine-report-v1",
      keyId: enrolled.runnerId,
      body: liveEngineBody,
      nonce: crossDomainNonce,
      privateKey: pair.privateKey,
    }),
  );
  assert.equal(crossDomainEngineResponse.status, 409);
  assert.deepEqual(await crossDomainEngineResponse.json(), {
    error: "nonce_reused",
  });

  const privateEngineBody = JSON.stringify({
    ...JSON.parse(liveEngineBody),
    account: "operator@example.com",
  });
  const privateEngineResponse = await fetch(
    `${baseUrl}${enginePath}`,
    await signedRequest({
      path: enginePath,
      domain: "nexus-runner-engine-report-v1",
      keyId: enrolled.runnerId,
      body: privateEngineBody,
      privateKey: pair.privateKey,
    }),
  );
  assert.equal(privateEngineResponse.status, 403);
  assert.equal(
    (
      await fetch(
        `${baseUrl}${enginePath}`,
        await signedRequest({
          path: enginePath,
          domain: "nexus-runner-capability-report-v1",
          keyId: enrolled.runnerId,
          body: liveEngineBody,
          privateKey: pair.privateKey,
        }),
      )
    ).status,
    403,
  );
  for (const invalidBody of [
    `\uFEFF${liveEngineBody}`,
    `${liveEngineBody} `,
  ]) {
    assert.equal(
      (
        await fetch(
          `${baseUrl}${enginePath}`,
          await signedRequest({
            path: enginePath,
            domain: "nexus-runner-engine-report-v1",
            keyId: enrolled.runnerId,
            body: invalidBody,
            privateKey: pair.privateKey,
          }),
        )
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await fetch(`${baseUrl}${enginePath}`, {
        method: "POST",
        body: "x".repeat(4_097),
        headers: {
          "content-type": "application/json",
          "x-nexus-runner-id": enrolled.runnerId,
        },
      })
    ).status,
    403,
  );

  if (testPersistPath) {
    const horizonResponse = await fetch(
      `${baseUrl}${enginePath}`,
      await signedRequest({
        path: enginePath,
        domain: "nexus-runner-engine-report-v1",
        keyId: enrolled.runnerId,
        body: oldestEngineBody,
        privateKey: pair.privateKey,
      }),
    );
    assert.equal(horizonResponse.status, 410);
    assert.deepEqual(await horizonResponse.json(), {
      error: "report_horizon_exceeded",
    });
  }

  const engineReportNonce = base64url(randomBytes(16));
  const engineReportRequest = await signedRequest({
    path: enginePath,
    domain: "nexus-runner-engine-report-v1",
    keyId: enrolled.runnerId,
    body: liveEngineBody,
    nonce: engineReportNonce,
    privateKey: pair.privateKey,
  });
  const engineReportResponse = await fetch(
    `${baseUrl}${enginePath}`,
    engineReportRequest,
  );
  assert.equal(engineReportResponse.status, 201);
  assert.equal(engineReportResponse.headers.get("x-nexus-replay"), null);
  const engineReportBytes = await engineReportResponse.text();
  const engineAck = JSON.parse(engineReportBytes);
  assert.deepEqual(Object.keys(engineAck), [
    "nextReportBy",
    "receivedAt",
    "reportId",
  ]);
  assert.equal(engineAck.reportId, liveEngineReportId);
  assert.equal(
    Date.parse(engineAck.nextReportBy) - Date.parse(engineAck.receivedAt),
    12 * 60 * 60 * 1_000,
  );
  if (futureEngineReceivedAt) {
    assert.equal(engineAck.receivedAt, futureEngineReceivedAt);
  }

  const exactEngineReplay = await fetch(
    `${baseUrl}${enginePath}`,
    engineReportRequest,
  );
  assert.equal(exactEngineReplay.status, 201);
  assert.equal(exactEngineReplay.headers.get("x-nexus-replay"), "1");
  assert.equal(await exactEngineReplay.text(), engineReportBytes);

  const changedNonceEngineResponse = await fetch(
    `${baseUrl}${enginePath}`,
    await signedRequest({
      path: enginePath,
      domain: "nexus-runner-engine-report-v1",
      keyId: enrolled.runnerId,
      body: engineReportBody({
        reportId: liveEngineReportId,
        collectedAt: JSON.parse(liveEngineBody).collectedAt,
        claudeAttention: true,
      }),
      nonce: engineReportNonce,
      privateKey: pair.privateKey,
    }),
  );
  assert.equal(changedNonceEngineResponse.status, 409);
  assert.deepEqual(await changedNonceEngineResponse.json(), {
    error: "nonce_reused",
  });

  const semanticEngineReplay = await fetch(
    `${baseUrl}${enginePath}`,
    await signedRequest({
      path: enginePath,
      domain: "nexus-runner-engine-report-v1",
      keyId: enrolled.runnerId,
      body: liveEngineBody,
      privateKey: pair.privateKey,
    }),
  );
  assert.equal(semanticEngineReplay.status, 201);
  assert.equal(semanticEngineReplay.headers.get("x-nexus-replay"), "1");
  assert.equal(await semanticEngineReplay.text(), engineReportBytes);

  const engineConflict = await fetch(
    `${baseUrl}${enginePath}`,
    await signedRequest({
      path: enginePath,
      domain: "nexus-runner-engine-report-v1",
      keyId: enrolled.runnerId,
      body: engineReportBody({
        reportId: liveEngineReportId,
        collectedAt: JSON.parse(liveEngineBody).collectedAt,
        claudeAttention: true,
      }),
      privateKey: pair.privateKey,
    }),
  );
  assert.equal(engineConflict.status, 409);
  assert.deepEqual(await engineConflict.json(), {
    error: "report_conflict",
  });

  const duplicateEngineId = `egr_${"d".repeat(32)}`;
  const duplicateEngineBody = engineReportBody({
    reportId: duplicateEngineId,
    collectedAt: new Date().toISOString(),
  });
  const duplicateEngineRequests = await Promise.all(
    [0, 1].map(() =>
      signedRequest({
        path: enginePath,
        domain: "nexus-runner-engine-report-v1",
        keyId: enrolled.runnerId,
        body: duplicateEngineBody,
        privateKey: pair.privateKey,
      }),
    ),
  );
  const duplicateEngineResponses = await Promise.all(
    duplicateEngineRequests.map((request) =>
      fetch(`${baseUrl}${enginePath}`, request),
    ),
  );
  assert.deepEqual(
    duplicateEngineResponses.map((response) => response.status),
    [201, 201],
  );
  assert.equal(
    duplicateEngineResponses.filter(
      (response) => response.headers.get("x-nexus-replay") === null,
    ).length,
    1,
  );
  assert.equal(
    duplicateEngineResponses.filter(
      (response) => response.headers.get("x-nexus-replay") === "1",
    ).length,
    1,
  );
  const duplicateEngineBodies = await Promise.all(
    duplicateEngineResponses.map((response) => response.text()),
  );
  assert.equal(duplicateEngineBodies[0], duplicateEngineBodies[1]);

  const engineRowsBeforeHistory = testPersistPath
    ? await queryLocalD1(
        `SELECT
           (SELECT COUNT(*) FROM runner_engine_reports
            WHERE runner_id = '${enrolled.runnerId}') AS reports,
           (SELECT COUNT(*) FROM runner_engine_evidence
            WHERE runner_id = '${enrolled.runnerId}') AS evidence,
           (SELECT COUNT(*) FROM runner_capability_nonces
            WHERE runner_id = '${enrolled.runnerId}') AS nonces`,
      )
    : [];
  const engineHistoryResponse = await authenticatedRequest(enginePath);
  assert.equal(engineHistoryResponse.status, 200);
  const engineHistory = await engineHistoryResponse.json();
  assert.equal(engineHistory.runnerId, enrolled.runnerId);
  assert.match(engineHistory.trustDisclosure, /operator-controlled host/);
  assert.ok(engineHistory.reports.length > 0);
  assert.equal(engineHistory.reports[0].trust, "hostReported");
  assert.equal(engineHistory.reports[0].engines.length, 2);
  assert.equal(
    JSON.stringify(engineHistory).includes("requestHash"),
    false,
  );
  assert.equal(
    JSON.stringify(engineHistory).includes("declarationHash"),
    false,
  );
  if (testPersistPath) {
    assert.equal(engineHistory.reports.length, 50);
    assert.ok(engineHistory.nextCursor);
    const engineHistoryNext = await authenticatedRequest(
      `${enginePath}?cursor=${encodeURIComponent(engineHistory.nextCursor)}`,
    );
    assert.equal(engineHistoryNext.status, 200);
    const engineNextPage = await engineHistoryNext.json();
    assert.ok(engineNextPage.reports.length >= 1);
    assert.equal(engineNextPage.nextCursor, null);
    assert.deepEqual(
      await queryLocalD1(
        `SELECT
           (SELECT COUNT(*) FROM runner_engine_reports
            WHERE runner_id = '${enrolled.runnerId}') AS reports,
           (SELECT COUNT(*) FROM runner_engine_evidence
            WHERE runner_id = '${enrolled.runnerId}') AS evidence,
           (SELECT COUNT(*) FROM runner_capability_nonces
            WHERE runner_id = '${enrolled.runnerId}') AS nonces`,
      ),
      engineRowsBeforeHistory,
    );
    const privacyRows = await queryLocalD1(
      `SELECT COUNT(*) AS leaked
       FROM runner_engine_reports
       WHERE response_body LIKE '%operator@example.com%'`,
    );
    assert.deepEqual(privacyRows, [{ leaked: 0 }]);
    assert.equal(serverOutput.includes("operator@example.com"), false);
  }
  assert.equal(
    (
      await authenticatedRequest(`${enginePath}?cursor=invalid`)
    ).status,
    400,
  );
  assert.equal(
    (
      await authenticatedRequest(`${enginePath}?unexpected=1`)
    ).status,
    400,
  );
  assert.equal(
    (
      await authenticatedRequest(enginePath, {
        headers: identityHeaders(otherOwnerId, otherOrganizationId),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await authenticatedRequest(
        `/api/runners/rnr_${"0".repeat(32)}/engine-reports`,
      )
    ).status,
    404,
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
  const engineAfterRevoke = await fetch(
    `${baseUrl}${enginePath}`,
    engineReportRequest,
  );
  assert.equal(engineAfterRevoke.status, 403);
  assert.deepEqual(await engineAfterRevoke.json(), {
    error: "runner_rejected",
  });

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
      "runner_policy.updated",
      "runner_policy.updated",
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

function capabilityReportBody(input) {
  return JSON.stringify({
    capabilities: [
      {
        capability: "node_permission_model",
        detection: "none",
        reasonCode: input.reasonCode ?? "probe_disabled",
        status: input.status ?? "unknown",
      },
    ],
    collectedAt: input.collectedAt,
    platform: {
      arch: "arm64",
      nodeVersion: "v22.14.0",
      os: "darwin",
    },
    reportId: input.reportId,
    schemaVersion: 1,
    truncated: false,
  });
}

function engineReportBody(input) {
  const claude = input.claudeAttention
    ? {
        engine: "claude_code_cli",
        readiness: "attention_required",
        reason: "engine_not_configured",
        status: "unavailable",
      }
    : {
        engine: "claude_code_cli",
        readiness: "ready",
        reason: "none",
        status: "available",
        version: "2.1.219 (Claude Code)",
      };
  return JSON.stringify({
    collectedAt: input.collectedAt,
    engines: [
      claude,
      {
        engine: "codex_cli",
        readiness: "attention_required",
        reason: "engine_not_configured",
        status: "unavailable",
      },
    ],
    reportId: input.reportId,
    schemaVersion: 1,
    truncated: false,
  });
}

async function signedRequest(input) {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const nonce = input.nonce ?? base64url(randomBytes(16));
  const bodyHash = createHash("sha256").update(input.body).digest("hex");
  const value = [
    input.domain,
    ...(input.keyId ? [input.keyId] : []),
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
      ...(input.keyId
        ? { "x-nexus-runner-id": input.keyId }
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

async function runLocalD1Result(sql, json = false) {
  assert.ok(testPersistPath, "local D1 persistence is required");
  return runCommandResult("npx", [
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
    ...(json ? ["--json"] : []),
  ]);
}

async function queryLocalD1(sql) {
  const result = await runLocalD1Result(sql, true);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  return payload[0]?.results ?? [];
}

async function runCommandResult(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function captureServerOutput(chunk) {
  serverOutput = `${serverOutput}${chunk}`.slice(-16_000);
}
