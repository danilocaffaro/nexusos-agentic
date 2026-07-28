import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CONNECTION_INTENT_REJECTION_REASONS,
  CONNECTION_INTENT_RESOLUTION_CLAIM,
  CONNECTION_INTENT_RESOLUTION_SPEC_VERSION,
  CONNECTION_INTENT_SPEC_VERSION,
  type ConnectionIntentRejectionReason,
} from "../../src/contracts/connection-intent";
import {
  CONNECTION_METHOD_TRUST,
  PROVIDER_CATALOG_CLAIM,
  PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
  PROVIDER_CATALOG_PROJECTION_SPEC_VERSION,
} from "../../src/contracts/provider-catalog";
import { resolveConnectionIntent } from "../../src/domain/providers/connection-intent";
import {
  catalogModelKey,
  evaluateProviderCatalog,
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
        methods: [
          { method: "oauth", cliEngine: null },
          { method: "cli", cliEngine: "codex_cli" },
        ],
      },
      {
        providerId: "anthropic",
        displayName: "Anthropic",
        methods: [{ method: "cli", cliEngine: "claude_code_cli" }],
      },
    ],
    models: [
      {
        providerId: "openai",
        modelId: "gpt-5.6",
        displayName: "GPT 5.6",
        lifecycle: "available",
      },
      {
        providerId: "anthropic",
        modelId: "claude-opus-5",
        displayName: "Claude Opus 5",
        lifecycle: "unknown",
      },
    ],
  };
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    specVersion: CONNECTION_INTENT_SPEC_VERSION,
    providerId: "openai",
    method: "oauth",
    cliEngine: null,
    modelId: "gpt-5.6",
    ...overrides,
  };
}

test("connection-intent contract locks versions, claim and linear reasons", () => {
  assert.equal(
    CONNECTION_INTENT_SPEC_VERSION,
    "nexusos.connection-intent.v1",
  );
  assert.equal(
    CONNECTION_INTENT_RESOLUTION_SPEC_VERSION,
    "nexusos.connection-intent-resolution.v1",
  );
  assert.equal(
    CONNECTION_INTENT_RESOLUTION_CLAIM,
    "declared_candidate_only_no_connection",
  );
  assert.deepEqual(CONNECTION_INTENT_REJECTION_REASONS, [
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
  ]);
});

test("explicit oauth and both CLI engines resolve declared candidates only", () => {
  const cases = [
    intent({ modelId: null }),
    intent({ method: "cli", cliEngine: "codex_cli" }),
    intent({
      providerId: "anthropic",
      method: "cli",
      cliEngine: "claude_code_cli",
      modelId: "claude-opus-5",
    }),
  ];
  const results = cases.map((value) =>
    resolveConnectionIntent(value, declaration()),
  );
  for (const result of results) {
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") continue;
    assert.equal(
      result.candidate.specVersion,
      CONNECTION_INTENT_RESOLUTION_SPEC_VERSION,
    );
    assert.equal(
      result.candidate.resolutionClaim,
      CONNECTION_INTENT_RESOLUTION_CLAIM,
    );
    assert.equal(result.candidate.catalogClaim, PROVIDER_CATALOG_CLAIM);
    assert.equal(result.candidate.method.trust, CONNECTION_METHOD_TRUST);
    assert.equal("selected" in result.candidate, false);
    assert.equal("model" in result.candidate, false);
    assertDeepFrozen(result);
  }
  assert.equal(
    results[0]?.status === "resolved"
      ? results[0].candidate.declaredModel
      : undefined,
    null,
  );
  assert.deepEqual(
    results[1]?.status === "resolved"
      ? results[1].candidate.declaredModel
      : undefined,
    {
      modelId: "gpt-5.6",
      displayName: "GPT 5.6",
      lifecycle: "available",
    },
  );
  assert.deepEqual(
    results
      .filter((result) => result.status === "resolved")
      .map((result) => result.candidate.method.cliEngine),
    [null, "codex_cli", "claude_code_cli"],
  );
});

test("model lifecycle is copied verbatim and never interpreted as availability", () => {
  for (const lifecycle of [
    "available",
    "deprecated",
    "retired",
    "unknown",
  ]) {
    const catalog = declaration();
    catalog.models[0]!.lifecycle = lifecycle;
    const result = resolveConnectionIntent(intent(), catalog);
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") continue;
    assert.equal(result.candidate.declaredModel?.lifecycle, lifecycle);
  }
});

