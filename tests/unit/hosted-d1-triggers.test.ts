import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { finalHostedD1Triggers } from "@/src/domain/hosted-d1-triggers";

const BREAKPOINT = "--> statement-breakpoint";
const migrations = readdirSync(new URL("../../drizzle/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) =>
    readFileSync(
      new URL(`../../drizzle/${name}`, import.meta.url),
      "utf8",
    ),
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
  for (const { createSql } of triggers) {
    hosted.exec(createSql);
  }
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
