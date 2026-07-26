#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RECONCILIATION_REASON = "preflight_reconciled";
const MAX_WRANGLER_OUTPUT_BYTES = 1024 * 1024;
const WRANGLER_TIMEOUT_MS = 60_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DUPLICATE_ACTIVE_LEASES_SQL = `
WITH ranked AS (
  SELECT
    runner_id,
    id AS lease_id,
    run_id,
    fence,
    issued_at,
    expires_at,
    COUNT(*) OVER (PARTITION BY runner_id) AS active_count,
    ROW_NUMBER() OVER (
      PARTITION BY runner_id
      ORDER BY expires_at DESC, issued_at DESC, id DESC
    ) AS active_rank
  FROM run_leases
  WHERE status = 'active'
)
SELECT
  runner_id,
  lease_id,
  run_id,
  fence,
  issued_at,
  expires_at,
  CASE active_rank WHEN 1 THEN 'survivor' ELSE 'loser' END AS disposition
FROM ranked
WHERE active_count > 1
ORDER BY runner_id, active_rank, lease_id;
`.trim();

export const MISSING_RECONCILIATION_EVENTS_SQL = `
SELECT
  lease.runner_id,
  lease.id AS lease_id,
  lease.run_id,
  lease.fence,
  lease.issued_at,
  lease.expires_at,
  lease.ended_at
FROM run_leases AS lease
WHERE lease.status = 'superseded'
  AND lease.ended_reason = '${RECONCILIATION_REASON}'
  AND NOT EXISTS (
    SELECT 1
    FROM run_events AS event
    WHERE event.run_id = lease.run_id
      AND event.kind = 'lease.superseded'
      AND event.fence = lease.fence
  )
ORDER BY lease.runner_id, lease.run_id, lease.fence;
`.trim();

export const RECONCILE_EVENTS_SQL = `
INSERT INTO run_events (
  organization_id,
  run_id,
  sequence,
  kind,
  actor_id,
  fence,
  occurred_at,
  metadata_json
)
SELECT
  lease.organization_id,
  lease.run_id,
  COALESCE((
    SELECT MAX(event.sequence) + 1
    FROM run_events AS event
    WHERE event.run_id = lease.run_id
  ), 1) + ROW_NUMBER() OVER (
    PARTITION BY lease.run_id
    ORDER BY lease.fence, lease.id
  ) - 1,
  'lease.superseded',
  runner.principal_id,
  lease.fence,
  lease.ended_at,
  json_object(
    'leaseId', lease.id,
    'runnerId', lease.runner_id,
    'fence', lease.fence,
    'reason', '${RECONCILIATION_REASON}'
  )
FROM run_leases AS lease
INNER JOIN runners AS runner
  ON runner.id = lease.runner_id
  AND runner.organization_id = lease.organization_id
WHERE lease.status = 'superseded'
  AND lease.ended_reason = '${RECONCILIATION_REASON}'
  AND NOT EXISTS (
    SELECT 1
    FROM run_events AS event
    WHERE event.run_id = lease.run_id
      AND event.kind = 'lease.superseded'
      AND event.fence = lease.fence
  )
ORDER BY lease.run_id, lease.fence, lease.id
RETURNING run_id, fence;
`.trim();

export function buildReconcileLeasesSql(occurredAt) {
  const canonicalTime = new Date(occurredAt).toISOString();
  if (canonicalTime !== occurredAt) {
    throw new Error("occurredAt must be a canonical ISO-8601 timestamp");
  }
  const timeLiteral = quoteSqlText(canonicalTime);

  return `
UPDATE run_leases
SET
  status = 'superseded',
  ended_at = ${timeLiteral},
  ended_reason = '${RECONCILIATION_REASON}',
  updated_at = ${timeLiteral}
WHERE status = 'active'
  AND EXISTS (
    SELECT 1
    FROM run_leases AS winner
    WHERE winner.runner_id = run_leases.runner_id
      AND winner.status = 'active'
      AND (
        winner.expires_at > run_leases.expires_at
        OR (
          winner.expires_at = run_leases.expires_at
          AND winner.issued_at > run_leases.issued_at
        )
        OR (
          winner.expires_at = run_leases.expires_at
          AND winner.issued_at = run_leases.issued_at
          AND winner.id > run_leases.id
        )
      )
  )
RETURNING id AS lease_id;
`.trim();
}

export function parseArguments(argv) {
  const options = {
    apply: false,
    target: "local",
    config: "wrangler.local.jsonc",
    database: "DB",
    persistTo: ".wrangler/state",
    help: false,
  };
  let explicitTarget = false;
  let explicitConfig = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--local" || argument === "--remote") {
      const target = argument.slice(2);
      if (explicitTarget && options.target !== target) {
        throw new Error("choose exactly one of --local or --remote");
      }
      options.target = target;
      explicitTarget = true;
      if (target === "remote" && !explicitConfig) {
        options.config = undefined;
      }
    } else if (argument === "--config") {
      options.config = requireValue(argv, ++index, "--config");
      explicitConfig = true;
    } else if (argument === "--database") {
      options.database = requireValue(argv, ++index, "--database");
    } else if (argument === "--persist-to") {
      options.persistTo = requireValue(argv, ++index, "--persist-to");
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (options.target === "remote" && !options.config) {
    throw new Error("--remote requires --config <wrangler-config>");
  }
  return options;
}

