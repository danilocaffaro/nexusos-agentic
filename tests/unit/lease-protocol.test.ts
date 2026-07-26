import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../../src/domain/governance/canonical-json";
import {
  generateLeaseId,
  generateOperationId,
  generateRunId,
  isRunEventSequenceConflict,
  LEASE_ID_PATTERN,
  OPERATION_ID_PATTERN,
  parseLeaseClaimBody,
  parseLeaseRenewBody,
  parseRunCompleteBody,
  RUN_ID_PATTERN,
  runnerOperationRequestHash,
} from "../../src/domain/runners/lease-protocol";
import {
  buildRunnerStringToSign,
  encodeBase64Url,
} from "../../src/domain/runners/runner-protocol";

const bytes = (value: string) => new TextEncoder().encode(value);
const runId = `run_${"1".repeat(32)}`;
const leaseId = `lse_${"2".repeat(32)}`;
const operationId = `op_${"3".repeat(32)}`;
const runnerId = `rnr_${"4".repeat(32)}`;

test("lease ids are random canonical identifiers", () => {
  assert.match(generateRunId(), RUN_ID_PATTERN);
  assert.match(generateLeaseId(), LEASE_ID_PATTERN);
  assert.match(generateOperationId(), OPERATION_ID_PATTERN);
  assert.notEqual(generateOperationId(), generateOperationId());
});

test("run-event trigger conflicts are classified for whole-batch retry", () => {
  assert.equal(
    isRunEventSequenceConflict(new Error("invalid_run_event")),
    true,
  );
  assert.equal(
    isRunEventSequenceConflict(
      new Error(
        "UNIQUE constraint failed: run_events.run_id, run_events.sequence",
      ),
    ),
    true,
  );
  assert.equal(
    isRunEventSequenceConflict(new Error("invalid_runner_operation")),
    false,
  );
});

test("lease bodies require exact canonical bytes and closed schemas", () => {
  assert.deepEqual(
    parseLeaseClaimBody(bytes(canonicalJson({ operationId }))),
    { operationId },
  );
  assert.equal(
    parseLeaseClaimBody(bytes(`{ "operationId":"${operationId}"}`)),
    undefined,
  );
  assert.equal(
    parseLeaseClaimBody(
      bytes(canonicalJson({ operationId, runnerId })),
    ),
    undefined,
  );

  assert.deepEqual(
    parseLeaseRenewBody(bytes(canonicalJson({ leaseId, fence: 7 }))),
    { leaseId, fence: 7 },
  );
  assert.equal(
    parseLeaseRenewBody(bytes(canonicalJson({ leaseId, fence: 0 }))),
    undefined,
  );
  assert.equal(
    parseLeaseRenewBody(
      bytes(`{"leaseId":"${leaseId}","fence":7}`),
    ),
    undefined,
  );
});

test("completion bounds outcome and rejects noncanonical or unknown data", () => {
  const complete = {
    fence: 7,
    leaseId,
    operationId,
    outcome: {
      status: "succeeded",
      summary: "Diagnostic lease completed",
    },
  };
  assert.deepEqual(
    parseRunCompleteBody(bytes(canonicalJson(complete))),
    complete,
  );
  assert.equal(
    parseRunCompleteBody(
      bytes(canonicalJson({ ...complete, runId })),
    ),
    undefined,
  );
  assert.equal(
    parseRunCompleteBody(
      bytes(
        canonicalJson({
          ...complete,
          outcome: { status: "unknown", summary: "No" },
        }),
      ),
    ),
    undefined,
  );
  assert.equal(
    parseRunCompleteBody(
      bytes(
        canonicalJson({
          ...complete,
          outcome: { status: "failed", summary: "x".repeat(1_025) },
        }),
      ),
    ),
    undefined,
  );
});

test("lease signing binds the runner key id while semantic hash ignores nonce", async () => {
  const body = bytes(canonicalJson({ operationId }));
  const pathname = `/api/runs/${runId}/lease/claim`;
  const first = await buildRunnerStringToSign({
    domain: "nexus-runner-lease-claim-v1",
    keyId: runnerId,
    method: "POST",
    pathname,
    audience: "https://nexus.example",
    timestamp: "2026-07-26T12:34:56.789Z",
    nonce: encodeBase64Url(new Uint8Array(16).fill(1)),
    body,
  });
  const second = await buildRunnerStringToSign({
    domain: "nexus-runner-lease-claim-v1",
    keyId: runnerId,
    method: "POST",
    pathname,
    audience: "https://nexus.example",
    timestamp: "2026-07-26T12:35:01.000Z",
    nonce: encodeBase64Url(new Uint8Array(16).fill(2)),
    body,
  });
  assert.equal(first.value.split("\n")[1], runnerId);
  assert.notEqual(first.hash, second.hash);
  assert.equal(
    await runnerOperationRequestHash({
      domain: "nexus-runner-lease-claim-v1",
      runnerId,
      pathname,
      body,
    }),
    await runnerOperationRequestHash({
      domain: "nexus-runner-lease-claim-v1",
      runnerId,
      pathname,
      body,
    }),
  );
  assert.notEqual(
    await runnerOperationRequestHash({
      domain: "nexus-runner-lease-claim-v1",
      runnerId,
      pathname,
      body,
    }),
    await runnerOperationRequestHash({
      domain: "nexus-runner-lease-claim-v1",
      runnerId,
      pathname: `${pathname}/`,
      body,
    }),
  );
});
