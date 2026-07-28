import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  SUPERVISOR_BOOTSTRAP_MAX_BYTES,
  SUPERVISOR_CONTROL_MAX_BYTES,
  SUPERVISOR_EVENT_MAX_BYTES,
  SUPERVISOR_HANDSHAKE_TIMEOUT_MS,
  SUPERVISOR_INPUT_MAX_BYTES,
  encodeChildStartToken,
  encodeSupervisorBootstrap,
  encodeSupervisorControl,
  encodeSupervisorEvent,
  encodeSupervisorStartToken,
  createSupervisorPrestartReceipt,
  parseChildStartToken,
  parseSupervisorBootstrap,
  parseSupervisorControl,
  parseSupervisorEvent,
  parseSupervisorStartToken,
  supervisorChallengeProof,
  supervisorFaultReason,
  verifySupervisorHelloAck,
  verifySupervisorChildEvent,
} from "../runner/engine-supervisor-protocol.mjs";
import {
  finalizeAttemptRecord,
} from "../runner/attempt-journal-contract.mjs";
import {
  parseEngineExecutionResult,
} from "../runner/engine-complete-contract.mjs";

const attemptId = `att_${"a".repeat(32)}`;
const token = "b".repeat(32);
const input = Buffer.from('{"scenario":"success"}', "utf8");
const emptySha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("supervisor and child identities round-trip inside the journal grammar", () => {
  const supervisor = encodeSupervisorStartToken(65_535, token);
  assert.deepEqual(parseSupervisorStartToken(supervisor), {
    port: 65_535,
    token,
  });
  const child = encodeChildStartToken(token, 1);
  assert.deepEqual(parseChildStartToken(child), {
    ordinal: 1,
    supervisorToken: token,
  });
  assert.equal(parseSupervisorStartToken(`sup2:0:${token}`), undefined);
  assert.equal(parseSupervisorStartToken(`sup2:65536:${token}`), undefined);
  assert.equal(parseChildStartToken(`eng2:${token}:0`), undefined);
  assert.equal(parseChildStartToken(`eng2:${token}:2`), undefined);
  assert.equal(
    parseSupervisorStartToken(`sup1:41000:${token}`),
    undefined,
  );
  assert.equal(parseChildStartToken(`eng1:${token}:1`), undefined);
  assert.throws(() => encodeSupervisorStartToken(0, token));
  assert.throws(() => encodeChildStartToken(token, 0));
  assert.ok(
    finalizeAttemptRecord({
      attemptId,
      createdAt: "2026-07-27T12:00:01.000Z",
      state: "supervisor",
      supervisorPid: 42,
      supervisorStartToken: supervisor,
      v: 1,
    }),
  );
  assert.ok(
    finalizeAttemptRecord({
      attemptId,
      childPid: 43,
      childStartToken: child,
      createdAt: "2026-07-27T12:00:02.000Z",
      startedAt: "2026-07-27T12:00:02.000Z",
      state: "started",
      v: 1,
    }),
  );
});

test("bootstrap and every control variant use exact bounded canonical frames", () => {
  const bootstrap = {
    kind: "ready",
    pid: 42,
    port: 41_000,
    token,
    v: 2,
  };
  roundTrip(
    bootstrap,
    encodeSupervisorBootstrap,
    parseSupervisorBootstrap,
    SUPERVISOR_BOOTSTRAP_MAX_BYTES,
  );
  for (const frame of [
    {
      attemptId,
      kind: "hello",
      nonce: "c".repeat(32),
      v: 2,
    },
    { attemptId, kind: "attach", token, v: 2 },
    {
      attemptId,
      kind: "authorize_spawn",
      request: spawnRequest(),
      token,
      v: 2,
    },
    {
      attemptId,
      childToken: encodeChildStartToken(token, 1),
      kind: "authorize_input",
      token,
      v: 2,
    },
    { attemptId, kind: "cancel", token, v: 2 },
    { attemptId, kind: "abandon", token, v: 2 },
    { attemptId, kind: "ack_result", token, v: 2 },
  ]) {
    roundTrip(
      frame,
      encodeSupervisorControl,
      parseSupervisorControl,
      SUPERVISOR_CONTROL_MAX_BYTES,
    );
  }
});

