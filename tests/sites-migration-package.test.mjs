import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  compactSitesMigration,
} from "../scripts/package-sites-ready.mjs";

const BREAKPOINT = "--> statement-breakpoint";
const migrationNames = readdirSync(
  new URL("../drizzle/", import.meta.url),
)
  .filter((name) => name.endsWith(".sql"))
  .sort();

test("Sites migration packaging preserves the complete SQLite schema", () => {
  const canonical = new DatabaseSync(":memory:");
  const packaged = new DatabaseSync(":memory:");
  canonical.exec("PRAGMA foreign_keys = ON");
  packaged.exec("PRAGMA foreign_keys = ON");

  for (const migration of migrationNames) {
    const sql = readFileSync(
      new URL(`../drizzle/${migration}`, import.meta.url),
      "utf8",
    );
    const compacted = compactSitesMigration(sql);
    assert.equal(
      compacted
        .split(BREAKPOINT)
        .every(
          (statement) =>
            statement.trim().length > 0 &&
            !/[\r\n]/u.test(statement.trim()),
        ),
      true,
      `${migration} must contain one complete SQL statement per line`,
    );
    canonical.exec(sql.replaceAll(BREAKPOINT, ""));
    packaged.exec(compacted.replaceAll(BREAKPOINT, ""));
  }

  assert.deepEqual(schemaObjects(packaged), schemaObjects(canonical));
});

test("Sites deployment SQL omits triggers without losing other schema", () => {
  const canonical = new DatabaseSync(":memory:");
  const deployment = new DatabaseSync(":memory:");
  canonical.exec("PRAGMA foreign_keys = ON");
  deployment.exec("PRAGMA foreign_keys = ON");

  for (const migration of migrationNames) {
    const sql = readFileSync(
      new URL(`../drizzle/${migration}`, import.meta.url),
      "utf8",
    );
    canonical.exec(sql.replaceAll(BREAKPOINT, ""));
    deployment.exec(
      compactSitesMigration(sql, { omitTriggers: true }).replaceAll(
        BREAKPOINT,
        "",
      ),
    );
  }

  assert.equal(
    schemaObjects(deployment).some(({ type }) => type === "trigger"),
    false,
  );
  assert.deepEqual(
    schemaObjects(deployment),
    schemaObjects(canonical).filter(({ type }) => type !== "trigger"),
  );
});

test("Sites migration packaging preserves quoted whitespace and drops comments", () => {
  const compacted = compactSitesMigration(
    "CREATE TABLE `sample` (`value` text DEFAULT 'a  b');\n" +
      `${BREAKPOINT}\n` +
      "-- deployment-only note\n" +
      "CREATE INDEX `sample_value_idx` ON `sample` (`value`);",
  );
  assert.match(compacted, /DEFAULT 'a {2}b'/u);
  assert.equal(compacted.includes("deployment-only note"), false);
  assert.equal(
    compacted
      .split(BREAKPOINT)
      .every((statement) => !/[\r\n]/u.test(statement.trim())),
    true,
  );
});

function schemaObjects(database) {
  return database
    .prepare(
      `SELECT type, name, tbl_name
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all()
    .map(({ type, name, tbl_name }) => ({
      type,
      name,
      table: tbl_name,
    }));
}
