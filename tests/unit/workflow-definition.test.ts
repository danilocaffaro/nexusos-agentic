import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORKFLOW_BINDING_ID_PATTERN,
  WORKFLOW_DEFINITION_CLAIM,
  WORKFLOW_DEFINITION_HASH_PATTERN,
  WORKFLOW_DEFINITION_PROJECTION_SPEC_VERSION,
  WORKFLOW_DEFINITION_REJECTION_REASONS,
  WORKFLOW_DEFINITION_SPEC_VERSION,
  WORKFLOW_DISPLAY_NAME_MAX_CHARS,
  WORKFLOW_ID_PATTERN,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_STEP_ID_PATTERN,
  WORKFLOW_STEP_KINDS,
} from "../../src/contracts/workflow-definition";
import { hashCanonical } from "../../src/domain/governance/crypto";
import { evaluateWorkflowDefinition } from "../../src/domain/workflows/workflow-definition";

const root = fileURLToPath(new URL("../..", import.meta.url));

function definition() {
  return {
    specVersion: WORKFLOW_DEFINITION_SPEC_VERSION,
    workflowId: "ship_release",
    organizationId: "org-123",
    projectId: "project:alpha",
    displayName: "Ship release",
    steps: [
      {
        stepId: "prepare",
        kind: "agent_task",
        displayName: "Prepare",
      },
      {
        stepId: "approve",
        kind: "human_task",
        displayName: "Approve",
      },
    ],
  };
}

test("constants freeze the v1 declaration and truth vocabulary", () => {
  assert.equal(
    WORKFLOW_DEFINITION_SPEC_VERSION,
    "nexusos.workflow-definition.v1",
  );
  assert.equal(
    WORKFLOW_DEFINITION_PROJECTION_SPEC_VERSION,
    "nexusos.workflow-definition-projection.v1",
  );
  assert.equal(WORKFLOW_DEFINITION_CLAIM, "declared_only_not_schedulable");
  assert.deepEqual(WORKFLOW_STEP_KINDS, ["agent_task", "human_task"]);
  assert.equal(WORKFLOW_MAX_STEPS, 16);
  assert.equal(WORKFLOW_DISPLAY_NAME_MAX_CHARS, 64);
  assert.deepEqual(WORKFLOW_DEFINITION_REJECTION_REASONS, [
    "input_not_record",
    "spec_version_mismatch",
    "shape_invalid",
    "workflow_id_invalid",
    "step_id_invalid",
    "step_id_duplicate",
    "step_kind_invalid",
    "step_limit_exceeded",
    "steps_empty",
    "display_name_invalid",
    "tenant_binding_invalid",
  ]);
});

test("accepts, normalizes, hashes, detaches and deeply freezes one linear definition", async () => {
  const input = definition();
  const result = await evaluateWorkflowDefinition(input);
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.deepEqual(result.projection, {
    specVersion: WORKFLOW_DEFINITION_PROJECTION_SPEC_VERSION,
    definitionClaim: WORKFLOW_DEFINITION_CLAIM,
    definitionVersionHash: result.projection.definitionVersionHash,
    definition: input,
  });
  assert.match(
    result.projection.definitionVersionHash,
    WORKFLOW_DEFINITION_HASH_PATTERN,
  );
  assert.equal(
    result.projection.definitionVersionHash,
    await hashCanonical(result.projection.definition),
  );
  assertDeepFrozen(result);
  input.steps[0]!.displayName = "Mutated";
  assert.equal(
    result.projection.definition.steps[0]!.displayName,
    "Prepare",
  );
});

test("hash excludes its envelope, ignores property insertion order and preserves step order", async () => {
  const first = await evaluateWorkflowDefinition(definition());
  const value = definition();
  const reordered = {
    steps: value.steps.map((step) => ({
      displayName: step.displayName,
      kind: step.kind,
      stepId: step.stepId,
    })),
    displayName: value.displayName,
    projectId: value.projectId,
    organizationId: value.organizationId,
    workflowId: value.workflowId,
    specVersion: value.specVersion,
  };
  const second = await evaluateWorkflowDefinition(reordered);
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "accepted");
  if (first.status !== "accepted" || second.status !== "accepted") return;
  assert.equal(
    first.projection.definitionVersionHash,
    second.projection.definitionVersionHash,
  );
  const reverse = definition();
  reverse.steps.reverse();
  const third = await evaluateWorkflowDefinition(reverse);
  assert.equal(third.status, "accepted");
  if (third.status === "accepted") {
    assert.notEqual(
      first.projection.definitionVersionHash,
      third.projection.definitionVersionHash,
    );
  }
});

