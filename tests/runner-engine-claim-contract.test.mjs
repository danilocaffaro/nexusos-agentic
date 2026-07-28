import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createClaimedRecord,
  createEngineClaimBody,
  createEngineClaimIntent,
  createEnginePromptIntent,
  createPromptReadBody,
  createStartingRecord,
  deriveEngineClaimOperationId,
  ENGINE_CLAIM_CONTRACT_LIMITS,
  ENGINE_DESCRIPTOR_REJECTION_REASONS,
  EngineClaimContractError,
  evaluateDescriptorBudget,
  parseEngineLeaseDescriptor,
  verifyPromptPayload,
} from "../runner/engine-claim-contract.mjs";
import {
  validateAttemptRecordSet,
} from "../runner/attempt-journal-contract.mjs";

const attemptId = `att_${"a".repeat(32)}`;
const runId = `run_${"1".repeat(32)}`;
const promptRef = `prm_${"3".repeat(32)}`;
const leaseId = `lse_${"5".repeat(32)}`;
const operationId = "op_0df958fcdd276874c5959c07a5d93ee5";
const createdAt = "2026-07-27T12:00:00.000Z";

test("claim operation identity is deterministic and domain-separated", () => {
  assert.equal(deriveEngineClaimOperationId(attemptId), operationId);
  assert.equal(deriveEngineClaimOperationId(attemptId), operationId);
  const completion = `op_${sha256(canonicalJson({
    attemptId,
    domain: "nexus-runner-engine-outbox-operation-v1",
  })).slice(0, 32)}`;
  assert.equal(completion, "op_48810ff77e1ff69b7d9b070a1b643ce3");
  assert.notEqual(operationId, completion);
  assert.throws(
    () => deriveEngineClaimOperationId("att_NOT_CANONICAL"),
    /Invalid engine attempt identifier/u,
  );
});

test("claim and prompt bodies are byte-exact canonical vectors", () => {
  assert.equal(
    createEngineClaimBody({
      engine: "claude_code_cli",
      operationId,
    }).toString("utf8"),
    `{"engine":"claude_code_cli","operationId":"${operationId}"}`,
  );
  assert.equal(
    createPromptReadBody({
      fence: 1,
      leaseId,
      promptRef,
    }).toString("utf8"),
    `{"fence":1,"leaseId":"${leaseId}","promptRef":"${promptRef}"}`,
  );
  for (const value of [
    { engine: "claude_code_cli", operationId, extra: true },
    { engine: "unknown", operationId },
    { engine: "claude_code_cli", operationId: "op_bad" },
    ["claude_code_cli", operationId],
  ]) {
    assert.throws(() => createEngineClaimBody(value));
  }
  for (const value of [
    { fence: 0, leaseId, promptRef },
    { fence: 1, leaseId: "lse_bad", promptRef },
    { fence: 1, leaseId, promptRef: "prm_bad" },
    { fence: 1, leaseId, promptRef, extra: true },
  ]) {
    assert.throws(() => createPromptReadBody(value));
  }
});

test("claim intent commits exact request bytes, path and domain", () => {
  const intent = createEngineClaimIntent({
    attemptId,
    engine: "claude_code_cli",
    runId,
  });
  const body = createEngineClaimBody({
    engine: intent.engine,
    operationId: intent.operationId,
  });
  assert.deepEqual(intent, {
    attemptId,
    engine: "claude_code_cli",
    operationId,
    request: {
      bodyBase64Url: body.toString("base64url"),
      bodySha256: sha256(body),
      pathname: `/api/runs/${runId}/engine-lease/claim`,
      signatureDomain: "nexus-runner-engine-lease-claim-v1",
    },
    runId,
  });
  assert.equal(Object.isFrozen(intent), true);
  assert.equal(Object.isFrozen(intent.request), true);
});

