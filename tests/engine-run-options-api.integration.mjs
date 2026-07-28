import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.NEXUS_OPTIONS_TEST_PORT ?? "3942");
const baseUrl = `http://127.0.0.1:${port}`;
const persistPath = mkdtempSync(join(tmpdir(), "nexusos-options-api-"));
const organizationId = "org-local-aurora";
const ownerId = "principal-local-owner";
const memberId = "principal-options-member";
const nonmemberId = "principal-options-nonmember";
const otherOrganizationId = "org-options-other";
const otherOwnerId = "principal-options-other-owner";
const enrolledAt = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
const issuedAt = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
const inactiveReportReceivedAt =
  new Date(Date.now() - 90 * 1_000).toISOString();
const oldReportReceivedAt =
  new Date(Date.now() - 120 * 1_000).toISOString();
const latestReportReceivedAt =
  new Date(Date.now() - 60 * 1_000).toISOString();
const inactiveReportId = `egr_${"0".repeat(32)}`;
const oldReportId = `egr_${"1".repeat(32)}`;
const latestReportId = `egr_${"2".repeat(32)}`;
const runnerIds = Array.from(
  { length: 101 },
  (_, index) => runnerId(index + 1),
);
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
        NEXUS_ALLOW_TEST_IDENTITIES: "1",
        NEXUS_PERSIST_STATE_PATH: persistPath,
        WRANGLER_LOG_PATH: ".wrangler/wrangler-options-api.log",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);
  await healthy();

  const bootstrap = await request(ownerId, organizationId);
  assert.equal(bootstrap.status, 200);
  assertPrivate(bootstrap);
  await seedAccess();
  await seedRunners();
  await seedReports();

  const nonmemberWithBadQuery = await request(
    nonmemberId,
    organizationId,
    "?browserNow=2099-01-01T00%3A00%3A00.000Z",
  );
  assert.equal(nonmemberWithBadQuery.status, 403);
  assert.deepEqual(await nonmemberWithBadQuery.json(), {
    error: "workspace_membership_required",
  });
  assertPrivate(nonmemberWithBadQuery);

  const ownerWithBadQuery = await request(
    ownerId,
    organizationId,
    "?browserNow=2099-01-01T00%3A00%3A00.000Z",
  );
  assert.equal(ownerWithBadQuery.status, 400);
  assert.deepEqual(await ownerWithBadQuery.json(), {
    error: "unexpected_query_parameter",
  });
  assertPrivate(ownerWithBadQuery);

  const crossTenantMember = await request(
    memberId,
    otherOrganizationId,
  );
  assert.equal(crossTenantMember.status, 403);
  assert.deepEqual(await crossTenantMember.json(), {
    error: "workspace_membership_required",
  });
  assertPrivate(crossTenantMember);

  const otherTenant = await request(
    otherOwnerId,
    otherOrganizationId,
  );
  assert.equal(otherTenant.status, 200);
  const otherTenantBody = await otherTenant.json();
  assert.equal(otherTenantBody.truncated, false);
  assert.deepEqual(otherTenantBody.options, []);
  assertPrivate(otherTenant);

  const member = await request(memberId, organizationId);
  assert.equal(member.status, 200);
  assertPrivate(member);
  const body = await member.json();
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.truncated, true);
  assert.equal(body.options.length, 200);
  assert.equal(
    new Set(body.options.map((option) => option.runnerId)).size,
    100,
  );
  assert.equal(
    body.options.some((option) => option.runnerId === runnerIds[100]),
    false,
  );

  const inactiveOptions = body.options.filter(
    (option) => option.runnerId === runnerIds[0],
  );
  assert.equal(inactiveOptions.length, 2);
  for (const option of inactiveOptions) {
    assert.equal(option.runnerState, "inactive");
    assert.equal(option.eligible, false);
    assert.equal(option.disabledReason, "runner_inactive");
    assert.equal(option.reportId, inactiveReportId);
    assert.equal(option.status, "available");
    assert.equal(option.readiness, "ready");
    assert.equal(option.reason, "none");
    assert.equal(option.version, "2.1.219");
  }

  const latestOptions = body.options.filter(
    (option) => option.runnerId === runnerIds[1],
  );
  assert.equal(latestOptions.length, 2);
  for (const option of latestOptions) {
    assert.equal(option.runnerState, "active");
    assert.equal(option.eligible, true);
    assert.equal(option.disabledReason, null);
    assert.equal(option.reportId, latestReportId);
    assert.equal(option.receivedAt, latestReportReceivedAt);
    assert.equal(option.status, "available");
    assert.equal(option.readiness, "ready");
    assert.equal(option.reason, "none");
    assert.equal(option.version, "2.1.220");
  }
  assert.equal(
    body.options.some((option) => option.reportId === oldReportId),
    false,
  );

  process.stdout.write(
    "Engine run options API integration passed authz, tenancy, overlays, latest report and caps.\n",
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

async function seedAccess() {
  await sql(
    `INSERT INTO principals (id, organization_id, kind, display_name)
     VALUES
       ('${memberId}', '${organizationId}', 'human', 'Options member'),
       ('${nonmemberId}', '${organizationId}', 'human', 'Options nonmember');
     INSERT INTO memberships (id, organization_id, principal_id, role)
     VALUES (
       'membership-options-member', '${organizationId}', '${memberId}', 'member'
     );
     INSERT INTO organizations (id, slug, name)
     VALUES ('${otherOrganizationId}', 'options-other', 'Options other');
     INSERT INTO principals (id, organization_id, kind, display_name)
     VALUES (
       '${otherOwnerId}', '${otherOrganizationId}', 'human', 'Other owner'
     );
     INSERT INTO memberships (id, organization_id, principal_id, role)
     VALUES (
       'membership-options-other-owner', '${otherOrganizationId}',
       '${otherOwnerId}', 'owner'
     );`,
  );
}

async function seedRunners() {
  for (let start = 0; start < runnerIds.length; start += 20) {
    const statements = runnerIds
      .slice(start, start + 20)
      .map((selectedRunnerId, offset) =>
        runnerInsert(start + offset + 1, selectedRunnerId),
      )
      .join("\n");
    await sql(statements);
  }
}

async function seedReports() {
  await sql(
    `${reportInsert(
      runnerIds[0],
      inactiveReportId,
      inactiveReportReceivedAt,
      "2.1.219",
      true,
    )}
     ${reportInsert(
       runnerIds[1],
       oldReportId,
       oldReportReceivedAt,
       null,
       false,
     )}
     ${reportInsert(
       runnerIds[1],
       latestReportId,
       latestReportReceivedAt,
       "2.1.220",
       true,
     )}
     UPDATE principals
     SET status = 'inactive', updated_at = '${latestReportReceivedAt}'
     WHERE id = '${runnerPrincipalId(1)}'
       AND organization_id = '${organizationId}';`,
  );
}

function runnerInsert(index, selectedRunnerId) {
  const principalId = runnerPrincipalId(index);
  const tokenId = `token-options-${String(index).padStart(3, "0")}`;
  const tokenHash = index.toString(16).padStart(64, "0");
  const publicKey = `A${index.toString(16).padStart(42, "0")}`;
  return `INSERT INTO principals (
    id, organization_id, kind, external_id, display_name
  ) VALUES (
    '${principalId}', '${organizationId}', 'runner', '${selectedRunnerId}',
    'Options runner ${String(index).padStart(3, "0")}'
  );
  INSERT INTO runner_enrollment_tokens (
    id, organization_id, token_hash, issued_by, display_name,
    issued_at, expires_at
  ) VALUES (
    '${tokenId}', '${organizationId}', '${tokenHash}', '${ownerId}',
    'Options runner ${String(index).padStart(3, "0")}',
    '${issuedAt}', '${expiresAt}'
  );
  INSERT INTO runners (
    id, organization_id, principal_id, enrollment_token_id,
    display_name, public_key, enrolled_at
  ) VALUES (
    '${selectedRunnerId}', '${organizationId}', '${principalId}', '${tokenId}',
    'Options runner ${String(index).padStart(3, "0")}',
    '${publicKey}', '${enrolledAt}'
  );`;
}

function reportInsert(
  selectedRunnerId,
  reportId,
  receivedAt,
  version,
  ready,
) {
  const status = ready ? "available" : "unavailable";
  const readiness = ready ? "ready" : "attention_required";
  const reason = ready ? "none" : "engine_not_configured";
  const sqlVersion = version === null ? "NULL" : `'${version}'`;
  return `INSERT INTO runner_engine_reports (
    organization_id, runner_id, report_id, request_hash, declaration_hash,
    schema_version, collected_at, received_at, truncated, response_status,
    response_body, replay_count
  ) VALUES (
    '${organizationId}', '${selectedRunnerId}', '${reportId}',
    '${"a".repeat(64)}', '${"b".repeat(64)}', 1, '${receivedAt}',
    '${receivedAt}', 0, 201, '{}', 0
  );
  INSERT INTO runner_engine_evidence (
    runner_id, report_id, position, engine, status, readiness, reason, version
  ) VALUES (
    '${selectedRunnerId}', '${reportId}', 0, 'claude_code_cli',
    '${status}', '${readiness}', '${reason}', ${sqlVersion}
  );
  INSERT INTO runner_engine_evidence (
    runner_id, report_id, position, engine, status, readiness, reason, version
  ) VALUES (
    '${selectedRunnerId}', '${reportId}', 1, 'codex_cli',
    '${status}', '${readiness}', '${reason}', ${sqlVersion}
  );`;
}

function runnerId(index) {
  return `rnr_${index.toString(16).padStart(32, "0")}`;
}

function runnerPrincipalId(index) {
  return `principal-options-runner-${String(index).padStart(3, "0")}`;
}

function request(principalId, selectedOrganizationId, search = "") {
  return fetch(`${baseUrl}/api/runs/engine/options${search}`, {
    headers: {
      "x-nexus-test-principal": principalId,
      "x-nexus-test-organization": selectedOrganizationId,
    },
  });
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
