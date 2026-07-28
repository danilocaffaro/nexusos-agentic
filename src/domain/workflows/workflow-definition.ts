import {
  WORKFLOW_BINDING_ID_PATTERN,
  WORKFLOW_DEFINITION_CLAIM,
  WORKFLOW_DEFINITION_PROJECTION_SPEC_VERSION,
  WORKFLOW_DEFINITION_SPEC_VERSION,
  WORKFLOW_DISPLAY_NAME_MAX_CHARS,
  WORKFLOW_ID_PATTERN,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_STEP_ID_PATTERN,
  WORKFLOW_STEP_KINDS,
  type NormalizedWorkflowDefinition,
  type NormalizedWorkflowStep,
  type WorkflowDefinitionEvaluation,
  type WorkflowDefinitionRejectionReason,
  type WorkflowStepKind,
} from "../../contracts/workflow-definition";
import { hashCanonical } from "../governance/crypto";

const DEFINITION_KEYS = [
  "specVersion",
  "workflowId",
  "organizationId",
  "projectId",
  "displayName",
  "steps",
] as const;
const STEP_KEYS = ["stepId", "kind", "displayName"] as const;
const ARRAY_LIMIT_EXCEEDED = Symbol("array_limit_exceeded");
const UNSAFE_DISPLAY_CHAR = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

type MutableEvaluation =
  | {
      status: "accepted";
      definition: NormalizedWorkflowDefinition;
    }
  | {
      status: "rejected";
      reason: WorkflowDefinitionRejectionReason;
    };

export async function evaluateWorkflowDefinition(
  input: unknown,
): Promise<WorkflowDefinitionEvaluation> {
  try {
    const evaluated = evaluate(input);
    if (evaluated.status === "rejected") return deepFreeze(evaluated);
    const definitionVersionHash = await hashCanonical(evaluated.definition);
    return deepFreeze({
      status: "accepted",
      projection: {
        specVersion: WORKFLOW_DEFINITION_PROJECTION_SPEC_VERSION,
        definitionClaim: WORKFLOW_DEFINITION_CLAIM,
        definitionVersionHash,
        definition: evaluated.definition,
      },
    });
  } catch {
    return deepFreeze({
      status: "rejected",
      reason: "shape_invalid",
    } as const);
  }
}

function evaluate(input: unknown): MutableEvaluation {
  const value = exactRecord(input, DEFINITION_KEYS);
  if (!value) {
    return reject(isPlainRecord(input) ? "shape_invalid" : "input_not_record");
  }
  if (value.specVersion !== WORKFLOW_DEFINITION_SPEC_VERSION) {
    return reject("spec_version_mismatch");
  }
  if (
    typeof value.workflowId !== "string" ||
    !WORKFLOW_ID_PATTERN.test(value.workflowId)
  ) {
    return reject("workflow_id_invalid");
  }
  if (
    typeof value.organizationId !== "string" ||
    !WORKFLOW_BINDING_ID_PATTERN.test(value.organizationId) ||
    typeof value.projectId !== "string" ||
    !WORKFLOW_BINDING_ID_PATTERN.test(value.projectId)
  ) {
    return reject("tenant_binding_invalid");
  }
  if (!isDisplayName(value.displayName)) {
    return reject("display_name_invalid");
  }

  const rawSteps = exactArray(value.steps, WORKFLOW_MAX_STEPS);
  if (rawSteps === ARRAY_LIMIT_EXCEEDED) {
    return reject("step_limit_exceeded");
  }
  if (!rawSteps) return reject("shape_invalid");
  if (rawSteps.length === 0) return reject("steps_empty");

  const steps: NormalizedWorkflowStep[] = [];
  const stepIds = new Set<string>();
  for (const rawStep of rawSteps) {
    const step = exactRecord(rawStep, STEP_KEYS);
    if (!step) return reject("shape_invalid");
    if (
      typeof step.stepId !== "string" ||
      !WORKFLOW_STEP_ID_PATTERN.test(step.stepId)
    ) {
      return reject("step_id_invalid");
    }
    if (stepIds.has(step.stepId)) return reject("step_id_duplicate");
    if (!isStepKind(step.kind)) return reject("step_kind_invalid");
    if (!isDisplayName(step.displayName)) {
      return reject("display_name_invalid");
    }
    stepIds.add(step.stepId);
    steps.push({
      stepId: step.stepId,
      kind: step.kind,
      displayName: step.displayName,
    });
  }

  return {
    status: "accepted",
    definition: {
      specVersion: WORKFLOW_DEFINITION_SPEC_VERSION,
      workflowId: value.workflowId,
      organizationId: value.organizationId,
      projectId: value.projectId,
      displayName: value.displayName as string,
      steps,
    },
  };
}

function reject(
  reason: WorkflowDefinitionRejectionReason,
): MutableEvaluation {
  return { status: "rejected", reason };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  try {
    if (Array.isArray(value)) return false;
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

function exactArray(
  value: unknown,
  maximumLength: number,
): readonly unknown[] | typeof ARRAY_LIMIT_EXCEEDED | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !length ||
      !("value" in length) ||
      typeof length.value !== "number" ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0
    ) {
      return undefined;
    }
    if (length.value > maximumLength) return ARRAY_LIMIT_EXCEEDED;
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.length !== length.value + 1
    ) {
      return undefined;
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
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

function isDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= WORKFLOW_DISPLAY_NAME_MAX_CHARS * 2 &&
    value === value.trim() &&
    !UNSAFE_DISPLAY_CHAR.test(value) &&
    [...value].length <= WORKFLOW_DISPLAY_NAME_MAX_CHARS
  );
}

function isStepKind(value: unknown): value is WorkflowStepKind {
  return (
    typeof value === "string" &&
    WORKFLOW_STEP_KINDS.some((candidate) => candidate === value)
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
