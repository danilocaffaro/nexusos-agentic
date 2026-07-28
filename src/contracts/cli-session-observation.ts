import type {
  ConnectionIntentRejectionReason,
  ConnectionIntentResolution,
} from "./connection-intent";
import type { ExecutionEngineName } from "./execution-engines";
import {
  ENGINE_RUN_OPTION_DISABLED_REASONS,
  type EngineRunOptionDisabledReason,
} from "./engine-run-options";

export const CLI_SESSION_OBSERVATION_SPEC_VERSION =
  "nexusos.cli-session-observation.v1" as const;
export const CLI_SESSION_OBSERVATION_CLAIM =
  "fresh_host_reported_cli_auth_session_for_declared_candidate_no_provider_connection_no_account_no_execution_no_quota" as const;
export const CLI_SESSION_NOT_OBSERVED_CLAIM =
  "no_cli_session_observation" as const;

export const CLI_SESSION_OBSERVATION_FAILURE_REASONS = [
  "request_invalid",
  "runner_id_invalid",
  "connection_intent_rejected",
  "method_not_supported",
  "runner_not_observed",
  ...ENGINE_RUN_OPTION_DISABLED_REASONS,
] as const;

export type CliSessionObservationFailureReason =
  (typeof CLI_SESSION_OBSERVATION_FAILURE_REASONS)[number];

export type CliSessionObservationRequest = Readonly<{
  runnerId: string;
  intent: unknown;
  declaration: unknown;
}>;

export type CliSessionObservationCandidate = Readonly<{
  providerId: string;
  modelId: string | null;
  cliEngine: ExecutionEngineName;
  bindingTrust: "declared_unverified";
}>;

export type CliSessionHostObservation = Readonly<{
  runnerId: string;
  reportId: string;
  receivedAt: string;
  freshUntil: string;
  evaluatedAt: string;
  engineVersion: string;
  trust: "hostReported";
}>;

type NotObservedBase = Readonly<{
  specVersion: typeof CLI_SESSION_OBSERVATION_SPEC_VERSION;
  status: "not_observed";
  observationClaim: typeof CLI_SESSION_NOT_OBSERVED_CLAIM;
}>;

type ConnectionIntentCatalogReason = Extract<
  ConnectionIntentResolution,
  {
    status: "rejected";
    reason: "catalog_rejected";
  }
>["catalogReason"];

type SimpleFailureReason = Exclude<
  CliSessionObservationFailureReason,
  "connection_intent_rejected"
>;

export type CliSessionObservationResolution =
  | Readonly<{
      specVersion: typeof CLI_SESSION_OBSERVATION_SPEC_VERSION;
      status: "observed";
      observationClaim: typeof CLI_SESSION_OBSERVATION_CLAIM;
      candidate: CliSessionObservationCandidate;
      observation: CliSessionHostObservation;
    }>
  | (NotObservedBase & Readonly<{
      reason: SimpleFailureReason;
    }>)
  | (NotObservedBase & Readonly<{
      reason: "connection_intent_rejected";
      intentReason: Exclude<
        ConnectionIntentRejectionReason,
        "catalog_rejected"
      >;
    }>)
  | (NotObservedBase & Readonly<{
      reason: "connection_intent_rejected";
      intentReason: "catalog_rejected";
      catalogReason: ConnectionIntentCatalogReason;
    }>);

export type CliSessionRunOptionsSource =
  () => unknown | Promise<unknown>;

export type CliSessionDisabledReason =
  EngineRunOptionDisabledReason;
