import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import {
  MUTATION_ENGINE_RUN_CREATION_RETENTION_LIMIT,
  reconcileDueEngineRunCreationRetention,
  SCHEDULED_ENGINE_RUN_CREATION_RETENTION_LIMIT,
} from "@/src/adapters/d1/engine-run-creation-retention-repository";

test("engine creation retention is bounded and wired without identifier logs", () => {
  assert.equal(MUTATION_ENGINE_RUN_CREATION_RETENTION_LIMIT, 20);
  assert.equal(SCHEDULED_ENGINE_RUN_CREATION_RETENTION_LIMIT, 100);
  const repository = readFileSync(
    new URL(
      "../../src/adapters/d1/engine-run-creation-retention-repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const scheduler = readFileSync(
    new URL(
      "../../src/adapters/d1/schedule-deadline-reconciliation.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const worker = readFileSync(
    new URL("../../worker/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    repository,
    /state = 'confirmed_not_created'[\s\S]*?retain_until <= \?[\s\S]*?ORDER BY retain_until, creation_id[\s\S]*?limit \+ 1/u,
  );
  assert.match(
    repository,
    /DELETE FROM engine_run_creations[\s\S]*?state = 'confirmed_not_created'[\s\S]*?retain_until = \?[\s\S]*?retain_until <= \?/u,
  );
  assert.match(scheduler, /reconcileDueEngineRunCreationRetention/u);
  assert.match(worker, /reconcileDueEngineRunCreationRetention/u);
  for (const source of [scheduler, worker]) {
    const logBlocks = source
      .split("\n")
      .filter((line) => line.includes("engine-creation-retention"))
      .join("\n");
    assert.doesNotMatch(
      logBlocks,
      /creationId|requestedBy|organizationId/u,
    );
  }
});

test("real SQLite sweep preserves created and future rows across both caps", async () => {
  const database = migratedDatabase();
  const owner = seedOwnerAndEngineRun(database);
  seedCreationRows(database, owner);
  const d1 = sqliteD1(database);
  const observedAt = "2026-07-28T12:00:00.000Z";

  assert.deepEqual(
    await reconcileDueEngineRunCreationRetention(d1, {
      mode: "mutation",
      now: observedAt,
    }),
    {
      mode: "mutation",
      limit: 20,
      observedAt,
      scanned: 20,
      deleted: 20,
      skipped: 0,
      truncated: true,
    },
  );
  assert.equal(countExpiredProofs(database), 102);
  assertPreservedRows(database);

  assert.deepEqual(
    await reconcileDueEngineRunCreationRetention(d1, {
      mode: "scheduled",
      now: observedAt,
    }),
    {
      mode: "scheduled",
      limit: 100,
      observedAt,
      scanned: 100,
      deleted: 100,
      skipped: 0,
      truncated: true,
    },
  );
  assert.equal(countExpiredProofs(database), 2);
  assertPreservedRows(database);

  assert.deepEqual(
    await reconcileDueEngineRunCreationRetention(d1, {
      mode: "scheduled",
      now: observedAt,
    }),
    {
      mode: "scheduled",
      limit: 100,
      observedAt,
      scanned: 2,
      deleted: 2,
      skipped: 0,
      truncated: false,
    },
  );
  assert.equal(countExpiredProofs(database), 0);
  assertPreservedRows(database);
});

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (
    const migration of readdirSync(
      new URL("../../drizzle/", import.meta.url),
    )
      .filter((name) => name.endsWith(".sql"))
      .sort()
  ) {
    database.exec(
      readFileSync(
        new URL(`../../drizzle/${migration}`, import.meta.url),
        "utf8",
      ).replaceAll("--> statement-breakpoint", ""),
    );
  }
  return database;
}

function seedOwnerAndEngineRun(database: DatabaseSync): {
  organizationId: string;
  ownerId: string;
  runId: string;
} {
  const organizationId = "org-retention";
  const ownerId = "owner-retention";
  const runnerPrincipalId = "runner-principal-retention";
  const runnerId = "runner-retention";
  const runId = `run_${"f".repeat(32)}`;
  const createdAt = "2024-01-01T00:00:00.000Z";
  database
    .prepare("INSERT INTO organizations (id, slug, name) VALUES (?, ?, ?)")
    .run(organizationId, "retention", "Retention");
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
      ) VALUES ('membership-retention', ?, ?, 'owner')`,
    )
    .run(organizationId, ownerId);
  database
    .prepare(
      `INSERT INTO principals (
        id, organization_id, kind, external_id, display_name
      ) VALUES (?, ?, 'runner', ?, ?)`,
    )
    .run(runnerPrincipalId, organizationId, runnerId, runnerId);
  database
    .prepare(
      `INSERT INTO runner_enrollment_tokens (
        id, organization_id, token_hash, issued_by, display_name,
        issued_at, expires_at
      ) VALUES ('token-retention', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      organizationId,
      createHash("sha256").update("retention").digest("hex"),
      ownerId,
      runnerId,
      createdAt,
      "2024-01-01T01:00:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO runners (
        id, organization_id, principal_id, enrollment_token_id,
        display_name, public_key, enrolled_at
      ) VALUES (?, ?, ?, 'token-retention', ?, ?, ?)`,
    )
    .run(
      runnerId,
      organizationId,
      runnerPrincipalId,
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
      organizationId,
      ownerId,
      "2024-01-01T00:20:00.000Z",
      runnerId,
      createdAt,
      createdAt,
    );
  return { organizationId, ownerId, runId };
}

function seedCreationRows(
  database: DatabaseSync,
  owner: { organizationId: string; ownerId: string; runId: string },
): void {
  const insert = database.prepare(
    `INSERT INTO engine_run_creations (
      organization_id, requested_by, creation_id, request_hash, state,
      run_id, reconciliation_id, created_at, updated_at, retain_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    owner.organizationId,
    owner.ownerId,
    `ecr_${"f".repeat(32)}`,
    "a".repeat(64),
    "created",
    owner.runId,
    null,
    "2024-01-01T00:00:00.000Z",
    "2024-01-01T00:00:00.000Z",
    "2025-01-01T00:00:00.000Z",
  );
  insert.run(
    owner.organizationId,
    owner.ownerId,
    `ecr_${"e".repeat(32)}`,
    null,
    "confirmed_not_created",
    null,
    `ncp_${"e".repeat(32)}`,
    "2098-01-01T00:00:00.000Z",
    "2098-01-01T00:00:00.000Z",
    "2099-01-01T00:00:00.000Z",
  );
  for (let index = 0; index < 122; index += 1) {
    const suffix = index.toString(16).padStart(32, "0");
    insert.run(
      owner.organizationId,
      owner.ownerId,
      `ecr_${suffix}`,
      null,
      "confirmed_not_created",
      null,
      `ncp_${suffix}`,
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
    );
  }
}

function countExpiredProofs(database: DatabaseSync): number {
  return Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM engine_run_creations
         WHERE state = 'confirmed_not_created'
           AND retain_until = '2025-01-01T00:00:00.000Z'`,
      )
      .get()?.count,
  );
}

function assertPreservedRows(database: DatabaseSync): void {
  assert.deepEqual(
    database
      .prepare(
        `SELECT state, COUNT(*) AS count
         FROM engine_run_creations
         WHERE creation_id IN (?, ?)
         GROUP BY state
         ORDER BY state`,
      )
      .all(`ecr_${"e".repeat(32)}`, `ecr_${"f".repeat(32)}`)
      .map((row) => ({ ...row })),
    [
      { state: "confirmed_not_created", count: 1 },
      { state: "created", count: 1 },
    ],
  );
}

function sqliteD1(database: DatabaseSync): D1Database {
  const prepare = (query: string): D1PreparedStatement => {
    let values: SQLInputValue[] = [];
    const statement = {
      bind(...nextValues: unknown[]) {
        values = nextValues as SQLInputValue[];
        return statement;
      },
      async all<T>() {
        return {
          results: database.prepare(query).all(...values) as T[],
          success: true,
          meta: {},
        };
      },
      async run<T>() {
        const result = database.prepare(query).run(...values);
        return {
          results: [] as T[],
          success: true,
          meta: { changes: Number(result.changes) },
        };
      },
    };
    return statement as unknown as D1PreparedStatement;
  };
  return {
    prepare,
    async batch<T>(statements: D1PreparedStatement[]) {
      return Promise.all(
        statements.map((statement) => statement.run<T>()),
      );
    },
  } as unknown as D1Database;
}
