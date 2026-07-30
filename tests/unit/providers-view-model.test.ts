import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BUNDLED_PROVIDER_CATALOG_SOURCE,
  BUNDLED_PROVIDER_CATALOG_SOURCE_SPEC_VERSION,
  PROVIDER_CATALOG_VIEW_SPEC_VERSION,
} from "../../src/contracts/provider-catalog-source";
import {
  CATALOG_DISPLAY_NAME_MAX_CHARS,
  CONNECTION_METHODS,
  CONNECTION_METHOD_TRUST,
  MODEL_ID_PATTERN,
  MODEL_LIFECYCLES,
  PROVIDER_CATALOG_CLAIM,
  PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER,
  PROVIDER_CATALOG_MAX_PROVIDERS,
  PROVIDER_CATALOG_PROJECTION_SPEC_VERSION,
  PROVIDER_ID_PATTERN,
} from "../../src/contracts/provider-catalog";
import { EXECUTION_ENGINE_NAMES } from "../../src/contracts/execution-engines";
import {
  PROVIDER_CLIENT_WIRE,
  PROVIDER_DETAIL_COPY,
  PROVIDER_STATUS_COPY,
  ProviderRequestCoordinator,
  catalogDigestMatches,
  cliCandidatesFrom,
  providerCopyIsTruthful,
  readProviderCatalogView,
} from "../../app/providers-view-model";

const root = fileURLToPath(new URL("../..", import.meta.url));

function payload() {
  return {
    specVersion: PROVIDER_CATALOG_VIEW_SPEC_VERSION,
    sourceRef: {
      specVersion: BUNDLED_PROVIDER_CATALOG_SOURCE_SPEC_VERSION,
      source: BUNDLED_PROVIDER_CATALOG_SOURCE,
      declarationSha256: "a".repeat(64),
    },
    catalog: {
      specVersion: PROVIDER_CATALOG_PROJECTION_SPEC_VERSION,
      catalogClaim: PROVIDER_CATALOG_CLAIM,
      providers: [
        {
          providerId: "anthropic",
          displayName: "Anthropic",
          methods: [
            {
              method: CONNECTION_METHODS[1],
              trust: CONNECTION_METHOD_TRUST,
              cliEngine: EXECUTION_ENGINE_NAMES[0],
            },
          ],
        },
        {
          providerId: "openai",
          displayName: "OpenAI",
          methods: [
            {
              method: CONNECTION_METHODS[0],
              trust: CONNECTION_METHOD_TRUST,
              cliEngine: null,
            },
            {
              method: CONNECTION_METHODS[1],
              trust: CONNECTION_METHOD_TRUST,
              cliEngine: EXECUTION_ENGINE_NAMES[1],
            },
          ],
        },
      ],
      models: [
        {
          providerId: "openai",
          modelId: "gpt-test",
          displayName: "GPT Test",
          lifecycle: MODEL_LIFECYCLES[3],
        },
      ],
    },
  };
}

test("pins every local wire value to the current server contracts", () => {
  assert.deepEqual(PROVIDER_CLIENT_WIRE, {
    projectionSpecVersion: PROVIDER_CATALOG_PROJECTION_SPEC_VERSION,
    catalogClaim: PROVIDER_CATALOG_CLAIM,
    methodTrust: CONNECTION_METHOD_TRUST,
    methods: CONNECTION_METHODS,
    lifecycles: MODEL_LIFECYCLES,
    maxProviders: PROVIDER_CATALOG_MAX_PROVIDERS,
    maxModelsPerProvider: PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER,
    displayNameMaxChars: CATALOG_DISPLAY_NAME_MAX_CHARS,
    providerIdPattern: {
      source: PROVIDER_ID_PATTERN.source,
      flags: PROVIDER_ID_PATTERN.flags,
    },
    modelIdPattern: {
      source: MODEL_ID_PATTERN.source,
      flags: MODEL_ID_PATTERN.flags,
    },
    executionEngines: EXECUTION_ENGINE_NAMES,
  });
  assertDeepFrozen(PROVIDER_CLIENT_WIRE);
});

