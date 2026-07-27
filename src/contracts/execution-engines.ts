export const EXECUTION_ENGINE_NAMES = [
  "claude_code_cli",
  "codex_cli",
] as const;

export const ENGINE_RUN_KIND = "engine_prompt" as const;
export const ENGINE_RUN_DEADLINE_MS = 20 * 60_000;
export const ENGINE_RUN_MAX_CLAIMS = 2;
export const ENGINE_EXECUTION_TIMEOUT_MAX_MS = 600_000;
export const ENGINE_EXECUTION_TIMEOUT_MIN_MS = 270_000;
export const ENGINE_STDOUT_MAX_BYTES = 262_144;
export const ENGINE_STDERR_MAX_BYTES = 65_536;
export const ENGINE_EXCERPT_MAX_BYTES = 1_024;
export const ENGINE_COMPLETION_MAX_BYTES = 4_096;
export const ENGINE_SUMMARY_MAX_BYTES = 64;
export const ENGINE_VERSION_MAX_BYTES = 64;
export const ENGINE_PROMPT_MIN_BYTES = 1;
export const ENGINE_PROMPT_MAX_BYTES = 8_192;
export const ENGINE_CREATE_REQUEST_MAX_BYTES = 56 * 1_024;
export const ENGINE_SIGNED_CONTROL_BODY_MAX_BYTES = 4_096;

export const ENGINE_OUTPUT_BOUNDS = Object.freeze({
  stderrBytes: ENGINE_STDERR_MAX_BYTES,
  stdoutBytes: ENGINE_STDOUT_MAX_BYTES,
});

export const ENGINE_EXECUTION_LIMITS = Object.freeze({
  excerptBytes: ENGINE_EXCERPT_MAX_BYTES,
  outputBounds: ENGINE_OUTPUT_BOUNDS,
});

export const ENGINE_EXECUTION_STATUSES = [
  "succeeded",
  "failed",
  "canceled",
] as const;

export const ENGINE_EXECUTION_REASONS = [
  "none",
  "engine_incompatible",
  "engine_deadline_exhausted",
  "prompt_unavailable",
  "prompt_erased",
  "prompt_integrity_mismatch",
  "spawn_failed",
  "timed_out",
  "cancel_requested",
  "lease_lost",
  "output_limit_reached",
  "interrupted_after_start",
  "orphan_identity_ambiguous",
  "engine_exit_nonzero",
  "protocol_invalid",
] as const;

export const ENGINE_PROBE_REASONS = [
  "none",
  "engine_not_configured",
  "engine_binary_invalid",
  "engine_auth_attention_required",
  "engine_incompatible",
  "engine_probe_failed",
] as const;

export const ENGINE_PROBE_STATUSES = [
  "available",
  "unavailable",
  "unknown",
] as const;

export const ENGINE_PROBE_READINESS = [
  "ready",
  "attention_required",
  "unknown",
] as const;

export type ExecutionEngineName = (typeof EXECUTION_ENGINE_NAMES)[number];
export type EngineExecutionStatus =
  (typeof ENGINE_EXECUTION_STATUSES)[number];
export type EngineExecutionReason =
  (typeof ENGINE_EXECUTION_REASONS)[number];
export type EngineProbeReason = (typeof ENGINE_PROBE_REASONS)[number];
export type EngineProbeStatus = (typeof ENGINE_PROBE_STATUSES)[number];
export type EngineProbeReadiness = (typeof ENGINE_PROBE_READINESS)[number];
export type EngineExecutionSummary =
  | "completed"
  | Exclude<EngineExecutionReason, "none">;

export type EnginePromptDescriptor = {
  promptBytes: number;
  promptRef: string;
  promptSha256: string;
};

export type EngineJobDescriptor = EnginePromptDescriptor & {
  deadlineAt: string;
  engine: ExecutionEngineName;
  engineVersion: string;
  outputBounds: typeof ENGINE_OUTPUT_BOUNDS;
  timeoutMs: number;
};

export type EngineProbe = {
  collectedAt: string;
  engine: ExecutionEngineName;
  readiness: EngineProbeReadiness;
  reason: EngineProbeReason;
  status: EngineProbeStatus;
  version?: string;
};

export type EngineExecutionInput = {
  deadlineAt: string;
  engine: ExecutionEngineName;
  engineVersion: string;
  limits: typeof ENGINE_EXECUTION_LIMITS;
  prompt: Uint8Array;
  promptSha256: string;
  signal: AbortSignal;
  timeoutMs: number;
  workdir: string;
};

export type EngineStreamReceipt = {
  bytes: number;
  excerptBase64Url: string;
  sha256: string;
  truncated: boolean;
};

export type EngineExecutionResult = {
  cancelRequested: boolean;
  engine: ExecutionEngineName;
  engineVersion: string;
  exitCode: number | null;
  finishedAt: string;
  reason: EngineExecutionReason;
  startedAt: string;
  status: EngineExecutionStatus;
  stderr: EngineStreamReceipt;
  stdout: EngineStreamReceipt;
  summary: EngineExecutionSummary;
  timedOut: boolean;
};

export type EngineCompleteBody = {
  fence: number;
  leaseId: string;
  operationId: string;
  receipt: EngineExecutionResult;
};