test("lease descriptor fixture is canonical, bounded and deeply frozen", async () => {
  const text = await fixture();
  const descriptor = parseEngineLeaseDescriptor(text);
  assert.ok(descriptor);
  assert.equal(descriptor.runId, runId);
  assert.equal(descriptor.job.promptBytes, 120);
  assert.deepEqual(descriptor.job.outputBounds, {
    stderrBytes: 65_536,
    stdoutBytes: 262_144,
  });
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.job), true);
  assert.equal(Object.isFrozen(descriptor.job.outputBounds), true);
  assert.equal(
    Buffer.byteLength(text),
    Buffer.byteLength(canonicalJson(descriptor)),
  );
  assert.equal(
    parseEngineLeaseDescriptor(
      Buffer.alloc(ENGINE_CLAIM_CONTRACT_LIMITS.descriptorBytes + 1),
    ),
    undefined,
  );
});

test("descriptor rejects every closed schema and canonicality drift", async (t) => {
  const source = JSON.parse(await fixture());
  const { runId: reorderedRunId, ...reorderedRest } = source;
  const mutations = [
    ["extra top-level key", (v) => { v.extra = true; }],
    ["missing key", (v) => { delete v.leaseId; }],
    ["cancel type", (v) => { v.cancelRequested = 0; }],
    ["expires syntax", (v) => { v.expiresAt = "2026-07-27T12:01:00Z"; }],
    ["expires after deadline", (v) => { v.expiresAt = "2027-07-27T12:01:00.000Z"; }],
    ["fence zero", (v) => { v.fence = 0; }],
    ["fence overflow", (v) => { v.fence = 2_147_483_648; }],
    ["lease id", (v) => { v.leaseId = "lse_bad"; }],
    ["run id", (v) => { v.runId = "run_bad"; }],
    ["job extra", (v) => { v.job.extra = true; }],
    ["deadline", (v) => { v.job.deadlineAt = "not-a-time"; }],
    ["engine", (v) => { v.job.engine = "shell"; }],
    ["version empty", (v) => { v.job.engineVersion = ""; }],
    ["version overlong", (v) => { v.job.engineVersion = "x".repeat(65); }],
    ["bounds stdout", (v) => { v.job.outputBounds.stdoutBytes -= 1; }],
    ["bounds extra", (v) => { v.job.outputBounds.extra = 1; }],
    ["prompt zero", (v) => { v.job.promptBytes = 0; }],
    ["prompt overflow", (v) => { v.job.promptBytes = 8_193; }],
    ["prompt ref", (v) => { v.job.promptRef = "prm_bad"; }],
    ["prompt sha", (v) => { v.job.promptSha256 = "A".repeat(64); }],
    ["timeout short", (v) => { v.job.timeoutMs = 269_999; }],
    ["timeout long", (v) => { v.job.timeoutMs = 600_001; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const value = structuredClone(source);
      mutate(value);
      assert.equal(
        parseEngineLeaseDescriptor(canonicalJson(value)),
        undefined,
      );
    });
  }
  for (const drift of [
    ` ${canonicalJson(source)}`,
    `${canonicalJson(source)}\n`,
    JSON.stringify({ runId: reorderedRunId, ...reorderedRest }),
    Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from(canonicalJson(source))]),
    new Uint8Array([0xc3, 0x28]),
  ]) {
    assert.equal(parseEngineLeaseDescriptor(drift), undefined);
  }
});

test("descriptor budget clamps locally after claim and fails closed", async () => {
  assert.deepEqual(ENGINE_DESCRIPTOR_REJECTION_REASONS, [
    "engine_deadline_insufficient",
    "lease_expired",
  ]);
  assert.equal(Object.isFrozen(ENGINE_DESCRIPTOR_REJECTION_REASONS), true);
  const descriptor = parseEngineLeaseDescriptor(await fixture());
  assert.deepEqual(
    evaluateDescriptorBudget({
      descriptor,
      nowMs: Date.parse("2026-07-27T12:00:00.000Z"),
    }),
    { accepted: true, effectiveTimeoutMs: 600_000 },
  );
  const deadlineLimited = structuredClone(descriptor);
  deadlineLimited.expiresAt = "2026-07-27T12:16:00.000Z";
  assert.deepEqual(
    evaluateDescriptorBudget({
      descriptor: deadlineLimited,
      nowMs: Date.parse("2026-07-27T12:15:00.001Z"),
    }),
    {
      accepted: false,
      reason: "engine_deadline_insufficient",
    },
  );
  const exact = structuredClone(descriptor);
  exact.job.deadlineAt = "2026-07-27T12:05:00.000Z";
  exact.expiresAt = "2026-07-27T12:01:00.000Z";
  assert.deepEqual(
    evaluateDescriptorBudget({
      descriptor: exact,
      nowMs: Date.parse("2026-07-27T12:00:00.000Z"),
    }),
    { accepted: true, effectiveTimeoutMs: 270_000 },
  );
  const expired = structuredClone(descriptor);
  expired.expiresAt = "2026-07-27T12:00:00.000Z";
  expired.job.deadlineAt = "2026-07-27T12:04:59.999Z";
  assert.deepEqual(
    evaluateDescriptorBudget({
      descriptor: expired,
      nowMs: Date.parse("2026-07-27T12:00:00.000Z"),
    }),
    { accepted: false, reason: "lease_expired" },
  );
});

