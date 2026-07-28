import type {
  EngineRunDetailView,
  EngineRunListItemView,
  EngineRunOptionView,
} from "../../../app/engine-run-view";

const readyRunnerId = `rnr_${"a".repeat(32)}`;
const attentionRunnerId = `rnr_${"b".repeat(32)}`;
const queuedRunId = `run_${"1".repeat(32)}`;
const leasedRunId = `run_${"2".repeat(32)}`;
const completedRunId = `run_${"3".repeat(32)}`;

export const engineRunUiOptions = [
  {
    optionId: "aurora-claude",
    assignedRunnerId: readyRunnerId,
    runnerDisplayName: "Aurora local",
    engine: "claude_code_cli",
    engineVersion: "1.0.93",
    status: "available",
    readiness: "ready",
    reason: "none",
    freshness: "fresh",
    reportId: `erp_${"c".repeat(32)}`,
    reportReceivedAt: "2026-07-28T13:00:00.000Z",
    freshUntil: "2026-07-28T14:00:00.000Z",
    evaluatedAt: "2026-07-28T13:05:00.000Z",
    trust: "hostReported",
    eligible: true,
    disabledReasonCode: null,
    disabledReason: "",
  },
  {
    optionId: "atlas-codex",
    assignedRunnerId: attentionRunnerId,
    runnerDisplayName: "Atlas local",
    engine: "codex_cli",
    engineVersion: null,
    status: "unavailable",
    readiness: "attention_required",
    reason: "engine_auth_attention_required",
    freshness: "fresh",
    reportId: `erp_${"d".repeat(32)}`,
    reportReceivedAt: "2026-07-28T13:01:00.000Z",
    freshUntil: "2026-07-28T14:01:00.000Z",
    evaluatedAt: "2026-07-28T13:05:00.000Z",
    trust: "hostReported",
    eligible: false,
    disabledReasonCode: "engine_auth_attention_required",
    disabledReason:
      "O login local do Codex CLI requer atenção no host Atlas.",
  },
  {
    optionId: "boreal-claude",
    assignedRunnerId: `rnr_${"e".repeat(32)}`,
    runnerDisplayName: "Boreal local",
    engine: "claude_code_cli",
    engineVersion: null,
    status: null,
    readiness: null,
    reason: null,
    freshness: "not_evaluated",
    reportId: null,
    reportReceivedAt: null,
    freshUntil: null,
    evaluatedAt: "2026-07-28T13:05:00.000Z",
    trust: "hostReported",
    eligible: false,
    disabledReasonCode: "engine_policy_invalid",
    disabledReason:
      "O relatório do host não pôde ser avaliado pela política vigente.",
  },
] as const satisfies readonly EngineRunOptionView[];

export const engineRunUiRuns = [
  {
    id: queuedRunId,
    assignedRunnerId: readyRunnerId,
    runnerDisplayName: "Aurora local",
    engine: "claude_code_cli",
    storedStatus: "queued",
    deadlineAt: "2026-07-28T13:20:00.000Z",
    overdue: true,
    deadlineState: "overdue_awaiting_reconciliation",
    createdAt: "2026-07-28T13:00:00.000Z",
    updatedAt: "2026-07-28T13:00:00.000Z",
  },
  {
    id: leasedRunId,
    assignedRunnerId: readyRunnerId,
    runnerDisplayName: "Aurora local",
    engine: "claude_code_cli",
    storedStatus: "leased",
    deadlineAt: "2026-07-28T13:25:00.000Z",
    overdue: false,
    deadlineState: "pending",
    createdAt: "2026-07-28T13:02:00.000Z",
    updatedAt: "2026-07-28T13:04:00.000Z",
  },
  {
    id: completedRunId,
    assignedRunnerId: readyRunnerId,
    runnerDisplayName: "Aurora local",
    engine: "claude_code_cli",
    storedStatus: "completed",
    deadlineAt: "2026-07-28T13:30:00.000Z",
    overdue: false,
    deadlineState: "settled",
    createdAt: "2026-07-28T13:03:00.000Z",
    updatedAt: "2026-07-28T13:09:00.000Z",
  },
] as const satisfies readonly EngineRunListItemView[];

export const engineRunUiTerminalRuns = [
  {
    ...engineRunUiRuns[2],
    id: `run_${"a".repeat(32)}`,
    storedStatus: "canceled",
    overdue: true,
    deadlineState: "settled",
  },
  {
    ...engineRunUiRuns[2],
    id: `run_${"b".repeat(32)}`,
    storedStatus: "expired",
    overdue: true,
    deadlineState: "settled",
  },
] as const satisfies readonly EngineRunListItemView[];

export const engineRunUiCompletedDetail = {
  run: {
    ...engineRunUiRuns[2],
    leaseGeneration: 1,
    currentLeaseId: `lea_${"4".repeat(32)}`,
    currentRunnerId: readyRunnerId,
  },
  eventsCount: 4,
  eventsTruncated: false,
  receipt: {
    receiptSha256: "5".repeat(64),
    excerptStorageState: "stored_encrypted",
    engineVersion: "1.0.93",
    status: "succeeded",
    reason: "none",
    exitCode: 0,
    timedOut: false,
    cancelRequested: false,
    startedAt: "2026-07-28T13:05:00.000Z",
    finishedAt: "2026-07-28T13:08:00.000Z",
    recordedAt: "2026-07-28T13:09:00.000Z",
    stdout: {
      bytes: 8_192,
      excerptBytes: 768,
      sha256: "8".repeat(64),
      truncated: true,
    },
    stderr: {
      bytes: 0,
      excerptBytes: 0,
      sha256: "9".repeat(64),
      truncated: false,
    },
  },
} as const satisfies EngineRunDetailView;