test("all 13 rejection reasons are reachable in normative order", () => {
  const invalidCatalog = declaration();
  invalidCatalog.specVersion = "nexusos.provider-catalog-declaration.v0";
  const cases: Array<{
    reason: ConnectionIntentRejectionReason;
    intent: unknown;
    declaration: unknown;
  }> = [
    {
      reason: "intent_not_record",
      intent: null,
      declaration: declaration(),
    },
    {
      reason: "intent_structure_invalid",
      intent: { ...intent(), extra: true },
      declaration: declaration(),
    },
    {
      reason: "intent_spec_version_mismatch",
      intent: intent({ specVersion: "nexusos.connection-intent.v0" }),
      declaration: declaration(),
    },
    {
      reason: "intent_field_type_invalid",
      intent: intent({ providerId: 7 }),
      declaration: declaration(),
    },
    {
      reason: "intent_provider_id_invalid",
      intent: intent({ providerId: "A" }),
      declaration: declaration(),
    },
    {
      reason: "intent_method_invalid",
      intent: intent({ method: "api" }),
      declaration: declaration(),
    },
    {
      reason: "intent_method_engine_mismatch",
      intent: intent({ cliEngine: "codex_cli" }),
      declaration: declaration(),
    },
    {
      reason: "intent_model_id_invalid",
      intent: intent({ modelId: "bad id" }),
      declaration: declaration(),
    },
    {
      reason: "catalog_rejected",
      intent: intent(),
      declaration: invalidCatalog,
    },
    {
      reason: "provider_not_declared",
      intent: intent({ providerId: "missing" }),
      declaration: declaration(),
    },
    {
      reason: "method_not_declared",
      intent: intent({
        providerId: "anthropic",
        method: "oauth",
        modelId: null,
      }),
      declaration: declaration(),
    },
    {
      reason: "engine_not_declared",
      intent: intent({
        method: "cli",
        cliEngine: "claude_code_cli",
      }),
      declaration: declaration(),
    },
    {
      reason: "model_not_declared",
      intent: intent({ modelId: "gpt-missing" }),
      declaration: declaration(),
    },
  ];
  assert.deepEqual(
    cases.map(({ reason }) => reason),
    CONNECTION_INTENT_REJECTION_REASONS,
  );
  for (const item of cases) {
    const result = resolveConnectionIntent(item.intent, item.declaration);
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") continue;
    assert.equal(result.reason, item.reason);
    assertDeepFrozen(result);
    if (item.reason === "catalog_rejected") {
      assert.deepEqual(result, {
        status: "rejected",
        reason: "catalog_rejected",
        catalogReason: "spec_version_mismatch",
      });
    }
  }
});

test("multi-defect inputs descend through the exact rejection machine", () => {
  const badCatalog = declaration();
  badCatalog.specVersion = "wrong";
  const steps: Array<[unknown, unknown, ConnectionIntentRejectionReason]> = [
    [
      { ...intent({ specVersion: "wrong", providerId: 7 }), extra: true },
      badCatalog,
      "intent_structure_invalid",
    ],
    [
      intent({ specVersion: "wrong", providerId: 7 }),
      badCatalog,
      "intent_spec_version_mismatch",
    ],
    [
      intent({ providerId: 7, method: "api" }),
      badCatalog,
      "intent_field_type_invalid",
    ],
    [
      intent({ providerId: "A", method: "api" }),
      badCatalog,
      "intent_provider_id_invalid",
    ],
    [
      intent({ method: "api", cliEngine: "other_cli" }),
      badCatalog,
      "intent_method_invalid",
    ],
    [
      intent({ cliEngine: "codex_cli", modelId: "bad id" }),
      badCatalog,
      "intent_method_engine_mismatch",
    ],
    [
      intent({ modelId: "bad id" }),
      badCatalog,
      "intent_model_id_invalid",
    ],
    [intent({ providerId: "missing" }), badCatalog, "catalog_rejected"],
    [
      intent({
        providerId: "anthropic",
        method: "oauth",
        modelId: "missing",
      }),
      declaration(),
      "method_not_declared",
    ],
    [
      intent({
        method: "cli",
        cliEngine: "claude_code_cli",
        modelId: "missing",
      }),
      declaration(),
      "engine_not_declared",
    ],
    [
      intent({ modelId: "missing" }),
      declaration(),
      "model_not_declared",
    ],
  ];
  for (const [input, catalog, reason] of steps) {
    const result = resolveConnectionIntent(input, catalog);
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason, reason);
  }
});

test("version and primitive-field failures stay in distinct linear stages", () => {
  assert.deepEqual(
    resolveConnectionIntent(intent({ specVersion: 7 }), declaration()),
    { status: "rejected", reason: "intent_spec_version_mismatch" },
  );
  for (const overrides of [
    { providerId: 7 },
    { method: 7 },
    { cliEngine: 7 },
    { modelId: 7 },
  ]) {
    assert.deepEqual(
      resolveConnectionIntent(intent(overrides), declaration()),
      { status: "rejected", reason: "intent_field_type_invalid" },
    );
  }
});

