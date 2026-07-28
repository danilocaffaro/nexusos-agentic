import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyEngineRunCreateResponse,
  classifyEngineRunReconcileResponse,
  engineRunDetailUrl,
  engineRunListUrl,
  engineRunOptionFreshness,
  engineRunReconcileUrl,
  generateEngineRunCreationId,
  mapEngineRunDetail,
  mapEngineRunOptions,
  mapEngineRunPage,
  mergeEngineRunAppend,
  mergeEngineRunRefresh,
  pendingEngineRunCreationState,
  readEngineRunCreationResolution,
  readEngineRunDetail,
  readEngineRunOptions,
  readEngineRunRegistry,
} from "../../app/engine-run-adapter";
import type { EngineRunOption } from "../../src/contracts/engine-run-options";
import type { EngineRunRead } from "../../src/contracts/runs";

const runnerId = `rnr_${"a".repeat(32)}`;
const runId = `run_${"b".repeat(32)}`;
const creationId = `ecr_${"c".repeat(32)}`;
const now = "2026-07-28T13:05:00.000Z";

test("validates a closed bounded options response and preserves nullable facts", () => {
  const invalidPolicy = engineOption({
    eligible: false,
    disabledReason: "engine_policy_invalid",
    reportId: null,
    receivedAt: null,
    freshUntil: null,
    status: null,
    readiness: null,
    reason: null,
    version: null,
  });
  const payload = {
    schemaVersion: 1,
    trustDisclosure: "server disclosure",
    truncated: false,
    options: [invalidPolicy],
  };
  const parsed = readEngineRunOptions(payload);
  assert.ok(parsed);
  const [mapped] = mapEngineRunOptions(parsed);
  assert.equal(mapped.status, null);
  assert.equal(mapped.readiness, null);
  assert.equal(mapped.reason, null);
  assert.equal(mapped.engineVersion, null);
  assert.equal(mapped.freshness, "not_evaluated");
  assert.equal(mapped.disabledReasonCode, "engine_policy_invalid");
  assert.doesNotMatch(JSON.stringify(mapped), /report_policy_invalid/u);

  assert.equal(
    readEngineRunOptions({ ...payload, attackerControlled: true }),
    null,
  );
  assert.equal(
    readEngineRunOptions({
      ...payload,
      options: Array.from({ length: 201 }, (_, index) =>
        engineOption({
          runnerId: `rnr_${index.toString(16).padStart(32, "0")}`,
        }),
      ),
    }),
    null,
  );
  assert.equal(
    readEngineRunOptions({
      ...payload,
      options: [invalidPolicy, invalidPolicy],
    }),
    null,
  );
});

test("derives freshness only from server facts, including inactive runners", () => {
  assert.equal(
    engineRunOptionFreshness(
      engineOption({
        eligible: false,
        disabledReason: "engine_report_absent",
        reportId: null,
        receivedAt: null,
        freshUntil: null,
        status: null,
        readiness: null,
        reason: null,
        version: null,
      }),
    ),
    "absent",
  );
  assert.equal(
    engineRunOptionFreshness(
      engineOption({
        eligible: false,
        disabledReason: "runner_inactive",
        runnerState: "inactive",
        evaluatedAt: "2026-07-28T14:00:00.000Z",
        receivedAt: "2026-07-28T13:00:00.000Z",
        freshUntil: "2026-07-28T13:59:59.000Z",
      }),
    ),
    "stale",
  );
  assert.equal(
    engineRunOptionFreshness(
      engineOption({
        eligible: false,
        disabledReason: "runner_inactive",
        runnerState: "inactive",
        evaluatedAt: "2026-07-28T12:59:59.000Z",
        receivedAt: "2026-07-28T13:00:00.000Z",
        freshUntil: "2026-07-28T14:00:00.000Z",
      }),
    ),
    "future",
  );
  assert.equal(
    engineRunOptionFreshness(
      engineOption({
        eligible: false,
        disabledReason: "runner_inactive",
        runnerState: "inactive",
        reportId: null,
        receivedAt: null,
        freshUntil: null,
        status: null,
        readiness: null,
        reason: null,
        version: null,
      }),
    ),
    "not_evaluated",
  );
});

test("validates all stored statuses and maps only factual run fields", () => {
  for (const status of [
    "queued",
    "leased",
    "completed",
    "canceled",
    "expired",
  ] as const) {
    const terminal = !["queued", "leased"].includes(status);
    const raw = engineRun({
      status,
      overdue: false,
      deadlineState: terminal ? "settled" : "pending",
    });
    const parsed = readEngineRunRegistry({ runs: [raw] });
    assert.ok(parsed, status);
    const mapped = mapEngineRunPage(parsed);
    assert.equal(mapped.runs[0].storedStatus, status);
    assert.equal(mapped.runs[0].runnerDisplayName, null);
    assert.equal(mapped.runs[0].deadlineAt, raw.deadlineAt);
  }
  assert.equal(
    readEngineRunRegistry({
      runs: [
        engineRun({
          status: "completed",
          overdue: true,
          deadlineState: "settled",
        }),
      ],
    }),
    null,
  );
});

