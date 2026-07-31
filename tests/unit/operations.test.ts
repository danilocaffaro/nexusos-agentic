import assert from "node:assert/strict";
import test from "node:test";
import {
  contextualizeOperationPrompt,
  deriveOperationPublicationState,
  OperationInputError,
  OperationOutputError,
  parseOperationCreateInput,
  parseOperationIdempotencyKey,
  projectOperationArtifactContent,
} from "../../src/domain/operations";
import { ENGINE_PROMPT_MAX_BYTES } from "../../src/contracts/execution-engines";

const encoder = new TextEncoder();

test("operation creation contract is exact and idempotency is canonical", () => {
  const input = {
    projectId: "project-a",
    workItemId: "work-item-a",
    agentId: "agent-a",
    assignedRunnerId: `rnr_${"a".repeat(32)}`,
    engine: "claude_code_cli",
    prompt: "Analyze the current acceptance evidence.",
  };
  assert.deepEqual(parseOperationCreateInput(input), input);
  assert.equal(
    parseOperationIdempotencyKey(`opr_${"b".repeat(32)}`),
    `opr_${"b".repeat(32)}`,
  );
  assert.throws(
    () => parseOperationCreateInput({ ...input, model: "from-prompt" }),
    OperationInputError,
  );
  assert.throws(
    () => parseOperationIdempotencyKey("opr_NOT_CANONICAL"),
    OperationInputError,
  );
});

test("context snapshot and user prompt share the exact engine byte budget", () => {
  const snapshot = {
    agentName: "Architecture Agent",
    agentRole: "Reviewer",
    agentModel: "gpt-5.6-sol",
    workItemRef: "NX-42",
    workItemTitle: "Review architecture",
    workItemDescription: "D".repeat(3_000),
  };
  const overhead = encoder.encode(
    contextualizeOperationPrompt(snapshot, ""),
  ).byteLength;
  const exactPrompt = "P".repeat(ENGINE_PROMPT_MAX_BYTES - overhead);
  assert.equal(
    encoder.encode(
      contextualizeOperationPrompt(snapshot, exactPrompt),
    ).byteLength,
    ENGINE_PROMPT_MAX_BYTES,
  );
  assert.throws(
    () => contextualizeOperationPrompt(snapshot, `${exactPrompt}P`),
    (error) =>
      error instanceof OperationInputError &&
      error.code === "operation_prompt_too_large" &&
      error.status === 413,
  );
});

test("engine choice stays explicit while CLI validation owns model compatibility", () => {
  const input = parseOperationCreateInput({
    projectId: "project-a",
    workItemId: "work-item-a",
    agentId: "agent-a",
    assignedRunnerId: `rnr_${"a".repeat(32)}`,
    engine: "codex_cli",
    prompt: "Use the declared agent configuration.",
  });
  const prompt = contextualizeOperationPrompt(
    {
      agentName: "Declared agent",
      agentRole: "Reviewer",
      agentModel: "claude-opus-5",
      workItemRef: "NX-43",
      workItemTitle: "Explicit adapter",
      workItemDescription: "Do not infer a provider from the model name.",
    },
    input.prompt,
  );
  assert.equal(input.engine, "codex_cli");
  assert.match(prompt, /Model: claude-opus-5/u);
  assert.deepEqual(
    deriveOperationPublicationState({
      runStatus: "completed",
      outcomeStatus: "failed",
      receiptStatus: "failed",
      receiptReason: "engine_incompatible",
      stdoutBytes: 0,
      stdoutTruncated: false,
      excerptAvailable: true,
    }),
    { state: "blocked", reason: "run_not_succeeded" },
  );
});

test("Claude publication preserves validated plain UTF-8 output", () => {
  const output = "# Analysis\n\nThe release is ready.\n";
  assert.equal(
    projectOperationArtifactContent(
      "claude_code_cli",
      encoder.encode(output),
      false,
    ),
    output,
  );
  assert.throws(
    () =>
      projectOperationArtifactContent(
        "claude_code_cli",
        encoder.encode(output),
        true,
      ),
    (error) =>
      error instanceof OperationOutputError &&
      error.code === "output_unavailable",
  );
});

test("Codex publication extracts only completed agent messages from JSONL", () => {
  const jsonl = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: "reason-1", type: "reasoning", text: "private reasoning" },
    },
    {
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: "# Result\nDone." },
    },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  assert.equal(
    projectOperationArtifactContent(
      "codex_cli",
      encoder.encode(jsonl),
      false,
    ),
    "# Result\nDone.",
  );
});

test("Codex publication rejects truncated and tool-shaped JSONL", () => {
  const malicious = [
    { type: "thread.started", thread_id: "thread-1" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        id: "tool-1",
        type: "command_execution",
        command: "rm -rf /",
      },
    },
    { type: "turn.completed", usage: {} },
  ].map((event) => JSON.stringify(event)).join("\n");
  for (const [value, truncated] of [
    [malicious, false],
    [
      '{"type":"thread.started","thread_id":"thread-1"}\n' +
        '{"type":"turn.started"}\n' +
        '{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"part',
      true,
    ],
  ] as const) {
    assert.throws(
      () =>
        projectOperationArtifactContent(
          "codex_cli",
          encoder.encode(value),
          truncated,
        ),
      (error) =>
        error instanceof OperationOutputError &&
        error.code === "output_unavailable",
    );
  }
});
