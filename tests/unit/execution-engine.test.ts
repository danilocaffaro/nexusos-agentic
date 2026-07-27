import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  EngineExecutionInput,
  EngineExecutionResult,
} from "../../src/contracts/execution-engines";
import {
  ENGINE_COMPLETION_MAX_BYTES,
  ENGINE_CREATE_REQUEST_MAX_BYTES,
  ENGINE_EXECUTION_LIMITS,
  ENGINE_EXECUTION_TIMEOUT_MAX_MS,
  ENGINE_EXECUTION_TIMEOUT_MIN_MS,
  ENGINE_EXCERPT_MAX_BYTES,
  ENGINE_PROMPT_MAX_BYTES,
  ENGINE_RUN_DEADLINE_MS,
  ENGINE_RUN_MAX_CLAIMS,
  ENGINE_SIGNED_CONTROL_BODY_MAX_BYTES,
  ENGINE_STDERR_MAX_BYTES,
  ENGINE_STDOUT_MAX_BYTES,
  EXECUTION_ENGINE_NAMES,
} from "../../src/contracts/execution-engines";
import { canonicalJson } from "../../src/domain/governance/canonical-json";
import { sha256Bytes } from "../../src/domain/governance/crypto";
import {
  buildEngineJobDescriptor,
  canonicalEngineCompleteBody,
  engineCreateRequestCanRepresentWorstEscaping,
  EngineContractError,
  EngineExecutionFault,
  executeWithEngine,
  FakeExecutionEngine,
  isExecutionEngineName,
  maximalEngineCompleteFixture,
  parseEngineProbe,
  parseEngineCompleteBody,
} from "../../src/domain/runners/execution-engine";
import { buildRunnerStringToSign } from "../../src/domain/runners/runner-protocol";

const encode = (value: string) => new TextEncoder().encode(value);
const emptySha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("engine vocabulary and dark constants are closed and exact", () => {
  assert.deepEqual(EXECUTION_ENGINE_NAMES, [
    "claude_code_cli",
    "codex_cli",
  ]);
  assert.equal(isExecutionEngineName("claude_code_cli"), true);
  assert.equal(isExecutionEngineName("codex_cli"), true);
  for (const value of ["claude", "codex", "open_code", "", null]) {
    assert.equal(isExecutionEngineName(value), false);
  }
  assert.equal(ENGINE_EXECUTION_TIMEOUT_MAX_MS, 600_000);
  assert.equal(ENGINE_EXECUTION_TIMEOUT_MIN_MS, 270_000);
  assert.equal(ENGINE_STDOUT_MAX_BYTES, 262_144);
  assert.equal(ENGINE_STDERR_MAX_BYTES, 65_536);
  assert.equal(ENGINE_EXCERPT_MAX_BYTES, 1_024);
  assert.equal(ENGINE_RUN_DEADLINE_MS, 20 * 60_000);
  assert.equal(ENGINE_RUN_MAX_CLAIMS, 2);
  assert.equal(ENGINE_CREATE_REQUEST_MAX_BYTES, 56 * 1_024);
  assert.equal(engineCreateRequestCanRepresentWorstEscaping(), true);
});

test("job descriptor carries only opaque prompt facts and fixed bounds", () => {
  const job = buildEngineJobDescriptor({
    deadlineAt: "2026-07-26T12:20:00.000Z",
    engine: "claude_code_cli",
    engineVersion: "2.1.219",
    promptBytes: 8_192,
    promptRef: `prm_${"1".repeat(32)}`,
    promptSha256: "2".repeat(64),
    timeoutMs: 570_000,
  });
  assert.deepEqual(Object.keys(job).sort(), [
    "deadlineAt",
    "engine",
    "engineVersion",
    "outputBounds",
    "promptBytes",
    "promptRef",
    "promptSha256",
    "timeoutMs",
  ]);
  assert.equal("prompt" in job, false);
  assert.equal("promptContent" in job, false);
  assert.equal(job.outputBounds.stdoutBytes, ENGINE_STDOUT_MAX_BYTES);
  assert.equal(job.outputBounds.stderrBytes, ENGINE_STDERR_MAX_BYTES);
  assert.throws(
    () =>
      buildEngineJobDescriptor({
        ...job,
        promptBytes: ENGINE_PROMPT_MAX_BYTES + 1,
      }),
    /Invalid engine job descriptor/u,
  );
  assert.throws(
    () =>
      buildEngineJobDescriptor({
        ...job,
        engineVersion: "/Users/operator/.claude",
      }),
    /Invalid engine job descriptor/u,
  );
  assert.throws(
    () => buildEngineJobDescriptor({ ...job, timeoutMs: 269_999 }),
    /Invalid engine job descriptor/u,
  );
});

