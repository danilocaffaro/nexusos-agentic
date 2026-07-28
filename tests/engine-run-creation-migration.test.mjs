import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(new URL("../drizzle/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    database.exec(
      readFileSync(
        new URL(`../drizzle/${migration}`, import.meta.url),
        "utf8",
      ).replaceAll("--> statement-breakpoint", ""),
    );
  }
  return database;
}

function seedOwner(database, suffix) {
  const organizationId = `org-creation-${suffix}`;
  const ownerId = `owner-creation-${suffix}`;
  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run(organizationId, `creation-${suffix}`, `Creation ${suffix}`);
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, display_name
      ) VALUES (?, ?, 'human', ?)`,
    )
    .run(ownerId, organizationId, ownerId);
  database
    .prepare(
      `INSERT INTO memberships (
        id, organization_id, principal_id, role
      ) VALUES (?, ?, ?, 'owner')`,
    )
    .run(`membership-creation-${suffix}`, organizationId, ownerId);
  return { organizationId, ownerId };
}

function seedEngineRun(database, owner, suffix) {
  const runnerPrincipalId = `runner-principal-creation-${suffix}`;
  const runnerId = `runner-creation-${suffix}`;
  const tokenId = `token-creation-${suffix}`;
  const runId = `run_${suffix.repeat(32)}`;
  const createdAt = "2025-01-01T00:00:00.000Z";
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, external_id, display_name
      ) VALUES (?, ?, 'runner', ?, ?)`,
    )
    .run(
      runnerPrincipalId,
      owner.organizationId,
      runnerId,
      runnerId,
    );
  database
    .prepare(
      `INSERT INTO runner_enrollment_tokens (
        id, organization_id, token_hash, issued_by, display_name,
        issued_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tokenId,
      owner.organizationId,
      createHash("sha256").update(suffix).digest("hex"),
      owner.ownerId,
      runnerId,
      createdAt,
      "2025-01-01T01:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO runners (
        id, organization_id, principal_id, enrollment_token_id,
        display_name, public_key, enrolled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runnerId,
      owner.organizationId,
      runnerPrincipalId,
      tokenId,
      runnerId,
      "A".repeat(43),
      createdAt,
    );
  database
    .prepare(
      `INSERT INTO runs (
        id, organization_id, requested_by, kind, status, max_claims,
        deadline_at, engine, assigned_runner_id, required_capability,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, 'engine_prompt', 'queued', 2, ?,
        'claude_code_cli', ?, NULL, ?, ?
      )`,
    )
    .run(
      runId,
      owner.organizationId,
      owner.ownerId,
      "2025-01-01T00:20:00.000Z",
      runnerId,
      createdAt,
      createdAt,
    );
  database
    .prepare(
      `INSERT INTO run_prompts (
        run_id, organization_id, prompt_ref, cipher_version, key_id,
        iv, ciphertext, tag, prompt_sha256, prompt_bytes, created_at
      ) VALUES (?, ?, ?, 1, 'key-a', ?, ?, ?, ?, 4, ?)`,
    )
    .run(
      runId,
      owner.organizationId,
      `prm_${suffix.repeat(32)}`,
      Buffer.alloc(12, 1),
      Buffer.alloc(4, 2),
      Buffer.alloc(16, 3),
      suffix.repeat(64),
      createdAt,
    );
  return { createdAt, runId };
}

test("engine creation resolutions are tenant-bound, immutable and retained", () => {
  const database = migratedDatabase();
  const ownerA = seedOwner(database, "a");
  const ownerB = seedOwner(database, "b");
  const run = seedEngineRun(database, ownerA, "a");
  const creationId = `ecr_${"a".repeat(32)}`;
  const requestHash = "1".repeat(64);

  database
    .prepare(
      `INSERT INTO engine_run_creations (
        organization_id, requested_by, creation_id, request_hash, state,
        run_id, reconciliation_id, created_at, updated_at, retain_until
      ) VALUES (?, ?, ?, ?, 'created', ?, NULL, ?, ?, ?)`,
    )
    .run(
      ownerA.organizationId,
      ownerA.ownerId,
      creationId,
      requestHash,
      run.runId,
      run.createdAt,
      run.createdAt,
      "2025-01-31T00:00:00.000Z",
    );
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE engine_run_creations SET request_hash = ? WHERE creation_id = ?",
        )
        .run("2".repeat(64), creationId),
    /immutable_engine_run_creation/u,
  );
  assert.throws(
    () =>
      database
        .prepare(
          "DELETE FROM engine_run_creations WHERE creation_id = ?",
        )
        .run(creationId),
    /immutable_engine_run_creation/u,
    "created resolutions live with their run even after retain_until",
  );

  const proofId = `ncp_${"b".repeat(32)}`;
  database
    .prepare(
      `INSERT INTO engine_run_creations (
        organization_id, requested_by, creation_id, request_hash, state,
        run_id, reconciliation_id, created_at, updated_at, retain_until
      ) VALUES (
        ?, ?, ?, NULL, 'confirmed_not_created', NULL, ?, ?, ?, ?
      )`,
    )
    .run(
      ownerB.organizationId,
      ownerB.ownerId,
      creationId,
      proofId,
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
      "2025-01-31T00:00:00.000Z",
    );
  assert.equal(
    database
      .prepare(
        `SELECT request_hash
         FROM engine_run_creations
         WHERE organization_id = ? AND requested_by = ?`,
      )
      .get(ownerB.organizationId, ownerB.ownerId).request_hash,
    null,
  );
  assert.equal(
    database
      .prepare(
        `DELETE FROM engine_run_creations
         WHERE organization_id = ? AND requested_by = ?`,
      )
      .run(ownerB.organizationId, ownerB.ownerId).changes,
    1,
    "only an aged confirmed_not_created proof is collectable",
  );

  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO engine_run_creations (
            organization_id, requested_by, creation_id, request_hash,
            state, run_id, reconciliation_id, created_at, updated_at,
            retain_until
          ) VALUES (
            ?, ?, ?, NULL, 'confirmed_not_created', NULL, ?, ?, ?, ?
          )`,
        )
        .run(
          ownerA.organizationId,
          ownerB.ownerId,
          `ecr_${"c".repeat(32)}`,
          `ncp_${"c".repeat(32)}`,
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          "2026-01-31T00:00:00.000Z",
        ),
    /invalid_engine_run_creation/u,
    "requester authority cannot cross tenant boundaries",
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO engine_run_creations (
            organization_id, requested_by, creation_id, request_hash,
            state, run_id, reconciliation_id, created_at, updated_at,
            retain_until
          ) VALUES (
            ?, ?, ?, NULL, 'confirmed_not_created', NULL, ?, ?, ?, ?
          )`,
        )
        .run(
          ownerA.organizationId,
          ownerA.ownerId,
          `ecr_${"d".repeat(32)}`,
          `ncp_${"d".repeat(32)}`,
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
          "2026-01-30T23:59:59.999Z",
        ),
    /engine_run_creations_retention_check/u,
  );
});
