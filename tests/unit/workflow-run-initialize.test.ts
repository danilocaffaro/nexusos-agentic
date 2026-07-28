import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORKFLOW_RUN_CLAIM,
  WORKFLOW_RUN_EVENT_ID_PATTERN,
  WORKFLOW_RUN_GENESIS_SEQUENCE,
  WORKFLOW_RUN_HASH_PATTERN,
  WORKFLOW_RUN_INITIALIZE_REJECTION_REASONS,
  WORKFLOW_RUN_INITIAL_VERSION,
  WORKFLOW_RUN_RECORD_SPEC_VERSION,
  WORKFLOW_RUN_SPEC_VERSION,
  WORKFLOW_RUN_STATES,
  WORKFLOW_RUN_STEP_STATES,
} from "../../src/contracts/workflow-run";
import { canonicalJson } from "../../src/domain/governance/canonical-json";
import { evaluateWorkflowDefinition } from "../../src/domain/workflows/workflow-definition";
import { initializeRun } from "../../src/domain/workflows/workflow-run";

const root = fileURLToPath(new URL("../..", import.meta.url));
const createdAt = "1970-01-01T00:00:00.000Z";

function declaration() {
  return {
    specVersion: "nexusos.workflow-definition.v1",
    workflowId: "ship_release",
    organizationId: "org-123",
    projectId: "project:alpha",
    displayName: "Ship release",
    steps: [
      { stepId: "prepare", kind: "agent_task", displayName: "Prepare" },
      { stepId: "approve", kind: "human_task", displayName: "Approve" },
    ],
  };
}

function request() {
  return {
    runId: "run:alpha",
    organizationId: "org-123",
    projectId: "project:alpha",
    declaration: declaration(),
    createdAt,
  };
}

test("contract freezes the complete dark run and genesis vocabulary", () => {
  assert.equal(WORKFLOW_RUN_SPEC_VERSION, "nexusos.workflow-run.v1");
  assert.equal(
    WORKFLOW_RUN_RECORD_SPEC_VERSION,
    "nexusos.workflow-run-record.v1",
  );
  assert.equal(WORKFLOW_RUN_CLAIM, "state_only_no_execution");
  assert.equal(WORKFLOW_RUN_INITIAL_VERSION, 0);
  assert.equal(Object.is(WORKFLOW_RUN_INITIAL_VERSION, -0), false);
  assert.equal(WORKFLOW_RUN_GENESIS_SEQUENCE, 0);
  assert.deepEqual(WORKFLOW_RUN_STATES, [
    "created",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ]);
  assert.deepEqual(WORKFLOW_RUN_STEP_STATES, [
    "pending",
    "active",
    "succeeded",
    "failed",
    "cancelled",
  ]);
  assert.deepEqual(WORKFLOW_RUN_INITIALIZE_REJECTION_REASONS, [
    "input_not_record",
    "shape_invalid",
    "run_binding_invalid",
    "tenant_binding_invalid",
    "created_at_invalid",
    "definition_rejected",
    "tenant_binding_mismatch",
  ]);
  assert.equal(WORKFLOW_RUN_EVENT_ID_PATTERN.test("event_1-A"), true);
  assert.equal(WORKFLOW_RUN_EVENT_ID_PATTERN.test("a".repeat(64)), true);
  assert.equal(WORKFLOW_RUN_EVENT_ID_PATTERN.test("a".repeat(65)), false);
  assert.equal(WORKFLOW_RUN_HASH_PATTERN.test("0".repeat(64)), true);
});

test("initialize re-evaluates B1a and emits one complete deterministic genesis", async () => {
  const input = request();
  const definition = await evaluateWorkflowDefinition(input.declaration);
  assert.equal(definition.status, "accepted");
  if (definition.status !== "accepted") return;

  const first = await initializeRun(input);
  const second = await initializeRun(request());
  assert.equal(first.status, "initialized");
  assert.equal(second.status, "initialized");
  if (first.status !== "initialized" || second.status !== "initialized") {
    return;
  }
  assert.deepEqual(first, second);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(Object.keys(first.genesis).sort(), [
    "recordSpecVersion",
    "recordType",
    "sequence",
    "snapshot",
  ]);
  assert.deepEqual(first.genesis, {
    recordSpecVersion: WORKFLOW_RUN_RECORD_SPEC_VERSION,
    recordType: "genesis",
    sequence: 0,
    snapshot: first.snapshot,
  });
  assert.deepEqual(first.snapshot, {
    specVersion: WORKFLOW_RUN_SPEC_VERSION,
    stateClaim: WORKFLOW_RUN_CLAIM,
    runId: input.runId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    workflowId: input.declaration.workflowId,
    definitionVersionHash:
      definition.projection.definitionVersionHash,
    runVersion: 0,
    runState: "created",
    steps: [
      { stepId: "prepare", state: "pending" },
      { stepId: "approve", state: "pending" },
    ],
    appliedEvents: [],
    createdAt,
    updatedAt: createdAt,
  });
  assertDeepFrozen(first);

  input.runId = "mutated";
  input.declaration.steps[0]!.stepId = "mutated";
  assert.equal(first.snapshot.runId, "run:alpha");
  assert.equal(first.snapshot.steps[0]?.stepId, "prepare");
});