test("forged catalog projections fail with exact B1 catalog reasons", () => {
  const evaluated = evaluateProviderCatalog(declaration());
  assert.equal(evaluated.status, "accepted");
  if (evaluated.status !== "accepted") return;

  const wrongVersionShape = declaration();
  wrongVersionShape.specVersion = PROVIDER_CATALOG_PROJECTION_SPEC_VERSION;
  const projectedMethod = declaration();
  projectedMethod.providers[0]!.methods = [
    {
      method: "oauth",
      cliEngine: null,
      trust: CONNECTION_METHOD_TRUST,
    } as { method: string; cliEngine: string | null },
  ];
  for (const [catalog, catalogReason] of [
    [evaluated.projection, "shape_invalid"],
    [wrongVersionShape, "spec_version_mismatch"],
    [projectedMethod, "shape_invalid"],
  ] as const) {
    assert.deepEqual(resolveConnectionIntent(intent(), catalog), {
      status: "rejected",
      reason: "catalog_rejected",
      catalogReason,
    });
  }
});

test("hostile intent reflection is total and classified without executing getters", () => {
  class IntentInstance {
    specVersion = CONNECTION_INTENT_SPEC_VERSION;
  }
  const revoked = Proxy.revocable(intent(), {});
  revoked.revoke();
  const hostileIdentity = new Proxy(intent(), {
    getPrototypeOf() {
      throw new Error("hostile identity");
    },
  });
  for (const input of [
    undefined,
    null,
    true,
    1,
    "intent",
    Symbol("intent"),
    [],
    new IntentInstance(),
    revoked.proxy,
    hostileIdentity,
  ]) {
    assert.doesNotThrow(() =>
      resolveConnectionIntent(input, declaration()),
    );
    assert.deepEqual(resolveConnectionIntent(input, declaration()), {
      status: "rejected",
      reason: "intent_not_record",
    });
  }

  let getterExecuted = false;
  const accessor = intent();
  Object.defineProperty(accessor, "providerId", {
    enumerable: true,
    get() {
      getterExecuted = true;
      throw new Error("must not execute");
    },
  });
  const hostileKeys = new Proxy(intent(), {
    ownKeys() {
      throw new Error("hostile keys");
    },
  });
  const hostileDescriptor = new Proxy(intent(), {
    getOwnPropertyDescriptor() {
      throw new Error("hostile descriptor");
    },
  });
  for (const input of [
    accessor,
    hostileKeys,
    hostileDescriptor,
    { ...intent(), [Symbol("extra")]: true },
  ]) {
    assert.doesNotThrow(() =>
      resolveConnectionIntent(input, declaration()),
    );
    assert.deepEqual(resolveConnectionIntent(input, declaration()), {
      status: "rejected",
      reason: "intent_structure_invalid",
    });
  }
  assert.equal(getterExecuted, false);
});

test("hostile declarations remain inside the B1 rejection boundary", () => {
  const revoked = Proxy.revocable(declaration(), {});
  revoked.revoke();
  assert.doesNotThrow(() =>
    resolveConnectionIntent(intent(), revoked.proxy),
  );
  assert.deepEqual(resolveConnectionIntent(intent(), revoked.proxy), {
    status: "rejected",
    reason: "catalog_rejected",
    catalogReason: "shape_invalid",
  });
  assert.deepEqual(resolveConnectionIntent(intent(), null), {
    status: "rejected",
    reason: "catalog_rejected",
    catalogReason: "input_not_record",
  });
});

test("caller claims and unknown fields cannot escalate a connection intent", () => {
  for (const extra of [
    { trust: "verified" },
    { resolutionClaim: "connected" },
    { catalogClaim: PROVIDER_CATALOG_CLAIM },
    { status: "resolved" },
  ]) {
    assert.deepEqual(
      resolveConnectionIntent({ ...intent(), ...extra }, declaration()),
      { status: "rejected", reason: "intent_structure_invalid" },
    );
  }
});

test("resolver never substitutes an undeclared method, engine or model", () => {
  assert.deepEqual(
    resolveConnectionIntent(
      intent({
        providerId: "anthropic",
        method: "oauth",
        modelId: null,
      }),
      declaration(),
    ),
    { status: "rejected", reason: "method_not_declared" },
  );
  assert.deepEqual(
    resolveConnectionIntent(
      intent({ method: "cli", cliEngine: "claude_code_cli" }),
      declaration(),
    ),
    { status: "rejected", reason: "engine_not_declared" },
  );
  assert.deepEqual(
    resolveConnectionIntent(intent({ modelId: "gpt-5" }), declaration()),
    { status: "rejected", reason: "model_not_declared" },
  );
});