test("every semantic field contributes to the version hash", async () => {
  const base = await evaluateWorkflowDefinition(definition());
  assert.equal(base.status, "accepted");
  if (base.status !== "accepted") return;
  const variants = [
    { ...definition(), workflowId: "ship_release_v2" },
    { ...definition(), organizationId: "org-456" },
    { ...definition(), projectId: "project:beta" },
    { ...definition(), displayName: "Ship safely" },
    {
      ...definition(),
      steps: [
        { ...definition().steps[0]!, displayName: "Prepare safely" },
        definition().steps[1]!,
      ],
    },
    {
      ...definition(),
      steps: [
        { ...definition().steps[0]!, kind: "human_task" },
        definition().steps[1]!,
      ],
    },
    {
      ...definition(),
      steps: [
        { ...definition().steps[0]!, stepId: "prepare_v2" },
        definition().steps[1]!,
      ],
    },
  ];
  for (const variant of variants) {
    const result = await evaluateWorkflowDefinition(variant);
    assert.equal(result.status, "accepted");
    if (result.status === "accepted") {
      assert.notEqual(
        result.projection.definitionVersionHash,
        base.projection.definitionVersionHash,
      );
    }
  }
});

test("all closed rejection reasons are reachable with deterministic precedence", async () => {
  const duplicate = definition();
  duplicate.steps[1]!.stepId = duplicate.steps[0]!.stepId;
  const tooMany = definition();
  tooMany.steps = Array.from({ length: WORKFLOW_MAX_STEPS + 1 }, (_, index) => ({
    stepId: `step_${index}`,
    kind: "agent_task",
    displayName: `Step ${index}`,
  }));
  const cases = new Map<string, unknown>([
    ["input_not_record", null],
    ["spec_version_mismatch", { ...definition(), specVersion: "v0" }],
    ["shape_invalid", { ...definition(), extra: true }],
    ["workflow_id_invalid", { ...definition(), workflowId: "Ship" }],
    [
      "step_id_invalid",
      {
        ...definition(),
        steps: [{ ...definition().steps[0]!, stepId: "1" }],
      },
    ],
    ["step_id_duplicate", duplicate],
    [
      "step_kind_invalid",
      {
        ...definition(),
        steps: [{ ...definition().steps[0]!, kind: "script" }],
      },
    ],
    ["step_limit_exceeded", tooMany],
    ["steps_empty", { ...definition(), steps: [] }],
    ["display_name_invalid", { ...definition(), displayName: "" }],
    ["tenant_binding_invalid", { ...definition(), projectId: "has space" }],
  ]);
  assert.deepEqual(
    [...cases.keys()],
    [...WORKFLOW_DEFINITION_REJECTION_REASONS],
  );
  for (const [reason, input] of cases) {
    assert.deepEqual(await evaluateWorkflowDefinition(input), {
      status: "rejected",
      reason,
    });
  }
  assert.deepEqual(
    await evaluateWorkflowDefinition({
      ...definition(),
      workflowId: "Ship",
      projectId: "has space",
      displayName: "",
    }),
    { status: "rejected", reason: "workflow_id_invalid" },
  );
  assert.deepEqual(
    await evaluateWorkflowDefinition({
      ...definition(),
      projectId: "has space",
      displayName: "",
      steps: [],
    }),
    { status: "rejected", reason: "tenant_binding_invalid" },
  );
});

test("identifier, display and tenant boundaries accept N and reject N+1", async () => {
  assert.equal(WORKFLOW_ID_PATTERN.test("a1"), true);
  assert.equal(WORKFLOW_ID_PATTERN.test("a"), false);
  assert.equal(WORKFLOW_STEP_ID_PATTERN.test(`a${"1".repeat(31)}`), true);
  assert.equal(WORKFLOW_STEP_ID_PATTERN.test(`a${"1".repeat(32)}`), false);
  assert.equal(WORKFLOW_BINDING_ID_PATTERN.test("a"), true);
  assert.equal(WORKFLOW_BINDING_ID_PATTERN.test("a".repeat(64)), true);
  assert.equal(WORKFLOW_BINDING_ID_PATTERN.test("a".repeat(65)), false);
  assert.equal(WORKFLOW_BINDING_ID_PATTERN.test("has space"), false);

  const maximum = definition();
  maximum.displayName = "🧭".repeat(WORKFLOW_DISPLAY_NAME_MAX_CHARS);
  maximum.steps = Array.from({ length: WORKFLOW_MAX_STEPS }, (_, index) => ({
    stepId: `s${index}`,
    kind: index % 2 ? "human_task" : "agent_task",
    displayName: "🧭".repeat(WORKFLOW_DISPLAY_NAME_MAX_CHARS),
  }));
  assert.equal((await evaluateWorkflowDefinition(maximum)).status, "accepted");

  for (const displayName of [
    "x".repeat(WORKFLOW_DISPLAY_NAME_MAX_CHARS + 1),
    " leading",
    "trailing ",
    "zero\u200bwidth",
    "line\nbreak",
    "\ud800",
  ]) {
    assert.deepEqual(
      await evaluateWorkflowDefinition({
        ...definition(),
        displayName,
      }),
      { status: "rejected", reason: "display_name_invalid" },
    );
  }
});

