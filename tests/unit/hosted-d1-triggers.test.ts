import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  assertHostedD1TriggerAttestation,
  canonicalHostedD1TriggerSql,
  finalHostedD1Triggers,
} from "@/src/domain/hosted-d1-triggers";

const BREAKPOINT = "--> statement-breakpoint";
const migrationNames = readdirSync(
  new URL("../../drizzle/", import.meta.url),
)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migrations = migrationNames
  .map((name) =>
    readFileSync(
      new URL(`../../drizzle/${name}`, import.meta.url),
      "utf8",
    ),
  );
const bootstrapSource = readFileSync(
  new URL(
    "../../src/adapters/d1/hosted-trigger-bootstrap.ts",
    import.meta.url,
  ),
  "utf8",
);

test("hosted trigger manifest restores the exact final trigger boundary", () => {
  const canonical = new DatabaseSync(":memory:");
  const hosted = new DatabaseSync(":memory:");
  canonical.exec("PRAGMA foreign_keys = ON");
  hosted.exec("PRAGMA foreign_keys = ON");

  for (const migration of migrations) {
    canonical.exec(migration.replaceAll(BREAKPOINT, ""));
    const triggerFree = migration
      .split(BREAKPOINT)
      .filter(
        (statement) =>
          !/^\s*(?:CREATE|DROP)\s+TRIGGER\b/iu.test(
            stripLeadingComments(statement),
          ),
      )
      .join(BREAKPOINT);
    hosted.exec(triggerFree.replaceAll(BREAKPOINT, ""));
  }

  const triggers = finalHostedD1Triggers(migrations);
  assert.equal(triggers.length, 134);
  for (const { createSql, name } of triggers) {
    hosted.exec(createSql);
    const observed = hosted
      .prepare(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'trigger' AND name = ?`,
      )
      .get(name) as { sql: string };
    assert.equal(
      canonicalHostedD1TriggerSql(observed.sql),
      canonicalHostedD1TriggerSql(createSql),
    );
  }
  const observedTriggers = hosted
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'trigger'
       ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string }>;
  assert.doesNotThrow(() =>
    assertHostedD1TriggerAttestation(triggers, observedTriggers),
  );
  assert.deepEqual(triggerNames(hosted), triggerNames(canonical));
});

test("hosted trigger manifest is frozen, idempotent SQL and fail-closed", () => {
  const triggers = finalHostedD1Triggers(migrations);
  assert.equal(Object.isFrozen(triggers), true);
  assert.equal(triggers.every((trigger) => Object.isFrozen(trigger)), true);
  assert.equal(
    triggers.every(({ createSql }) =>
      /^CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\b/iu.test(createSql),
    ),
    true,
  );
  assert.throws(
    () =>
      finalHostedD1Triggers([
        "CREATE TRIGGER `duplicate` AFTER INSERT ON `x` BEGIN SELECT 1; END;" +
          BREAKPOINT +
          "CREATE TRIGGER `duplicate` AFTER INSERT ON `x` BEGIN SELECT 1; END;",
      ]),
    /Duplicate hosted D1 trigger/u,
  );
});

test("same-name stale trigger body is not a valid attestation", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE guarded (value INTEGER)");
  database.exec(
    `CREATE TRIGGER guard
     AFTER INSERT ON guarded
     BEGIN
       SELECT 1;
     END;`,
  );
  database.exec(
    `CREATE TRIGGER IF NOT EXISTS guard
     AFTER INSERT ON guarded
     BEGIN
       SELECT RAISE(ABORT, 'blocked');
     END;`,
  );
  const observed = database
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'trigger'`,
    )
    .get() as { name: string; sql: string };
  const expectedSql =
    `CREATE TRIGGER IF NOT EXISTS guard
     AFTER INSERT ON guarded
     BEGIN
       SELECT RAISE(ABORT, 'blocked');
     END;`;
  const expected = finalHostedD1Triggers([expectedSql]);

  assert.equal(observed.name, "guard");
  assert.throws(
    () =>
      assertHostedD1TriggerAttestation(expected, [observed]),
    /Hosted D1 trigger attestation failed/u,
  );
});

test("canonical trigger bodies ignore packaging layout but preserve literals", () => {
  const formatted =
    `CREATE TRIGGER IF NOT EXISTS guard
     AFTER INSERT ON guarded
     BEGIN
       -- formatting-only comment
       SELECT 'a  b';
     END;`;
  const compact =
    "CREATE TRIGGER guard AFTER INSERT ON guarded " +
    "BEGIN SELECT 'a  b'; END";
  const changedLiteral =
    "CREATE TRIGGER guard AFTER INSERT ON guarded " +
    "BEGIN SELECT 'a b'; END";

  assert.equal(
    canonicalHostedD1TriggerSql(formatted),
    canonicalHostedD1TriggerSql(compact),
  );
  assert.notEqual(
    canonicalHostedD1TriggerSql(formatted),
    canonicalHostedD1TriggerSql(changedLiteral),
  );
});

test("NBSP remains a semantic SQLite token and fails body attestation", () => {
  const expectedDatabase = new DatabaseSync(":memory:");
  const observedDatabase = new DatabaseSync(":memory:");
  const setup =
    "CREATE TABLE guarded (value INTEGER);" +
    "CREATE TABLE audit (value INTEGER);";
  const expectedSql =
    `CREATE TRIGGER guard
     AFTER INSERT ON guarded
     BEGIN
       INSERT INTO audit(value) VALUES (NEW .value);
     END;`;
  const nbsp = "\u00a0";
  const observedSql =
    `CREATE TRIGGER guard
     AFTER INSERT ON guarded
     BEGIN
       INSERT INTO audit(value) VALUES (NEW${nbsp}.value);
     END;`;

  expectedDatabase.exec(setup);
  expectedDatabase.exec(expectedSql);
  expectedDatabase.exec("INSERT INTO guarded VALUES (7)");
  assert.equal(
    (
      expectedDatabase
        .prepare("SELECT value FROM audit")
        .get() as { value: number }
    ).value,
    7,
  );

  observedDatabase.exec(setup);
  observedDatabase.exec(observedSql);
  assert.throws(
    () => observedDatabase.exec("INSERT INTO guarded VALUES (7)"),
    /no such column: NEW\u00a0\.value/u,
  );
  assert.equal(
    (
      observedDatabase
        .prepare("SELECT count(*) AS count FROM audit")
        .get() as { count: number }
    ).count,
    0,
  );
  const observed = observedDatabase
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'trigger'`,
    )
    .get() as { name: string; sql: string };
  const expected = finalHostedD1Triggers([expectedSql]);
  assert.throws(
    () =>
      assertHostedD1TriggerAttestation(expected, [observed]),
    /Hosted D1 trigger attestation failed/u,
  );
});

test("hosted bootstrap imports and represents every Drizzle migration", () => {
  assertMigrationCoverage(bootstrapSource);
  assert.doesNotMatch(bootstrapSource, /DROP\s+TRIGGER/iu);
  const omitted = bootstrapSource.replace(
    /^import migration0028[^\n]+\n/mu,
    "",
  );
  assert.throws(
    () => assertMigrationCoverage(omitted),
    /Hosted D1 migration import coverage mismatch/u,
  );
  const unrepresented = bootstrapSource.replace(
    /^\s+migration0028,\n/mu,
    "",
  );
  assert.throws(
    () => assertMigrationCoverage(unrepresented),
    /Hosted D1 migration manifest coverage mismatch/u,
  );
  const reordered = bootstrapSource.replace(
    "  migration0008,\n  migration0009,",
    "  migration0009,\n  migration0008,",
  );
  assert.throws(
    () => assertMigrationCoverage(reordered),
    /Hosted D1 migration manifest coverage mismatch/u,
  );
});

test("the worker gates every private alpha request on trigger readiness", () => {
  const worker = readFileSync(
    new URL("../../worker/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(worker, /await ensureHostedD1Triggers\(/u);
  assert.match(worker, /database_integrity_unavailable/u);
  assert.ok(
    worker.indexOf("await ensureHostedD1Triggers(") <
      worker.indexOf("return handler.fetch("),
  );
});

function assertMigrationCoverage(source: string): void {
  const imports = Array.from(
    source.matchAll(
      /^import (migration\d+) from "\.\.\/\.\.\/\.\.\/drizzle\/([^"]+\.sql)\?raw";$/gmu,
    ),
    (match) => ({ identifier: match[1]!, name: match[2]! }),
  );
  if (
    imports.length !== migrationNames.length ||
    imports.some(({ name }, index) => name !== migrationNames[index])
  ) {
    throw new TypeError("Hosted D1 migration import coverage mismatch.");
  }
  const manifest = source.match(
    /const TRIGGERS = finalHostedD1Triggers\(\[\n([\s\S]*?)\n\]\);/u,
  );
  const represented = Array.from(
    manifest?.[1]?.matchAll(/^\s+(migration\d+),$/gmu) ?? [],
    (match) => match[1]!,
  );
  if (
    represented.length !== imports.length ||
    represented.some(
      (identifier, index) => identifier !== imports[index]!.identifier,
    )
  ) {
    throw new TypeError(
      "Hosted D1 migration manifest coverage mismatch.",
    );
  }
  for (const { identifier } of imports) {
    const occurrences =
      source.match(new RegExp(`\\b${identifier}\\b`, "gu")) ?? [];
    if (occurrences.length !== 2) {
      throw new TypeError(
        "Hosted D1 migration manifest coverage mismatch.",
      );
    }
  }
}

function stripLeadingComments(value: string): string {
  let statement = value.trim();
  while (statement.startsWith("--")) {
    const newline = statement.search(/[\r\n]/u);
    if (newline === -1) return "";
    statement = statement.slice(newline + 1).trimStart();
  }
  return statement;
}

function triggerNames(database: DatabaseSync): string[] {
  return database
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'trigger'
       ORDER BY name`,
    )
    .all()
    .map(({ name }) => String(name));
}
