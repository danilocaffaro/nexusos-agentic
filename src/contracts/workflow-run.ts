export const WORKFLOW_RUN_SPEC_VERSION = "nexusos.workflow-run.v1" as const;
export const WORKFLOW_RUN_RECORD_SPEC_VERSION =
  "nexusos.workflow-run-record.v1" as const;
export const WORKFLOW_RUN_CLAIM = "state_only_no_execution" as const;

export const WORKFLOW_RUN_STATES = [
  "created",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const WORKFLOW_RUN_STEP_STATES = [
  "pending",
  "active",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const WORKFLOW_RUN_EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
export const WORKFLOW_RUN_HASH_PATTERN = /^[0-9a-f]{64}$/u;
export const WORKFLOW_RUN_INITIAL_VERSION = 0 as const;
export const WORKFLOW_RUN_GENESIS_SEQUENCE = 0 as const;

export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];
export type WorkflowRunStepState =
  (typeof WORKFLOW_RUN_STEP_STATES)[number];

export type WorkflowRunStep = Readonly<{
  stepId: string;
  state: WorkflowRunStepState;
}>;

export type WorkflowRunAppliedEvent = Readonly<{
  eventId: string;
  payloadHash: string;
}>;

export type WorkflowRunSnapshot = Readonly<{
  specVersion: typeof WORKFLOW_RUN_SPEC_VERSION;
  stateClaim: typeof WORKFLOW_RUN_CLAIM;
  runId: string;
  organizationId: string;
  projectId: string;
  workflowId: string;
  definitionVersionHash: string;
  runVersion: typeof WORKFLOW_RUN_INITIAL_VERSION | number;
  runState: WorkflowRunState;
  steps: readonly WorkflowRunStep[];
  appliedEvents: readonly WorkflowRunAppliedEvent[];
  createdAt: string;
  updatedAt: string;
}>;

export type WorkflowRunGenesisRecord = Readonly<{
  recordSpecVersion: typeof WORKFLOW_RUN_RECORD_SPEC_VERSION;
  recordType: "genesis";
  sequence: typeof WORKFLOW_RUN_GENESIS_SEQUENCE;
  snapshot: WorkflowRunSnapshot;
}>;

export type WorkflowRunInitializeRequest = Readonly<{
  runId: string;
  organizationId: string;
  projectId: string;
  declaration: unknown;
  createdAt: string;
}>;

export const WORKFLOW_RUN_INITIALIZE_REJECTION_REASONS = [
  "input_not_record",
  "shape_invalid",
  "run_binding_invalid",
  "tenant_binding_invalid",
  "created_at_invalid",
  "definition_rejected",
  "tenant_binding_mismatch",
] as const;
export type WorkflowRunInitializeRejectionReason =
  (typeof WORKFLOW_RUN_INITIALIZE_REJECTION_REASONS)[number];

export type WorkflowRunInitializeResult =
  | Readonly<{
      status: "initialized";
      snapshot: WorkflowRunSnapshot;
      genesis: WorkflowRunGenesisRecord;
    }>
  | Readonly<{
      status: "rejected";
      reason: WorkflowRunInitializeRejectionReason;
    }>;