test("a single invalid step rejects the whole definition without partial projection", async () => {
  const input = definition();
  input.steps.push({
    stepId: "bad id",
    kind: "agent_task",
    displayName: "Bad",
  });
  const result = await evaluateWorkflowDefinition(input);
  assert.deepEqual(result, {
    status: "rejected",
    reason: "step_id_invalid",
  });
  assert.equal("projection" in result, false);
});

test("hostile records, accessors, symbols, sparse arrays and revoked proxies fail closed", async () => {
  const accessor = definition() as Record<string, unknown>;
  let accessorTouched = false;
  Object.defineProperty(accessor, "displayName", {
    enumerable: true,
    get() {
      accessorTouched = true;
      return "Must not be read";
    },
  });
  const symbol = { ...definition(), [Symbol("extra")]: true };
  const sparse = definition();
  sparse.steps = new Array(1);
  const revoked = Proxy.revocable(definition(), {});
  revoked.revoke();
  for (const [value, reason] of [
    [accessor, "shape_invalid"],
    [symbol, "shape_invalid"],
    [sparse, "shape_invalid"],
    [revoked.proxy, "input_not_record"],
  ] as const) {
    assert.deepEqual(await evaluateWorkflowDefinition(value), {
      status: "rejected",
      reason,
    });
  }
  assert.equal(accessorTouched, false);
});

test("truth stamps and derived hashes cannot be supplied by the caller", async () => {
  for (const extra of [
    { definitionClaim: "schedulable" },
    { definitionVersionHash: "0".repeat(64) },
    { status: "published" },
    { trigger: "cron" },
  ]) {
    assert.deepEqual(
      await evaluateWorkflowDefinition({ ...definition(), ...extra }),
      { status: "rejected", reason: "shape_invalid" },
    );
  }
});

test("batch files contain no effects and only the run initializer consumes B1a", async () => {
  const created = new Set([
    join(root, "src/contracts/workflow-definition.ts"),
    join(root, "src/domain/workflows/workflow-definition.ts"),
  ]);
  const sources = await Promise.all(
    [...created].map((path) => readFile(path, "utf8")),
  );
  const banned =
    /(?:\bfetch\s*\(|\b(?:Request|WebSocket)\b|node:(?:http|https|net|dns|tls)|child_process|drizzle|cloudflare:workers|\bDB\b|\bD1\b|cron|schedule|setTimeout|setInterval|credential|secret|api.?key|access.?token|refresh.?token|client.?secret)/iu;
  for (const source of sources) assert.equal(banned.test(source), false);

  const importPattern =
    /(?:\b(?:from|import)\s*(?:\(\s*)?["'][^"']*workflow-definition(?:\.[cm]?[jt]sx?)?["']|\brequire\s*\(\s*["'][^"']*workflow-definition(?:\.[cm]?[jt]sx?)?["']\s*\))/u;
  const consumers: string[] = [];
  for (const file of await productionFiles(root)) {
    if (created.has(file)) continue;
    if (importPattern.test(await readFile(file, "utf8"))) consumers.push(file);
  }
  assert.deepEqual(consumers, [
    join(root, "src/domain/workflows/workflow-run.ts"),
  ]);
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
    ".vinext",
    ".wrangler",
    "build",
    "dist",
    "docs",
    "node_modules",
    "out",
    "tests",
  ]);
  const files: string[] = [];
  for (const entry of await readdir(directory)) {
    if (directory === root && ignored.has(entry)) continue;
    const path = join(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) files.push(...(await productionFiles(path)));
    else if (/\.(?:[cm]?ts|tsx|[cm]?js|jsx|sql)$/u.test(entry)) files.push(path);
  }
  return files.sort();
}