test("validates latest-event detail and preserves factual receipt storage state", () => {
  const raw = engineDetail() as Record<string, any>;
  const parsed = readEngineRunDetail(raw, runId);
  assert.ok(parsed);
  const mapped = mapEngineRunDetail(
    parsed,
    new Map([[runnerId, "Aurora atual"]]),
  );
  assert.equal(mapped.run.runnerDisplayName, "Aurora atual");
  assert.equal(mapped.run.currentLeaseId, raw.run.currentLease.id);
  assert.equal(mapped.eventsCount, 2);
  assert.equal(mapped.eventsTruncated, true);
  assert.equal(mapped.receipt?.excerptStorageState, "stored_encrypted");
  assert.equal("erasedAt" in (mapped.receipt ?? {}), false);

  const erased = engineDetail({
    receipt: {
      ...raw.receipt,
      excerptStorageState: "erased",
      erasedAt: "2026-07-28T14:00:00.000Z",
    },
  });
  const erasedParsed = readEngineRunDetail(erased, runId);
  assert.ok(erasedParsed);
  assert.equal(
    mapEngineRunDetail(erasedParsed).receipt?.excerptStorageState,
    "erased",
  );
  assert.equal(
    mapEngineRunDetail(erasedParsed).receipt?.erasedAt,
    "2026-07-28T14:00:00.000Z",
  );

  assert.equal(
    readEngineRunDetail(
      { ...raw, receipt: { ...raw.receipt, promptRef: "secret" } },
      runId,
    ),
    null,
  );
  assert.equal(
    readEngineRunDetail(
      {
        ...raw,
        events: [raw.events[1], raw.events[0]],
      },
      runId,
    ),
    null,
  );
  assert.equal(readEngineRunDetail(raw, `run_${"d".repeat(32)}`), null);
});

test("merges cursor pages deterministically and refreshes without losing older pages", () => {
  const newest = mapEngineRunPage({
    runs: [
      engineRun({
        id: `run_${"f".repeat(32)}`,
      }) as unknown as EngineRunRead,
    ],
    nextCursor: "opaque+cursor",
  }).runs[0];
  const boundary = {
    ...newest,
    id: `run_${"e".repeat(32)}`,
    createdAt: "2026-07-28T13:04:00.000Z",
    updatedAt: "2026-07-28T13:04:00.000Z",
  };
  const older = {
    ...newest,
    id: `run_${"d".repeat(32)}`,
    createdAt: "2026-07-28T13:03:00.000Z",
    updatedAt: "2026-07-28T13:03:00.000Z",
  };
  assert.deepEqual(
    mergeEngineRunAppend([newest, boundary], [boundary, older]).map(
      (run) => run.id,
    ),
    [newest.id, boundary.id, older.id],
  );
  assert.deepEqual(
    mergeEngineRunRefresh({
      current: [newest, boundary, older],
      incoming: [{ ...newest, storedStatus: "completed" }],
      firstPageHasMore: true,
      loadedAdditionalPages: true,
    }).map((run) => [run.id, run.storedStatus]),
    [
      [newest.id, "completed"],
      [boundary.id, "queued"],
      [older.id, "queued"],
    ],
  );
  assert.deepEqual(
    mergeEngineRunRefresh({
      current: [newest, boundary, older],
      incoming: [{ ...newest, storedStatus: "completed" }],
      firstPageHasMore: false,
      loadedAdditionalPages: true,
    }).map((run) => run.id),
    [newest.id],
  );
  assert.equal(engineRunListUrl("opaque+cursor"), "/api/runs/engine?limit=50&cursor=opaque%2Bcursor");
  assert.equal(engineRunDetailUrl("run/hostile"), "/api/runs/engine/run%2Fhostile");
  assert.equal(
    engineRunReconcileUrl("ecr/hostile"),
    "/api/runs/engine/creations/ecr%2Fhostile/reconcile",
  );
});

