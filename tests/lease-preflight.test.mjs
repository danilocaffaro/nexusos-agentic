import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DUPLICATE_ACTIVE_LEASES_SQL,
  MISSING_RECONCILIATION_EVENTS_SQL,
  RECONCILE_EVENTS_SQL,
  buildReconcileLeasesSql,
  parseArguments,
  parseWranglerJson,
} from "../scripts/lease-preflight.mjs";

test("operator arguments are local and list-only unless explicitly elevated", () => {
  assert.deepEqual(parseArguments([]), {
    apply: false,
    target: "local",
    config: "wrangler.local.jsonc",
    database: "DB",
    persistTo: ".wrangler/state",
    help: false,
  });
  assert.deepEqual(
    parseArguments([
      "--remote",
      "--config",
      "wrangler.production.jsonc",
      "--database",
      "NEXUS_DB",
      "--apply",
    ]),
    {
      apply: true,
      target: "remote",
      config: "wrangler.production.jsonc",
      database: "NEXUS_DB",
      persistTo: ".wrangler/state",
      help: false,
    },
  );
  assert.throws(() => parseArguments(["--remote"]), /requires --config/u);
  assert.throws(
    () => parseArguments(["--local", "--remote", "--config", "x.jsonc"]),
    /choose exactly one/u,
  );
  assert.throws(() => parseArguments(["--surprise"]), /unknown argument/u);
});

test("Wrangler JSON parsing is strict and bounded to successful documents", () => {
  assert.deepEqual(
    parseWranglerJson(
      JSON.stringify([
        { success: true, results: [{ lease_id: "lse_1" }], meta: { changes: 2 } },
      ]),
    ),
    { rows: [{ lease_id: "lse_1" }] },
  );
  assert.throws(() => parseWranglerJson("not json"), /non-JSON/u);
  assert.throws(
    () => parseWranglerJson(JSON.stringify([{ success: false }])),
    /unsuccessful/u,
  );
});

test("preflight deterministically reconciles duplicate runner leases and recovers phase-two crashes", () => {
  const database = createMigratedDatabase();
  seedDuplicateRunnerLeases(database);

  const bytesBeforeList = snapshotState(database);
  const listed = database
    .prepare(DUPLICATE_ACTIVE_LEASES_SQL)
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(listed, [
    {
      runner_id: "runner-preflight",
      lease_id: `lse_${"3".repeat(32)}`,
      run_id: `run_${"3".repeat(32)}`,
      fence: 1,
      issued_at: "2026-07-26T12:02:00.000Z",
      expires_at: "2026-07-26T12:05:00.000Z",
      disposition: "survivor",
    },
    {
      runner_id: "runner-preflight",
      lease_id: `lse_${"2".repeat(32)}`,
      run_id: `run_${"2".repeat(32)}`,
      fence: 1,
      issued_at: "2026-07-26T12:02:00.000Z",
      expires_at: "2026-07-26T12:05:00.000Z",
      disposition: "loser",
    },
    {
      runner_id: "runner-preflight",
      lease_id: `lse_${"1".repeat(32)}`,
      run_id: `run_${"1".repeat(32)}`,
      fence: 1,
      issued_at: "2026-07-26T12:01:00.000Z",
      expires_at: "2026-07-26T12:05:00.000Z",
      disposition: "loser",
    },
  ]);
  assert.deepEqual(snapshotState(database), bytesBeforeList);

  const occurredAt = "2026-07-26T12:06:00.000Z";
  const phaseOne = database
    .prepare(buildReconcileLeasesSql(occurredAt))
    .all();
  assert.equal(phaseOne.length, 2);
  assert.deepEqual(database.prepare(DUPLICATE_ACTIVE_LEASES_SQL).all(), []);

  const missingAfterCrash = database
    .prepare(MISSING_RECONCILIATION_EVENTS_SQL)
    .all();
  assert.equal(missingAfterCrash.length, 2);
  assert.deepEqual(
    database
      .prepare(
        `SELECT id, status, current_lease_id
         FROM runs
         ORDER BY id`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { id: `run_${"1".repeat(32)}`, status: "queued", current_lease_id: null },
      { id: `run_${"2".repeat(32)}`, status: "queued", current_lease_id: null },
      {
        id: `run_${"3".repeat(32)}`,
        status: "leased",
        current_lease_id: `lse_${"3".repeat(32)}`,
      },
    ],
  );

  const insertedEvents = database
    .prepare(RECONCILE_EVENTS_SQL)
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(insertedEvents, [
    { run_id: `run_${"1".repeat(32)}`, fence: 1 },
    { run_id: `run_${"2".repeat(32)}`, fence: 1 },
  ]);
  assert.deepEqual(
    database
      .prepare(
        `SELECT
           event.run_id,
           event.kind,
           event.actor_id,
           event.fence,
           event.occurred_at,
           event.metadata_json
         FROM run_events AS event
         WHERE event.kind = 'lease.superseded'
         ORDER BY event.run_id`,
      )
      .all()
      .map((row) => ({ ...row, metadata_json: JSON.parse(row.metadata_json) })),
    [
      {
        run_id: `run_${"1".repeat(32)}`,
        kind: "lease.superseded",
        actor_id: "principal-preflight-runner",
        fence: 1,
        occurred_at: occurredAt,
        metadata_json: {
          leaseId: `lse_${"1".repeat(32)}`,
          runnerId: "runner-preflight",
          fence: 1,
          reason: "preflight_reconciled",
        },
      },
      {
        run_id: `run_${"2".repeat(32)}`,
        kind: "lease.superseded",
        actor_id: "principal-preflight-runner",
        fence: 1,
        occurred_at: occurredAt,
        metadata_json: {
          leaseId: `lse_${"2".repeat(32)}`,
          runnerId: "runner-preflight",
          fence: 1,
          reason: "preflight_reconciled",
        },
      },
    ],
  );
  assert.deepEqual(
    database.prepare(MISSING_RECONCILIATION_EVENTS_SQL).all(),
    [],
  );

  const completedBytes = snapshotState(database);
  assert.equal(
    database
      .prepare(buildReconcileLeasesSql("2026-07-26T12:07:00.000Z"))
      .all().length,
    0,
  );
  assert.equal(database.prepare(RECONCILE_EVENTS_SQL).all().length, 0);
  assert.deepEqual(snapshotState(database), completedBytes);
  database.close();
});

