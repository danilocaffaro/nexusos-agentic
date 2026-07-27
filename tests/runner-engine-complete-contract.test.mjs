import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyEngineCompleteResponse,
  ENGINE_COMPLETION_MAX_BYTES,
  parseEngineCompleteAck,
  parseEngineCompleteBody,
} from "../runner/engine-complete-contract.mjs";
import { ENGINE_COMPLETE_LIMITS } from "../runner/engine-complete-limits.mjs";
import {
  operationBody,
  persistDeclarationOperation,
  pruneOutbox,
  recoverOutbox,
  transitionOperation,
} from "../runner/durable-outbox.mjs";
import {
  deriveOutboxPathname,
  finalizeOutboxEntry,
  OUTBOX_V3_DIRECTORY,
  parseOutboxEntryText,
} from "../runner/outbox-contract.mjs";
import serverLimits from "../src/contracts/engine-complete-limits.json" with {
  type: "json",
};

const runId = `run_${"2".repeat(32)}`;
const operationId = `op_${"4".repeat(32)}`;

test("runner and server share the frozen completion limit and maximal vector", async () => {
  assert.equal(
    ENGINE_COMPLETE_LIMITS.completionMaxBytes,
    serverLimits.completionMaxBytes,
  );
  assert.equal(ENGINE_COMPLETION_MAX_BYTES, 4_096);
  const maximal = await fixture("engine-complete-maximal-v1.json");
  assert.equal(Buffer.byteLength(maximal), 2_119);
  assert.equal(
    sha256(maximal),
    "1d34e13f3cf04ec25c063982763bb92be283de10308e83c18702a94fb07b3302",
  );
  assert.ok(parseEngineCompleteBody(maximal));
});

test("completion body and acknowledgement fixtures are strict and canonical", async () => {
  const [bodyText, responseText] = await Promise.all([
    fixture("engine-complete-body-v1.json"),
    fixture("engine-complete-response-v1.json"),
  ]);
  const parsed = parseEngineCompleteBody(bodyText);
  assert.ok(parsed);
  assert.equal(parsed.operationId, operationId);
  assert.equal(
    Buffer.from(
      parsed.receipt.stdout.excerptBase64Url,
      "base64url",
    ).toString("utf8"),
    "PRIVATE_OUTPUT_MARKER\n",
  );
  const acknowledgement = parseEngineCompleteAck(
    JSON.parse(responseText),
    runId,
  );
  assert.deepEqual(acknowledgement, JSON.parse(responseText));
  for (const invalid of [
    { ...acknowledgement, extra: true },
    { ...acknowledgement, runId: `run_${"9".repeat(32)}` },
    { ...acknowledgement, status: "succeeded" },
    { ...acknowledgement, recordedAt: "not-a-time" },
    { ...acknowledgement, late: 0 },
  ]) {
    assert.equal(parseEngineCompleteAck(invalid, runId), undefined);
  }

  assert.equal(
    parseEngineCompleteBody(bodyText.replace("{", "{ ")),
    undefined,
  );
  assert.equal(
    parseEngineCompleteBody(Buffer.alloc(ENGINE_COMPLETION_MAX_BYTES + 1)),
    undefined,
  );
  const overExcerpt = structuredClone(parsed);
  overExcerpt.receipt.stdout.excerptBase64Url =
    Buffer.alloc(513, 1).toString("base64url");
  overExcerpt.receipt.stderr.excerptBase64Url =
    Buffer.alloc(512, 2).toString("base64url");
  overExcerpt.receipt.stdout.bytes = 262_144;
  overExcerpt.receipt.stderr.bytes = 65_536;
  overExcerpt.receipt.stdout.truncated = true;
  overExcerpt.receipt.stderr.truncated = true;
  assert.equal(
    parseEngineCompleteBody(canonicalJson(overExcerpt)),
    undefined,
  );
  const wrongOutcome = structuredClone(parsed);
  wrongOutcome.receipt.timedOut = true;
  assert.equal(
    parseEngineCompleteBody(canonicalJson(wrongOutcome)),
    undefined,
  );
});

test("runner rejects the shared differential completion corpus", async () => {
  const source = await fixture("engine-complete-body-v1.json");
  const vectors = JSON.parse(
    await fixture("engine-complete-negative-v1.json"),
  );
  for (const vector of vectors) {
    assert.equal(
      parseEngineCompleteBody(negativeBody(vector, source)),
      undefined,
      vector.name,
    );
  }
});

