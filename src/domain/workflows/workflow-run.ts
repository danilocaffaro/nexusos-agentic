import {
  WORKFLOW_RUN_CLAIM,
  WORKFLOW_RUN_GENESIS_SEQUENCE,
  WORKFLOW_RUN_INITIAL_VERSION,
  WORKFLOW_RUN_RECORD_SPEC_VERSION,
  WORKFLOW_RUN_SPEC_VERSION,
  type WorkflowRunInitializeRejectionReason,
  type WorkflowRunInitializeResult,
} from "../../contracts/workflow-run";
import { WORKFLOW_BINDING_ID_PATTERN } from "../../contracts/workflow-definition";
import { evaluateWorkflowDefinition } from "./workflow-definition";

const INITIALIZE_KEYS = [
  "runId",
  "organizationId",
  "projectId",
  "declaration",
  "createdAt",
] as const;
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export async function initializeRun(
  input: unknown,
): Promise<WorkflowRunInitializeResult> {
  try {
    const request = exactRecord(input, INITIALIZE_KEYS);
    if (!request) {
      return rejected(
        isPlainRecord(input) ? "shape_invalid" : "input_not_record",
      );
    }
    if (!isBinding(request.runId)) return rejected("run_binding_invalid");
    if (
      !isBinding(request.organizationId) ||
      !isBinding(request.projectId)
    ) {
      return rejected("tenant_binding_invalid");
    }
    if (!isCanonicalTimestamp(request.createdAt)) {
      return rejected("created_at_invalid");
    }

    const evaluation = await evaluateWorkflowDefinition(
      request.declaration,
    );
    if (evaluation.status !== "accepted") {
      return rejected("definition_rejected");
    }
    const definition = evaluation.projection.definition;
    if (
      definition.organizationId !== request.organizationId ||
      definition.projectId !== request.projectId
    ) {
      return rejected("tenant_binding_mismatch");
    }

    const snapshot = deepFreeze({
      specVersion: WORKFLOW_RUN_SPEC_VERSION,
      stateClaim: WORKFLOW_RUN_CLAIM,
      runId: request.runId,
      organizationId: request.organizationId,
      projectId: request.projectId,
      workflowId: definition.workflowId,
      definitionVersionHash:
        evaluation.projection.definitionVersionHash,
      runVersion: WORKFLOW_RUN_INITIAL_VERSION,
      runState: "created" as const,
      steps: definition.steps.map(({ stepId }) => ({
        stepId,
        state: "pending" as const,
      })),
      appliedEvents: [],
      createdAt: request.createdAt,
      updatedAt: request.createdAt,
    });
    const genesis = deepFreeze({
      recordSpecVersion: WORKFLOW_RUN_RECORD_SPEC_VERSION,
      recordType: "genesis" as const,
      sequence: WORKFLOW_RUN_GENESIS_SEQUENCE,
      snapshot,
    });
    return deepFreeze({
      status: "initialized" as const,
      snapshot,
      genesis,
    });
  } catch {
    return rejected("shape_invalid");
  }
}

function rejected(
  reason: WorkflowRunInitializeRejectionReason,
): WorkflowRunInitializeResult {
  return deepFreeze({ status: "rejected", reason });
}

function isBinding(value: unknown): value is string {
  return (
    typeof value === "string" &&
    WORKFLOW_BINDING_ID_PATTERN.test(value)
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
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