test("reads the exact v1 envelope into a detached deeply frozen view", () => {
  const input = payload();
  const parsed = readProviderCatalogView(input);
  assert.ok(parsed);
  assert.deepEqual(parsed, {
    specVersion: "nexusos.provider-catalog-view.v1",
    sourceRef: input.sourceRef,
    catalogClaim: "declared_only_no_connectivity",
    providers: [
      {
        providerId: "anthropic",
        displayName: "Anthropic",
        methods: input.catalog.providers[0].methods,
        models: [],
      },
      {
        providerId: "openai",
        displayName: "OpenAI",
        methods: input.catalog.providers[1].methods,
        models: [
          {
            modelId: "gpt-test",
            displayName: "GPT Test",
            lifecycle: "unknown",
          },
        ],
      },
    ],
  });
  input.sourceRef.declarationSha256 = "b".repeat(64);
  input.catalog.providers[0].displayName = "Mutated";
  assert.equal(parsed.sourceRef.declarationSha256, "a".repeat(64));
  assert.equal(parsed.providers[0].displayName, "Anthropic");
  assertDeepFrozen(parsed);
  for (const provider of parsed.providers) {
    for (const method of provider.methods) {
      assert.equal(method.trust, "declared_unverified");
    }
  }
});

test("fails closed for version, source, claim, digest and exact-shape drift", () => {
  const valid = payload();
  const cases: unknown[] = [
    null,
    [],
    { ...valid, extra: true },
    { ...valid, specVersion: "nexusos.provider-catalog-view.v2" },
    {
      ...valid,
      sourceRef: { ...valid.sourceRef, specVersion: "source.v2" },
    },
    { ...valid, sourceRef: { ...valid.sourceRef, source: "remote" } },
    {
      ...valid,
      sourceRef: { ...valid.sourceRef, declarationSha256: "A".repeat(64) },
    },
    {
      ...valid,
      catalog: { ...valid.catalog, specVersion: "projection.v2" },
    },
    {
      ...valid,
      catalog: { ...valid.catalog, catalogClaim: "connectivity_verified" },
    },
    {
      ...valid,
      catalog: {
        ...valid.catalog,
        providers: [{ ...valid.catalog.providers[0], extra: true }],
      },
    },
    {
      ...valid,
      catalog: {
        ...valid.catalog,
        providers: [{
          ...valid.catalog.providers[0],
          methods: [{
            ...valid.catalog.providers[0].methods[0],
            trust: "verified",
          }],
        }],
      },
    },
  ];
  for (const input of cases) assert.equal(readProviderCatalogView(input), null);
});

test("enforces provider, method and model bounds and relationships", () => {
  const valid = payload();
  const provider = valid.catalog.providers[0];
  const withCatalog = (providers: unknown[], models: unknown[]) => ({
    ...valid,
    catalog: { ...valid.catalog, providers, models },
  });
  const cases = [
    withCatalog(
      Array.from({ length: PROVIDER_CATALOG_MAX_PROVIDERS + 1 }, (_, index) => ({
        ...provider,
        providerId: `provider_${index}`,
      })),
      [],
    ),
    withCatalog(
      [{
        ...provider,
        methods: [
          provider.methods[0],
          { ...provider.methods[0] },
          { ...provider.methods[0] },
        ],
      }],
      [],
    ),
    withCatalog([provider, { ...provider }], []),
    withCatalog(
      [{
        ...provider,
        methods: [provider.methods[0], { ...provider.methods[0] }],
      }],
      [],
    ),
    withCatalog(
      [{
        ...provider,
        methods: [{ ...provider.methods[0], cliEngine: null }],
      }],
      [],
    ),
    withCatalog(
      [provider],
      Array.from(
        { length: PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER + 1 },
        (_, index) => ({
        providerId: "anthropic",
        modelId: `model-${index}`,
        displayName: `Model ${index}`,
        lifecycle: "available",
        }),
      ),
    ),
    withCatalog([provider], [{
      providerId: "missing",
      modelId: "model",
      displayName: "Model",
      lifecycle: "available",
    }]),
    withCatalog([provider], [{
      providerId: "anthropic",
      modelId: "model",
      displayName: "Model",
      lifecycle: "future",
    }]),
    withCatalog([provider], [
      {
        providerId: "anthropic",
        modelId: "model",
        displayName: "Model",
        lifecycle: "available",
      },
      {
        providerId: "anthropic",
        modelId: "model",
        displayName: "Duplicate",
        lifecycle: "available",
      },
    ]),
  ];
  for (const input of cases) assert.equal(readProviderCatalogView(input), null);
});