test("completion response classifier is v3-native and closed", async () => {
  const acknowledgement = JSON.parse(
    await fixture("engine-complete-response-v1.json"),
  );
  for (const [status, error, expected] of [
    [200, undefined, ["success", "acked"]],
    [201, undefined, ["protocol_error", "pending"]],
    [204, undefined, ["protocol_error", "pending"]],
    [500, "server_error", ["retryable", "pending"]],
    [503, "prompt_cipher_unavailable", ["retryable", "pending"]],
    [429, "rate_limited", ["retryable", "pending"]],
    [409, "nonce_reused", ["retryable", "pending"]],
    [409, "conflict_retry", ["retryable", "pending"]],
    [409, "lease_superseded", ["terminal", "superseded"]],
    [409, "run_unavailable", ["terminal", "superseded"]],
    [409, "lease_expired", ["terminal", "superseded"]],
    [409, "engine_deadline_exhausted", ["terminal", "superseded"]],
    [409, "operation_conflict", ["terminal", "rejected"]],
    [409, "engine_mismatch", ["terminal", "rejected"]],
    [409, "engine_version_mismatch", ["terminal", "rejected"]],
    [409, "cancellation_not_requested", ["terminal", "rejected"]],
    [401, "unauthorized", ["terminal", "rejected"]],
    [403, "runner_rejected", ["terminal", "rejected"]],
    [410, "gone", ["terminal", "rejected"]],
    [418, "unknown", ["terminal", "rejected"]],
  ]) {
    const result = classifyEngineCompleteResponse(
      status,
      status === 200 ? acknowledgement : error ? { error } : {},
      runId,
    );
    assert.deepEqual(
      [result.classification, result.outboxStatus],
      expected,
      `${status} ${error}`,
    );
    assert.notEqual(result.outboxStatus, "abandoned");
  }
  assert.deepEqual(
    classifyEngineCompleteResponse(200, {}, runId),
    { classification: "protocol_error", outboxStatus: "pending" },
  );
  assert.deepEqual(
    classifyEngineCompleteResponse(
      200,
      acknowledgement,
      `run_${"9".repeat(32)}`,
    ),
    { classification: "protocol_error", outboxStatus: "pending" },
  );
  assert.deepEqual(
    classifyEngineCompleteResponse(409, { error: [] }, runId),
    { classification: "terminal", outboxStatus: "rejected" },
  );
  assert.deepEqual(
    classifyEngineCompleteResponse(500, null, runId),
    { classification: "retryable", outboxStatus: "pending" },
  );
  assert.throws(
    () => classifyEngineCompleteResponse(99, {}, runId),
    /Invalid engine completion response status/u,
  );
  assert.throws(
    () => classifyEngineCompleteResponse(200.5, acknowledgement, runId),
    /Invalid engine completion response status/u,
  );
  assert.throws(
    () => classifyEngineCompleteResponse(600, acknowledgement, runId),
    /Invalid engine completion response status/u,
  );
});

test("golden v3 completion entries replay exact bytes and retain safe tombstones", async () => {
  const [bodyText, responseText, pendingText, ackedText, reportText] =
    await Promise.all([
      fixture("engine-complete-body-v1.json"),
      fixture("engine-complete-response-v1.json"),
      fixture("outbox-v3-engine-complete.json"),
      fixture("outbox-v3-engine-complete-acked.json"),
      fixture("outbox-v3-engine-report.json"),
    ]);
  const pending = parseOutboxEntryText(pendingText);
  const acked = parseOutboxEntryText(ackedText);
  assert.ok(pending);
  assert.ok(acked);
  assert.ok(parseOutboxEntryText(reportText));
  assert.deepEqual(Object.keys(pending).sort(), [
    "bodyBase64",
    "bodySha256",
    "createdAt",
    "declarationKind",
    "entrySha256",
    "operationId",
    "response",
    "runId",
    "status",
    "updatedAt",
    "v",
  ]);
  assert.deepEqual(Object.keys(acked).sort(), [
    "bodySha256",
    "createdAt",
    "declarationKind",
    "entrySha256",
    "operationId",
    "responseSha256",
    "responseStatus",
    "runId",
    "settledAt",
    "status",
    "updatedAt",
    "v",
  ]);
  assert.equal(operationBody(pending).toString("utf8"), bodyText);
  assert.equal(
    deriveOutboxPathname(pending),
    `/api/runs/${runId}/engine-complete`,
  );
  assert.equal(acked.responseSha256, sha256(responseText));
  assert.equal("bodyBase64" in acked, false);
  assert.equal("response" in acked, false);
  assert.throws(() => operationBody(acked), /has no replay body/u);
  for (const invalid of [
    finalizeOutboxEntry({
      ...withoutChecksum(acked),
      responseStatus: 500,
    }),
    finalizeOutboxEntry({
      ...withoutChecksum(acked),
      status: "rejected",
      responseStatus: 200,
    }),
  ]) {
    assert.equal(
      parseOutboxEntryText(JSON.stringify(invalid)),
      undefined,
    );
  }
});

