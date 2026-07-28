import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLI_SESSION_NOT_OBSERVED_CLAIM,
  CLI_SESSION_OBSERVATION_CLAIM,
  CLI_SESSION_OBSERVATION_FAILURE_REASONS,
  CLI_SESSION_OBSERVATION_SPEC_VERSION,
} from "../../src/contracts/cli-session-observation";
import {
  CONNECTION_INTENT_REJECTION_REASONS,
  CONNECTION_INTENT_SPEC_VERSION,
  type ConnectionIntentRejectionReason,
} from "../../src/contracts/connection-intent";
import {
  ENGINE_RUN_OPTIONS_SCHEMA_VERSION,
  ENGINE_RUN_OPTIONS_TRUST_DISCLOSURE,
  ENGINE_RUN_OPTION_DISABLED_REASONS,
  type EngineRunOptionDisabledReason,
} from "../../src/contracts/engine-run-options";
import {
  PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
} from "../../src/contracts/provider-catalog";
import { resolveCliSessionObservation } from "../../src/domain/providers/cli-session-observation";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runnerId = `rnr_${"a".repeat(32)}`;
const reportId = `egr_${"b".repeat(32)}`;
const receivedAt = "2026-01-01T00:00:00.000Z";
const evaluatedAt = "2026-01-01T00:05:00.000Z";
const freshUntil = "2026-01-01T00:10:00.000Z";

function declaration() {
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
    method: "cli",
    cliEngine: "codex_cli",
    modelId: "gpt-5.6",
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    runnerId,
    intent: intent(),
    declaration: declaration(),
    ...overrides,
  };
}

function option(overrides: Record<string, unknown> = {}) {
  return {
    evaluatedAt,
    trust: "hostReported",
    reportId,
    receivedAt,
    freshUntil,
    engine: "codex_cli",
    status: "available",
    readiness: "ready",
    reason: "none",
    version: "2.1.220",
    runnerId,
    runnerName: "Local runner",
    runnerState: "active",
    eligible: true,
    disabledReason: null,
    ...overrides,
  };
}

function disabledOption(reason: EngineRunOptionDisabledReason) {
  const withoutReport =
    reason === "engine_policy_invalid" ||
    reason === "engine_report_absent";
  return option({
    ...(withoutReport
      ? {
          reportId: null,
          receivedAt: null,
          freshUntil: null,
          status: null,
          readiness: null,
          reason: null,
          version: null,
        }
      : {}),
    runnerState: reason === "runner_inactive" ? "inactive" : "active",
    eligible: false,
    disabledReason: reason,
  });
}

function view(
  options: unknown[] = [option()],
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: ENGINE_RUN_OPTIONS_SCHEMA_VERSION,
    trustDisclosure: ENGINE_RUN_OPTIONS_TRUST_DISCLOSURE,
    truncated: false,
    options,
    ...overrides,
  };
}

function countingSource(value: unknown) {
  let calls = 0;
  return {
    source: () => {
      calls += 1;
      return value;
    },
    calls: () => calls,
  };
}

test("contract freezes the exact point-in-time claims and closed reasons", () => {
  assert.equal(
    CLI_SESSION_OBSERVATION_SPEC_VERSION,
    "nexusos.cli-session-observation.v1",
  );
  assert.equal(
    CLI_SESSION_OBSERVATION_CLAIM,
    "fresh_host_reported_cli_auth_session_for_declared_candidate_no_provider_connection_no_account_no_execution_no_quota",
  );
  assert.equal(
    CLI_SESSION_NOT_OBSERVED_CLAIM,
    "no_cli_session_observation",
  );
  assert.deepEqual(CLI_SESSION_OBSERVATION_FAILURE_REASONS, [
    "request_invalid",
    "runner_id_invalid",
    "connection_intent_rejected",
    "method_not_supported",
    "runner_not_observed",
    ...ENGINE_RUN_OPTION_DISABLED_REASONS,
  ]);
});

