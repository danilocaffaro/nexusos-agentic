import {
  BUNDLED_PROVIDER_CATALOG_SOURCE,
  BUNDLED_PROVIDER_CATALOG_SOURCE_SPEC_VERSION,
  ProviderCatalogSourceError,
  type BundledProviderCatalogSnapshot,
  type BundledProviderCatalogSource,
} from "../../contracts/provider-catalog-source";
import {
  PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
  type ProviderCatalogProjection,
} from "../../contracts/provider-catalog";
import { canonicalJson } from "../governance/canonical-json";
import { sha256Hex } from "../governance/crypto";
import { evaluateProviderCatalog } from "./provider-catalog";

const BUNDLED_DECLARATION = {
  specVersion: PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
  providers: [
    {
      providerId: "anthropic",
      displayName: "Anthropic",
      methods: [
        {
          method: "cli",
          cliEngine: "claude_code_cli",
        },
      ],
    },
    {
      providerId: "openai",
      displayName: "OpenAI",
      methods: [
        {
          method: "cli",
          cliEngine: "codex_cli",
        },
      ],
    },
  ],
  models: [],
} as const;

export function createBundledProviderCatalogSource(
  loadDeclaration: () => unknown | Promise<unknown>,
): BundledProviderCatalogSource {
  let memoized: Promise<BundledProviderCatalogSnapshot> | undefined;
  return () => {
    memoized ??= Promise.resolve()
      .then(loadDeclaration)
      .then(buildSnapshot)
      .catch(() => {
        throw new ProviderCatalogSourceError();
      });
    return memoized;
  };
}

export const getBundledProviderCatalog =
  createBundledProviderCatalogSource(() => BUNDLED_DECLARATION);

async function buildSnapshot(
  declaration: unknown,
): Promise<BundledProviderCatalogSnapshot> {
  const evaluation = evaluateProviderCatalog(declaration);
  if (evaluation.status !== "accepted") {
    throw new ProviderCatalogSourceError();
  }
  const canonicalDeclaration = declarationFromProjection(
    evaluation.projection,
  );
  const declarationSha256 = await sha256Hex(
    canonicalJson(canonicalDeclaration),
  );
  return deepFreeze({
    sourceRef: {
      specVersion: BUNDLED_PROVIDER_CATALOG_SOURCE_SPEC_VERSION,
      source: BUNDLED_PROVIDER_CATALOG_SOURCE,
      declarationSha256,
    },
    declaration: canonicalDeclaration,
    projection: evaluation.projection,
  });
}

function declarationFromProjection(
  projection: ProviderCatalogProjection,
): unknown {
  return {
    specVersion: PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
    providers: projection.providers.map((provider) => ({
      providerId: provider.providerId,
      displayName: provider.displayName,
      methods: provider.methods.map((method) => ({
        method: method.method,
        cliEngine: method.cliEngine,
      })),
    })),
    models: projection.models.map((model) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      displayName: model.displayName,
      lifecycle: model.lifecycle,
    })),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