test("accepts the exact server provider, model and display-name bounds", () => {
  const valid = payload();
  const method = valid.catalog.providers[0].methods[0];
  const providers = Array.from(
    { length: PROVIDER_CATALOG_MAX_PROVIDERS },
    (_, index) => ({
      providerId: `provider_${index}`,
      displayName: `Provider ${index}`,
      methods: [{ ...method }],
    }),
  );
  assert.ok(readProviderCatalogView({
    ...valid,
    catalog: { ...valid.catalog, providers, models: [] },
  }));

  const models = Array.from(
    { length: PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER },
    (_, index) => ({
      providerId: "anthropic",
      modelId: `model-${index}`,
      displayName: `Model ${index}`,
      lifecycle: MODEL_LIFECYCLES[0],
    }),
  );
  assert.ok(readProviderCatalogView({
    ...valid,
    catalog: {
      ...valid.catalog,
      providers: [valid.catalog.providers[0]],
      models,
    },
  }));

  const displayName = "A".repeat(CATALOG_DISPLAY_NAME_MAX_CHARS);
  assert.ok(readProviderCatalogView({
    ...valid,
    catalog: {
      ...valid.catalog,
      providers: [{
        ...valid.catalog.providers[0],
        displayName,
      }],
      models: [{
        providerId: "anthropic",
        modelId: "model",
        displayName,
        lifecycle: MODEL_LIFECYCLES[0],
      }],
    },
  }));
});

test("rejects invalid identities, labels and method-engine claims", () => {
  const valid = payload();
  const provider = valid.catalog.providers[0];
  const model = valid.catalog.models[0];
  const withProvider = (candidate: unknown) => ({
    ...valid,
    catalog: { ...valid.catalog, providers: [candidate], models: [] },
  });
  const withModel = (candidate: unknown) => ({
    ...valid,
    catalog: {
      ...valid.catalog,
      providers: [valid.catalog.providers[1]],
      models: [candidate],
    },
  });
  const cases = [
    withProvider({ ...provider, providerId: "Anthropic" }),
    withProvider({ ...provider, providerId: "a" }),
    withProvider({ ...provider, displayName: "" }),
    withProvider({ ...provider, displayName: " Anthropic" }),
    withProvider({
      ...provider,
      displayName: "A".repeat(CATALOG_DISPLAY_NAME_MAX_CHARS + 1),
    }),
    withProvider({ ...provider, displayName: "Anthro\u202Epic" }),
    withProvider({ ...provider, displayName: "\ud800" }),
    withProvider({
      ...valid.catalog.providers[1],
      methods: [{
        ...valid.catalog.providers[1].methods[0],
        cliEngine: EXECUTION_ENGINE_NAMES[1],
      }],
    }),
    withModel({ ...model, modelId: "" }),
    withModel({ ...model, modelId: "has space" }),
    withModel({ ...model, displayName: "" }),
    withModel({ ...model, displayName: " GPT Test" }),
    withModel({
      ...model,
      displayName: "A".repeat(CATALOG_DISPLAY_NAME_MAX_CHARS + 1),
    }),
    withModel({ ...model, displayName: "GPT\u202ETest" }),
    withModel({ ...model, displayName: "\ud800" }),
  ];
  for (const input of cases) assert.equal(readProviderCatalogView(input), null);
});

test("rejects sparse arrays, symbols, accessors and hostile proxies without reads", () => {
  const sparse = payload();
  sparse.catalog.providers =
    new Array(1) as typeof sparse.catalog.providers;

  let accessorTouched = false;
  const accessor = payload();
  Object.defineProperty(accessor, "specVersion", {
    enumerable: true,
    get() {
      accessorTouched = true;
      return "nexusos.provider-catalog-view.v1";
    },
  });

  const symbol = payload() as ReturnType<typeof payload> & {
    [key: symbol]: boolean;
  };
  symbol[Symbol("extra")] = true;
  const proxy = new Proxy(payload(), {
    ownKeys() {
      throw new Error("hostile");
    },
  });

  for (const input of [sparse, accessor, symbol, proxy]) {
    assert.equal(readProviderCatalogView(input), null);
  }
  assert.equal(accessorTouched, false);
});

test("derives only declared CLI candidates and preserves trust", () => {
  const parsed = readProviderCatalogView(payload());
  assert.ok(parsed);
  const candidates = cliCandidatesFrom(parsed);
  assert.deepEqual(candidates, [
    {
      providerId: "anthropic",
      displayName: "Anthropic",
      cliEngine: "claude_code_cli",
      trust: "declared_unverified",
    },
    {
      providerId: "openai",
      displayName: "OpenAI",
      cliEngine: "codex_cli",
      trust: "declared_unverified",
    },
  ]);
  assertDeepFrozen(candidates);
});

