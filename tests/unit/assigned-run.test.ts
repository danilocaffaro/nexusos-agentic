import assert from "node:assert/strict";
import test from "node:test";

import { parseAssignedRunRequest } from "../../src/domain/runners/assigned-run";
import { isRunDeadlineExpired } from "../../src/domain/runners/lease-protocol";

const runnerId = `rnr_${"a".repeat(32)}`;

test("assigned run parser accepts only exact canonical request shapes", () => {
  assert.deepEqual(parseAssignedRunRequest({ assignedRunnerId: runnerId }), {
    assignedRunnerId: runnerId,
  });
  assert.deepEqual(
    parseAssignedRunRequest({
      assignedRunnerId: runnerId,
      requiredCapability: "bubblewrap",
    }),
    {
      assignedRunnerId: runnerId,
      requiredCapability: "bubblewrap",
    },
  );

  for (const invalid of [
    {},
    { requiredCapability: "bubblewrap" },
    { assignedRunnerId: runnerId, extra: true },
    { assignedRunnerId: null },
    { assignedRunnerId: `rnr_${"A".repeat(32)}` },
    { assignedRunnerId: `rnr_${"a".repeat(31)}` },
    { assignedRunnerId: runnerId, requiredCapability: null },
    { assignedRunnerId: runnerId, requiredCapability: "sandboxed" },
    { assignedRunnerId: runnerId, requiredCapability: 1 },
  ]) {
    assert.equal(parseAssignedRunRequest(invalid), undefined);
  }
});

test("run deadline expiry has an inclusive boundary and excludes terminals", () => {
  const deadlineAt = "2026-07-26T12:00:00.000Z";
  assert.equal(
    isRunDeadlineExpired({
      status: "queued",
      deadlineAt,
      now: "2026-07-26T11:59:59.999Z",
    }),
    false,
  );
  assert.equal(
    isRunDeadlineExpired({ status: "queued", deadlineAt, now: deadlineAt }),
    true,
  );
  assert.equal(
    isRunDeadlineExpired({
      status: "leased",
      deadlineAt,
      now: "2026-07-26T12:00:00.001Z",
    }),
    true,
  );
  for (const status of ["completed", "canceled"] as const) {
    assert.equal(
      isRunDeadlineExpired({
        status,
        deadlineAt,
        now: "2026-07-26T12:00:00.001Z",
      }),
      false,
    );
  }
});
