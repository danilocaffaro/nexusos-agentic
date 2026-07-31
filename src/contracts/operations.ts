import type {
  EngineExecutionReason,
  EngineExecutionStatus,
  ExecutionEngineName,
} from "./execution-engines";
import type { EngineRunStatus, RunOutcomeStatus } from "./runs";

export type OperationId = `opr_${string}`;

export type OperationReceipt = {
  status: EngineExecutionStatus;
  reason: Exclude<EngineExecutionReason, "engine_deadline_exhausted">;
  stdout: {
    bytes: number;
    sha256: string;
    truncated: boolean;
    excerptBytes: number;
  };
  receiptSha256: string;
  recordedAt: string;
};

export type OperationPublication =
  | { state: "pending" | "eligible" }
  | {
      state: "blocked";
      reason:
        | "run_not_succeeded"
        | "output_empty"
        | "output_unavailable";
    }
  | {
      state: "published";
      artifactId: string;
      versionNumber: 1;
      contentHash: string;
      publishedAt: string;
      stdoutTruncated: boolean;
    };

export type OperationRead = {
  id: OperationId;
  projectId: string;
  workItem: { id: string; ref: string; title: string };
  agent: { id: string; name: string; role: string; model: string };
  assignedRunnerId: string;
  engine: ExecutionEngineName;
  runId: string;
  run: {
    status: EngineRunStatus;
    outcomeStatus?: RunOutcomeStatus;
    deadlineAt: string;
    createdAt: string;
  };
  receipt?: OperationReceipt;
  publication: OperationPublication;
  createdAt: string;
};

export type OperationRegistry = { operations: OperationRead[] };

export type OperationPublishResult = {
  published: boolean;
  operation: OperationRead;
};