test("probe facts use one strict privacy-safe consistency matrix", () => {
  const ready = {
    collectedAt: "2026-07-26T12:00:00.000Z",
    engine: "claude_code_cli",
    readiness: "ready",
    reason: "none",
    status: "available",
    version: "2.1.219",
  };
  assert.deepEqual(parseEngineProbe(ready), ready);
  for (const invalid of [
    { ...ready, email: "operator@example.com" },
    { ...ready, version: "/Users/operator/.claude" },
    { ...ready, reason: "engine_auth_attention_required" },
    { ...ready, readiness: "unknown" },
    { ...ready, status: "unavailable" },
    {
      collectedAt: ready.collectedAt,
      engine: ready.engine,
      readiness: "unknown",
      reason: "engine_probe_failed",
      status: "unknown",
      version: ready.version,
    },
  ]) {
    assert.equal(parseEngineProbe(invalid), undefined);
  }
  assert.deepEqual(
    parseEngineProbe({
      collectedAt: ready.collectedAt,
      engine: "codex_cli",
      readiness: "attention_required",
      reason: "engine_not_configured",
      status: "unavailable",
    }),
    {
      collectedAt: ready.collectedAt,
      engine: "codex_cli",
      readiness: "attention_required",
      reason: "engine_not_configured",
      status: "unavailable",
    },
  );
});

test("maximal canonical completion is valid and below signed transport", async () => {
  const fixture = maximalEngineCompleteFixture();
  const text = canonicalEngineCompleteBody(fixture);
  const raw = encode(text);
  const shared = (
    await readFile(
      new URL(
        "../fixtures/s6-b4/engine-complete-maximal-v1.json",
        import.meta.url,
      ),
      "utf8",
    )
  ).trimEnd();
  assert.equal(text, shared);
  assert.equal(raw.byteLength, 2_119);
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    "1d34e13f3cf04ec25c063982763bb92be283de10308e83c18702a94fb07b3302",
  );
  assert.ok(raw.byteLength <= ENGINE_COMPLETION_MAX_BYTES);
  assert.deepEqual(parseEngineCompleteBody(raw), fixture);
  assert.equal(text, canonicalJson(fixture));
});

