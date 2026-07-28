import type { ExecutionEngineName } from "./execution-engines";

export const PROVIDER_CATALOG_DECLARATION_SPEC_VERSION =
  "nexusos.provider-catalog-declaration.v1" as const;
export const PROVIDER_CATALOG_PROJECTION_SPEC_VERSION =
  "nexusos.provider-catalog-projection.v1" as const;
export const PROVIDER_CATALOG_CLAIM =
  "declared_only_no_connectivity" as const;
export const CONNECTION_METHOD_TRUST = "declared_unverified" as const;
export const CONNECTION_METHODS = ["oauth", "cli"] as const;
export const MODEL_LIFECYCLES = [
  "available",
  "deprecated",
  "retired",
  "unknown",
] as const;
export const PROVIDER_CATALOG_MAX_PROVIDERS = 16;
export const PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER = 64;
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/u;
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,127}$/u;
export const CATALOG_DISPLAY_NAME_MAX_CHARS = 64;
export const PROVIDER_CATALOG_REJECTION_REASONS = [
  "input_not_record",
  "spec_version_mismatch",
  "shape_invalid",
  "provider_id_invalid",
  "provider_id_duplicate",
  "provider_limit_exceeded",
  "method_invalid",
  "method_duplicate",
  "method_engine_mismatch",
  "model_id_invalid",
  "model_id_duplicate",
  "model_limit_exceeded",
  "model_provider_unknown",
  "lifecycle_invalid",
  "display_name_invalid",
] as const;
export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];
export type ModelLifecycle = (typeof MODEL_LIFECYCLES)[number];
export type ProviderCatalogRejectionReason =
  (typeof PROVIDER_CATALOG_REJECTION_REASONS)[number];
export type ConnectionMethodProjection = Readonly<{
  method: ConnectionMethod;
  trust: typeof CONNECTION_METHOD_TRUST;
  cliEngine: ExecutionEngineName | null;
}>;
export type CatalogProviderProjection = Readonly<{
  providerId: string;
  displayName: string;
  methods: readonly ConnectionMethodProjection[];
}>;
export type CatalogModelProjection = Readonly<{
  providerId: string;
  modelId: string;
  displayName: string;
  lifecycle: ModelLifecycle;
}>;
export type ProviderCatalogProjection = Readonly<{
  specVersion: typeof PROVIDER_CATALOG_PROJECTION_SPEC_VERSION;
  catalogClaim: typeof PROVIDER_CATALOG_CLAIM;
  providers: readonly CatalogProviderProjection[];
  models: readonly CatalogModelProjection[];
}>;
export type ProviderCatalogEvaluation =
  | Readonly<{ status: "accepted"; projection: ProviderCatalogProjection }>
  | Readonly<{ status: "rejected"; reason: ProviderCatalogRejectionReason }>;
