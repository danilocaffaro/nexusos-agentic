import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CATALOG_DISPLAY_NAME_MAX_CHARS,
  CONNECTION_METHODS,
  CONNECTION_METHOD_TRUST,
  MODEL_ID_PATTERN,
  MODEL_LIFECYCLES,
  PROVIDER_CATALOG_CLAIM,
  PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
  PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER,
  PROVIDER_CATALOG_MAX_PROVIDERS,
  PROVIDER_CATALOG_PROJECTION_SPEC_VERSION,
  PROVIDER_CATALOG_REJECTION_REASONS,
  PROVIDER_ID_PATTERN,
  type ProviderCatalogRejectionReason,
} from "../../src/contracts/provider-catalog";
import { EXECUTION_ENGINE_NAMES } from "../../src/contracts/execution-engines";
import {
  catalogModelKey,
  evaluateProviderCatalog,
  projectProviderCatalog,
} from "../../src/domain/providers/provider-catalog";

const root = fileURLToPath(new URL("../..", import.meta.url));

type DeclarationFixture = {
  specVersion: string;
  providers: Array<{
    providerId: string;
    displayName: string;
    methods: Array<{ method: string; cliEngine: string | null }>;
  }>;
  models: Array<{
    providerId: string;
    modelId: string;
    displayName: string;
    lifecycle: string;
  }>;
};

function declaration(): DeclarationFixture {
  return {
    specVersion: PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
    providers: [
      {
        providerId: "openai",
        displayName: "OpenAI",
        methods: [{ method: "oauth", cliEngine: null }],
      },
    ],
    models: [
      {
        providerId: "openai",
        modelId: "gpt-5.6",
        displayName: "GPT 5.6",
        lifecycle: "available",
      },
    ],
  };
}

test("catalog constants lock the closed declaration vocabulary", () => {
  assert.equal(
    PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
    "nexusos.provider-catalog-declaration.v1",
  );
  assert.equal(
    PROVIDER_CATALOG_PROJECTION_SPEC_VERSION,
    "nexusos.provider-catalog-projection.v1",
  );
  assert.equal(PROVIDER_CATALOG_CLAIM, "declared_only_no_connectivity");
  assert.equal(CONNECTION_METHOD_TRUST, "declared_unverified");
  assert.deepEqual(CONNECTION_METHODS, ["oauth", "cli"]);
  assert.deepEqual(MODEL_LIFECYCLES, [
    "available",
    "deprecated",
    "retired",
    "unknown",
  ]);
  assert.equal(PROVIDER_CATALOG_MAX_PROVIDERS, 16);
  assert.equal(PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER, 64);
  assert.equal(CATALOG_DISPLAY_NAME_MAX_CHARS, 64);
  assert.deepEqual(PROVIDER_CATALOG_REJECTION_REASONS, [
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
  ]);
  assert.equal(PROVIDER_ID_PATTERN.test("aa"), true);
  assert.equal(PROVIDER_ID_PATTERN.test("a_2"), true);
  assert.equal(PROVIDER_ID_PATTERN.test("A2"), false);
  assert.equal(PROVIDER_ID_PATTERN.test("a"), false);
  assert.equal(MODEL_ID_PATTERN.test("x"), true);
  assert.equal(MODEL_ID_PATTERN.test("m1"), true);
  assert.equal(MODEL_ID_PATTERN.test("m:1.2-beta"), true);
  assert.equal(MODEL_ID_PATTERN.test("anthropic/claude"), true);
  assert.equal(MODEL_ID_PATTERN.test("meta-llama/Llama-4+Scout"), true);
  assert.equal(MODEL_ID_PATTERN.test("@cf/meta/llama_3@latest"), true);
  assert.equal(MODEL_ID_PATTERN.test("_local/model_name"), true);
  assert.equal(
    MODEL_ID_PATTERN.test("publishers/google/models/gemini-2.5-pro"),
    true,
  );
  assert.equal(MODEL_ID_PATTERN.test("model name"), false);
  assert.equal(MODEL_ID_PATTERN.test(`@${"_".repeat(255)}`), true);
  assert.equal(MODEL_ID_PATTERN.test(`@${"_".repeat(256)}`), false);
});

test("connection methods mirror the frozen D1 auth-method enum", async () => {
  const schema = await readFile(join(root, "db/schema.ts"), "utf8");
  assert.deepEqual(CONNECTION_METHODS, ["oauth", "cli"]);
  assert.match(
    schema,
    /authMethod:\s*text\("auth_method", \{ enum: \["oauth", "cli"\] \}\)/u,
  );
});