test("completion parser rejects unknown, noncanonical and inconsistent data", () => {
  const fixture = maximalEngineCompleteFixture();
  const excerpt513 = base64Url(new Uint8Array(513).fill(1));
  const excerpt512 = base64Url(new Uint8Array(512).fill(2));
  const invalid: unknown[] = [
    { ...fixture, prompt: "secret" },
    {
      ...fixture,
      receipt: { ...fixture.receipt, unknown: true },
    },
    {
      ...fixture,
      receipt: {
        ...fixture.receipt,
        stdout: {
          ...fixture.receipt.stdout,
          excerptBase64Url: "A",
        },
      },
    },
    {
      ...fixture,
      receipt: {
        ...fixture.receipt,
        stdout: {
          ...fixture.receipt.stdout,
          excerptBase64Url: excerpt513,
        },
        stderr: {
          ...fixture.receipt.stderr,
          excerptBase64Url: excerpt512,
        },
      },
    },
    {
      ...fixture,
      receipt: {
        ...fixture.receipt,
        stdout: { ...fixture.receipt.stdout, sha256: "g".repeat(64) },
      },
    },
    {
      ...fixture,
      receipt: {
        ...fixture.receipt,
        stdout: {
          ...fixture.receipt.stdout,
          sha256: emptySha256,
        },
      },
    },
    {
      ...fixture,
      receipt: {
        ...fixture.receipt,
        stdout: {
          ...fixture.receipt.stdout,
          bytes: 1,
          excerptBase64Url: base64Url(new Uint8Array(2)),
          truncated: false,
        },
      },
    },
    {
      ...fixture,
      receipt: {
        ...fixture.receipt,
        stdout: { ...fixture.receipt.stdout, truncated: false },
      },
    },
    {
      ...fixture,
      receipt: {
        ...fixture.receipt,
        reason: "none",
        status: "failed",
      },
    },
    {
      ...fixture,
      receipt: { ...fixture.receipt, summary: "não ASCII" },
    },
    {
      ...fixture,
      receipt: { ...fixture.receipt, summary: "provider text leak" },
    },
    {
      ...fixture,
      receipt: {
        ...fixture.receipt,
        engineVersion: "version=/tmp/private",
      },
    },
    {
      ...fixture,
      receipt: {
        ...fixture.receipt,
        cancelRequested: true,
        exitCode: 0,
        reason: "none",
        status: "succeeded",
        summary: "completed",
      },
    },
    {
      ...fixture,
      receipt: {
        ...fixture.receipt,
        exitCode: 0,
        reason: "none",
        status: "succeeded",
        summary: "completed",
        timedOut: true,
      },
    },
    {
      ...fixture,
      receipt: {
        ...fixture.receipt,
        reason: "output_limit_reached",
        status: "failed",
        summary: "output_limit_reached",
        stdout: {
          bytes: 512,
          excerptBase64Url: excerpt512,
          sha256: "f".repeat(64),
          truncated: false,
        },
        stderr: {
          bytes: 512,
          excerptBase64Url: excerpt512,
          sha256: "f".repeat(64),
          truncated: false,
        },
      },
    },
    {
      ...fixture,
      receipt: {
        ...fixture.receipt,
        stdout: {
          ...fixture.receipt.stdout,
          bytes: ENGINE_STDOUT_MAX_BYTES + 1,
        },
      },
    },
  ];
  for (const value of invalid) {
    assert.equal(
      parseEngineCompleteBody(encode(canonicalJson(value))),
      undefined,
    );
  }
  const canonical = canonicalJson(fixture);
  const raceReceipt = {
    ...fixture,
    receipt: {
      ...fixture.receipt,
      cancelRequested: true,
      reason: "interrupted_after_start",
      summary: "interrupted_after_start",
      timedOut: true,
    },
  };
  assert.deepEqual(
    parseEngineCompleteBody(encode(canonicalJson(raceReceipt))),
    raceReceipt,
  );
  assert.equal(
    parseEngineCompleteBody(encode(canonical.replace("{", "{ "))),
    undefined,
  );
  assert.equal(
    parseEngineCompleteBody(
      encode(
        canonical.replace(
          '"fence":2147483647',
          '"fence":2147483647,"fence":2147483647',
        ),
      ),
    ),
    undefined,
  );
  assert.equal(
    parseEngineCompleteBody(
      encode(
        canonical.replace(
          '"receipt":{',
          '"__proto__":{},"receipt":{',
        ),
      ),
    ),
    undefined,
  );
  assert.equal(
    parseEngineCompleteBody(
      encode(
        canonical.replace(
          '"fence":2147483647',
          '"fence":2.147483647e9',
        ),
      ),
    ),
    undefined,
  );
  assert.equal(
    parseEngineCompleteBody(
      encode(
        canonical.replace(
          fixture.receipt.stdout.excerptBase64Url,
          "AB",
        ),
      ),
    ),
    undefined,
  );
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...encode(canonical)]);
  assert.equal(parseEngineCompleteBody(bom), undefined);
  assert.equal(
    parseEngineCompleteBody(new Uint8Array(ENGINE_COMPLETION_MAX_BYTES + 1)),
    undefined,
  );
  assert.equal(
    parseEngineCompleteBody(Uint8Array.from([0xc3, 0x28])),
    undefined,
  );
});