test("fresh CLI evidence observes only the declared candidate and host report", async () => {
  const catalog = declaration();
  const sourceOption = option();
  const sourceView = view([sourceOption]);
  const tracked = countingSource(sourceView);
  const result = await resolveCliSessionObservation(request({
    declaration: catalog,
  }), tracked.source);
  assert.equal(tracked.calls(), 1);
  assert.deepEqual(result, {
    specVersion: CLI_SESSION_OBSERVATION_SPEC_VERSION,
    status: "observed",
    observationClaim: CLI_SESSION_OBSERVATION_CLAIM,
    candidate: {
      providerId: "openai",
      modelId: "gpt-5.6",
      cliEngine: "codex_cli",
      bindingTrust: "declared_unverified",
    },
    observation: {
      runnerId,
      reportId,
      receivedAt,
      freshUntil,
      evaluatedAt,
      engineVersion: "2.1.220",
      trust: "hostReported",
    },
  });
  assertDeepFrozen(result);
  catalog.providers[0]!.displayName = "Changed";
  sourceOption.version = "changed";
  assert.equal(
    result.status === "observed"
      ? result.observation.engineVersion
      : undefined,
    "2.1.220",
  );
  const outputKeys = deepKeys(result);
  for (const excluded of [
    "organizationId",
    "runnerName",
    "labels",
    "collectedAt",
    "account",
    "email",
    "path",
    "metadata",
    "rawOutput",
    "token",
    "connected",
    "authenticated",
    "usable",
  ]) {
    assert.equal(outputKeys.includes(excluded), false);
  }
});

test("nullable model remains nullable and never becomes a selection", async () => {
  const result = await resolveCliSessionObservation(
    request({ intent: intent({ modelId: null }) }),
    () => view(),
  );
  assert.equal(result.status, "observed");
  if (result.status !== "observed") return;
  assert.equal(result.candidate.modelId, null);
  assert.equal("selected" in result.candidate, false);
});

