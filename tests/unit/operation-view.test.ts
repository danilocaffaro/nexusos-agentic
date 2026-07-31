import assert from "node:assert/strict";
import test from "node:test";
import type { OperationRead } from "../../src/contracts/operations";
import type { EngineRunOptionView } from "../../app/engine-run-view";
import {
  classifyOperationCreateResponse,
  generateOperationId,
  isAbsoluteExecutionPath,
  mergeOperation,
  operationCreateGate,
  operationErrorMessage,
  operationExecutionCommand,
  readOperationCreateResult,
  readOperationPublishResult,
  readOperationRegistry,
  selectEligibleOperationOptions,
} from "../../app/operation-view";

const operationId = `opr_${"a".repeat(32)}` as const;

test("operation registry parser is closed, bounded and id-consistent", () => {
  const operation = operationFixture();
  assert.deepEqual(readOperationRegistry({ operations: [operation] }), {
    operations: [operation],
  });
  assert.equal(
    readOperationRegistry({ operations: [operation], injected: true }),
    null,
  );
  assert.equal(
    readOperationRegistry({ operations: [operation, operation] }),
    null,
  );
  assert.equal(
    readOperationRegistry({
      operations: Array.from({ length: 51 }, (_, index) =>
        operationFixture({
          id: `opr_${index.toString(16).padStart(32, "0")}`,
        }),
      ),
    }),
    null,
  );
  assert.equal(
    readOperationRegistry({
      operations: [
        operationFixture({
          run: { ...operation.run, deadlineAt: "not-a-date" },
        }),
      ],
    }),
    null,
  );
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.doesNotThrow(() => readOperationRegistry(proxy));
  assert.equal(readOperationRegistry(proxy), null);
});

test("create and publish result parsers bind the expected operation id", () => {
  const operation = operationFixture();
  assert.ok(
    readOperationCreateResult(
      { created: true, operation },
      operation.id,
    ),
  );
  assert.equal(
    readOperationCreateResult(
      { created: true, operation },
      `opr_${"f".repeat(32)}`,
    ),
    null,
  );
  const published = operationFixture({
    publication: {
      state: "published",
      artifactId: "artifact-1",
      versionNumber: 1,
      contentHash: "b".repeat(64),
      publishedAt: "2026-07-30T12:10:00.000Z",
      stdoutTruncated: false,
    },
  });
  assert.ok(
    readOperationPublishResult(
      { published: true, operation: published },
      published.id,
    ),
  );
});

test("unknown create outcome keeps the caller's stable id retryable", () => {
  const operation = operationFixture();
  assert.equal(
    classifyOperationCreateResponse({
      status: 503,
      value: { error: "temporary" },
      operationId,
    }).kind,
    "outcome_unknown",
  );
  assert.equal(
    classifyOperationCreateResponse({
      status: 201,
      value: { created: true, operation: { ...operation, id: "wrong" } },
      operationId,
    }).kind,
    "outcome_unknown",
  );
  assert.equal(
    classifyOperationCreateResponse({
      status: 409,
      value: { error: "idempotency_key_reused" },
      operationId,
    }).kind,
    "failure_confirmed",
  );
});

test("operation ids are canonical and deterministic from sixteen bytes", () => {
  assert.equal(
    generateOperationId(new Uint8Array(16).fill(15)),
    `opr_${"0f".repeat(16)}`,
  );
  assert.throws(() => generateOperationId(new Uint8Array(15)));
});

test("command requires an absolute path and safely quotes shell values", () => {
  assert.equal(isAbsoluteExecutionPath("/opt/homebrew/bin/claude"), true);
  assert.equal(isAbsoluteExecutionPath("claude"), false);
  assert.equal(isAbsoluteExecutionPath(" /bin/claude"), false);
  assert.equal(
    operationExecutionCommand({
      engine: "claude_code_cli",
      runId: `run_${"b".repeat(32)}`,
      executablePath: "/Applications/Claude's CLI/bin/claude",
      serverOrigin: "http://localhost:3001",
    }),
    "npm run local:engine -- --engine claude_code_cli --path '/Applications/Claude'\"'\"'s CLI/bin/claude' --server 'http://localhost:3001' --run run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.throws(() =>
    operationExecutionCommand({
      engine: "codex_cli",
      runId: `run_${"b".repeat(32)}`,
      executablePath: "<caminho-absoluto>",
      serverOrigin: "http://localhost:3001",
    }),
  );
});