test("worker rejects the shared differential completion corpus", async () => {
  const [source, vectorText] = await Promise.all([
    readFile(
      new URL(
        "../fixtures/s6-b4/engine-complete-body-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../fixtures/s6-b4/engine-complete-negative-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const vectors = JSON.parse(vectorText) as Array<Record<string, unknown>>;
  for (const vector of vectors) {
    assert.equal(
      parseEngineCompleteBody(
        differentialNegativeBody(vector, source.trimEnd()),
      ),
      undefined,
      String(vector.name),
    );
  }
});

test("fake port maps closed faults and cancellation but fails loud on bugs", async () => {
  const input = await executionInput();
  const success = result({
    engine: input.engine,
    engineVersion: input.engineVersion,
  });
  const successEngine = new FakeExecutionEngine({
    name: input.engine,
    execute: async () => success,
  });
  assert.deepEqual(
    await executeWithEngine(successEngine, input),
    success,
  );
  assert.equal(successEngine.executeCount, 1);

  const nonzero = result({
    engine: input.engine,
    engineVersion: input.engineVersion,
    exitCode: 17,
    reason: "engine_exit_nonzero",
    status: "failed",
    summary: "engine_exit_nonzero",
  });
  const nonzeroEngine = new FakeExecutionEngine({
    name: input.engine,
    execute: async () => nonzero,
  });
  assert.deepEqual(await executeWithEngine(nonzeroEngine, input), nonzero);

  const timestamps = [
    "2026-07-26T12:00:00.000Z",
    "2026-07-26T12:00:05.000Z",
  ];
  const timeoutEngine = new FakeExecutionEngine({
    name: input.engine,
    execute: async () => {
      throw new EngineExecutionFault("timed_out");
    },
  });
  const timedOut = await executeWithEngine(
    timeoutEngine,
    input,
    () => timestamps.shift() ?? "invalid",
  );
  assert.equal(timedOut.status, "failed");
  assert.equal(timedOut.reason, "timed_out");
  assert.equal(timedOut.timedOut, true);

  const promptFaultTimes = [
    "2026-07-26T12:00:00.000Z",
    "2026-07-26T12:00:00.001Z",
  ];
  const promptFaultEngine = new FakeExecutionEngine({
    name: input.engine,
    execute: async () => {
      throw new EngineExecutionFault("prompt_integrity_mismatch");
    },
  });
  const promptFault = await executeWithEngine(
    promptFaultEngine,
    input,
    () => promptFaultTimes.shift() ?? "invalid",
  );
  assert.equal(promptFault.reason, "prompt_integrity_mismatch");
  assert.equal(promptFault.summary, "prompt_integrity_mismatch");

  const invalidFault = new FakeExecutionEngine({
    name: input.engine,
    execute: async () => {
      throw new EngineExecutionFault("off_vocabulary" as never);
    },
  });
  await assert.rejects(
    executeWithEngine(invalidFault, input),
    (error: unknown) =>
      error instanceof EngineContractError &&
      error.message === "Closed execution fault produced an invalid result.",
  );
  for (const excluded of [
    "output_limit_reached",
    "engine_exit_nonzero",
  ] as const) {
    const excludedFault = new FakeExecutionEngine({
      name: input.engine,
      execute: async () => {
        throw new EngineExecutionFault(excluded as never);
      },
    });
    await assert.rejects(
      executeWithEngine(excludedFault, input),
      (error: unknown) =>
        error instanceof EngineContractError &&
        error.message ===
          "Closed execution fault produced an invalid result.",
    );
  }

  const controller = new AbortController();
  controller.abort();
  const canceledEngine = new FakeExecutionEngine({
    name: input.engine,
    execute: async () => {
      throw new Error("must not execute");
    },
  });
  const canceledTimes = [
    "2026-07-26T12:00:00.000Z",
    "2026-07-26T12:00:00.001Z",
  ];
  const canceled = await executeWithEngine(
    canceledEngine,
    { ...input, signal: controller.signal },
    () => canceledTimes.shift() ?? "invalid",
  );
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.reason, "cancel_requested");
  assert.equal(canceledEngine.executeCount, 0);
  const regressiveTimes = [
    "2026-07-26T12:00:01.000Z",
    "2026-07-26T12:00:00.000Z",
  ];
  await assert.rejects(
    executeWithEngine(
      canceledEngine,
      { ...input, signal: controller.signal },
      () => regressiveTimes.shift() ?? "invalid",
    ),
    (error: unknown) =>
      error instanceof EngineContractError &&
      error.message === "Closed cancellation produced an invalid result.",
  );
  const cancelAfterTimeout = {
    ...maximalEngineCompleteFixture(),
    receipt: {
      ...maximalEngineCompleteFixture().receipt,
      cancelRequested: true,
      reason: "cancel_requested",
      status: "canceled",
      summary: "cancel_requested",
      timedOut: true,
    },
  };
  assert.deepEqual(
    parseEngineCompleteBody(encode(canonicalJson(cancelAfterTimeout))),
    cancelAfterTimeout,
  );

  const bug = new FakeExecutionEngine({
    name: input.engine,
    execute: async () => {
      throw new Error("programmer bug");
    },
  });
  await assert.rejects(
    executeWithEngine(bug, input),
    (error: unknown) =>
      error instanceof EngineContractError &&
      error.message ===
        "Execution engine failed outside the closed fault protocol.",
  );
  const identityMismatch = new FakeExecutionEngine({
    name: input.engine,
    execute: async () => ({ ...success, engineVersion: "2.1.220" }),
  });
  await assert.rejects(
    executeWithEngine(identityMismatch, input),
    (error: unknown) =>
      error instanceof EngineContractError &&
      error.message === "Execution engine returned an invalid result.",
  );
  await assert.rejects(
    executeWithEngine(successEngine, {
      ...input,
      promptSha256: "0".repeat(64),
    }),
    /Invalid execution engine input/u,
  );
  for (const workdir of [
    "/private/tmp/../escape",
    "/private//tmp/nexus",
    "/private/tmp/nexus\nforged",
    "/",
  ]) {
    await assert.rejects(
      executeWithEngine(successEngine, { ...input, workdir }),
      /Invalid execution engine input/u,
    );
  }
});

test("engine domains are additive while diagnostic signing bytes stay frozen", async () => {
  const diagnostic = await buildRunnerStringToSign({
    audience: "https://nexus.example",
    body: encode('{"operationId":"op_33333333333333333333333333333333"}'),
    domain: "nexus-runner-lease-claim-v1",
    keyId: `rnr_${"4".repeat(32)}`,
    method: "POST",
    nonce: "AQEBAQEBAQEBAQEBAQEBAQ",
    pathname: `/api/runs/run_${"1".repeat(32)}/lease/claim`,
    timestamp: "2026-07-26T12:34:56.789Z",
  });
  assert.equal(
    diagnostic.value,
    [
      "nexus-runner-lease-claim-v1",
      `rnr_${"4".repeat(32)}`,
      "POST",
      `/api/runs/run_${"1".repeat(32)}/lease/claim`,
      "https://nexus.example",
      "2026-07-26T12:34:56.789Z",
      "AQEBAQEBAQEBAQEBAQEBAQ",
      "sha256:0ed000e85fdac1148cd1fe2c78f9810b50ef18fd8bd264b709faa38629f1f4ea",
    ].join("\n"),
  );
  for (const domain of [
    "nexus-runner-engine-report-v1",
    "nexus-runner-engine-lease-claim-v1",
    "nexus-runner-engine-prompt-read-v1",
    "nexus-runner-engine-complete-v1",
  ] as const) {
    const signed = await buildRunnerStringToSign({
      audience: "https://nexus.example",
      body: encode("{}"),
      domain,
      keyId: `rnr_${"4".repeat(32)}`,
      method: "POST",
      nonce: "AQEBAQEBAQEBAQEBAQEBAQ",
      pathname: "/api/engine-dark",
      timestamp: "2026-07-26T12:34:56.789Z",
    });
    assert.equal(signed.value.split("\n")[0], domain);
  }
});

test("signed run transport consumes the shared completion bound", async () => {
  assert.equal(
    ENGINE_SIGNED_CONTROL_BODY_MAX_BYTES,
    ENGINE_COMPLETION_MAX_BYTES,
  );
  const source = await readFile(
    new URL(
      "../../src/adapters/http/signed-run-route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /ENGINE_SIGNED_CONTROL_BODY_MAX_BYTES/u);
  assert.match(
    source,
    /Number\(declaredLength\) > ENGINE_SIGNED_CONTROL_BODY_MAX_BYTES/u,
  );
  assert.doesNotMatch(source, /Number\(declaredLength\) > 4_096/u);
});

test("B4.1 production slice imports no process-spawn API", async () => {
  for (const relative of [
    "../../src/contracts/execution-engines.ts",
    "../../src/domain/runners/execution-engine.ts",
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /(?:node:)?child_process|node:worker_threads|spawn\s*\(|fork\s*\(|exec(?:File|Sync)?\s*\(/u,
    );
    assert.doesNotMatch(source, /executeCalls/u);
  }
});

async function executionInput(): Promise<EngineExecutionInput> {
  const prompt = encode("Bounded local engine prompt");
  return {
    deadlineAt: "2026-07-26T12:20:00.000Z",
    engine: "claude_code_cli",
    engineVersion: "2.1.219",
    limits: ENGINE_EXECUTION_LIMITS,
    prompt,
    promptSha256: (await sha256Bytes(prompt)).hex,
    signal: new AbortController().signal,
    timeoutMs: 570_000,
    workdir: "/private/tmp/nexus-attempt",
  };
}

function result(
  overrides: Partial<EngineExecutionResult> &
    Pick<EngineExecutionResult, "engine" | "engineVersion">,
): EngineExecutionResult {
  const { engine, engineVersion, ...rest } = overrides;
  return {
    cancelRequested: false,
    engine,
    engineVersion,
    exitCode: 0,
    finishedAt: "2026-07-26T12:00:01.000Z",
    reason: "none",
    startedAt: "2026-07-26T12:00:00.000Z",
    status: "succeeded",
    stderr: {
      bytes: 0,
      excerptBase64Url: "",
      sha256: emptySha256,
      truncated: false,
    },
    stdout: {
      bytes: 0,
      excerptBase64Url: "",
      sha256: emptySha256,
      truncated: false,
    },
    summary: "completed",
    timedOut: false,
    ...rest,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function differentialNegativeBody(
  vector: Record<string, unknown>,
  source: string,
): Uint8Array {
  if (
    vector.mode === "replace" &&
    typeof vector.search === "string" &&
    typeof vector.replacement === "string"
  ) {
    assert.equal(source.includes(vector.search), true, String(vector.name));
    return encode(source.replace(vector.search, vector.replacement));
  }
  if (vector.mode === "bom") {
    return Uint8Array.from([0xef, 0xbb, 0xbf, ...encode(source)]);
  }
  if (vector.mode === "raw" && typeof vector.bodyBase64 === "string") {
    return new Uint8Array(Buffer.from(vector.bodyBase64, "base64url"));
  }
  if (vector.mode === "oversized" && typeof vector.bytes === "number") {
    return new Uint8Array(vector.bytes);
  }
  throw new TypeError(`Unsupported negative vector: ${String(vector.name)}`);
}