test("classifies create and reconcile without converting ambiguity into failure", () => {
  const created = {
    creationId,
    state: "created",
    runId,
    confirmationId: "confirmation-1",
  };
  const notCreated = {
    creationId,
    state: "confirmed_not_created",
    notCreatedProofId: "not-created-proof-1",
  };
  assert.deepEqual(readEngineRunCreationResolution(created, creationId), created);
  assert.equal(
    classifyEngineRunCreateResponse({
      status: 201,
      value: created,
      creationId,
    }).kind,
    "confirmed",
  );
  assert.equal(
    classifyEngineRunCreateResponse({
      status: 400,
      value: { error: "invalid_engine_run_request" },
      creationId,
    }).kind,
    "failure_confirmed",
  );
  assert.equal(
    classifyEngineRunCreateResponse({
      status: 409,
      value: notCreated,
      creationId,
    }).kind,
    "failure_confirmed",
  );
  for (const input of [
    { status: 201, value: { ...created, promptRef: "leak" } },
    { status: 500, value: { error: "internal" } },
    { status: 0, value: null },
    { status: 418, value: { error: "unexpected_problem" } },
    { status: 400, value: { error: "invalid_engine_run_request", extra: true } },
  ]) {
    assert.equal(
      classifyEngineRunCreateResponse({ ...input, creationId }).kind,
      "outcome_unknown",
    );
  }
  assert.equal(
    classifyEngineRunReconcileResponse({
      status: 200,
      value: notCreated,
      creationId,
    }).kind,
    "authoritative",
  );
  assert.equal(
    classifyEngineRunReconcileResponse({
      status: 403,
      value: { error: "forbidden" },
      creationId,
    }).kind,
    "outcome_unknown",
  );
});

test("generates deterministic canonical ids for injected entropy and stores no prompt", () => {
  assert.equal(
    generateEngineRunCreationId(Uint8Array.from({ length: 16 }, (_, i) => i)),
    "ecr_000102030405060708090a0b0c0d0e0f",
  );
  assert.throws(
    () => generateEngineRunCreationId(new Uint8Array(15)),
    /exactly 16/u,
  );
  const pending = pendingEngineRunCreationState({
    creationId,
    message: "Resultado desconhecido.",
  });
  assert.equal(pending.phase, "outcome_unknown");
  assert.equal(pending.incidentId, `incident:${creationId}`);
  assert.equal("prompt" in pending, false);
  assert.doesNotMatch(JSON.stringify(pending), /assignedRunnerId|engine/u);
});

function engineOption(
  override: Partial<EngineRunOption> = {},
): EngineRunOption {
  return {
    evaluatedAt: now,
    trust: "hostReported",
    reportId: `egr_${"d".repeat(32)}`,
    receivedAt: "2026-07-28T13:00:00.000Z",
    freshUntil: "2026-07-28T14:00:00.000Z",
    engine: "claude_code_cli",
    status: "available",
    readiness: "ready",
    reason: "none",
    version: "1.0.93",
    eligible: true,
    runnerId,
    runnerName: "Aurora local",
    runnerState: "active",
    disabledReason: null,
    ...override,
  };
}

function engineRun(override: Record<string, unknown> = {}) {
  return {
    id: runId,
    organizationId: "org-1",
    requestedBy: "principal-1",
    kind: "engine_prompt",
    engine: "claude_code_cli",
    assignedRunnerId: runnerId,
    status: "queued",
    overdue: false,
    deadlineState: "pending",
    version: 1,
    leaseGeneration: 0,
    claimCount: 0,
    maxClaims: 2,
    deadlineAt: "2026-07-28T13:25:00.000Z",
    createdAt: "2026-07-28T13:05:00.000Z",
    updatedAt: "2026-07-28T13:05:00.000Z",
    ...override,
  };
}

function engineDetail(
  override: { receipt?: Record<string, unknown> } = {},
) {
  const receipt = {
    operationId: "operation-1",
    leaseId: "lease-1",
    fence: 1,
    engine: "claude_code_cli",
    engineVersion: "1.0.93",
    status: "succeeded",
    reason: "none",
    exitCode: 0,
    timedOut: false,
    cancelRequested: false,
    startedAt: "2026-07-28T13:06:00.000Z",
    finishedAt: "2026-07-28T13:07:00.000Z",
    stdout: {
      bytes: 8,
      sha256: "1".repeat(64),
      truncated: false,
      excerptBytes: 8,
    },
    stderr: {
      bytes: 0,
      sha256: "0".repeat(64),
      truncated: false,
      excerptBytes: 0,
    },
    receiptSha256: "2".repeat(64),
    recordedAt: "2026-07-28T13:07:01.000Z",
    excerptStorageState: "stored_encrypted",
    ...override.receipt,
  };
  return {
    run: engineRun({
      status: "completed",
      deadlineState: "settled",
      leaseGeneration: 1,
      currentLease: {
        id: "lease-1",
        runnerId,
        fence: 1,
        status: "released",
        issuedAt: "2026-07-28T13:05:30.000Z",
        expiresAt: "2026-07-28T13:10:30.000Z",
        expired: false,
        renewCount: 0,
        endedAt: "2026-07-28T13:07:00.000Z",
        endedReason: "engine_complete",
      },
    }),
    events: [
      {
        sequence: 1,
        kind: "run.created",
        actorId: "principal-1",
        occurredAt: "2026-07-28T13:05:00.000Z",
        metadata: {},
      },
      {
        sequence: 4,
        kind: "run.completed",
        actorId: runnerId,
        occurredAt: "2026-07-28T13:07:01.000Z",
        fence: 1,
        metadata: {},
      },
    ],
    eventsTruncated: true,
    receipt,
  };
}