test("creation gate is owner-only and uses only current eligible options", () => {
  const ready = optionFixture();
  const stale = optionFixture({
    optionId: `${ready.assignedRunnerId}:codex_cli`,
    engine: "codex_cli",
    freshness: "stale",
  });
  assert.deepEqual(selectEligibleOperationOptions([ready, stale]), [ready]);
  assert.equal(
    operationCreateGate({
      currentRole: "owner",
      projectId: "project-1",
      workItemId: "work-1",
      agentId: "agent-1",
      option: ready,
      prompt: "Faça a tarefa",
      pending: false,
    }).canSubmit,
    true,
  );
  assert.equal(
    operationCreateGate({
      currentRole: "admin",
      projectId: "project-1",
      workItemId: "work-1",
      agentId: "agent-1",
      option: ready,
      prompt: "Faça a tarefa",
      pending: false,
    }).canSubmit,
    false,
  );
  assert.equal(
    operationCreateGate({
      currentRole: "owner",
      projectId: "project-1",
      workItemId: "work-1",
      agentId: "agent-1",
      option: ready,
      prompt: "x".repeat(6_001),
      pending: false,
    }).canSubmit,
    false,
  );
});

test("merge is bounded and error copy covers repository codes", () => {
  const earlier = operationFixture({
    id: `opr_${"c".repeat(32)}`,
    createdAt: "2026-07-30T11:00:00.000Z",
  });
  assert.deepEqual(
    mergeOperation([earlier], operationFixture()).map((item) => item.id),
    [operationId, earlier.id],
  );
  for (const code of [
    "idempotency_key_reused",
    "invalid_operation_reference",
    "workspace_owner_required",
    "operation_request_too_large",
    "operation_prompt_too_large",
    "output_empty",
    "output_unavailable",
  ]) {
    assert.doesNotMatch(operationErrorMessage(code), /rejeitou/u, code);
  }
});

function operationFixture(
  overrides: Partial<OperationRead> = {},
): OperationRead {
  return {
    id: operationId,
    projectId: "project-1",
    workItem: {
      id: "work-1",
      ref: "WI-001",
      title: "Entregar operação",
    },
    agent: {
      id: "agent-1",
      name: "Aurora",
      role: "Implementação",
      model: "claude-opus-5",
    },
    assignedRunnerId: `rnr_${"d".repeat(32)}`,
    engine: "claude_code_cli",
    runId: `run_${"b".repeat(32)}`,
    run: {
      status: "queued",
      deadlineAt: "2026-07-30T12:20:00.000Z",
      createdAt: "2026-07-30T12:00:00.000Z",
    },
    publication: { state: "pending" },
    createdAt: "2026-07-30T12:00:00.000Z",
    ...overrides,
  };
}

function optionFixture(
  overrides: Partial<EngineRunOptionView> = {},
): EngineRunOptionView {
  const runnerId = `rnr_${"d".repeat(32)}`;
  return {
    optionId: `${runnerId}:claude_code_cli`,
    assignedRunnerId: runnerId,
    runnerDisplayName: "Runner local",
    engine: "claude_code_cli",
    engineVersion: "1.0.0",
    status: "available",
    readiness: "ready",
    reason: "none",
    freshness: "fresh",
    reportId: "report-1",
    reportReceivedAt: "2026-07-30T12:00:00.000Z",
    freshUntil: "2026-07-30T12:20:00.000Z",
    evaluatedAt: "2026-07-30T12:05:00.000Z",
    trust: "hostReported",
    eligible: true,
    disabledReasonCode: null,
    disabledReason: "",
    ...overrides,
  };
}
