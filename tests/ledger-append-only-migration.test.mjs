import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const BREAKPOINT = "--> statement-breakpoint";
const migrations = readdirSync(new URL("../drizzle/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const appendOnlyMigration = "0030_decision_ledger_append_only.sql";
const appendOnlyTriggers = [
  "action_intents_prevent_delete",
  "action_intents_restrict_update",
  "intent_approvals_prevent_delete",
  "intent_approvals_prevent_replace",
  "intent_approvals_prevent_update",
  "ledger_entries_prevent_delete",
  "ledger_entries_prevent_replace",
  "ledger_entries_prevent_update",
];

test("0030 upgrades populated decision history without rewriting it", () => {
  const database = populatedDatabaseBefore0030();
  const before = decisionSnapshot(database);

  applyMigration(database, appendOnlyMigration);

  assert.deepEqual(decisionSnapshot(database), before);
  assert.deepEqual(
    database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'trigger'
           AND name IN (${appendOnlyTriggers.map(() => "?").join(", ")})
         ORDER BY name`,
      )
      .all(...appendOnlyTriggers)
      .map(({ name }) => name),
    appendOnlyTriggers,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("0030 makes ledger entries and approvals append-only even under replace", () => {
  const database = populatedDatabaseAfter0030();
  const originalLedger = ledgerRow(database, "ledger-proposed");
  const originalApproval = approvalRow(database, "approval-owner");

  for (const recursiveTriggers of ["OFF", "ON"]) {
    database.exec(`PRAGMA recursive_triggers = ${recursiveTriggers}`);
    assert.throws(
      () =>
        insertLedger(database, {
          id: "ledger-proposed",
          sequence: 101,
          hash: `replacement-id-${recursiveTriggers}`,
          replace: true,
        }),
      /ledger_entry_is_immutable/u,
    );
    assert.throws(
      () =>
        insertLedger(database, {
          id: `replacement-sequence-${recursiveTriggers}`,
          sequence: 1,
          hash: `replacement-sequence-hash-${recursiveTriggers}`,
          replace: true,
        }),
      /UNIQUE constraint failed: ledger_entries\.organization_id, ledger_entries\.sequence/u,
    );
    assert.throws(
      () =>
        insertLedger(database, {
          id: `replacement-hash-${recursiveTriggers}`,
          sequence: recursiveTriggers === "OFF" ? 102 : 103,
          hash: "hash-proposed",
          replace: true,
        }),
      /ledger_entry_is_immutable/u,
    );
    assert.deepEqual(ledgerRow(database, "ledger-proposed"), originalLedger);

    assert.throws(
      () =>
        database
          .prepare(
            `INSERT OR REPLACE INTO intent_approvals (
              id, intent_id, actor_id, actor_kind, parameters_hash,
              solo_owner_acknowledged, approved_at
            ) VALUES (?, ?, ?, 'human', ?, 0, ?)`,
          )
          .run(
            "approval-owner",
            "intent-approval",
            "principal-peer",
            "parameters-hash",
            "2026-07-30T12:02:00.000Z",
          ),
      /UNIQUE constraint failed: intent_approvals\.intent_id, intent_approvals\.actor_id/u,
    );
    assert.deepEqual(
      approvalRow(database, "approval-owner"),
      originalApproval,
    );
  }

  assert.throws(
    () =>
      database
        .prepare("UPDATE ledger_entries SET kind = 'forged' WHERE id = ?")
        .run("ledger-proposed"),
    /ledger_entry_is_immutable/u,
  );
  assert.throws(
    () =>
      database
        .prepare("DELETE FROM ledger_entries WHERE id = ?")
        .run("ledger-proposed"),
    /ledger_entry_is_immutable/u,
  );
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE intent_approvals SET actor_kind = 'agent' WHERE id = ?",
        )
        .run("approval-owner"),
    /intent_approval_is_immutable/u,
  );
  assert.throws(
    () =>
      database
        .prepare("DELETE FROM intent_approvals WHERE id = ?")
        .run("approval-owner"),
    /intent_approval_is_immutable/u,
  );

  insertLedger(database, {
    id: "ledger-next",
    sequence: 2,
    hash: "hash-next",
  });
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM ledger_entries")
      .get().count,
    2,
  );
});

test("0030 permits only the persisted action-intent transitions", () => {
  const database = populatedDatabaseAfter0030();

  database
    .prepare(
      `INSERT INTO intent_approvals (
        id, intent_id, actor_id, actor_kind, parameters_hash,
        solo_owner_acknowledged, approved_at
      ) VALUES (?, ?, ?, 'human', ?, 0, ?)`,
    )
    .run(
      "approval-peer",
      "intent-approval",
      "principal-peer",
      "parameters-hash",
      "2026-07-30T12:02:00.000Z",
    );
  assert.equal(
    database
      .prepare(
        `UPDATE action_intents
         SET status = 'approved', updated_at = ?
         WHERE id = ?`,
      )
      .run("2026-07-30T12:02:00.000Z", "intent-approval").changes,
    1,
  );
  assert.equal(
    database
      .prepare(
        `UPDATE action_intents
         SET status = 'succeeded', fencing_token = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(17, "2026-07-30T12:03:00.000Z", "intent-approval").changes,
    1,
  );

  assert.equal(
    database
      .prepare(
        `UPDATE action_intents
         SET status = 'failed', updated_at = ?
         WHERE id = ?`,
      )
      .run("2026-07-30T12:04:00.000Z", "intent-failure").changes,
    1,
  );
  assert.equal(
    database
      .prepare(
        `UPDATE action_intents
         SET status = 'expired', updated_at = ?
         WHERE id = ?`,
      )
      .run("2026-07-30T12:05:00.000Z", "intent-expiry").changes,
    1,
  );

  for (const [sql, parameters, error] of [
    [
      "UPDATE action_intents SET parameters_json = '{}' WHERE id = ?",
      ["intent-tamper"],
      /action_intent_decision_is_immutable/u,
    ],
    [
      "UPDATE action_intents SET updated_at = ? WHERE id = ?",
      ["2026-07-30T12:06:00.000Z", "intent-tamper"],
      /action_intent_transition_is_invalid/u,
    ],
    [
      "UPDATE action_intents SET fencing_token = 9 WHERE id = ?",
      ["intent-tamper"],
      /action_intent_transition_is_invalid/u,
    ],
    [
      "UPDATE action_intents SET status = 'cancelled', updated_at = ? WHERE id = ?",
      ["2026-07-30T12:06:00.000Z", "intent-tamper"],
      /action_intent_transition_is_invalid/u,
    ],
    [
      "DELETE FROM action_intents WHERE id = ?",
      ["intent-tamper"],
      /action_intent_history_is_immutable/u,
    ],
  ]) {
    assert.throws(() => database.prepare(sql).run(...parameters), error);
  }

  const before = database
    .prepare(
      "SELECT id, kind, hash FROM ledger_entries ORDER BY sequence",
    )
    .all();
  assert.throws(
    () =>
      database
        .prepare("UPDATE ledger_entries SET kind = 'forged'")
        .run(),
    /ledger_entry_is_immutable/u,
  );
  assert.deepEqual(
    database
      .prepare(
        "SELECT id, kind, hash FROM ledger_entries ORDER BY sequence",
      )
      .all(),
    before,
  );

  database.exec("PRAGMA foreign_keys = OFF");
  assert.throws(
    () =>
      database
        .prepare("DELETE FROM ledger_entries WHERE id = ?")
        .run("ledger-proposed"),
    /ledger_entry_is_immutable/u,
  );
});

function populatedDatabaseAfter0030() {
  const database = populatedDatabaseBefore0030();
  applyMigration(database, appendOnlyMigration);
  return database;
}

function populatedDatabaseBefore0030() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) {
    if (migration === appendOnlyMigration) break;
    applyMigration(database, migration);
  }
  seedDecisionHistory(database);
  return database;
}

