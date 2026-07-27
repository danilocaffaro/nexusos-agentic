import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateEnginePromptRead,
  type EnginePromptReadSnapshot,
} from "../../src/domain/runners/engine-prompt-read";

const now = "2026-07-27T12:00:00.000Z";
const runnerId = `rnr_${"1".repeat(32)}`;
const leaseId = `lse_${"2".repeat(32)}`;
const promptRef = `prm_${"3".repeat(32)}`;

function snapshot(
  patch: Partial<EnginePromptReadSnapshot> = {},
): EnginePromptReadSnapshot {
  return {
    runnerActive: true,
    runnerId,
    runnerOrganizationId: "org-local-aurora",
    now,
    leaseId,
    fence: 1,
    promptRef,
    run: {
      organizationId: "org-local-aurora",
      kind: "engine_prompt",
      engine: "claude_code_cli",
      status: "leased",
      cancelRequestedAt: null,
      assignedRunnerId: runnerId,
      currentLeaseId: leaseId,
      leaseGeneration: 1,
      leaseRunnerId: runnerId,
      leaseStatus: "active",
      leaseExpiresAt: "2026-07-27T12:01:00.000Z",
      storedPromptRef: promptRef,
      promptErasedAt: null,
    },
    ...patch,
  };
}

function withRun(
  base: EnginePromptReadSnapshot,
  patch: Partial<NonNullable<EnginePromptReadSnapshot["run"]>>,
): EnginePromptReadSnapshot {
  assert.ok(base.run);
  return { ...base, run: { ...base.run, ...patch } };
}

test("prompt read admits only the current assigned engine lease", () => {
  assert.deepEqual(evaluateEnginePromptRead(snapshot()), {
    kind: "admitted",
  });
});

test("prompt read freezes denial precedence", () => {
  const otherRunner = `rnr_${"9".repeat(32)}`;
  const cases: Array<{
    value: EnginePromptReadSnapshot;
    code: string;
    status: number;
  }> = [
    {
      value: snapshot({ runnerActive: false, run: null }),
      code: "runner_rejected",
      status: 403,
    },
    {
      value: snapshot({ run: null }),
      code: "run_unavailable",
      status: 409,
    },
    {
      value: withRun(snapshot(), {
        organizationId: "org-other",
        currentLeaseId: "wrong",
      }),
      code: "run_unavailable",
      status: 409,
    },
    {
      value: withRun(snapshot(), {
        kind: "diagnostic",
        currentLeaseId: "wrong",
      }),
      code: "run_unavailable",
      status: 409,
    },
    {
      value: withRun(snapshot(), {
        status: "canceled",
        currentLeaseId: "wrong",
      }),
      code: "run_unavailable",
      status: 409,
    },
    {
      value: withRun(snapshot(), {
        cancelRequestedAt: now,
        currentLeaseId: "wrong",
      }),
      code: "run_unavailable",
      status: 409,
    },
    {
      value: withRun(snapshot(), {
        assignedRunnerId: otherRunner,
        currentLeaseId: "wrong",
      }),
      code: "run_unavailable",
      status: 409,
    },
    {
      value: withRun(snapshot(), {
        currentLeaseId: `lse_${"8".repeat(32)}`,
        leaseExpiresAt: "2026-07-27T11:59:00.000Z",
      }),
      code: "lease_superseded",
      status: 409,
    },
    {
      value: withRun(snapshot(), {
        leaseExpiresAt: now,
        storedPromptRef: `prm_${"8".repeat(32)}`,
        promptErasedAt: now,
      }),
      code: "lease_expired",
      status: 410,
    },
    {
      value: withRun(snapshot(), {
        storedPromptRef: `prm_${"8".repeat(32)}`,
        promptErasedAt: now,
      }),
      code: "prompt_unavailable",
      status: 404,
    },
    {
      value: withRun(snapshot(), { promptErasedAt: now }),
      code: "prompt_erased",
      status: 410,
    },
  ];

  for (const candidate of cases) {
    assert.deepEqual(
      evaluateEnginePromptRead(candidate.value),
      {
        kind: "denied",
        code: candidate.code,
        status: candidate.status,
      },
      candidate.code,
    );
  }
});

test("prompt read rejects every lease identity mismatch as superseded", () => {
  const otherRunner = `rnr_${"9".repeat(32)}`;
  for (const value of [
    snapshot({ leaseId: `lse_${"8".repeat(32)}` }),
    snapshot({ fence: 2 }),
    withRun(snapshot(), { leaseRunnerId: otherRunner }),
    withRun(snapshot(), { leaseStatus: "revoked" }),
  ]) {
    assert.deepEqual(evaluateEnginePromptRead(value), {
      kind: "denied",
      code: "lease_superseded",
      status: 409,
    });
  }
});