test("reconciliation requires canonical operator time", () => {
  assert.throws(
    () => buildReconcileLeasesSql("2026-07-26 12:00:00"),
    /canonical ISO-8601/u,
  );
  assert.throws(
    () => buildReconcileLeasesSql("not-a-date"),
    /Invalid time value/u,
  );
});

test("phase two allocates ordered sequences for multiple repaired leases on one run", () => {
  const database = createMigratedDatabase();
  seedDuplicateRunnerLeases(database);
  const runId = `run_${"1".repeat(32)}`;
  const firstLeaseId = `lse_${"1".repeat(32)}`;
  const secondLeaseId = `lse_${"4".repeat(32)}`;

  database
    .prepare(
      `UPDATE run_leases
       SET status = 'superseded', ended_at = ?, ended_reason = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      "2026-07-26T12:06:00.000Z",
      "preflight_reconciled",
      "2026-07-26T12:06:00.000Z",
      firstLeaseId,
    );
  database
    .prepare(
      `INSERT INTO run_leases (
        id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
        created_at, updated_at
      ) VALUES (
        ?, 'org-preflight', ?, 'runner-preflight', 2, ?, ?, ?, ?
      )`,
    )
    .run(
      secondLeaseId,
      runId,
      "2026-07-26T12:07:00.000Z",
      "2026-07-26T12:08:00.000Z",
      "2026-07-26T12:07:00.000Z",
      "2026-07-26T12:07:00.000Z",
    );
  database
    .prepare(
      `UPDATE run_leases
       SET status = 'superseded', ended_at = ?, ended_reason = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      "2026-07-26T12:09:00.000Z",
      "preflight_reconciled",
      "2026-07-26T12:09:00.000Z",
      secondLeaseId,
    );

  assert.equal(
    database
      .prepare(MISSING_RECONCILIATION_EVENTS_SQL)
      .all()
      .filter((row) => row.run_id === runId).length,
    2,
  );
  const insertedSameRun = database
    .prepare(RECONCILE_EVENTS_SQL)
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(insertedSameRun, [
    { run_id: runId, fence: 1 },
    { run_id: runId, fence: 2 },
  ]);
  assert.deepEqual(
    database
      .prepare(
        `SELECT sequence, kind, fence
         FROM run_events
         WHERE run_id = ?
         ORDER BY sequence`,
      )
      .all(runId)
      .map((row) => ({ ...row })),
    [
      { sequence: 1, kind: "run.created", fence: null },
      { sequence: 2, kind: "lease.superseded", fence: 1 },
      { sequence: 3, kind: "lease.superseded", fence: 2 },
    ],
  );
  database.close();
});

