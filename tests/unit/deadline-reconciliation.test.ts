import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canonicalDeadlineExpiryMetadata,
  DEADLINE_HEALTH_GRACE_MS,
  deadlineExpiryMetadata,
  deadlineHealthCutoff,
  deadlineLedgerPayload,
  deadlineOperationId,
  ENGINE_DEADLINE_REASON,
  isBenignDeadlineRace,
  MUTATION_DEADLINE_RECONCILE_LIMIT,
  SCHEDULED_DEADLINE_RECONCILE_LIMIT,
} from "@/src/domain/runners/deadline-reconciliation";

const runId = `run_${"a".repeat(32)}`;
const deadlineAt = "2026-07-27T12:20:00.000Z";

test("deadline reconciliation freezes identities, bounds and metadata", () => {
  assert.equal(deadlineOperationId(runId), `op_${"a".repeat(32)}`);
  assert.equal(MUTATION_DEADLINE_RECONCILE_LIMIT, 25);
  assert.equal(SCHEDULED_DEADLINE_RECONCILE_LIMIT, 100);
  assert.equal(DEADLINE_HEALTH_GRACE_MS, 600_000);
  assert.deepEqual(deadlineExpiryMetadata(runId, deadlineAt), {
    deadlineAt,
    operationId: `op_${"a".repeat(32)}`,
    reason: ENGINE_DEADLINE_REASON,
  });
  assert.deepEqual(deadlineLedgerPayload(runId, deadlineAt), {
    deadlineAt,
    operationId: `op_${"a".repeat(32)}`,
    reason: ENGINE_DEADLINE_REASON,
    runId,
  });
  assert.equal(
    canonicalDeadlineExpiryMetadata(runId, deadlineAt),
    `{"deadlineAt":"${deadlineAt}","operationId":"op_${"a".repeat(32)}","reason":"engine_deadline_exhausted"}`,
  );
});

test("deadline reconciliation enforces canonical identifiers and timestamps", () => {
  assert.throws(() => deadlineOperationId("run_bad"), /Invalid deadline run id/u);
  assert.throws(
    () => deadlineExpiryMetadata(runId, "2026-07-27T12:20:00Z"),
    /Invalid canonical timestamp/u,
  );
  assert.equal(
    deadlineHealthCutoff("2026-07-27T12:20:00.000Z"),
    "2026-07-27T12:10:00.000Z",
  );
});

test("deadline races skip only terminal, superseded or no-longer-due rows", () => {
  const base = {
    candidateVersion: 2,
    observedAt: deadlineAt,
  };
  assert.equal(
    isBenignDeadlineRace({
      ...base,
      current: { status: "canceled", version: 3, deadlineAt },
    }),
    true,
  );
  assert.equal(
    isBenignDeadlineRace({
      ...base,
      current: { status: "queued", version: 3, deadlineAt },
    }),
    true,
  );
  assert.equal(
    isBenignDeadlineRace({
      ...base,
      current: {
        status: "queued",
        version: 2,
        deadlineAt: "2026-07-27T12:20:00.001Z",
      },
    }),
    true,
  );
  assert.equal(
    isBenignDeadlineRace({
      ...base,
      current: { status: "queued", version: 2, deadlineAt },
    }),
    false,
  );
  assert.equal(isBenignDeadlineRace({ ...base, current: null }), false);
});

test("deadline reconciliation wiring keeps one bounded repository operation", () => {
  const repository = readFileSync(
    new URL(
      "../../src/adapters/d1/deadline-reconciliation-repository.ts",
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
  const localRoute = readFileSync(
    new URL(
      "../../app/api/system/deadlines/reconcile/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const localCli = readFileSync(
    new URL("../../scripts/deadline-reconcile.mjs", import.meta.url),
    "utf8",
  );
  const vite = readFileSync(
    new URL("../../vite.config.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    repository,
    /input\.mode === "mutation"[\s\S]*?MUTATION_DEADLINE_RECONCILE_LIMIT[\s\S]*?: SCHEDULED_DEADLINE_RECONCILE_LIMIT/u,
  );
  assert.match(
    repository,
    /ORDER BY[\s\S]*?CASE WHEN[\s\S]*?mapping\.principal_id IS NOT NULL[\s\S]*?THEN 0 ELSE 1 END,[\s\S]*?run\.deadline_at, run\.id[\s\S]*?LIMIT \?/u,
  );
  assert.match(repository, /listDueEngineRuns\(observedAt, limit \+ 1\)/u);
  assert.match(repository, /selected\.length > limit/u);
  assert.match(
    repository,
    /await d1\.batch\(statements\)/u,
  );
  assert.match(scheduler, /mode: "mutation"/u);
  assert.match(scheduler, /\.catch\([\s\S]*?mutation pass failed/u);
  assert.match(worker, /scheduled\([\s\S]*?ctx\.waitUntil/u);
  assert.match(worker, /mode: "scheduled"/u);
  assert.match(localRoute, /NEXUS_ALLOW_LOCAL_IDENTITY !== "1"/u);
  assert.match(localRoute, /"deadline-reconcile-v1"/u);
  assert.match(localCli, /\["127\.0\.0\.1", "\[::1\]"\]/u);
  assert.match(localCli, /redirect: "error"/u);
  assert.doesNotMatch(localCli, /child_process|spawn|execFile|exec\(/u);
  assert.match(vite, /triggers: \{ crons: \["\* \* \* \* \*"\] \}/u);
  assert.match(scheduler, /MUTATION_RECONCILE_COOLDOWN_MS = 30_000/u);
  assert.match(scheduler, /mutationPassInFlight/u);
});