test("all initialization rejections are reachable in frozen precedence", async () => {
  const badDefinition = { ...declaration(), workflowId: "Invalid" };
  const wrongTenant = declaration();
  wrongTenant.organizationId = "org-other";
  const cases = new Map<string, unknown>([
    ["input_not_record", null],
    ["shape_invalid", { ...request(), extra: true }],
    ["run_binding_invalid", { ...request(), runId: "has space" }],
    [
      "tenant_binding_invalid",
      { ...request(), organizationId: "has space" },
    ],
    [
      "created_at_invalid",
      { ...request(), createdAt: "2026-07-28T12:00:00Z" },
    ],
    ["definition_rejected", { ...request(), declaration: badDefinition }],
    [
      "tenant_binding_mismatch",
      { ...request(), declaration: wrongTenant },
    ],
  ]);
  assert.deepEqual(
    [...cases.keys()],
    [...WORKFLOW_RUN_INITIALIZE_REJECTION_REASONS],
  );
  for (const [reason, input] of cases) {
    const result = await initializeRun(input);
    assert.deepEqual(result, { status: "rejected", reason });
    assertDeepFrozen(result);
  }
  assert.deepEqual(
    await initializeRun({
      ...request(),
      runId: "has space",
      organizationId: "also bad",
      createdAt: "bad",
      declaration: badDefinition,
    }),
    { status: "rejected", reason: "run_binding_invalid" },
  );
});

test("bindings and canonical UTC millisecond timestamps enforce exact bounds", async () => {
  for (const runId of ["!", "a".repeat(64)]) {
    assert.equal((await initializeRun({ ...request(), runId })).status, "initialized");
  }
  for (const runId of ["", "a".repeat(65), "has space", "line\nbreak"]) {
    assert.deepEqual(await initializeRun({ ...request(), runId }), {
      status: "rejected",
      reason: "run_binding_invalid",
    });
  }
  for (const timestamp of [
    "1969-12-31T23:59:59.999Z",
    "2024-02-29T12:34:56.789Z",
  ]) {
    assert.equal(
      (await initializeRun({ ...request(), createdAt: timestamp })).status,
      "initialized",
    );
  }
  for (const createdAt of [
    "2026-07-28T12:00:00Z",
    "2026-07-28T12:00:00.000+00:00",
    "2026-07-28T12:00:00.000000Z",
    "2026-02-30T12:00:00.000Z",
    "+02026-07-28T12:00:00.000Z",
  ]) {
    assert.deepEqual(await initializeRun({ ...request(), createdAt }), {
      status: "rejected",
      reason: "created_at_invalid",
    });
  }
});

test("accessors, symbols, sparse declarations and revoked proxies fail closed", async () => {
  const accessor = request() as Record<string, unknown>;
  let accessorTouched = false;
  Object.defineProperty(accessor, "declaration", {
    enumerable: true,
    get() {
      accessorTouched = true;
      return declaration();
    },
  });
  const symbol = { ...request(), [Symbol("extra")]: true };
  const sparse = declaration();
  sparse.steps = new Array(1);
  const revoked = Proxy.revocable(request(), {});
  revoked.revoke();
  for (const [input, reason] of [
    [accessor, "shape_invalid"],
    [symbol, "shape_invalid"],
    [{ ...request(), declaration: sparse }, "definition_rejected"],
    [revoked.proxy, "shape_invalid"],
  ] as const) {
    assert.deepEqual(await initializeRun(input), {
      status: "rejected",
      reason,
    });
  }
  assert.equal(accessorTouched, false);
});

test("batch stays clock-free, effect-free, below budget and unconsumed", async () => {
  const contractPath = join(root, "src/contracts/workflow-run.ts");
  const domainPath = join(root, "src/domain/workflows/workflow-run.ts");
  const sources = await Promise.all(
    [contractPath, domainPath].map((path) => readFile(path, "utf8")),
  );
  const banned =
    /(?:Date\.now|Math\.random|randomUUID|setTimeout|setInterval|\bfetch\s*\(|\bRequest\b|WebSocket|node:(?:http|https|net|dns|tls|fs)|child_process|drizzle|cloudflare:workers|\bDB\b|\bD1\b|cron|schedule|provider|credential|secret|api.?key|access.?token|refresh.?token|client.?secret|process\.env)/u;
  for (const source of sources) assert.equal(banned.test(source), false);
  const lines = sources.map((source) => source.trimEnd().split("\n").length);
  assert.equal(lines[0]! <= 130, true);
  assert.equal(lines[1]! <= 170, true);
  assert.equal(
    lines.reduce((total, count) => total + count, 0) <= 300,
    true,
  );
  assert.deepEqual(
    [...sources[1]!.matchAll(/\bexport\s+(?:async\s+)?function\s+(\w+)/gu)].map(
      (match) => match[1],
    ),
    ["initializeRun"],
  );

  const created = new Set([contractPath, domainPath]);
  const consumers: string[] = [];
  const importPattern =
    /(?:\b(?:from|import)\s*(?:\(\s*)?["'][^"']*workflow-run(?:\.[cm]?[jt]sx?)?["']|\brequire\s*\(\s*["'][^"']*workflow-run(?:\.[cm]?[jt]sx?)?["']\s*\))/u;
  for (const file of await productionFiles(root)) {
    if (created.has(file)) continue;
    if (importPattern.test(await readFile(file, "utf8"))) consumers.push(file);
  }
  assert.deepEqual(consumers, []);
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
    if (ignored.has(entry)) continue;
    const path = join(directory, entry);
    const details = await stat(path);
    if (details.isDirectory()) files.push(...(await productionFiles(path)));
    else if (/\.[cm]?[jt]sx?$/u.test(entry)) files.push(path);
  }
  return files.sort();
}
