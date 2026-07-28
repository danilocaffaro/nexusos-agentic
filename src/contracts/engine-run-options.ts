import type {
  EngineProbeReadiness,
  EngineProbeReason,
  EngineProbeStatus,
  ExecutionEngineName,
} from "./execution-engines";

export const ENGINE_RUN_OPTIONS_SCHEMA_VERSION = 1 as const;
export const ENGINE_RUN_OPTIONS_MAX_RUNNERS = 100;
export const ENGINE_RUN_OPTIONS_MAX_OPTIONS =
  ENGINE_RUN_OPTIONS_MAX_RUNNERS * 2;

export const ENGINE_RUN_OPTION_DISABLED_REASONS = [
  "runner_inactive",
  "engine_policy_invalid",
  "engine_report_absent",
  "engine_report_future",
  "engine_report_stale",
  "engine_evidence_missing",
  "engine_unavailable",
  "engine_auth_attention_required",
  "engine_misconfigured",
  "engine_version_missing",
  "engine_inventory_inconsistent",
] as const;

export const ENGINE_RUN_OPTIONS_TRUST_DISCLOSURE =
  "Engine status, readiness, reason and version are unverified hostReported metadata from the operator-controlled host. receivedAt and evaluatedAt are server facts; freshUntil is derived by the server from organization policy. eligible is a point-in-time selection preflight only: POST and runner claim revalidate and may reject. It neither reserves a runner nor guarantees routing, execution or provider behavior, and it does not attest host or network isolation. Browser time is never authority.";

export type EngineRunOptionDisabledReason =
  (typeof ENGINE_RUN_OPTION_DISABLED_REASONS)[number];

export type EngineRunInventoryEligibility = Readonly<{
  evaluatedAt: string;
  trust: "hostReported";
  reportId: string | null;
  receivedAt: string | null;
  freshUntil: string | null;
  engine: ExecutionEngineName;
  status: EngineProbeStatus | null;
  readiness: EngineProbeReadiness | null;
  reason: EngineProbeReason | null;
  version: string | null;
  eligible: boolean;
  disabledReason: Exclude<
    EngineRunOptionDisabledReason,
    "runner_inactive"
  > | null;
}>;

export type EngineRunOption = Readonly<
  Omit<EngineRunInventoryEligibility, "disabledReason"> & {
    runnerId: string;
    runnerName: string;
    runnerState: "active" | "inactive";
    disabledReason: EngineRunOptionDisabledReason | null;
  }
>;

export type EngineRunOptionsView = Readonly<{
  schemaVersion: typeof ENGINE_RUN_OPTIONS_SCHEMA_VERSION;
  trustDisclosure: typeof ENGINE_RUN_OPTIONS_TRUST_DISCLOSURE;
  truncated: boolean;
  options: readonly EngineRunOption[];
}>;
