import type { ProviderCatalogProjection } from "./provider-catalog";

export const BUNDLED_PROVIDER_CATALOG_SOURCE_SPEC_VERSION =
  "nexusos.bundled-provider-catalog-source.v1" as const;
export const PROVIDER_CATALOG_VIEW_SPEC_VERSION =
  "nexusos.provider-catalog-view.v1" as const;
export const BUNDLED_PROVIDER_CATALOG_SOURCE = "nexusos_bundled" as const;

export type BundledProviderCatalogSourceRef = Readonly<{
  specVersion: typeof BUNDLED_PROVIDER_CATALOG_SOURCE_SPEC_VERSION;
  source: typeof BUNDLED_PROVIDER_CATALOG_SOURCE;
  declarationSha256: string;
}>;

export type ProviderCatalogView = Readonly<{
  specVersion: typeof PROVIDER_CATALOG_VIEW_SPEC_VERSION;
  sourceRef: BundledProviderCatalogSourceRef;
  catalog: ProviderCatalogProjection;
}>;

export type BundledProviderCatalogSnapshot = Readonly<{
  sourceRef: BundledProviderCatalogSourceRef;
  declaration: unknown;
  projection: ProviderCatalogProjection;
}>;

export type BundledProviderCatalogSource =
  () => Promise<BundledProviderCatalogSnapshot>;

export class ProviderCatalogSourceError extends Error {
  readonly code = "provider_catalog_unavailable" as const;

  constructor() {
    super("Bundled provider catalog is unavailable");
    this.name = "ProviderCatalogSourceError";
  }
}
