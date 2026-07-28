import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const port = Number(
  process.env.NEXUS_CLI_SESSION_OBSERVATION_TEST_PORT ?? "3943",
);
const baseUrl = `http://127.0.0.1:${port}`;
const tempPath = mkdtempSync(
  join(tmpdir(), "nexusos-cli-session-observation-"),
);
const persistPath = join(tempPath, "state");
const workerPath = join(tempPath, "worker.ts");
const configPath = join(tempPath, "wrangler.jsonc");
const adapterPath = resolve(
  root,
  "src/adapters/d1/cli-session-observation-read-model.ts",
);
const organizationA = "org-cli-session-a";
const organizationB = "org-cli-session-b";
const ownerA = "principal-cli-session-owner-a";
const ownerB = "principal-cli-session-owner-b";
const runnerIdsA = Array.from(
  { length: 101 },
  (_, index) => runnerId(index + 1),
);
const runnerIdB = runnerId(200);
const freshRunnerId = runnerIdsA[0];
const inactiveRunnerId = runnerIdsA[1];
const staleRunnerId = runnerIdsA[2];
const hiddenRunnerId = runnerIdsA[100];
const now = Date.now();
const issuedAt = iso(now - 4 * 86_400_000);
const expiresAt = iso(now + 4 * 86_400_000);
const freshReceivedAt = iso(now - 30_000);
const staleReceivedAt = iso(now - 90_000_000);
const freshReportId = reportId(1);
const inactiveReportId = reportId(2);
const staleReportId = reportId(3);
const otherReportId = reportId(4);
let server;
let serverOutput = "";

writeFileSync(
  workerPath,
  `import { resolveCliSessionObservationFromD1 } from ${JSON.stringify(adapterPath)};

const identity = {
  id: ${JSON.stringify(ownerA)},
  kind: "human" as const,
  displayName: "CLI session test owner",
  organizationId: ${JSON.stringify(organizationA)},
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") return new Response("ok");
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    const result = await resolveCliSessionObservationFromD1(
      identity,
      await request.json(),
    );
    return Response.json(result);
  },
};
`,
  "utf8",
);
writeFileSync(
  configPath,
  `${JSON.stringify({
    name: "nexusos-cli-session-observation-test",
    main: workerPath,
    compatibility_date: "2026-07-25",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [
      {
        binding: "DB",
        database_name: "nexusos-cli-session-observation-test",
        database_id: "00000000-0000-4000-8000-000000000000",
        migrations_dir: resolve(root, "drizzle"),
      },
    ],
  }, null, 2)}\n`,
  "utf8",
);