test("accepted projection is sorted, truth-stamped and deeply frozen", () => {
  const input = {
    specVersion: PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
    providers: [
      {
        providerId: "zeta",
        displayName: "Zeta",
        methods: [{ method: "oauth", cliEngine: null }],
      },
      {
        providerId: "alpha",
        displayName: "Alpha",
        methods: [
          { method: "oauth", cliEngine: null },
          { method: "cli", cliEngine: "codex_cli" },
        ],
      },
    ],
    models: [
      {
        providerId: "zeta",
        modelId: "z2",
        displayName: "Zeta 2",
        lifecycle: "unknown",
      },
      {
        providerId: "alpha",
        modelId: "a2",
        displayName: "Alpha 2",
        lifecycle: "deprecated",
      },
    ],
  };
  const result = evaluateProviderCatalog(input);
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.projection.specVersion, PROVIDER_CATALOG_PROJECTION_SPEC_VERSION);
  assert.equal(result.projection.catalogClaim, PROVIDER_CATALOG_CLAIM);
  assert.deepEqual(
    result.projection.providers.map(({ providerId }) => providerId),
    ["alpha", "zeta"],
  );
  assert.deepEqual(result.projection.providers[0]?.methods, [
    {
      method: "cli",
      trust: CONNECTION_METHOD_TRUST,
      cliEngine: "codex_cli",
    },
    {
      method: "oauth",
      trust: CONNECTION_METHOD_TRUST,
      cliEngine: null,
    },
  ]);
  assert.deepEqual(
    result.projection.models.map(({ providerId, modelId }) => [
      providerId,
      modelId,
    ]),
    [
      ["alpha", "a2"],
      ["zeta", "z2"],
    ],
  );
  assertDeepFrozen(result);
});

test("hostile unknown inputs are total and fail closed", () => {
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(accessor, {
    specVersion: {
      value: PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
      enumerable: true,
    },
    providers: {
      get() {
        throw new Error("must not execute");
      },
      enumerable: true,
    },
    models: { value: [], enumerable: true },
  });
  const sparse = declaration();
  sparse.providers = new Array(1) as typeof sparse.providers;
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const throwingProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("hostile");
      },
    },
  );
  const symbolKey = { ...declaration(), [Symbol("extra")]: true };
  const hostile: unknown[] = [
    undefined,
    null,
    true,
    1,
    "catalog",
    Symbol("catalog"),
    [],
    accessor,
    sparse,
    revoked.proxy,
    throwingProxy,
    symbolKey,
    JSON.parse(
      `{"__proto__":{},"specVersion":"${PROVIDER_CATALOG_DECLARATION_SPEC_VERSION}","providers":[],"models":[]}`,
    ),
  ];
  for (const input of hostile) {
    assert.doesNotThrow(() => evaluateProviderCatalog(input));
    assert.equal(evaluateProviderCatalog(input).status, "rejected");
    assert.equal(projectProviderCatalog(input), undefined);
  }
});

test("non-array and sparse collections are shape errors, not limit errors", () => {
  const sparseProviders = declaration();
  sparseProviders.providers = new Array(1) as typeof sparseProviders.providers;
  const sparseModels = declaration();
  sparseModels.models = new Array(1) as typeof sparseModels.models;
  for (const input of [
    { ...declaration(), providers: {} },
    sparseProviders,
    { ...declaration(), models: {} },
    sparseModels,
  ]) {
    assert.deepEqual(evaluateProviderCatalog(input), {
      status: "rejected",
      reason: "shape_invalid",
    });
  }
});

test("every closed rejection reason is reachable and exact", () => {
  const cases = new Map<ProviderCatalogRejectionReason, unknown>();
  cases.set("input_not_record", null);
  cases.set("spec_version_mismatch", {
    ...declaration(),
    specVersion: "nexusos.provider-catalog-declaration.v0",
  });
  cases.set("shape_invalid", { ...declaration(), catalogClaim: "verified" });
  cases.set("provider_id_invalid", {
    ...declaration(),
    providers: [{ ...declaration().providers[0], providerId: "A" }],
  });
  cases.set("provider_id_duplicate", {
    ...declaration(),
    providers: [
      declaration().providers[0],
      { ...declaration().providers[0] },
    ],
  });
  cases.set("provider_limit_exceeded", {
    ...declaration(),
    providers: Array.from({ length: 17 }, (_, index) => ({
      ...declaration().providers[0],
      providerId: `p${index}`,
    })),
    models: [],
  });
  cases.set("method_invalid", {
    ...declaration(),
    providers: [
      {
        ...declaration().providers[0],
        methods: [{ method: "api", cliEngine: null }],
      },
    ],
  });
  cases.set("method_duplicate", {
    ...declaration(),
    providers: [
      {
        ...declaration().providers[0],
        methods: [
          { method: "oauth", cliEngine: null },
          { method: "oauth", cliEngine: null },
        ],
      },
    ],
  });
  cases.set("method_engine_mismatch", {
    ...declaration(),
    providers: [
      {
        ...declaration().providers[0],
        methods: [{ method: "oauth", cliEngine: "codex_cli" }],
      },
    ],
  });
  cases.set("model_id_invalid", {
    ...declaration(),
    models: [{ ...declaration().models[0], modelId: "bad id" }],
  });
  cases.set("model_id_duplicate", {
    ...declaration(),
    models: [declaration().models[0], { ...declaration().models[0] }],
  });
  cases.set("model_limit_exceeded", {
    ...declaration(),
    models: Array.from({ length: 65 }, (_, index) => ({
      ...declaration().models[0],
      modelId: `m${index}`,
    })),
  });
  cases.set("model_provider_unknown", {
    ...declaration(),
    models: [{ ...declaration().models[0], providerId: "missing" }],
  });
  cases.set("lifecycle_invalid", {
    ...declaration(),
    models: [{ ...declaration().models[0], lifecycle: "preview" }],
  });
  cases.set("display_name_invalid", {
    ...declaration(),
    providers: [{ ...declaration().providers[0], displayName: "" }],
  });

  assert.deepEqual(
    [...cases.keys()],
    [...PROVIDER_CATALOG_REJECTION_REASONS],
  );
  for (const [reason, input] of cases) {
    assert.deepEqual(evaluateProviderCatalog(input), {
      status: "rejected",
      reason,
    });
  }
});