function applyMigration(database, migration) {
  database.exec(
    readFileSync(
      new URL(`../drizzle/${migration}`, import.meta.url),
      "utf8",
    ).replaceAll(BREAKPOINT, ""),
  );
}

function seedDecisionHistory(database) {
  database
    .prepare(
      `INSERT INTO organizations (id, slug, name)
       VALUES ('org-ledger', 'ledger', 'Ledger')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO projects (id, organization_id, slug, name, objective)
       VALUES ('project-ledger', 'org-ledger', 'ledger', 'Ledger', 'Seal history')`,
    )
    .run();
  for (const [id, name] of [
    ["principal-owner", "Owner"],
    ["principal-peer", "Peer"],
  ]) {
    database
      .prepare(
        `INSERT INTO principals (
          id, organization_id, kind, display_name
        ) VALUES (?, 'org-ledger', 'human', ?)`,
      )
      .run(id, name);
  }
  for (const intent of [
    {
      id: "intent-approval",
      requiredApprovals: 2,
      status: "proposed",
      expiresAt: "2026-07-31T12:00:00.000Z",
    },
    {
      id: "intent-failure",
      requiredApprovals: 1,
      status: "approved",
      expiresAt: "2026-07-31T12:00:00.000Z",
    },
    {
      id: "intent-expiry",
      requiredApprovals: 1,
      status: "proposed",
      expiresAt: "2026-07-30T12:04:00.000Z",
    },
    {
      id: "intent-tamper",
      requiredApprovals: 1,
      status: "proposed",
      expiresAt: "2026-07-31T12:00:00.000Z",
    },
  ]) {
    database
      .prepare(
        `INSERT INTO action_intents (
          id, organization_id, project_id, proposer_id, proposer_kind,
          action_type, target_ref, parameters_json, parameters_hash,
          preconditions_json, risk_tier, policy_decision_json,
          required_approvals, expires_at, idempotency_key, status,
          separation_of_duties, self_approval_policy, created_at, updated_at
        ) VALUES (
          ?, 'org-ledger', 'project-ledger', 'principal-owner', 'human',
          'nexus.test', ?, '{"value":1}', 'parameters-hash',
          '[]', 'medium', '{"effect":"require_approval"}',
          ?, ?, ?, ?, 1, NULL, ?, ?
        )`,
      )
      .run(
        intent.id,
        `target:${intent.id}`,
        intent.requiredApprovals,
        intent.expiresAt,
        `idempotency:${intent.id}`,
        intent.status,
        "2026-07-30T12:00:00.000Z",
        "2026-07-30T12:00:00.000Z",
      );
  }
  database
    .prepare(
      `INSERT INTO intent_approvals (
        id, intent_id, actor_id, actor_kind, parameters_hash,
        solo_owner_acknowledged, approved_at
      ) VALUES (
        'approval-owner', 'intent-approval', 'principal-owner',
        'human', 'parameters-hash', 0, '2026-07-30T12:01:00.000Z'
      )`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, intent_id, previous_hash, hash
      ) VALUES (
        'ledger-proposed', 'org-ledger', 1, 'intent.proposed',
        'principal-owner', '2026-07-30T12:00:00.000Z',
        'payload-proposed', 'intent-approval', 'GENESIS', 'hash-proposed'
      )`,
    )
    .run();
}

function decisionSnapshot(database) {
  return {
    intents: database
      .prepare("SELECT * FROM action_intents ORDER BY id")
      .all(),
    approvals: database
      .prepare("SELECT * FROM intent_approvals ORDER BY id")
      .all(),
    ledger: database
      .prepare("SELECT * FROM ledger_entries ORDER BY sequence")
      .all(),
  };
}

function ledgerRow(database, id) {
  return database
    .prepare("SELECT * FROM ledger_entries WHERE id = ?")
    .get(id);
}

function approvalRow(database, id) {
  return database
    .prepare("SELECT * FROM intent_approvals WHERE id = ?")
    .get(id);
}

function insertLedger(
  database,
  { id, sequence, hash, replace = false },
) {
  return database
    .prepare(
      `INSERT ${replace ? "OR REPLACE " : ""}INTO ledger_entries (
        id, organization_id, sequence, kind, actor_id, occurred_at,
        payload_hash, intent_id, previous_hash, hash
      ) VALUES (?, 'org-ledger', ?, 'intent.proposed', 'principal-owner',
        '2026-07-30T12:10:00.000Z', 'payload-next',
        'intent-approval', 'hash-proposed', ?)`,
    )
    .run(id, sequence, hash);
}