test("every event variant is exact, frozen and output-closed", () => {
  const child = {
    attemptId,
    childPid: 43,
    childToken: encodeChildStartToken(token, 1),
    kind: "state",
    startedAt: "2026-07-27T12:00:02.000Z",
    v: 2,
  };
  const frames = [
    {
      attemptId,
      kind: "hello_ack",
      nonce: "c".repeat(32),
      proof: supervisorChallengeProof(
        token,
        attemptId,
        "c".repeat(32),
      ),
      v: 2,
    },
    {
      attemptId,
      kind: "state",
      state: "waiting_spawn",
      v: 2,
    },
    { ...child, state: "waiting_input" },
    { ...child, state: "running" },
    {
      attemptId,
      kind: "state",
      receipt: receipt(),
      state: "result",
      v: 2,
    },
    {
      attemptId,
      code: "protocol_invalid",
      kind: "state",
      state: "fault",
      v: 2,
    },
  ];
  const parsedFrames = [];
  for (const frame of frames) {
    const parsed = roundTrip(
      frame,
      encodeSupervisorEvent,
      parseSupervisorEvent,
      SUPERVISOR_EVENT_MAX_BYTES,
    );
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(JSON.stringify(parsed).includes("message"), false);
    parsedFrames.push(parsed);
  }
  const started = parsedFrames.find((frame) => frame.state === "running");
  const completed = parsedFrames.find((frame) => frame.state === "result");
  assert.equal(started.startedAt, completed.receipt.startedAt);
});

test("challenge proof and fault mapping close every journal seam", () => {
  const nonce = "c".repeat(32);
  const proof = supervisorChallengeProof(token, attemptId, nonce);
  assert.match(proof, /^[0-9a-f]{64}$/u);
  assert.notEqual(
    proof,
    supervisorChallengeProof(token, `att_${"d".repeat(32)}`, nonce),
  );
  const ack = parseSupervisorEvent(
    encodeSupervisorEvent({
      attemptId,
      kind: "hello_ack",
      nonce,
      proof,
      v: 2,
    }),
  );
  assert.equal(
    verifySupervisorHelloAck({ attemptId, nonce, token }, ack),
    true,
  );
  assert.equal(
    verifySupervisorHelloAck(
      { attemptId, nonce: "d".repeat(32), token },
      ack,
    ),
    false,
  );
  assert.equal(
    verifySupervisorHelloAck(
      { attemptId: `att_${"d".repeat(32)}`, nonce, token },
      ack,
    ),
    false,
  );
  for (const code of [
    "cancel_requested",
    "interrupted_after_start",
    "protocol_invalid",
    "spawn_failed",
    "timed_out",
  ]) {
    assert.equal(
      supervisorFaultReason("waiting_spawn", code),
      "spawn_failed",
    );
  }
  assert.equal(
    supervisorFaultReason("running", "cancel_requested"),
    "cancel_requested",
  );
  assert.equal(
    supervisorFaultReason("waiting_input", "spawn_failed"),
    "interrupted_after_start",
  );
  assert.throws(() =>
    supervisorFaultReason("running", "output_limit_reached"),
  );
  assert.equal(verifySupervisorHelloAck(null, ack), false);
  const running = parseSupervisorEvent(
    encodeSupervisorEvent({
      attemptId,
      childPid: 43,
      childToken: encodeChildStartToken(token, 1),
      kind: "state",
      startedAt: "2026-07-27T12:00:02.000Z",
      state: "running",
      v: 2,
    }),
  );
  assert.equal(verifySupervisorChildEvent(token, running), true);
  assert.equal(
    verifySupervisorChildEvent("d".repeat(32), running),
    false,
  );
  assert.equal(
    supervisorFaultReason("running", "timed_out"),
    "timed_out",
  );
  assert.equal(
    supervisorFaultReason("running", "protocol_invalid"),
    "protocol_invalid",
  );
  assert.throws(() =>
    supervisorFaultReason("waiting_spawn", "invalid_request"),
  );
  const prestart = createSupervisorPrestartReceipt({
    engine: "claude_code_cli",
    engineVersion: "2.1.219",
    recordedAt: "2026-07-27T12:00:02.000Z",
  });
  assert.ok(parseEngineExecutionResult(prestart));
  assert.deepEqual(
    {
      cancelRequested: prestart.cancelRequested,
      exitCode: prestart.exitCode,
      reason: prestart.reason,
      status: prestart.status,
      stderrBytes: prestart.stderr.bytes,
      stdoutBytes: prestart.stdout.bytes,
      timedOut: prestart.timedOut,
    },
    {
      cancelRequested: false,
      exitCode: null,
      reason: "spawn_failed",
      status: "failed",
      stderrBytes: 0,
      stdoutBytes: 0,
      timedOut: false,
    },
  );
  assert.throws(() =>
    createSupervisorPrestartReceipt({
      engine: "claude_code_cli",
      engineVersion: "2.1.219",
      recordedAt: "not-a-time",
    }),
  );
  assert.throws(() =>
    encodeSupervisorControl({
      attemptId,
      childToken: encodeChildStartToken("d".repeat(32), 1),
      kind: "authorize_input",
      token,
      v: 2,
    }),
  );
});