test("body identity, declaration kind and checksum drift all fail closed", async () => {
  const [pendingText, reportText] = await Promise.all([
    fixture("outbox-v3-engine-complete.json"),
    fixture("outbox-v3-engine-report.json"),
  ]);
  const pending = JSON.parse(pendingText);
  const body = JSON.parse(
    Buffer.from(pending.bodyBase64, "base64url").toString("utf8"),
  );
  const changedBody = canonicalJson({
    ...body,
    operationId: `op_${"8".repeat(32)}`,
  });
  const bodyDrift = finalizeOutboxEntry({
    ...withoutChecksum(pending),
    bodyBase64: Buffer.from(changedBody).toString("base64url"),
    bodySha256: sha256(changedBody),
  });
  assert.equal(
    parseOutboxEntryText(JSON.stringify(bodyDrift)),
    undefined,
  );
  assert.equal(
    parseOutboxEntryText(
      JSON.stringify({
        ...pending,
        runId: `run_${"9".repeat(32)}`,
      }),
    ),
    undefined,
  );
  assert.equal(
    parseOutboxEntryText(
      JSON.stringify(
        finalizeOutboxEntry({
          ...withoutChecksum(pending),
          declarationKind: "engine.report",
        }),
      ),
    ),
    undefined,
  );
  const report = JSON.parse(reportText);
  assert.equal(
    parseOutboxEntryText(
      JSON.stringify(
        finalizeOutboxEntry({
          ...withoutChecksum(report),
          declarationKind: "engine.complete",
        }),
      ),
    ),
    undefined,
  );
});

test("completion settlement atomically scrubs request and response markers", async (t) => {
  const stateDir = await mkdtemp(
    join(tmpdir(), "nexus-engine-complete-outbox-"),
  );
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const body = Buffer.from(await fixture("engine-complete-body-v1.json"));
  const created = await persistDeclarationOperation(stateDir, {
    body,
    declarationKind: "engine.complete",
    operationId,
    runId,
  });
  assert.equal(created.status, "pending");
  assert.equal(operationBody(created).equals(body), true);

  const response = Buffer.from(
    '{"late":false,"mustNotSurvive":"RESPONSE_SECRET_MARKER"}',
  );
  const acked = await transitionOperation(
    stateDir,
    created,
    "acked",
    { status: 200, body: response },
  );
  const path = join(
    stateDir,
    OUTBOX_V3_DIRECTORY,
    `${operationId}.json`,
  );
  const stored = await readFile(path, "utf8");
  assert.ok(parseOutboxEntryText(stored));
  assert.equal(stored.includes("PRIVATE_OUTPUT_MARKER"), false);
  assert.equal(stored.includes("RESPONSE_SECRET_MARKER"), false);
  assert.equal(stored.includes("bodyBase64"), false);
  assert.equal(acked.bodySha256, sha256(body));
  assert.equal(acked.responseSha256, sha256(response));

  const repeated = await transitionOperation(
    stateDir,
    acked,
    "acked",
    { status: 299, body: Buffer.from("must-not-replace") },
  );
  assert.deepEqual(repeated, acked);
  assert.equal(await readFile(path, "utf8"), stored);
  assert.equal(
    await pruneOutbox(
      stateDir,
      Date.parse(acked.updatedAt) + 7 * 24 * 60 * 60 * 1_000,
    ),
    1,
  );
  assert.deepEqual(await recoverOutbox(stateDir), []);
});

test("server responses never use abandoned and local abandonment stays response-free", async (t) => {
  const stateDir = await mkdtemp(
    join(tmpdir(), "nexus-engine-complete-terminal-"),
  );
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const body = Buffer.from(await fixture("engine-complete-body-v1.json"));
  const created = await persistDeclarationOperation(stateDir, {
    body,
    declarationKind: "engine.complete",
    operationId,
    runId,
  });
  await assert.rejects(
    transitionOperation(
      stateDir,
      created,
      "abandoned",
      { status: 410, body: Buffer.from("{}") },
    ),
    /Invalid declaration terminal response/u,
  );
  await assert.rejects(
    transitionOperation(stateDir, created, "superseded", null),
    /Invalid declaration terminal response/u,
  );
  const abandoned = await transitionOperation(
    stateDir,
    created,
    "abandoned",
    null,
  );
  assert.equal(abandoned.responseStatus, null);
  assert.equal(abandoned.responseSha256, null);
  assert.equal("bodyBase64" in abandoned, false);
});

function fixture(name) {
  return readFile(
    new URL(`./fixtures/s6-b4/${name}`, import.meta.url),
    "utf8",
  ).then((value) => value.trimEnd());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function withoutChecksum(entry) {
  const value = { ...entry };
  delete value.entrySha256;
  return value;
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

function negativeBody(vector, source) {
  if (vector.mode === "replace") {
    assert.equal(source.includes(vector.search), true, vector.name);
    return Buffer.from(
      source.replace(vector.search, vector.replacement),
      "utf8",
    );
  }
  if (vector.mode === "bom") {
    return Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(source, "utf8"),
    ]);
  }
  if (vector.mode === "raw") {
    return Buffer.from(vector.bodyBase64, "base64url");
  }
  if (vector.mode === "oversized") {
    return Buffer.alloc(vector.bytes);
  }
  throw new TypeError(`Unsupported negative vector: ${vector.name}`);
}