test("invalid request and runner id fail before the source is called", async () => {
  const getter = request();
  Object.defineProperty(getter, "runnerId", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  const revoked = Proxy.revocable(request(), {});
  revoked.revoke();
  const invalidRequests = [
    null,
    [],
    { ...request(), extra: true },
    { ...request(), [Symbol("extra")]: true },
    getter,
    revoked.proxy,
  ];
  for (const invalid of invalidRequests) {
    const tracked = countingSource(view());
    assert.deepEqual(
      await resolveCliSessionObservation(invalid, tracked.source),
      notObserved("request_invalid"),
    );
    assert.equal(tracked.calls(), 0);
  }
  for (const invalidRunnerId of [
    null,
    7,
    "runner",
    `rnr_${"A".repeat(32)}`,
    `rnr_${"a".repeat(31)}`,
  ]) {
    const tracked = countingSource(view());
    assert.deepEqual(
      await resolveCliSessionObservation(
        request({ runnerId: invalidRunnerId }),
        tracked.source,
      ),
      notObserved("runner_id_invalid"),
    );
    assert.equal(tracked.calls(), 0);
  }
});

test("every B2 rejection is preserved without reading host inventory", async () => {
  const badCatalog = {
    ...declaration(),
    specVersion: "nexusos.provider-catalog-declaration.v0",
  };
  const cases: Array<{
    intent: unknown;
    declaration: unknown;
    intentReason: ConnectionIntentRejectionReason;
    catalogReason?: string;
  }> = [
    {
      intent: null,
      declaration: declaration(),
      intentReason: "intent_not_record",
    },
    {
      intent: { ...intent(), extra: true },
      declaration: declaration(),
      intentReason: "intent_structure_invalid",
    },
    {
      intent: intent({ specVersion: "wrong" }),
      declaration: declaration(),
      intentReason: "intent_spec_version_mismatch",
    },
    {
      intent: intent({ providerId: 7 }),
      declaration: declaration(),
      intentReason: "intent_field_type_invalid",
    },
    {
      intent: intent({ providerId: "A" }),
      declaration: declaration(),
      intentReason: "intent_provider_id_invalid",
    },
    {
      intent: intent({ method: "api" }),
      declaration: declaration(),
      intentReason: "intent_method_invalid",
    },
    {
      intent: intent({ method: "oauth", cliEngine: "codex_cli" }),
      declaration: declaration(),
      intentReason: "intent_method_engine_mismatch",
    },
    {
      intent: intent({ modelId: "bad id" }),
      declaration: declaration(),
      intentReason: "intent_model_id_invalid",
    },
    {
      intent: intent(),
      declaration: badCatalog,
      intentReason: "catalog_rejected",
      catalogReason: "spec_version_mismatch",
    },
    {
      intent: intent({ providerId: "missing" }),
      declaration: declaration(),
      intentReason: "provider_not_declared",
    },
    {
      intent: intent({
        providerId: "anthropic",
        method: "oauth",
        cliEngine: null,
        modelId: null,
      }),
      declaration: declaration(),
      intentReason: "method_not_declared",
    },
    {
      intent: intent({ cliEngine: "claude_code_cli" }),
      declaration: declaration(),
      intentReason: "engine_not_declared",
    },
    {
      intent: intent({ modelId: "missing" }),
      declaration: declaration(),
      intentReason: "model_not_declared",
    },
  ];
  assert.deepEqual(
    cases.map(({ intentReason }) => intentReason),
    CONNECTION_INTENT_REJECTION_REASONS,
  );
  for (const item of cases) {
    const tracked = countingSource(view());
    const result = await resolveCliSessionObservation(
      request({
        intent: item.intent,
        declaration: item.declaration,
      }),
      tracked.source,
    );
    assert.deepEqual(result, {
      ...notObserved("connection_intent_rejected"),
      intentReason: item.intentReason,
      ...(item.catalogReason
        ? { catalogReason: item.catalogReason }
        : {}),
    });
    assertDeepFrozen(result);
    assert.equal(tracked.calls(), 0);
  }
});

test("OAuth is intentionally unsupported and performs no host read", async () => {
  const tracked = countingSource(view());
  assert.deepEqual(
    await resolveCliSessionObservation(
      request({
        intent: intent({
          method: "oauth",
          cliEngine: null,
        }),
      }),
      tracked.source,
    ),
    notObserved("method_not_supported"),
  );
  assert.equal(tracked.calls(), 0);
});

test("every server disabled reason passes through exactly", async () => {
  for (const reason of ENGINE_RUN_OPTION_DISABLED_REASONS) {
    const tracked = countingSource(view([disabledOption(reason)]));
    const result = await resolveCliSessionObservation(
      request(),
      tracked.source,
    );
    assert.deepEqual(result, notObserved(reason));
    assertDeepFrozen(result);
    assert.equal(tracked.calls(), 1);
  }
});

test("valid CLI requests call the source exactly once on malformed output", async () => {
  let calls = 0;
  const result = await resolveCliSessionObservation(request(), () => {
    calls += 1;
    return { malformed: true };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, notObserved("engine_inventory_inconsistent"));
});

test("absent, cross-tenant and truncated targets collapse to one reason", async () => {
  for (const sourceView of [
    view([]),
    view([option({ runnerId: `rnr_${"c".repeat(32)}` })]),
    view([], { truncated: true }),
  ]) {
    assert.deepEqual(
      await resolveCliSessionObservation(request(), () => sourceView),
      notObserved("runner_not_observed"),
    );
  }
});

test("duplicate, open and contradictory inventory fails closed", async () => {
  const openView = { ...view(), extra: true };
  const openOption = option({ extra: true });
  const contradictions = [
    view([option(), option()]),
    openView,
    view([openOption]),
    view([option({ eligible: false, disabledReason: null })]),
    view([option({ status: "unavailable" })]),
    view([option({ runnerState: "inactive" })]),
  ];
  for (const sourceView of contradictions) {
    assert.deepEqual(
      await resolveCliSessionObservation(request(), () => sourceView),
      notObserved("engine_inventory_inconsistent"),
    );
  }
});

test("freshness is point-in-time and stale/future/inactive remain failures", async () => {
  assert.equal(
    (
      await resolveCliSessionObservation(request(), () => view())
    ).status,
    "observed",
  );
  for (const [selected, expected] of [
    [
      disabledOption("engine_report_stale"),
      "engine_report_stale",
    ],
    [
      disabledOption("engine_report_future"),
      "engine_report_future",
    ],
    [disabledOption("runner_inactive"), "runner_inactive"],
  ] as const) {
    assert.deepEqual(
      await resolveCliSessionObservation(
        request(),
        () => view([selected]),
      ),
      notObserved(expected),
    );
  }
  for (const selected of [
    option({ evaluatedAt: "2026-01-01T00:11:00.000Z" }),
    option({ evaluatedAt: "2025-12-31T23:59:59.999Z" }),
  ]) {
    assert.deepEqual(
      await resolveCliSessionObservation(
        request(),
        () => view([selected]),
      ),
      notObserved("engine_inventory_inconsistent"),
    );
  }
});

test("hostile views, accessors, symbols and oversized arrays fail closed", async () => {
  const getter = view();
  Object.defineProperty(getter, "options", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  const oversized = Array.from({ length: 201 }, (_, index) =>
    option({
      runnerId: `rnr_${index.toString(16).padStart(32, "0")}`,
    }),
  );
  for (const sourceView of [
    getter,
    { ...view(), [Symbol("extra")]: true },
    view(oversized),
  ]) {
    assert.deepEqual(
      await resolveCliSessionObservation(request(), () => sourceView),
      notObserved("engine_inventory_inconsistent"),
    );
  }
});

test("B3 source and adapter stay free of effects, secrets and connection state", async () => {
  const paths = [
    "src/contracts/cli-session-observation.ts",
    "src/domain/providers/cli-session-observation.ts",
    "src/adapters/d1/cli-session-observation-read-model.ts",
  ];
  const sources = await Promise.all(
    paths.map((path) => readFile(join(root, path), "utf8")),
  );
  const banned =
    /(?:model_connections|\bfetch\s*\(|child_process|node:(?:http|https|net|dns|tls)|\bconnected\b|\bauthenticated\b|\busable\b|api.?key|refresh.?token|access.?token|client.?secret|private.?key|\bbearer\b)/iu;
  for (const [index, source] of sources.entries()) {
    assert.equal(banned.test(source), false, paths[index]);
  }
  assert.equal(sources[1]!.includes("RequestIdentity"), false);
  assert.equal(sources[2]!.includes("listEngineRunOptions(identity)"), true);
});

test("only the D1 read model consumes the dark B3 boundary", async () => {
  const self = new Set([
    join(root, "src/contracts/cli-session-observation.ts"),
    join(root, "src/domain/providers/cli-session-observation.ts"),
  ]);
  const sanctioned = join(
    root,
    "src/adapters/d1/cli-session-observation-read-model.ts",
  );
  const importPattern =
    /(?:\b(?:from|import)\s*(?:\(\s*)?["'][^"']*cli-session-observation(?:\.[cm]?[jt]sx?)?["']|\brequire\s*\(\s*["'][^"']*cli-session-observation(?:\.[cm]?[jt]sx?)?["']\s*\))/u;
  const consumers: string[] = [];
  for (const file of await productionFiles(root)) {
    if (self.has(file)) continue;
    if (importPattern.test(await readFile(file, "utf8"))) {
      consumers.push(file);
    }
  }
  assert.deepEqual(consumers, [sanctioned]);
});

function notObserved(reason: string) {
  return {
    specVersion: CLI_SESSION_OBSERVATION_SPEC_VERSION,
    status: "not_observed",
    observationClaim: CLI_SESSION_NOT_OBSERVED_CLAIM,
    reason,
  };
}

function assertDeepFrozen(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  assert.equal(Object.isFrozen(input), true);
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(input),
  )) {
    if ("value" in descriptor) assertDeepFrozen(descriptor.value);
  }
}

function deepKeys(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  return Object.entries(input).flatMap(([key, value]) => [
    key,
    ...deepKeys(value),
  ]);
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
