import assert from "node:assert/strict";
import test from "node:test";
import {
  INVALID_REALTIME_FRAME_CLOSE_CODE,
  parseRealtimeFrame,
  pollingDelayMs,
  reconnectDelayMs,
  RealtimeSignalBuffer,
} from "../../app/realtime-policy";

test("client parser separates keepalive from strict payload-free signals", () => {
  assert.deepEqual(parseRealtimeFrame("pong"), { kind: "pong" });
  assert.deepEqual(
    parseRealtimeFrame(
      JSON.stringify({
        kind: "conversation",
        conversationId: "conversation-1",
        sequenceHint: 3,
      }),
    ),
    {
      kind: "signal",
      signal: {
        kind: "conversation",
        conversationId: "conversation-1",
        sequenceHint: 3,
      },
    },
  );
  assert.deepEqual(
    parseRealtimeFrame(
      JSON.stringify({ kind: "attention", principalId: "principal-1" }),
    ),
    {
      kind: "signal",
      signal: { kind: "attention", principalId: "principal-1" },
    },
  );
  assert.deepEqual(parseRealtimeFrame('{"kind":"presence"}'), {
    kind: "signal",
    signal: { kind: "presence" },
  });
});

test("client parser rejects data, tenant routing and unknown fields", () => {
  for (const frame of [
    "not-json",
    '{"kind":"presence","organizationId":"org-1"}',
    '{"kind":"attention","principalId":"principal-1","payload":"secret"}',
    '{"kind":"conversation","conversationId":"bad id"}',
    '{"kind":"conversation","conversationId":"conversation-1","sequenceHint":0}',
    '{"kind":"unknown"}',
  ]) {
    assert.deepEqual(parseRealtimeFrame(frame), { kind: "invalid" });
  }
});

test("client polling only downgrades to watchdog cadence while live", () => {
  assert.equal(
    pollingDelayMs({
      status: "live",
      baseDelayMs: 4_000,
      failureCount: 0,
      maximumDelayMs: 30_000,
    }),
    60_000,
  );
  assert.equal(
    pollingDelayMs({
      status: "live",
      baseDelayMs: 5_000,
      failureCount: 0,
      maximumDelayMs: 60_000,
      liveDelayMs: 15_000,
    }),
    15_000,
  );
  assert.equal(
    pollingDelayMs({
      status: "live",
      baseDelayMs: 5_000,
      failureCount: 3,
      maximumDelayMs: 60_000,
      liveDelayMs: 15_000,
    }),
    40_000,
  );
  for (const status of [
    "probing",
    "connecting",
    "reconnect_wait",
    "fallback",
  ] as const) {
    assert.equal(
      pollingDelayMs({
        status,
        baseDelayMs: 4_000,
        failureCount: 0,
        maximumDelayMs: 60_000,
      }),
      4_000,
    );
  }
});

test("invalid-frame close code is legal for a browser client", () => {
  assert.ok(
    INVALID_REALTIME_FRAME_CLOSE_CODE >= 3_000 &&
      INVALID_REALTIME_FRAME_CLOSE_CODE <= 4_999,
  );
});

test("reconnect backoff applies bounded full jitter", () => {
  assert.equal(reconnectDelayMs(0, () => 0), 0);
  assert.equal(reconnectDelayMs(0, () => 1), 1_000);
  assert.equal(reconnectDelayMs(2, () => 0.5), 2_000);
  assert.equal(reconnectDelayMs(20, () => 1), 30_000);
});

test("signal buffer coalesces bursts per domain key without mixing conversations", () => {
  const buffer = new RealtimeSignalBuffer();
  buffer.add({ kind: "presence" });
  buffer.add({ kind: "presence" });
  buffer.add({ kind: "attention", principalId: "principal-1" });
  buffer.add({
    kind: "conversation",
    conversationId: "conversation-1",
    sequenceHint: 1,
  });
  buffer.add({
    kind: "conversation",
    conversationId: "conversation-1",
    sequenceHint: 2,
  });
  buffer.add({
    kind: "conversation",
    conversationId: "conversation-2",
  });

  assert.equal(buffer.size, 4);
  assert.deepEqual(buffer.drain(), [
    { kind: "presence" },
    { kind: "attention", principalId: "principal-1" },
    {
      kind: "conversation",
      conversationId: "conversation-1",
      sequenceHint: 2,
    },
    { kind: "conversation", conversationId: "conversation-2" },
  ]);
  assert.equal(buffer.size, 0);
});
