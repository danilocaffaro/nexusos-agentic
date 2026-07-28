export const WORKFLOW_DEFINITION_SPEC_VERSION =
  "nexusos.workflow-definition.v1" as const;
export const WORKFLOW_DEFINITION_PROJECTION_SPEC_VERSION =
  "nexusos.workflow-definition-projection.v1" as const;
export const WORKFLOW_DEFINITION_CLAIM =
  "declared_only_not_schedulable" as const;

export const WORKFLOW_STEP_KINDS = [
  "agent_task",
  "human_task",
] as const;
export const WORKFLOW_MAX_STEPS = 16;
export const WORKFLOW_DISPLAY_NAME_MAX_CHARS = 64;
export const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/u;
export const WORKFLOW_STEP_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/u;
export const WORKFLOW_BINDING_ID_PATTERN = /^[!-~]{1,64}$/u;
export const WORKFLOW_DEFINITION_HASH_PATTERN = /^[0-9a-f]{64}$/u;

export const WORKFLOW_DEFINITION_REJECTION_REASONS = [
  "input_not_record",
  "spec_version_mismatch",
  "shape_invalid",
  "workflow_id_invalid",
  "step_id_invalid",
  "step_id_duplicate",
  "step_kind_invalid",
  "step_limit_exceeded",
  "steps_empty",
  "display_name_invalid",
  "tenant_binding_invalid",
] as const;

export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];
export type WorkflowDefinitionRejectionReason =
  (typeof WORKFLOW_DEFINITION_REJECTION_REASONS)[number];

export type NormalizedWorkflowStep = Readonly<{
  stepId: string;
  kind: WorkflowStepKind;
  displayName: string;
}>;

export type NormalizedWorkflowDefinition = Readonly<{
  specVersion: typeof WORKFLOW_DEFINITION_SPEC_VERSION;
  workflowId: string;
  organizationId: string;
  projectId: string;
  displayName: string;
  steps: readonly NormalizedWorkflowStep[];
}>;

export type WorkflowDefinitionProjection = Readonly<{
  specVersion: typeof WORKFLOW_DEFINITION_PROJECTION_SPEC_VERSION;
  definitionClaim: typeof WORKFLOW_DEFINITION_CLAIM;
  definitionVersionHash: string;
  definition: NormalizedWorkflowDefinition;
}>;

export type WorkflowDefinitionEvaluation =
  | Readonly<{
      status: "accepted";
      projection: WorkflowDefinitionProjection;
    }>
  | Readonly<{
      status: "rejected";
      reason: WorkflowDefinitionRejectionReason;
    }>;
