import assert from "node:assert/strict";
import test from "node:test";
import {
  assertObjectiveTransition,
  assertWorkItemTransition,
  WorkGraphTransitionError,
} from "../../src/domain/work-graph";

test("objective lifecycle accepts only explicit forward transitions", () => {
  assert.doesNotThrow(() => assertObjectiveTransition("open", "active"));
  assert.doesNotThrow(() => assertObjectiveTransition("active", "completed"));
  assert.throws(
    () => assertObjectiveTransition("completed", "active"),
    (error) =>
      error instanceof WorkGraphTransitionError &&
      error.code === "invalid_status_transition",
  );
});

test("work item lifecycle supports rework, reopen and unblocking", () => {
  assert.doesNotThrow(() =>
    assertWorkItemTransition("in_review", "in_progress"),
  );
  assert.doesNotThrow(() => assertWorkItemTransition("done", "in_progress"));
  assert.doesNotThrow(() => assertWorkItemTransition("blocked", "ready"));
});

test("work item lifecycle fails closed for skipped states", () => {
  assert.throws(
    () => assertWorkItemTransition("backlog", "done"),
    (error) =>
      error instanceof WorkGraphTransitionError &&
      error.code === "invalid_status_transition",
  );
  assert.throws(
    () => assertWorkItemTransition("done", "ready"),
    WorkGraphTransitionError,
  );
});