test("protocol rejects drift, malformed input and raw error surfaces", () => {
  const request = spawnRequest();
  for (const mutation of [
    { inputBase64: Buffer.from("changed").toString("base64url") },
    { inputSha256: "0".repeat(64) },
    { timeoutMs: 269_999 },
    { timeoutMs: 600_001 },
    { executableRealPath: "../engine" },
    { cwdRoot: "/private/../tmp" },
    { cwdRoot: "/private/tmp/" },
    { cwdRoot: "/private/\ud800/tmp" },
    { deadlineAt: "not-a-time" },
    { engine: "other" },
    { engineVersion: "\n" },
    {
      binaryFingerprint: {
        ...request.binaryFingerprint,
        size: -1,
      },
    },
  ]) {
    const frame = {
      attemptId,
      kind: "authorize_spawn",
      request: { ...request, ...mutation },
      token,
      v: 2,
    };
    assert.throws(() => encodeSupervisorControl(frame));
  }
  const raw = encodeSupervisorControl({
    attemptId,
    kind: "authorize_spawn",
    request,
    token,
    v: 2,
  });
  assert.equal(
    parseSupervisorControl(Buffer.concat([Buffer.from(" "), raw])),
    undefined,
  );
  assert.equal(parseSupervisorControl(raw.subarray(0, -1)), undefined);
  assert.equal(
    parseSupervisorControl(
      Buffer.from(
        `${JSON.stringify({
          attemptId,
          kind: "authorize_spawn",
          request,
          token,
          v: 1,
        })}\n`,
      ),
    ),
    undefined,
  );
  assert.equal(
    parseSupervisorControl(Buffer.from('{"kind":"hello"}\n')),
    undefined,
  );
  assert.equal(
    parseSupervisorEvent(
      Buffer.from(
        `${JSON.stringify({
          attemptId,
          code: "protocol_invalid",
          kind: "state",
          message: "private provider error",
          state: "fault",
          v: 2,
        })}\n`,
      ),
    ),
    undefined,
  );
});

test("input and frame bounds fail closed at the next byte", () => {
  const maximal = Buffer.alloc(SUPERVISOR_INPUT_MAX_BYTES, 0x61);
  const request = spawnRequest(maximal);
  assert.ok(
    parseSupervisorControl(
      encodeSupervisorControl({
        attemptId,
        kind: "authorize_spawn",
        request,
        token,
        v: 2,
      }),
    ),
  );
  const overflow = Buffer.alloc(SUPERVISOR_INPUT_MAX_BYTES + 1, 0x61);
  assert.throws(() =>
    encodeSupervisorControl({
      attemptId,
      kind: "authorize_spawn",
      request: spawnRequest(overflow),
      token,
      v: 2,
    }),
  );
  assert.equal(
    parseSupervisorControl(
      Buffer.alloc(SUPERVISOR_CONTROL_MAX_BYTES + 1, 0x61),
    ),
    undefined,
  );
});