export function parseWranglerJson(output) {
  let documents;
  try {
    documents = JSON.parse(output);
  } catch {
    throw new Error("Wrangler returned non-JSON output");
  }
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error("Wrangler returned an empty result");
  }
  if (documents.some((document) => document?.success !== true)) {
    throw new Error("Wrangler reported an unsuccessful D1 operation");
  }
  return {
    rows: documents.flatMap((document) =>
      Array.isArray(document.results) ? document.results : [],
    ),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const configPath = resolve(repositoryRoot, options.config);
  if (!existsSync(configPath)) {
    throw new Error(`Wrangler config does not exist: ${options.config}`);
  }

  const before = await executeD1(DUPLICATE_ACTIVE_LEASES_SQL, options);
  const missingBefore = await executeD1(
    MISSING_RECONCILIATION_EVENTS_SQL,
    options,
  );
  if (!options.apply) {
    writeResult({
      mode: "list",
      target: options.target,
      duplicateRunners: uniqueRunnerCount(before.rows),
      activeLeases: before.rows,
      missingEvents: missingBefore.rows,
    });
    if (before.rows.length > 0 || missingBefore.rows.length > 0) {
      process.exitCode = 2;
    }
    return;
  }

  const occurredAt = new Date().toISOString();
  const phaseOne = await executeD1(
    buildReconcileLeasesSql(occurredAt),
    options,
  );
  const phaseTwo = await executeD1(RECONCILE_EVENTS_SQL, options);
  const after = await executeD1(DUPLICATE_ACTIVE_LEASES_SQL, options);
  const missingEvents = await executeD1(
    MISSING_RECONCILIATION_EVENTS_SQL,
    options,
  );

  const result = {
    mode: "apply",
    target: options.target,
    occurredAt,
    duplicateRunnersBefore: uniqueRunnerCount(before.rows),
    activeLeasesBefore: before.rows,
    missingEventsBefore: missingBefore.rows,
    leasesReconciled: phaseOne.rows.length,
    eventsAppended: phaseTwo.rows.length,
    duplicateRunnersAfter: uniqueRunnerCount(after.rows),
    missingEventsAfter: missingEvents.rows,
  };
  writeResult(result);

  if (after.rows.length > 0 || missingEvents.rows.length > 0) {
    process.exitCode = 2;
  }
}

async function executeD1(sql, options) {
  const wranglerPath = resolve(
    repositoryRoot,
    "node_modules/wrangler/bin/wrangler.js",
  );
  if (!existsSync(wranglerPath)) {
    throw new Error("install the locked dependencies before running preflight");
  }

  const args = [
    wranglerPath,
    "d1",
    "execute",
    options.database,
    options.target === "remote" ? "--remote" : "--local",
    "--config",
    options.config,
  ];
  if (options.target === "local") {
    args.push("--persist-to", options.persistTo);
  }
  args.push("--command", sql, "--json");

  const output = await runBounded(process.execPath, args);
  return parseWranglerJson(output);
}

function runBounded(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let outputBytes = 0;
    let settled = false;
    const handleSigint = () => interrupt("SIGINT", 130);
    const handleSigterm = () => interrupt("SIGTERM", 143);
    const timeout = setTimeout(() => {
      terminateProcessTree(child);
      finish(new Error("Wrangler D1 operation exceeded 60 seconds"));
    }, WRANGLER_TIMEOUT_MS);
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);

    const capture = (target) => (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_WRANGLER_OUTPUT_BYTES) {
        terminateProcessTree(child);
        finish(new Error("Wrangler output exceeded 1 MiB"));
        return;
      }
      if (target === "stdout") stdout += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.once("error", finish);
    child.once("close", (code) => {
      if (code === 0) finish(undefined, stdout);
      else {
        finish(new Error(`Wrangler D1 operation failed (${code})`));
      }
    });

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.removeListener("SIGINT", handleSigint);
      process.removeListener("SIGTERM", handleSigterm);
      if (error) rejectRun(error);
      else resolveRun(value);
    }

    function interrupt(signal, exitCode) {
      terminateProcessTree(child);
      process.exitCode = exitCode;
      finish(new Error(`Wrangler D1 operation interrupted by ${signal}`));
    }
  });
}

function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function quoteSqlText(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function uniqueRunnerCount(rows) {
  return new Set(rows.map((row) => row.runner_id)).size;
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function usage() {
  return `NexusOS active-lease preflight

Usage:
  npm run db:lease-preflight
  npm run db:lease-preflight -- --apply
  npm run db:lease-preflight -- --remote --config <wrangler-config>
  npm run db:lease-preflight -- --remote --config <wrangler-config> --apply

Defaults:
  local D1, wrangler.local.jsonc, .wrangler/state, list-only

Only --apply mutates data. Remote mode is never inferred.
`;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`lease preflight failed: ${error.message}\n`);
    if (!process.exitCode) process.exitCode = 1;
  });
}
