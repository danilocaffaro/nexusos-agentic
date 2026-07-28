import {
  WORKFLOW_RUN_CLAIM,
  WORKFLOW_RUN_EVENT_ID_PATTERN,
  WORKFLOW_RUN_HASH_PATTERN,
  WORKFLOW_RUN_MAX_APPLIED_EVENTS,
  WORKFLOW_RUN_SNAPSHOT_BINDING_ID_PATTERN,
  WORKFLOW_RUN_SNAPSHOT_MAX_STEPS,
  WORKFLOW_RUN_SNAPSHOT_STEP_ID_PATTERN,
  WORKFLOW_RUN_SNAPSHOT_WORKFLOW_ID_PATTERN,
  WORKFLOW_RUN_SPEC_VERSION,
  WORKFLOW_RUN_STATES,
  WORKFLOW_RUN_STEP_STATES,
  type WorkflowRunAppliedEvent,
  type WorkflowRunSnapshot,
  type WorkflowRunState,
  type WorkflowRunStep,
} from "../../contracts/workflow-run";

const SNAPSHOT_KEYS = [
  "specVersion",
  "stateClaim",
  "runId",
  "organizationId",
  "projectId",
  "workflowId",
  "definitionVersionHash",
  "runVersion",
  "runState",
  "steps",
  "appliedEvents",
  "createdAt",
  "updatedAt",
] as const;
const STEP_KEYS = ["stepId", "state"] as const;
const EVENT_KEYS = ["eventId", "payloadHash"] as const;
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function projectRunSnapshot(
  input: unknown,
): WorkflowRunSnapshot | undefined {
  try {
    const value = exactRecord(input, SNAPSHOT_KEYS);
    if (!value) return undefined;

    const steps = projectSteps(value.steps);
    const appliedEvents = projectEvents(value.appliedEvents);
    if (!steps || !appliedEvents) return undefined;
    if (
      value.specVersion !== WORKFLOW_RUN_SPEC_VERSION ||
      value.stateClaim !== WORKFLOW_RUN_CLAIM ||
      !matches(value.runId, WORKFLOW_RUN_SNAPSHOT_BINDING_ID_PATTERN) ||
      !matches(
        value.organizationId,
        WORKFLOW_RUN_SNAPSHOT_BINDING_ID_PATTERN,
      ) ||
      !matches(value.projectId, WORKFLOW_RUN_SNAPSHOT_BINDING_ID_PATTERN) ||
      !matches(value.workflowId, WORKFLOW_RUN_SNAPSHOT_WORKFLOW_ID_PATTERN) ||
      !matches(value.definitionVersionHash, WORKFLOW_RUN_HASH_PATTERN) ||
      !isVersion(value.runVersion, appliedEvents.length) ||
      !isOneOf(value.runState, WORKFLOW_RUN_STATES) ||
      !isCanonicalTimestamp(value.createdAt) ||
      !isCanonicalTimestamp(value.updatedAt) ||
      value.updatedAt < value.createdAt ||
      !hasValidStateShape(value.runState, value.runVersion, steps)
    ) {
      return undefined;
    }

    return deepFreeze({
      specVersion: value.specVersion,
      stateClaim: value.stateClaim,
      runId: value.runId,
      organizationId: value.organizationId,
      projectId: value.projectId,
      workflowId: value.workflowId,
      definitionVersionHash: value.definitionVersionHash,
      runVersion: value.runVersion,
      runState: value.runState,
      steps,
      appliedEvents,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    });
  } catch {
    return undefined;
  }
}

function projectSteps(
  input: unknown,
): WorkflowRunStep[] | undefined {
  const values = exactArray(input, 1, WORKFLOW_RUN_SNAPSHOT_MAX_STEPS);
  if (!values) return undefined;
  const steps: WorkflowRunStep[] = [];
  const stepIds = new Set<string>();
  for (const value of values) {
    const step = exactRecord(value, STEP_KEYS);
    if (
      !step ||
      !matches(step.stepId, WORKFLOW_RUN_SNAPSHOT_STEP_ID_PATTERN) ||
      stepIds.has(step.stepId) ||
      !isOneOf(step.state, WORKFLOW_RUN_STEP_STATES)
    ) {
      return undefined;
    }
    stepIds.add(step.stepId);
    steps.push({ stepId: step.stepId, state: step.state });
  }
  return steps;
}

function projectEvents(
  input: unknown,
): WorkflowRunAppliedEvent[] | undefined {
  const values = exactArray(input, 0, WORKFLOW_RUN_MAX_APPLIED_EVENTS);
  if (!values) return undefined;
  const events: WorkflowRunAppliedEvent[] = [];
  const eventIds = new Set<string>();
  for (const value of values) {
    const event = exactRecord(value, EVENT_KEYS);
    if (
      !event ||
      !matches(event.eventId, WORKFLOW_RUN_EVENT_ID_PATTERN) ||
      eventIds.has(event.eventId) ||
      !matches(event.payloadHash, WORKFLOW_RUN_HASH_PATTERN)
    ) {
      return undefined;
    }
    eventIds.add(event.eventId);
    events.push({
      eventId: event.eventId,
      payloadHash: event.payloadHash,
    });
  }
  return events;
}

function hasValidStateShape(
  runState: WorkflowRunState,
  runVersion: number,
  steps: readonly WorkflowRunStep[],
): boolean {
  const states = steps.map(({ state }) => state);
  if ((runState === "created") !== (runVersion === 0)) return false;
  if (runState === "created") {
    return states.every((state) => state === "pending");
  }
  if (runState === "running") {
    return /^(?:(?:succeeded)+(?:pending)+|(?:succeeded)*active(?:pending)*)$/u.test(
      states.join(""),
    );
  }
  if (runState === "succeeded") {
    return states.every((state) => state === "succeeded");
  }
  if (runState === "failed") {
    return /^(succeeded)*failed(cancelled)*$/u.test(states.join(""));
  }
  return /^(succeeded)*(cancelled)+$/u.test(states.join(""));
}

function isVersion(value: unknown, eventCount: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    (value as number) >= 0 &&
    value === eventCount &&
    value <= WORKFLOW_RUN_MAX_APPLIED_EVENTS
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !CANONICAL_TIMESTAMP.test(value)
  ) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === "string" &&
    values.some((candidate) => candidate === value);
}

function exactArray(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): unknown[] | undefined {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      return undefined;
    }
    const length = value.length;
    if (
      length < minimumLength ||
      length > maximumLength ||
      Reflect.ownKeys(value).length !== length + 1
    ) {
      return undefined;
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        value,
        String(index),
      );
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  expectedKeys: Keys,
): Record<Keys[number], unknown> | undefined {
  if (!isPlainRecord(value)) return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string") ||
      !expectedKeys.every((key) => keys.includes(key))
    ) {
      return undefined;
    }
    const snapshot = Object.create(null) as Record<Keys[number], unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
      snapshot[key as Keys[number]] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
