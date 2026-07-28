import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFLOW_RUN_MAX_APPLIED_EVENTS,
  type WorkflowRunState,
  type WorkflowRunStepState,
} from "../../src/contracts/workflow-run";
import { canonicalJson } from "../../src/domain/governance/canonical-json";
import { projectRunSnapshot } from "../../src/domain/workflows/workflow-run-snapshot";

const epoch = "1970-01-01T00:00:00.000Z";

function events(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    eventId: `event_${index}`,
    payloadHash: index.toString(16).padStart(64, "0"),
  }));
}

function snapshot(options: {
  runState?: WorkflowRunState;
  states?: WorkflowRunStepState[];
  runVersion?: number;
  createdAt?: string;
  updatedAt?: string;
} = {}) {
  const runVersion = options.runVersion ?? 0;
  const states = options.states ?? ["pending", "pending"];
  return {
    specVersion: "nexusos.workflow-run.v1",
    stateClaim: "state_only_no_execution",
    runId: "run:alpha",
    organizationId: "org-123",
    projectId: "project:alpha",
    workflowId: "ship_release",
    definitionVersionHash: "a".repeat(64),
    runVersion,
    runState: options.runState ?? "created",
    steps: states.map((state, index) => ({
      stepId: index === 0 ? "prepare" : `step_${index}`,
      state,
    })),
    appliedEvents: events(runVersion),
    createdAt: options.createdAt ?? epoch,
    updatedAt: options.updatedAt ?? epoch,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("contract freezes the hostile snapshot event bound", () => {
  assert.equal(WORKFLOW_RUN_MAX_APPLIED_EVENTS, 128);
  assert.equal(Object.is(WORKFLOW_RUN_MAX_APPLIED_EVENTS, -0), false);
});

test("projects one deterministic detached and deeply frozen snapshot", () => {
  const input = snapshot();
  const first = projectRunSnapshot(input);
  const second = projectRunSnapshot(snapshot());
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(first, input);
  assert.deepEqual(first, second);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.notEqual(first, input);
  assert.notEqual(first.steps, input.steps);
  assert.notEqual(first.appliedEvents, input.appliedEvents);
  assertDeepFrozen(first);

  input.runId = "mutated";
  input.steps[0]!.stepId = "mutated";
  input.appliedEvents.push({
    eventId: "mutated",
    payloadHash: "b".repeat(64),
  });
  assert.equal(first.runId, "run:alpha");
  assert.equal(first.steps[0]?.stepId, "prepare");
  assert.equal(first.appliedEvents.length, 0);
});

test("accepts every exact created, running and terminal state shape", () => {
  const accepted = [
    snapshot(),
    snapshot({
      runState: "running",
      states: ["active", "pending"],
      runVersion: 1,
    }),
    snapshot({
      runState: "running",
      states: ["succeeded", "pending"],
      runVersion: 2,
    }),
    snapshot({
      runState: "running",
      states: ["succeeded", "active"],
      runVersion: 3,
    }),
    snapshot({
      runState: "succeeded",
      states: ["succeeded", "succeeded"],
      runVersion: 4,
    }),
    snapshot({
      runState: "failed",
      states: ["failed", "cancelled"],
      runVersion: 2,
    }),
    snapshot({
      runState: "failed",
      states: ["succeeded", "failed"],
      runVersion: 3,
    }),
    snapshot({
      runState: "cancelled",
      states: ["cancelled", "cancelled"],
      runVersion: 1,
    }),
    snapshot({
      runState: "cancelled",
      states: ["succeeded", "cancelled"],
      runVersion: 2,
    }),
  ];
  for (const value of accepted) assert.ok(projectRunSnapshot(value));
});

test("rejects every impossible created, running and terminal state shape", () => {
  const rejected = [
    snapshot({ runState: "created", runVersion: 1 }),
    snapshot({ runState: "created", states: ["active", "pending"] }),
    snapshot({
      runState: "running",
      states: ["succeeded", "succeeded"],
      runVersion: 2,
    }),
    snapshot({
      runState: "running",
      states: ["pending", "active"],
      runVersion: 2,
    }),
    snapshot({
      runState: "running",
      states: ["active", "active"],
      runVersion: 2,
    }),
    snapshot({
      runState: "succeeded",
      states: ["succeeded", "failed"],
      runVersion: 2,
    }),
    snapshot({
      runState: "failed",
      states: ["succeeded", "cancelled"],
      runVersion: 2,
    }),
    snapshot({
      runState: "failed",
      states: ["failed", "failed"],
      runVersion: 2,
    }),
    snapshot({
      runState: "failed",
      states: ["cancelled", "failed"],
      runVersion: 2,
    }),
    snapshot({
      runState: "cancelled",
      states: ["succeeded", "failed"],
      runVersion: 2,
    }),
    snapshot({
      runState: "cancelled",
      states: ["succeeded", "succeeded"],
      runVersion: 2,
    }),
    snapshot({
      runState: "cancelled",
      states: ["cancelled", "pending"],
      runVersion: 2,
    }),
    snapshot({
      runState: "succeeded",
      states: ["succeeded", "succeeded"],
      runVersion: 0,
    }),
  ];
  for (const value of rejected) {
    assert.equal(projectRunSnapshot(value), undefined);
  }
});

test("validates exact scalar, version, timestamp and collection bounds", () => {
  const base = snapshot();
  const invalid = [
    { ...base, extra: true },
    { ...base, specVersion: "wrong" },
    { ...base, stateClaim: "authenticated" },
    { ...base, runId: "has space" },
    { ...base, organizationId: "" },
    { ...base, projectId: "a".repeat(65) },
    { ...base, workflowId: "Invalid" },
    { ...base, definitionVersionHash: "A".repeat(64) },
    { ...base, runVersion: -0 },
    { ...base, runVersion: -1 },
    { ...base, runVersion: 0.5 },
    { ...base, runVersion: 1 },
    { ...base, runState: "queued" },
    { ...base, createdAt: "1970-01-01T00:00:00Z" },
    { ...base, updatedAt: "1970-01-01T00:00:00.000+00:00" },
    {
      ...base,
      createdAt: epoch,
      updatedAt: "1969-12-31T23:59:59.999Z",
    },
    { ...base, steps: [] },
    {
      ...base,
      steps: Array.from({ length: 17 }, (_, index) => ({
        stepId: `step_${index}`,
        state: "pending",
      })),
    },
    {
      ...base,
      appliedEvents: events(WORKFLOW_RUN_MAX_APPLIED_EVENTS + 1),
      runVersion: WORKFLOW_RUN_MAX_APPLIED_EVENTS + 1,
    },
  ];
  for (const value of invalid) {
    assert.equal(projectRunSnapshot(value), undefined);
  }

  const maximum = snapshot({
    runState: "running",
    states: ["active", "pending"],
    runVersion: WORKFLOW_RUN_MAX_APPLIED_EVENTS,
  });
  assert.ok(projectRunSnapshot(maximum));
  assert.ok(
    projectRunSnapshot(
      snapshot({
        createdAt: "1969-12-31T23:59:59.999Z",
        updatedAt: "1969-12-31T23:59:59.999Z",
      }),
    ),
  );
});

test("rejects invalid, duplicate, sparse and accessor-backed steps", () => {
  const base = snapshot();
  const duplicate = clone(base);
  duplicate.steps[1]!.stepId = duplicate.steps[0]!.stepId;
  const invalidId = clone(base);
  invalidId.steps[0]!.stepId = "Invalid";
  const invalidState = clone(base);
  invalidState.steps[0]!.state = "active";
  const sparse = clone(base);
  sparse.steps = new Array(2);
  const symbol = clone(base);
  Object.assign(symbol.steps[0]!, { [Symbol("extra")]: true });
  const accessor = clone(base);
  let touched = false;
  Object.defineProperty(accessor.steps[0], "state", {
    enumerable: true,
    get() {
      touched = true;
      return "pending";
    },
  });
  for (const value of [
    duplicate,
    invalidId,
    invalidState,
    sparse,
    symbol,
    accessor,
  ]) {
    assert.equal(projectRunSnapshot(value), undefined);
  }
  assert.equal(touched, false);
});

test("rejects invalid, duplicate, sparse and accessor-backed event refs", () => {
  const base = snapshot({
    runState: "running",
    states: ["active", "pending"],
    runVersion: 2,
  });
  const duplicate = clone(base);
  duplicate.appliedEvents[1]!.eventId =
    duplicate.appliedEvents[0]!.eventId;
  const invalidId = clone(base);
  invalidId.appliedEvents[0]!.eventId = "bad id";
  const invalidHash = clone(base);
  invalidHash.appliedEvents[0]!.payloadHash = "A".repeat(64);
  const sparse = clone(base);
  sparse.appliedEvents = new Array(2);
  const symbol = clone(base);
  Object.assign(symbol.appliedEvents[0]!, { [Symbol("extra")]: true });
  const accessor = clone(base);
  let touched = false;
  Object.defineProperty(accessor.appliedEvents[0], "payloadHash", {
    enumerable: true,
    get() {
      touched = true;
      return "a".repeat(64);
    },
  });
  for (const value of [
    duplicate,
    invalidId,
    invalidHash,
    sparse,
    symbol,
    accessor,
  ]) {
    assert.equal(projectRunSnapshot(value), undefined);
  }
  assert.equal(touched, false);
});

test("hostile records and proxies are total and never invoke accessors", () => {
  const base = snapshot();
  let touched = false;
  Object.defineProperty(base, "runId", {
    enumerable: true,
    get() {
      touched = true;
      return "run:alpha";
    },
  });
  const symbol = {
    ...snapshot(),
    [Symbol("extra")]: true,
  };
  const revoked = Proxy.revocable(snapshot(), {});
  revoked.revoke();
  const customArray = snapshot();
  Object.setPrototypeOf(customArray.steps, null);

  for (const value of [
    null,
    [],
    base,
    symbol,
    revoked.proxy,
    customArray,
  ]) {
    assert.doesNotThrow(() => {
      assert.equal(projectRunSnapshot(value), undefined);
    });
  }
  assert.equal(touched, false);
});

test("accepts a null-prototype envelope but returns ordinary frozen data", () => {
  const input = Object.assign(Object.create(null), snapshot());
  const projected = projectRunSnapshot(input);
  assert.ok(projected);
  assert.equal(Object.getPrototypeOf(projected), Object.prototype);
  assertDeepFrozen(projected);
});

function assertDeepFrozen(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  assert.equal(Object.isFrozen(input), true);
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(input),
  )) {
    if ("value" in descriptor) assertDeepFrozen(descriptor.value);
  }
}