test("model lookup cannot cross providers through an ambiguous concatenated key", () => {
  const ambiguousCatalog: DeclarationFixture = {
    specVersion: PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
    providers: [
      {
        providerId: "ab",
        displayName: "AB",
        methods: [{ method: "oauth", cliEngine: null }],
      },
      {
        providerId: "abc",
        displayName: "ABC",
        methods: [{ method: "oauth", cliEngine: null }],
      },
    ],
    models: [
      {
        providerId: "abc",
        modelId: "d",
        displayName: "D",
        lifecycle: "available",
      },
    ],
  };
  assert.equal("ab" + "cd", "abc" + "d");
  assert.notEqual(
    catalogModelKey("ab", "cd"),
    catalogModelKey("abc", "d"),
  );
  assert.deepEqual(
    resolveConnectionIntent(
      intent({ providerId: "ab", modelId: "cd" }),
      ambiguousCatalog,
    ),
    { status: "rejected", reason: "model_not_declared" },
  );
});

test("resolved candidates are deterministic, detached and deeply frozen", () => {
  const input = intent();
  const catalog = declaration();
  const first = resolveConnectionIntent(input, catalog);
  const second = resolveConnectionIntent(
    { ...input },
    {
      ...catalog,
      providers: [...catalog.providers].reverse(),
      models: [...catalog.models].reverse(),
    },
  );
  assert.deepEqual(first, second);
  assertDeepFrozen(first);
  input.providerId = "changed";
  catalog.providers[0]!.displayName = "Changed";
  catalog.models[0]!.displayName = "Changed";
  assert.equal(
    first.status === "resolved"
      ? first.candidate.provider.displayName
      : undefined,
    "OpenAI",
  );
  assert.equal(
    first.status === "resolved"
      ? first.candidate.declaredModel?.displayName
      : undefined,
    "GPT 5.6",
  );
});

test("maximum B1 catalog resolves exactly and model matching is case-sensitive", () => {
  const providers = Array.from({ length: 16 }, (_, providerIndex) => ({
    providerId: `p${providerIndex}`,
    displayName: `Provider ${providerIndex}`,
    methods: [{ method: "oauth", cliEngine: null }],
  }));
  const models = providers.flatMap(({ providerId }) =>
    Array.from({ length: 64 }, (_, modelIndex) => ({
      providerId,
      modelId: `m${modelIndex}`,
      displayName: `Model ${modelIndex}`,
      lifecycle: "available",
    })),
  );
  const maximum = {
    specVersion: PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
    providers,
    models,
  };
  assert.equal(
    resolveConnectionIntent(
      intent({ providerId: "p15", modelId: "m63" }),
      maximum,
    ).status,
    "resolved",
  );
  assert.deepEqual(
    resolveConnectionIntent(
      intent({ providerId: "p15", modelId: "M63" }),
      maximum,
    ),
    { status: "rejected", reason: "model_not_declared" },
  );
});

test("B2 production source has no integration or credential-processing surface", async () => {
  const sources = await Promise.all(
    [
      "src/contracts/connection-intent.ts",
      "src/domain/providers/connection-intent.ts",
    ].map((path) => readFile(join(root, path), "utf8")),
  );
  const banned =
    /(?:\bfetch\s*\(|\b(?:Request|WebSocket)\b|node:(?:http|https|net|dns|tls)|child_process|drizzle|secret|octokit|api\.github\.com|\bbearer\b|installation.?token|private.?key|\bjwt\b|\bapp_id\b|api.?key|refresh.?token|access.?token|client.?secret)/iu;
  for (const source of sources) assert.equal(banned.test(source), false);
});

test("no production consumer enters the dark connection-intent boundary", async () => {
  const self = new Set([
    join(root, "src/contracts/connection-intent.ts"),
    join(root, "src/domain/providers/connection-intent.ts"),
  ]);
  const importPattern =
    /(?:\b(?:from|import)\s*(?:\(\s*)?["'][^"']*connection-intent(?:\.[cm]?[jt]sx?)?["']|\brequire\s*\(\s*["'][^"']*connection-intent(?:\.[cm]?[jt]sx?)?["']\s*\))/u;
  for (const source of [
    `import "./connection-intent.js"`,
    `import("./connection-intent.mjs")`,
    `export { value } from "./connection-intent.ts"`,
    `require("./connection-intent.cjs")`,
    `import "./connection-intent.tsx"`,
    `import "./connection-intent.mts"`,
    `import "./connection-intent.cts"`,
    `import "./connection-intent.jsx"`,
  ]) {
    assert.equal(importPattern.test(source), true, source);
  }
  for (const file of await productionFiles(root)) {
    if (self.has(file)) continue;
    assert.equal(
      importPattern.test(await readFile(file, "utf8")),
      false,
      `${file} must not enter the dark connection-intent boundary`,
    );
  }
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
    ".vinext",
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