test("prompt intent is exact and contains no prompt plaintext", async () => {
  const descriptor = parseEngineLeaseDescriptor(await fixture());
  const intent = createEnginePromptIntent(descriptor);
  assert.deepEqual(intent, {
    expected: {
      promptBytes: 120,
      promptRef,
      promptSha256: "4".repeat(64),
    },
    request: {
      bodyBase64Url: createPromptReadBody({
        fence: 1,
        leaseId,
        promptRef,
      }).toString("base64url"),
      bodySha256: sha256(createPromptReadBody({
        fence: 1,
        leaseId,
        promptRef,
      })),
      pathname: `/api/runs/${runId}/prompt`,
      signatureDomain: "nexus-runner-engine-prompt-read-v1",
    },
    runId,
  });
  assert.equal(JSON.stringify(intent).includes("prompt plaintext"), false);
});

test("prompt verifier accepts exact bytes and returns safe metadata only", () => {
  const bytes = Buffer.from("PRIVATE_PROMPT_CANARY", "utf8");
  const expected = {
    promptBytes: bytes.byteLength,
    promptRef,
    promptSha256: sha256(bytes),
  };
  const result = verifyPromptPayload({
    bytes,
    expected,
    headers: new Headers({
      "content-type": "application/octet-stream",
      "x-nexus-prompt-bytes": String(bytes.byteLength),
      "x-nexus-prompt-ref": promptRef,
      "x-nexus-prompt-sha256": expected.promptSha256,
    }),
  });
  assert.deepEqual(result, {
    kind: "verified",
    metadata: expected,
  });
  assert.equal(JSON.stringify(result).includes("PRIVATE_PROMPT"), false);
});

test("prompt verifier separates malformed protocol from integrity mismatch", () => {
  const bytes = Buffer.from("PRIVATE_PROMPT_CANARY", "utf8");
  const expected = {
    promptBytes: bytes.byteLength,
    promptRef,
    promptSha256: sha256(bytes),
  };
  const headers = {
    "content-type": "application/octet-stream",
    "x-nexus-prompt-bytes": String(bytes.byteLength),
    "x-nexus-prompt-ref": promptRef,
    "x-nexus-prompt-sha256": expected.promptSha256,
  };
  for (const mutate of [
    (v) => { v["x-nexus-prompt-bytes"] = "01"; },
    (v) => { v["x-nexus-prompt-ref"] = "bad"; },
    (v) => { v["x-nexus-prompt-sha256"] = "bad"; },
    (v) => { v["content-type"] = "text/plain"; },
  ]) {
    const changed = { ...headers };
    mutate(changed);
    assert.deepEqual(
      verifyPromptPayload({ bytes, expected, headers: changed }),
      { kind: "protocol" },
    );
  }
  for (const mutate of [
    (v) => { v["x-nexus-prompt-bytes"] = "2"; },
    (v) => { v["x-nexus-prompt-ref"] = `prm_${"9".repeat(32)}`; },
    (v) => { v["x-nexus-prompt-sha256"] = "9".repeat(64); },
  ]) {
    const changed = { ...headers };
    mutate(changed);
    assert.deepEqual(
      verifyPromptPayload({ bytes, expected, headers: changed }),
      {
        kind: "integrity",
        reason: "prompt_integrity_mismatch",
      },
    );
  }
  assert.deepEqual(
    verifyPromptPayload({
      bytes: Buffer.from("other"),
      expected,
      headers,
    }),
    {
      kind: "integrity",
      reason: "prompt_integrity_mismatch",
    },
  );
});