try {
  await command("npx", [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    configPath,
    "--persist-to",
    persistPath,
  ]);
  await seedOrganizations();
  await seedRunners();
  await seedReports();

  server = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      workerPath,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--config",
      configPath,
      "--tsconfig",
      resolve(root, "tsconfig.json"),
      "--persist-to",
      persistPath,
      "--log-level",
      "error",
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);
  await healthy();

  const beforeFresh = Date.now();
  const fresh = await resolveObservation(freshRunnerId);
  const afterFresh = Date.now();
  assert.deepEqual(fresh.candidate, {
    providerId: "openai",
    modelId: "gpt-5.6",
    cliEngine: "codex_cli",
    bindingTrust: "declared_unverified",
  });
  assert.equal(fresh.status, "observed");
  assert.equal(
    fresh.observationClaim,
    "fresh_host_reported_cli_auth_session_for_declared_candidate_no_provider_connection_no_account_no_execution_no_quota",
  );
  assert.equal(fresh.observation.runnerId, freshRunnerId);
  assert.equal(fresh.observation.reportId, freshReportId);
  assert.equal(fresh.observation.receivedAt, freshReceivedAt);
  assert.equal(fresh.observation.engineVersion, "2.1.220");
  assert.equal(fresh.observation.trust, "hostReported");
  assert.equal(
    fresh.observation.freshUntil,
    iso(Date.parse(freshReceivedAt) + 86_400_000),
  );
  assert.equal(
    Date.parse(fresh.observation.evaluatedAt) >= beforeFresh &&
      Date.parse(fresh.observation.evaluatedAt) <= afterFresh,
    true,
  );

  assert.equal(
    (await resolveObservation(staleRunnerId)).reason,
    "engine_report_stale",
  );
  assert.equal(
    (await resolveObservation(inactiveRunnerId)).reason,
    "runner_inactive",
  );
  assert.equal(
    (await resolveObservation(runnerIdB)).reason,
    "runner_not_observed",
  );
  assert.equal(
    (await resolveObservation(hiddenRunnerId)).reason,
    "runner_not_observed",
  );

  process.stdout.write(
    "CLI session observation D1 integration passed fresh, stale, inactive, tenant and truncation boundaries.\n",
  );
} finally {
  if (server && !server.killed) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => server.once("exit", resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  rmSync(tempPath, { recursive: true, force: true });
}

async function seedOrganizations() {
  await sql(
    `INSERT INTO organizations (id, slug, name)
     VALUES
       ('${organizationA}', 'cli-session-a', 'CLI session A'),
       ('${organizationB}', 'cli-session-b', 'CLI session B');
     INSERT INTO principals (id, organization_id, kind, display_name)
     VALUES
       ('${ownerA}', '${organizationA}', 'human', 'CLI session owner A'),
       ('${ownerB}', '${organizationB}', 'human', 'CLI session owner B');
     INSERT INTO memberships (id, organization_id, principal_id, role)
     VALUES
       ('membership-cli-session-a', '${organizationA}', '${ownerA}', 'owner'),
       ('membership-cli-session-b', '${organizationB}', '${ownerB}', 'owner');`,
  );
}

async function seedRunners() {
  for (let start = 0; start < runnerIdsA.length; start += 20) {
    await sql(
      runnerIdsA
        .slice(start, start + 20)
        .map((selectedRunnerId, offset) =>
          runnerInsert({
            index: start + offset + 1,
            organizationId: organizationA,
            ownerId: ownerA,
            selectedRunnerId,
          }),
        )
        .join("\n"),
    );
  }
  await sql(runnerInsert({
    index: 200,
    organizationId: organizationB,
    ownerId: ownerB,
    selectedRunnerId: runnerIdB,
  }));
}

async function seedReports() {
  await sql(
    `${reportInsert({
      organizationId: organizationA,
      selectedRunnerId: freshRunnerId,
      selectedReportId: freshReportId,
      receivedAt: freshReceivedAt,
      version: "2.1.220",
    })}
     ${reportInsert({
       organizationId: organizationA,
       selectedRunnerId: inactiveRunnerId,
       selectedReportId: inactiveReportId,
       receivedAt: freshReceivedAt,
       version: "2.1.219",
     })}
     ${reportInsert({
       organizationId: organizationA,
       selectedRunnerId: staleRunnerId,
       selectedReportId: staleReportId,
       receivedAt: staleReceivedAt,
       version: "2.1.218",
     })}
     ${reportInsert({
       organizationId: organizationB,
       selectedRunnerId: runnerIdB,
       selectedReportId: otherReportId,
       receivedAt: freshReceivedAt,
       version: "2.1.220",
     })}
     UPDATE principals
     SET status = 'inactive', updated_at = '${freshReceivedAt}'
     WHERE id = '${runnerPrincipalId(2)}'
       AND organization_id = '${organizationA}';`,
  );
}

function runnerInsert({
  index,
  organizationId,
  ownerId,
  selectedRunnerId,
}) {
  const principalId = runnerPrincipalId(index);
  const tokenId = `token-cli-session-${String(index).padStart(3, "0")}`;
  const tokenHash = index.toString(16).padStart(64, "0");
  const publicKey = `A${index.toString(16).padStart(42, "0")}`;
  const enrolledAt = iso(now - 200_000_000 - index * 1_000);
  return `INSERT INTO principals (
    id, organization_id, kind, external_id, display_name
  ) VALUES (
    '${principalId}', '${organizationId}', 'runner', '${selectedRunnerId}',
    'CLI session runner ${String(index).padStart(3, "0")}'
  );
  INSERT INTO runner_enrollment_tokens (
    id, organization_id, token_hash, issued_by, display_name,
    issued_at, expires_at
  ) VALUES (
    '${tokenId}', '${organizationId}', '${tokenHash}', '${ownerId}',
    'CLI session runner ${String(index).padStart(3, "0")}',
    '${issuedAt}', '${expiresAt}'
  );
  INSERT INTO runners (
    id, organization_id, principal_id, enrollment_token_id,
    display_name, public_key, enrolled_at
  ) VALUES (
    '${selectedRunnerId}', '${organizationId}', '${principalId}', '${tokenId}',
    'CLI session runner ${String(index).padStart(3, "0")}',
    '${publicKey}', '${enrolledAt}'
  );`;
}

function reportInsert({
  organizationId,
  selectedRunnerId,
  selectedReportId,
  receivedAt,
  version,
}) {
  return `INSERT INTO runner_engine_reports (
    organization_id, runner_id, report_id, request_hash, declaration_hash,
    schema_version, collected_at, received_at, truncated, response_status,
    response_body, replay_count
  ) VALUES (
    '${organizationId}', '${selectedRunnerId}', '${selectedReportId}',
    '${"a".repeat(64)}', '${"b".repeat(64)}', 1, '${receivedAt}',
    '${receivedAt}', 0, 201, '{}', 0
  );
  INSERT INTO runner_engine_evidence (
    runner_id, report_id, position, engine, status, readiness, reason, version
  ) VALUES (
    '${selectedRunnerId}', '${selectedReportId}', 0, 'claude_code_cli',
    'available', 'ready', 'none', '${version}'
  );
  INSERT INTO runner_engine_evidence (
    runner_id, report_id, position, engine, status, readiness, reason, version
  ) VALUES (
    '${selectedRunnerId}', '${selectedReportId}', 1, 'codex_cli',
    'available', 'ready', 'none', '${version}'
  );`;
}

async function resolveObservation(selectedRunnerId) {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runnerId: selectedRunnerId,
      intent: {
        specVersion: "nexusos.connection-intent.v1",
        providerId: "openai",
        method: "cli",
        cliEngine: "codex_cli",
        modelId: "gpt-5.6",
      },
      declaration: {
        specVersion: "nexusos.provider-catalog-declaration.v1",
        providers: [
          {
            providerId: "openai",
            displayName: "OpenAI",
            methods: [
              { method: "cli", cliEngine: "codex_cli" },
            ],
          },
        ],
        models: [
          {
            providerId: "openai",
            modelId: "gpt-5.6",
            displayName: "GPT 5.6",
            lifecycle: "available",
          },
        ],
      },
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function healthy() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`Worker exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Expected while the temporary Worker starts.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Worker startup timed out.\n${serverOutput}`);
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
    configPath,
    "--persist-to",
    persistPath,
    "--command",
    statement,
  ]);
}

function command(executable, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", rejectCommand);
    child.once("close", (code) => {
      if (code === 0) resolveCommand(output);
      else {
        rejectCommand(
          new Error(`${executable} failed (${code}):\n${output}`),
        );
      }
    });
  });
}

function runnerId(index) {
  return `rnr_${index.toString(16).padStart(32, "0")}`;
}

function runnerPrincipalId(index) {
  return `principal-cli-session-runner-${String(index).padStart(3, "0")}`;
}

function reportId(index) {
  return `egr_${index.toString(16).padStart(32, "0")}`;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}