test("cross-parser, encoding and duplicate-key confusion fail closed", () => {
  const bootstrap = encodeSupervisorBootstrap({
    kind: "ready",
    pid: 42,
    port: 41_000,
    token,
    v: 2,
  });
  const hello = encodeSupervisorControl({
    attemptId,
    kind: "hello",
    nonce: "c".repeat(32),
    v: 2,
  });
  const event = encodeSupervisorEvent({
    attemptId,
    kind: "state",
    state: "waiting_spawn",
    v: 2,
  });
  assert.equal(parseSupervisorControl(bootstrap), undefined);
  assert.equal(parseSupervisorEvent(hello), undefined);
  assert.equal(parseSupervisorBootstrap(event), undefined);
  assert.equal(
    parseSupervisorControl(
      Buffer.from(
        `{"attemptId":"${attemptId}","kind":"cancel","kind":"abandon","token":"${token}","v":1}\n`,
      ),
    ),
    undefined,
  );
  assert.equal(
    parseSupervisorControl(
      Buffer.from(
        `{"__proto__":{},"attemptId":"${attemptId}","kind":"cancel","token":"${token}","v":1}\n`,
      ),
    ),
    undefined,
  );
  assert.equal(
    parseSupervisorControl(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), hello]),
    ),
    undefined,
  );
  assert.equal(
    parseSupervisorControl(Buffer.from([0xc3, 0x28, 0x0a])),
    undefined,
  );
  assert.equal(parseSupervisorControl([]), undefined);
  assert.equal(parseSupervisorControl(null), undefined);
  const request = spawnRequest();
  assert.throws(() =>
    encodeSupervisorControl({
      attemptId,
      kind: "authorize_spawn",
      request: { ...request, inputBase64: "ab" },
      token,
      v: 2,
    }),
  );
  assert.equal(
    parseSupervisorControl(
      Buffer.from(
        `${JSON.stringify({
          attemptId: [attemptId],
          kind: "cancel",
          token,
          v: 2,
        })}\n`,
      ),
    ),
    undefined,
  );
  assert.equal(
    parseSupervisorEvent(
      Buffer.from(
        `${JSON.stringify({
          attemptId,
          kind: "hello_ack",
          nonce: ["c".repeat(32)],
          proof: ["d".repeat(64)],
          v: 2,
        })}\n`,
      ),
    ),
    undefined,
  );
});

test("handshake and identity failures are explicitly bounded and ambiguous", () => {
  assert.equal(SUPERVISOR_HANDSHAKE_TIMEOUT_MS, 5_000);
  assert.equal(parseSupervisorStartToken("legacy:43210:token"), undefined);
  assert.equal(
    parseSupervisorBootstrap(
      Buffer.from(
        `${JSON.stringify({
          kind: "ready",
          pid: 42,
          port: 22,
          token,
          v: 2,
        })}\n`,
      ),
    ),
    undefined,
  );
});

function spawnRequest(bytes = input) {
  return {
    binaryFingerprint: {
      dev: "1",
      ino: "2",
      mode: 0o100700,
      mtimeMs: 1_000,
      size: 1_234,
      uid: 501,
    },
    cwdRoot: "/private/tmp/nexus-supervisor",
    deadlineAt: "2026-07-27T12:20:00.000Z",
    engine: "claude_code_cli",
    engineVersion: "2.1.219",
    executableRealPath: "/private/tmp/nexus-supervisor/fake-engine",
    inputBase64: bytes.toString("base64url"),
    inputSha256: createHash("sha256").update(bytes).digest("hex"),
    timeoutMs: 270_000,
  };
}

function receipt() {
  return {
    cancelRequested: false,
    engine: "claude_code_cli",
    engineVersion: "2.1.219",
    exitCode: 0,
    finishedAt: "2026-07-27T12:00:03.000Z",
    reason: "none",
    startedAt: "2026-07-27T12:00:02.000Z",
    status: "succeeded",
    stderr: {
      bytes: 0,
      excerptBase64Url: "",
      sha256: emptySha256,
      truncated: false,
    },
    stdout: {
      bytes: 2,
      excerptBase64Url: Buffer.from("ok").toString("base64url"),
      sha256: createHash("sha256").update("ok").digest("hex"),
      truncated: false,
    },
    summary: "completed",
    timedOut: false,
  };
}

function roundTrip(value, encode, parse, maximum) {
  const bytes = encode(value);
  assert.ok(bytes.byteLength <= maximum);
  assert.equal(bytes.at(-1), 0x0a);
  const parsed = parse(bytes);
  assert.deepEqual(parsed, value);
  assert.equal(encode(parsed).toString("hex"), bytes.toString("hex"));
  return parsed;
}