test("claimed and starting producers preserve journal commitments", async () => {
  const descriptor = parseEngineLeaseDescriptor(await fixture());
  const claimed = createClaimedRecord({
    attemptId,
    createdAt,
    engine: "claude_code_cli",
    runId,
  });
  const body = createEngineClaimBody({
    engine: claimed.engine,
    operationId: claimed.claimOperationId,
  });
  assert.equal(claimed.claimOperationId, operationId);
  assert.equal(claimed.claimBodySha256, sha256(body));
  const starting = createStartingRecord({
    claimed,
    createdAt: "2026-07-27T12:00:01.000Z",
    descriptor,
  });
  assert.deepEqual(starting.outputBounds, descriptor.job.outputBounds);
  assert.equal(starting.promptRef, descriptor.job.promptRef);
  assert.ok(validateAttemptRecordSet({ claimed, starting }));
  assert.equal(
    JSON.stringify({ claimed, starting }).includes("PRIVATE_PROMPT"),
    false,
  );
});

test("starting producer rejects correlation and transition drift", async () => {
  const descriptor = parseEngineLeaseDescriptor(await fixture());
  const claimed = createClaimedRecord({
    attemptId,
    createdAt,
    engine: "claude_code_cli",
    runId,
  });
  for (const [changed, at] of [
    [{ ...descriptor, runId: `run_${"9".repeat(32)}` }, createdAt],
    [
      {
        ...descriptor,
        job: { ...descriptor.job, engine: "codex_cli" },
      },
      createdAt,
    ],
    [descriptor, "2026-07-27T11:59:59.999Z"],
    [descriptor, "2026-07-27T12:01:00.001Z"],
  ]) {
    assert.throws(
      () => createStartingRecord({
        claimed,
        createdAt: at,
        descriptor: changed,
      }),
      /Invalid|correlate|transition/u,
    );
  }
});

test("hostile contract inputs fail without invoking accessors", () => {
  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, "engine", {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error("private");
    },
  });
  Object.defineProperty(hostile, "operationId", {
    enumerable: true,
    value: operationId,
  });
  assert.throws(() => createEngineClaimBody(hostile));
  assert.equal(reads, 0);
  const symbolExtra = {
    engine: "claude_code_cli",
    operationId,
  };
  symbolExtra[Symbol("extra")] = true;
  assert.throws(() => createEngineClaimBody(symbolExtra));
  const hiddenExtra = {
    engine: "claude_code_cli",
    operationId,
  };
  Object.defineProperty(hiddenExtra, "hidden", { value: true });
  assert.throws(() => createEngineClaimBody(hiddenExtra));
  const descriptorTrap = new Proxy(
    {
      engine: "claude_code_cli",
      operationId,
    },
    {
      getOwnPropertyDescriptor() {
        throw new Error("private");
      },
    },
  );
  assert.throws(
    () => createEngineClaimBody(descriptorTrap),
    EngineClaimContractError,
  );
  assert.equal(
    parseEngineLeaseDescriptor(new Proxy({}, {
      getPrototypeOf() {
        throw new Error("private");
      },
    })),
    undefined,
  );
});

test("new dark modules retain forbidden activation imports", async () => {
  const sources = await Promise.all([
    readFile(new URL("../runner/engine-claim-contract.mjs", import.meta.url), "utf8"),
    readFile(new URL("../runner/engine-claim-http-effect.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of sources) {
    for (const forbidden of [
      "nexus-runner.mjs",
      "node:child_process",
      "child_process",
      "engine-supervised-run.mjs",
      "engine-adapters.mjs",
      "engine-serve-command.mjs",
      "engine-serve-cycle.mjs",
    ]) {
      assert.equal(source.includes(`from "${forbidden}"`), false);
      assert.equal(source.includes(`from "./${forbidden}"`), false);
    }
    assert.doesNotMatch(source, /\b(?:spawn|exec|eval)\s*\(/u);
  }
});

async function fixture() {
  return (
    await readFile(
    new URL("./fixtures/engine-claim-v1.json", import.meta.url),
    "utf8",
    )
  ).trimEnd();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