test("one invalid model rejects the complete declaration", () => {
  const input = declaration();
  input.models.push({
    ...input.models[0],
    modelId: "bad id",
    displayName: "Invalid",
  });
  assert.deepEqual(evaluateProviderCatalog(input), {
    status: "rejected",
    reason: "model_id_invalid",
  });
  assert.equal(projectProviderCatalog(input), undefined);
});

test("method and engine mutex accepts only declared combinations", () => {
  for (const engine of EXECUTION_ENGINE_NAMES) {
    const input = declaration();
    input.providers[0]!.methods = [{ method: "cli", cliEngine: engine }];
    assert.equal(evaluateProviderCatalog(input).status, "accepted");
  }
  for (const methods of [
    [{ method: "oauth", cliEngine: "claude_code_cli" }],
    [{ method: "cli", cliEngine: null }],
    [{ method: "cli", cliEngine: "other_cli" }],
  ]) {
    const input = declaration();
    input.providers[0]!.methods = methods;
    assert.deepEqual(evaluateProviderCatalog(input), {
      status: "rejected",
      reason: "method_engine_mismatch",
    });
  }
});

test("provider and per-provider model bounds accept N and reject N plus one", () => {
  const providers = Array.from({ length: 16 }, (_, index) => ({
    ...declaration().providers[0],
    providerId: `p${index}`,
  }));
  assert.equal(
    evaluateProviderCatalog({
      ...declaration(),
      providers,
      models: [],
    }).status,
    "accepted",
  );
  assert.deepEqual(
    evaluateProviderCatalog({
      ...declaration(),
      providers: [
        ...providers,
        { ...declaration().providers[0], providerId: "p16" },
      ],
      models: [],
    }),
    { status: "rejected", reason: "provider_limit_exceeded" },
  );

  const models = Array.from({ length: 64 }, (_, index) => ({
    ...declaration().models[0],
    modelId: `m${index}`,
  }));
  assert.equal(
    evaluateProviderCatalog({ ...declaration(), models }).status,
    "accepted",
  );
  assert.deepEqual(
    evaluateProviderCatalog({
      ...declaration(),
      models: [
        ...models,
        { ...declaration().models[0], modelId: "m64" },
      ],
    }),
    { status: "rejected", reason: "model_limit_exceeded" },
  );
});

test("projection is deterministic, detached and ordered by code point", () => {
  const input = {
    ...declaration(),
    models: [
      {
        ...declaration().models[0],
        modelId: "a2",
        displayName: "A2",
      },
      {
        ...declaration().models[0],
        modelId: "a10",
        displayName: "A10",
      },
    ],
  };
  const first = projectProviderCatalog(input);
  const second = projectProviderCatalog({
    ...input,
    models: [...input.models].reverse(),
  });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first?.models.map(({ modelId }) => modelId),
    ["a10", "a2"],
  );
  input.providers[0]!.displayName = "Changed";
  input.models[0]!.displayName = "Changed";
  assert.equal(first?.providers[0]?.displayName, "OpenAI");
  assert.equal(first?.models[1]?.displayName, "A2");
  assertDeepFrozen(first);
});

