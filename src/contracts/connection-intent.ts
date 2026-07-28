import type { ExecutionEngineName } from "./execution-engines";
import type {
  ConnectionMethod,
  ConnectionMethodProjection,
  ModelLifecycle,
  PROVIDER_CATALOG_CLAIM,
  ProviderCatalogRejectionReason,
} from "./provider-catalog";

export const CONNECTION_INTENT_SPEC_VERSION =
  "nexusos.connection-intent.v1" as const;
export const CONNECTION_INTENT_RESOLUTION_SPEC_VERSION =
  "nexusos.connection-intent-resolution.v1" as const;
export const CONNECTION_INTENT_RESOLUTION_CLAIM =
  "declared_candidate_only_no_connection" as const;

export const CONNECTION_INTENT_REJECTION_REASONS = [
  "intent_not_record",
  "intent_structure_invalid",
  "intent_spec_version_mismatch",
  "intent_field_type_invalid",
  "intent_provider_id_invalid",
  "intent_method_invalid",
  "intent_method_engine_mismatch",
  "intent_model_id_invalid",
  "catalog_rejected",
  "provider_not_declared",
  "method_not_declared",
  "engine_not_declared",
  "model_not_declared",
] as const;

export type ConnectionIntentRejectionReason =
  (typeof CONNECTION_INTENT_REJECTION_REASONS)[number];

export type ConnectionIntent = Readonly<{
  specVersion: typeof CONNECTION_INTENT_SPEC_VERSION;
  providerId: string;
  method: ConnectionMethod;
  cliEngine: ExecutionEngineName | null;
  modelId: string | null;
}>;

export type ConnectionCandidateProjection = Readonly<{
  specVersion: typeof CONNECTION_INTENT_RESOLUTION_SPEC_VERSION;
  resolutionClaim: typeof CONNECTION_INTENT_RESOLUTION_CLAIM;
  catalogClaim: typeof PROVIDER_CATALOG_CLAIM;
  provider: Readonly<{
    providerId: string;
    displayName: string;
  }>;
  method: ConnectionMethodProjection;
  declaredModel: Readonly<{
    modelId: string;
    displayName: string;
    lifecycle: ModelLifecycle;
  }> | null;
}>;

export type ConnectionIntentResolution =
  | Readonly<{
      status: "resolved";
      candidate: ConnectionCandidateProjection;
    }>
  | Readonly<{
      status: "rejected";
      reason: Exclude<
        ConnectionIntentRejectionReason,
        "catalog_rejected"
      >;
    }>
  | Readonly<{
      status: "rejected";
      reason: "catalog_rejected";
      catalogReason: ProviderCatalogRejectionReason;
    }>;