function createMigratedDatabase() {
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

function seedDuplicateRunnerLeases(database) {
  database.exec(`
    INSERT INTO organizations (id, slug, name)
    VALUES ('org-preflight', 'preflight', 'Preflight');

    INSERT INTO principals (
      id, organization_id, kind, display_name
    ) VALUES (
      'owner-preflight', 'org-preflight', 'human', 'Preflight owner'
    );

    INSERT INTO memberships (
      id, organization_id, principal_id, role
    ) VALUES (
      'membership-preflight',
      'org-preflight',
      'owner-preflight',
      'owner'
    );

    INSERT INTO principals (
      id, organization_id, kind, external_id, display_name
    ) VALUES (
      'principal-preflight-runner',
      'org-preflight',
      'runner',
      'runner-preflight',
      'Preflight runner'
    );

    INSERT INTO runner_enrollment_tokens (
      id, organization_id, token_hash, issued_by, display_name,
      issued_at, expires_at
    ) VALUES (
      'token-preflight',
      'org-preflight',
      '${"a".repeat(64)}',
      'owner-preflight',
      'Preflight runner',
      '2026-07-26T12:00:00.000Z',
      '2026-07-26T12:15:00.000Z'
    );

    INSERT INTO runners (
      id, organization_id, principal_id, enrollment_token_id,
      display_name, public_key, enrolled_at
    ) VALUES (
      'runner-preflight',
      'org-preflight',
      'principal-preflight-runner',
      'token-preflight',
      'Preflight runner',
      '${"A".repeat(43)}',
      '2026-07-26T12:00:30.000Z'
    );
  `);

  for (const [digit, issuedAt] of [
    ["1", "2026-07-26T12:01:00.000Z"],
    ["2", "2026-07-26T12:02:00.000Z"],
    ["3", "2026-07-26T12:02:00.000Z"],
  ]) {
    const runId = `run_${digit.repeat(32)}`;
    const leaseId = `lse_${digit.repeat(32)}`;
    database
      .prepare(
        `INSERT INTO runs (
          id, organization_id, requested_by, deadline_at, created_at, updated_at
        ) VALUES (?, 'org-preflight', 'owner-preflight', ?, ?, ?)`,
      )
      .run(
        runId,
        "2026-07-26T12:15:00.000Z",
        "2026-07-26T12:00:00.000Z",
        "2026-07-26T12:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO run_events (
          organization_id, run_id, sequence, kind, actor_id, occurred_at
        ) VALUES ('org-preflight', ?, 1, 'run.created', 'owner-preflight', ?)`,
      )
      .run(runId, "2026-07-26T12:00:00.000Z");
    database
      .prepare(
        `INSERT INTO run_leases (
          id, organization_id, run_id, runner_id, fence, issued_at, expires_at,
          created_at, updated_at
        ) VALUES (
          ?, 'org-preflight', ?, 'runner-preflight', 1, ?,
          '2026-07-26T12:05:00.000Z', ?, ?
        )`,
      )
      .run(leaseId, runId, issuedAt, issuedAt, issuedAt);
  }
}

function snapshotState(database) {
  return {
    leases: database
      .prepare(
        `SELECT id, status, ended_at, ended_reason, updated_at
         FROM run_leases
         ORDER BY id`,
      )
      .all(),
    runs: database
      .prepare(
        `SELECT id, status, current_lease_id, version, updated_at
         FROM runs
         ORDER BY id`,
      )
      .all(),
    events: database
      .prepare(
        `SELECT run_id, sequence, kind, actor_id, fence, occurred_at, metadata_json
         FROM run_events
         ORDER BY run_id, sequence`,
      )
      .all(),
  };
}
