import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.NEXUS_EXCERPT_TEST_PORT ?? "3943");
const baseUrl = `http://127.0.0.1:${port}`;
const persistPath = mkdtempSync(join(tmpdir(), "nexusos-excerpt-api-"));
const organizationId = "org-local-aurora";
const ownerId = "principal-local-owner";
const memberId = "principal-excerpt-member";
const otherOrganizationId = "org-excerpt-other";
const otherOwnerId = "principal-excerpt-other-owner";
const runnerId = `rnr_${"3".repeat(32)}`;
const absentRunId = `run_${"4".repeat(32)}`;
const storedRunId = `run_${"5".repeat(32)}`;
const erasedRunId = `run_${"6".repeat(32)}`;
const corruptRunId = `run_${"7".repeat(32)}`;
const recordedAt = "2026-07-28T12:00:00.000Z";
const erasedAt = "2026-08-27T12:00:00.000Z";
const keyring =
  '{"activeKeyId":"integration-key-v1","keys":{"integration-key-v1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"schemaVersion":1}';
const STDOUT = Uint8Array.from([0xff, 0xfe, 0x1b, 0x5b, 0x31, 0x6d]);
const STDERR = Uint8Array.from([0, 0x80, 0x1b, 0x3c, 0x3e]);
const FRAMED = Uint8Array.from([
  0,
  STDOUT.byteLength,
  ...STDOUT,
  ...STDERR,
]);
const EXCERPT_SHA256 = sha256(FRAMED);
const STDOUT_SHA256 = sha256(STDOUT);
const STDERR_SHA256 = sha256(STDERR);
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
        NEXUS_ALLOW_LOCAL_IDENTITY: "0",
        NEXUS_ALLOW_TEST_IDENTITIES: "1",
        NEXUS_PERSIST_STATE_PATH: persistPath,
        NEXUS_PROMPT_CIPHER_KEYS: keyring,
        WRANGLER_LOG_PATH: ".wrangler/wrangler-excerpt-api.log",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);
  await healthy();

  const localFallback = await fetch(
    `${baseUrl}/api/runs/engine/${absentRunId}/excerpt`,
  );
  assert.equal(localFallback.status, 404);
  assertPrivate(localFallback);

  const seedOwner = await request(absentRunId, ownerId, organizationId);
  assert.equal(seedOwner.status, 404);
  await seedDatabase();

  const member = await request(absentRunId, memberId, organizationId);
  assert.equal(member.status, 403);
  assert.deepEqual(await member.json(), {
    error: "workspace_owner_required",
  });
  assertPrivate(member);

  const foreign = await request(absentRunId, otherOwnerId, otherOrganizationId);
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), {
    error: "engine_run_not_found",
  });
  assertPrivate(foreign);

  const absent = await request(absentRunId, ownerId, organizationId);
  assert.equal(absent.status, 200);
  assert.deepEqual(await absent.json(), {
    schemaVersion: 1,
    runId: absentRunId,
    state: "absent",
  });
  assertPrivate(absent);

  const stored = await request(storedRunId, ownerId, organizationId);
  assert.equal(stored.status, 200);
  const storedBody = await stored.json();
  assert.equal(storedBody.state, "stored");
  assert.equal(storedBody.encoding, "base64url");
  assert.equal(storedBody.interpretation, "opaque_bytes");
  assert.deepEqual(decodeBase64Url(storedBody.stdoutBase64Url), STDOUT);
  assert.deepEqual(decodeBase64Url(storedBody.stderrBase64Url), STDERR);
  assertPrivate(stored);

  const erased = await request(erasedRunId, ownerId, organizationId);
  assert.equal(erased.status, 200);
  const erasedBody = await erased.json();
  assert.equal(erasedBody.state, "erased");
  assert.equal(erasedBody.erasedAt, erasedAt);
  assert.equal(erasedBody.stdoutBase64Url, undefined);
  assert.equal(erasedBody.receipt.excerptSha256, EXCERPT_SHA256);
  assertPrivate(erased);

  const corrupt = await request(corruptRunId, ownerId, organizationId);
  assert.equal(corrupt.status, 503);
  assert.deepEqual(await corrupt.json(), {
    error: "prompt_cipher_key_unavailable",
  });
  assertPrivate(corrupt);

  assert.equal(serverOutput.includes("secret provider detail"), false);
  process.stdout.write(
    "Engine excerpt API integration passed authz, tenancy, states and crypto failure.\n",
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

async function seedDatabase() {
  const envelope = await encrypt(FRAMED, {
    organizationId,
    payloadRef: excerptRef(storedRunId),
    runId: storedRunId,
  });
  const corruptEnvelope = await encrypt(FRAMED, {
    organizationId,
    payloadRef: excerptRef(corruptRunId),
    runId: corruptRunId,
  });
  const damagedTag = corruptEnvelope.tag.slice();
  damagedTag[0] ^= 0xff;
  await sql(
    `INSERT INTO principals (id, organization_id, kind, display_name)
     VALUES
       ('${memberId}', '${organizationId}', 'human', 'Excerpt member');
     INSERT INTO memberships (id, organization_id, principal_id, role)
     VALUES
       ('membership-excerpt-member', '${organizationId}', '${memberId}', 'member');
     INSERT INTO organizations (id, slug, name)
     VALUES ('${otherOrganizationId}', 'excerpt-other', 'Excerpt other');
     INSERT INTO principals (id, organization_id, kind, display_name)
     VALUES (
       '${otherOwnerId}', '${otherOrganizationId}', 'human', 'Other owner'
     );
     INSERT INTO memberships (id, organization_id, principal_id, role)
     VALUES (
       'membership-excerpt-other', '${otherOrganizationId}',
       '${otherOwnerId}', 'owner'
     );
     INSERT INTO principals (
       id, organization_id, kind, external_id, display_name
     ) VALUES (
       'principal-excerpt-runner', '${organizationId}', 'runner',
       '${runnerId}', 'Excerpt runner'
     );
     INSERT INTO runner_enrollment_tokens (
       id, organization_id, token_hash, issued_by, display_name,
       issued_at, expires_at
     ) VALUES (
       'token-excerpt-runner', '${organizationId}', '${"d".repeat(64)}',
       '${ownerId}', 'Excerpt runner', '2026-07-28T10:00:00.000Z',
       '2026-07-28T13:00:00.000Z'
     );
     INSERT INTO runners (
       id, organization_id, principal_id, enrollment_token_id,
       display_name, public_key, enrolled_at
     ) VALUES (
       '${runnerId}', '${organizationId}', 'principal-excerpt-runner',
       'token-excerpt-runner', 'Excerpt runner', '${"A".repeat(43)}',
       '2026-07-28T10:00:00.000Z'
     );
     ${[absentRunId, storedRunId, erasedRunId, corruptRunId]
       .map(engineRunInsert)
       .join("\n")}`,
  ).catch((error) => {
    throw new Error("Core excerpt fixture failed.", { cause: error });
  });
  await sql(
     `PRAGMA foreign_keys = OFF;
     DROP TRIGGER run_leases_validate_before_insert;
     DROP TRIGGER run_leases_attach_after_insert;
     DROP TRIGGER runner_operations_validate_before_insert;
     DROP TRIGGER run_engine_excerpts_validate_before_insert;
     DROP TRIGGER run_engine_receipts_validate_before_insert;
     ${receiptDependencies(storedRunId)}
     ${excerptInsert(storedRunId, envelope, null)}
     ${receiptInsert(storedRunId)}
     ${receiptDependencies(erasedRunId)}
     ${excerptInsert(erasedRunId, null, erasedAt)}
     ${receiptInsert(erasedRunId)}
     ${receiptDependencies(corruptRunId)}
     ${excerptInsert(
       corruptRunId,
       { ...corruptEnvelope, tag: damagedTag },
       null,
     )}
     ${receiptInsert(corruptRunId)}`,
  ).catch((error) => {
    throw new Error("Protected excerpt fixture failed.", { cause: error });
  });
}

function receiptDependencies(selectedRunId) {
  return `INSERT INTO run_leases (
    id, organization_id, run_id, runner_id, fence, status,
    issued_at, expires_at, renew_count, ended_at, ended_reason
  ) VALUES (
    'lse_${selectedRunId.slice(4)}', '${organizationId}', '${selectedRunId}',
    '${runnerId}', 1, 'released', '2026-07-28T11:58:00.000Z',
    '2026-07-28T12:01:00.000Z', 0, '${recordedAt}', 'engine_complete'
  );
  INSERT INTO runner_operations (
    run_id, operation_id, request_hash, fence, response_status,
    response_body, replay_count, applied_at
  ) VALUES (
    '${selectedRunId}', 'op_${selectedRunId.slice(4)}',
    '${"b".repeat(64)}', 1, 200, '{}', 0, '${recordedAt}'
  );`;
}

function engineRunInsert(selectedRunId) {
  return `INSERT INTO runs (
    id, organization_id, requested_by, kind, status, version,
    lease_generation, claim_count, max_claims, deadline_at, engine,
    assigned_runner_id, required_capability, created_at, updated_at
  ) VALUES (
    '${selectedRunId}', '${organizationId}', '${ownerId}', 'engine_prompt',
    'queued', 1, 0, 0, 2, '2026-07-28T11:50:00.000Z',
    'claude_code_cli', '${runnerId}', NULL,
    '2026-07-28T11:30:00.000Z', '2026-07-28T11:30:00.000Z'
  );`;
}

function excerptInsert(selectedRunId, envelope, selectedErasedAt) {
  const live = selectedErasedAt === null;
  return `INSERT INTO run_engine_excerpts (
    run_id, organization_id, excerpt_ref, cipher_version, key_id,
    iv, ciphertext, tag, stdout_excerpt_bytes, stderr_excerpt_bytes,
    excerpt_sha256, created_at, erased_at
  ) VALUES (
    '${selectedRunId}', '${organizationId}', '${excerptRef(selectedRunId)}', 1,
    ${live ? "'integration-key-v1'" : "NULL"},
    ${live ? blob(envelope.iv) : "NULL"},
    ${live ? blob(envelope.ciphertext) : "NULL"},
    ${live ? blob(envelope.tag) : "NULL"},
    ${STDOUT.byteLength}, ${STDERR.byteLength}, '${EXCERPT_SHA256}',
    '${recordedAt}', ${selectedErasedAt ? `'${selectedErasedAt}'` : "NULL"}
  );`;
}

function receiptInsert(selectedRunId) {
  return `INSERT INTO run_engine_receipts (
    run_id, organization_id, operation_id, excerpt_ref, excerpt_sha256,
    lease_id, fence, engine, engine_version, status, reason, exit_code,
    timed_out, cancel_requested, started_at, finished_at, stdout_bytes,
    stdout_sha256, stdout_truncated, stdout_excerpt_bytes, stderr_bytes,
    stderr_sha256, stderr_truncated, stderr_excerpt_bytes, receipt_sha256,
    recorded_at
  ) VALUES (
    '${selectedRunId}', '${organizationId}',
    'op_${selectedRunId.slice(4)}', '${excerptRef(selectedRunId)}',
    '${EXCERPT_SHA256}', 'lse_${selectedRunId.slice(4)}', 1,
    'claude_code_cli', '2.1.219', 'succeeded', 'none', 0, 0, 0,
    '2026-07-28T11:59:00.000Z', '${recordedAt}',
    ${STDOUT.byteLength}, '${STDOUT_SHA256}', 0, ${STDOUT.byteLength},
    ${STDERR.byteLength}, '${STDERR_SHA256}', 0, ${STDERR.byteLength},
    '${"a".repeat(64)}', '${recordedAt}'
  );`;
}

async function encrypt(plaintext, context) {
  const key = await webcrypto.subtle.importKey(
    "raw",
    new Uint8Array(32),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = new Uint8Array(12).fill(Number(context.runId[4]) || 1);
  const additionalData = new TextEncoder().encode(
    `${context.runId}|${context.organizationId}|${context.payloadRef}`,
  );
  const combined = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      key,
      plaintext,
    ),
  );
  return {
    iv,
    ciphertext: combined.slice(0, -16),
    tag: combined.slice(-16),
  };
}

function request(selectedRunId, principalId, tenantId) {
  return fetch(`${baseUrl}/api/runs/engine/${selectedRunId}/excerpt`, {
    headers: {
      "x-nexus-test-principal": principalId,
      "x-nexus-test-organization": tenantId,
    },
  });
}

function assertPrivate(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

function excerptRef(selectedRunId) {
  return `exc_${selectedRunId.slice(4)}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function blob(bytes) {
  return `X'${Buffer.from(bytes).toString("hex")}'`;
}

function decodeBase64Url(value) {
  return new Uint8Array(Buffer.from(value, "base64url"));
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