test("display names are trimmed, well-formed and bounded by Unicode code points", () => {
  const valid = declaration();
  valid.providers[0]!.displayName = "😀".repeat(64);
  valid.models[0]!.displayName = "Café";
  assert.equal(evaluateProviderCatalog(valid).status, "accepted");

  for (const displayName of [
    "",
    " ",
    " Leading",
    "Trailing ",
    "line\nbreak",
    "nul\u0000byte",
    "right\u202eto-left",
    "zero\u200dwidth",
    "\ud800",
    "😀".repeat(65),
  ]) {
    const input = declaration();
    input.providers[0]!.displayName = displayName;
    assert.deepEqual(evaluateProviderCatalog(input), {
      status: "rejected",
      reason: "display_name_invalid",
    });
  }
});

test("caller truth stamps and unrecognized fields cannot escalate claims", () => {
  const inputs = [
    { ...declaration(), catalogClaim: "connected" },
    {
      ...declaration(),
      providers: [{ ...declaration().providers[0], trust: "verified" }],
    },
    {
      ...declaration(),
      providers: [
        {
          ...declaration().providers[0],
          methods: [
            {
              ...declaration().providers[0]!.methods[0],
              trust: "verified",
            },
          ],
        },
      ],
    },
    {
      ...declaration(),
      models: [{ ...declaration().models[0], observed: true }],
    },
  ];
  for (const input of inputs) {
    assert.deepEqual(evaluateProviderCatalog(input), {
      status: "rejected",
      reason: "shape_invalid",
    });
  }
});

test("catalog model keys are validated, length-prefixed and unambiguous", () => {
  assert.equal(catalogModelKey("openai", "gpt-5.6"), "6:openaigpt-5.6");
  assert.equal("ab" + "cd", "abc" + "d");
  assert.notEqual(
    catalogModelKey("ab", "cd"),
    catalogModelKey("abc", "d"),
  );
  assert.equal(PROVIDER_ID_PATTERN.test("provider/a"), false);
  assert.equal(MODEL_ID_PATTERN.test("model/a"), true);
  for (const [providerId, modelId] of [
    ["provider/a", "model"],
    ["openai", "model name"],
    ["", "model"],
  ]) {
    assert.throws(
      () => catalogModelKey(providerId, modelId),
      TypeError,
    );
  }
});

test("production source contains no integration or credential-processing surface", async () => {
  const sources = await Promise.all(
    [
      "src/contracts/provider-catalog.ts",
      "src/domain/providers/provider-catalog.ts",
    ].map((path) => readFile(join(root, path), "utf8")),
  );
  const banned =
    /(?:\bfetch\s*\(|\b(?:Request|WebSocket)\b|node:(?:http|https|net|dns|tls)|child_process|drizzle|secret|octokit|api\.github\.com|\bbearer\b|installation.?token|private.?key|\bjwt\b|\bapp_id\b|api.?key|refresh.?token|access.?token|client.?secret)/iu;
  for (const source of sources) assert.equal(banned.test(source), false);
});

test("only sanctioned dark modules import the dark provider catalog", async () => {
  const self = new Set([
    join(root, "src/contracts/provider-catalog.ts"),
    join(root, "src/domain/providers/provider-catalog.ts"),
  ]);
  const sanctioned = new Set([
    join(root, "src/contracts/connection-intent.ts"),
    join(root, "src/domain/providers/connection-intent.ts"),
  ]);
  const files = await productionFiles(root);
  const importPattern =
    /(?:\b(?:from|import)\s*(?:\(\s*)?["'][^"']*provider-catalog(?:\.[cm]?[jt]sx?)?["']|\brequire\s*\(\s*["'][^"']*provider-catalog(?:\.[cm]?[jt]sx?)?["']\s*\))/u;
  for (const source of [
    `import "./provider-catalog.js"`,
    `import("./provider-catalog.mjs")`,
    `export { value } from "./provider-catalog.ts"`,
    `require("./provider-catalog.cjs")`,
  ]) {
    assert.equal(importPattern.test(source), true, source);
  }
  const repositoryConsumers: string[] = [];
  for (const file of files) {
    if (self.has(file)) continue;
    if (importPattern.test(await readFile(file, "utf8"))) {
      repositoryConsumers.push(file);
    }
  }
  assert.equal(repositoryConsumers.length, 2);
  assert.deepEqual(
    repositoryConsumers.sort(),
    [...sanctioned].sort(),
    "repository-derived consumers must equal the exact sanctioned pair",
  );
});

function assertDeepFrozen(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  assert.equal(Object.isFrozen(input), true);
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(input),
  )) {
    if ("value" in descriptor) assertDeepFrozen(descriptor.value);
  }
}

async function productionFiles(directory: string): Promise<string[]> {
  const ignored = new Set([
    ".git",
    ".next",
    ".wrangler",
    "build",
    "dist",
    "docs",
    "node_modules",
    "out",
    "tests",
  ]);
  const extensions = /\.(?:[cm]?ts|tsx|[cm]?js|jsx|sql)$/u;
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await productionFiles(path)));
    else if (entry.isFile() && extensions.test(entry.name)) files.push(path);
  }
  return files;
}