test("binds source digest and rejects malformed or drifting headers", () => {
  const parsed = readProviderCatalogView(payload());
  assert.ok(parsed);
  assert.equal(catalogDigestMatches(parsed, "a".repeat(64)), true);
  assert.equal(catalogDigestMatches(parsed, "b".repeat(64)), false);
  assert.equal(catalogDigestMatches(parsed, "A".repeat(64)), false);
  assert.equal(catalogDigestMatches(parsed, null), false);
});

test("copy guard absolutely bans positive chips and permits explicit detail negation", () => {
  for (const copy of Object.values(PROVIDER_STATUS_COPY)) {
    assert.equal(providerCopyIsTruthful(copy, "status"), true, copy);
  }
  for (const copy of Object.values(PROVIDER_DETAIL_COPY)) {
    assert.equal(providerCopyIsTruthful(copy, "detail"), true, copy);
  }
  assert.equal(providerCopyIsTruthful("CONECTADO", "status"), false);
  assert.equal(providerCopyIsTruthful("NÃO CONECTADO", "status"), false);
  assert.equal(
    providerCopyIsTruthful("O provider está conectado.", "detail"),
    false,
  );
  assert.equal(
    providerCopyIsTruthful("O provider não está conectado.", "detail"),
    true,
  );
  assert.equal(
    providerCopyIsTruthful("Sem conta de usuário vinculada.", "detail"),
    true,
  );
});

test("coordinator isolates lanes, supersedes epochs and aborts all on cleanup", () => {
  const coordinator = new ProviderRequestCoordinator();
  const firstCatalog = coordinator.begin("catalog");
  const options = coordinator.begin("options");
  const secondCatalog = coordinator.begin("catalog");
  assert.equal(firstCatalog.signal.aborted, true);
  assert.equal(coordinator.isCurrent("catalog", firstCatalog.epoch), false);
  assert.equal(coordinator.isCurrent("catalog", secondCatalog.epoch), true);
  assert.equal(coordinator.isCurrent("options", options.epoch), true);
  assert.equal(coordinator.finish("catalog", firstCatalog.epoch), false);
  assert.equal(coordinator.finish("catalog", secondCatalog.epoch), true);
  assert.equal(options.signal.aborted, false);
  coordinator.abortAll();
  assert.equal(options.signal.aborted, true);
  assert.equal(coordinator.isCurrent("options", options.epoch), false);
});

test("batch stays bounded and has exactly the sanctioned visible consumer", () => {
  const modelPath = join(root, "app/providers-view-model.ts");
  const model = readFileSync(modelPath, "utf8");
  assert.ok(model.split("\n").length - 1 <= 400);
  assert.doesNotMatch(
    model,
    /(?:\bfetch\s*\(|\b(?:Request|WebSocket|XMLHttpRequest|EventSource)\b|node:(?:http|https|net|dns|tls)|child_process|drizzle|cloudflare:workers|setTimeout|setInterval|localStorage|navigator\.|document\.|process\.env|credential|secret|api.?key|access.?token|refresh.?token|client.?secret)/iu,
  );

  const importPattern =
    /(?:\b(?:from|import)\s*(?:\(\s*)?["'][^"']*providers-view-model(?:\.[cm]?[jt]sx?)?["']|\brequire\s*\(\s*["'][^"']*providers-view-model(?:\.[cm]?[jt]sx?)?["']\s*\))/u;
  const consumers = productionFiles(root)
    .filter((file) => file !== modelPath)
    .filter((file) => importPattern.test(readFileSync(file, "utf8")));
  assert.deepEqual(consumers, [join(root, "app/providers-view.tsx")]);

  const page = readFileSync(join(root, "app/page.tsx"), "utf8");
  assert.doesNotMatch(page, /\bconst providers\s*=/u);
  assert.doesNotMatch(page, /\bfunction ProvidersView\s*\(/u);
  assert.doesNotMatch(page, /from "\.\/providers-view-model"/u);
});

function productionFiles(repositoryRoot: string): string[] {
  const files: string[] = [];
  for (const relative of ["app", "src", "runner", "worker", "scripts"]) {
    const directory = join(repositoryRoot, relative);
    if (!existsSync(directory)) continue;
    visit(directory, files);
  }
  return files;
}

function visit(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path, files);
    else if (/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) files.push(path);
  }
}

function assertDeepFrozen(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  assert.equal(Object.isFrozen(input), true);
  for (const value of Object.values(input)) assertDeepFrozen(value);
}
