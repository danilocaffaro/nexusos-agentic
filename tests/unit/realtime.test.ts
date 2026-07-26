import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRealtimeSignal,
  RealtimeSignalError,
  toRealtimeWireSignal,
  type RealtimeSignal,
} from "../../src/contracts/realtime";
import { NoopRealtimeNotifyPort } from "../../src/adapters/realtime/noop-realtime-notify-port";
import { RecordingRealtimeNotifyPort } from "../support/recording-realtime-notify-port";

const signals: RealtimeSignal[] = [
  {
    kind: "conversation",
    organizationId: "org-1",
    conversationId: "room-1",
    sequenceHint: 7,
  },
  {
    kind: "attention",
    organizationId: "org-1",
    principalId: "human-1",
  },
  { kind: "presence", organizationId: "org-1" },
];

test("realtime wire signals are payload-free and omit tenant routing", () => {
  assert.deepEqual(
    signals.map(toRealtimeWireSignal),
    [
      { kind: "conversation", conversationId: "room-1", sequenceHint: 7 },
      { kind: "attention", principalId: "human-1" },
      { kind: "presence" },
    ],
  );

  const contaminated = {
    ...signals[0]!,
    bodyText: "must never cross the realtime boundary",
  };
  assert.deepEqual(
    toRealtimeWireSignal(contaminated),
    { kind: "conversation", conversationId: "room-1", sequenceHint: 7 },
  );
  assert.equal(
    JSON.stringify(signals.map(toRealtimeWireSignal)).includes(
      "organizationId",
    ),
    false,
  );
});

test("conversation invalidation supports changes without a sequence hint", () => {
  const wireSignal = toRealtimeWireSignal({
    kind: "conversation",
    organizationId: "org-1",
    conversationId: "room-1",
  });
  assert.deepEqual(wireSignal, {
    kind: "conversation",
    conversationId: "room-1",
  });
  assert.equal("sequenceHint" in wireSignal, false);
});

test("realtime signal validation rejects invalid ids, cursors and kinds", () => {
  assert.throws(
    () =>
      assertRealtimeSignal({
        kind: "presence",
        organizationId: "../foreign",
      }),
    (error) =>
      error instanceof RealtimeSignalError &&
      error.code === "realtime_invalid_id",
  );
  assert.throws(
    () =>
      assertRealtimeSignal({
        kind: "conversation",
        organizationId: "org-1",
        conversationId: "room-1",
        sequenceHint: 0,
      }),
    (error) =>
      error instanceof RealtimeSignalError &&
      error.code === "realtime_invalid_sequence",
  );
  assert.throws(
    () =>
      assertRealtimeSignal({
        kind: "future-kind",
        organizationId: "org-1",
      }),
    (error) =>
      error instanceof RealtimeSignalError &&
      error.code === "realtime_invalid_kind",
  );
  assert.throws(
    () =>
      assertRealtimeSignal({
        kind: "presence",
        organizationId: "..",
      }),
    (error) =>
      error instanceof RealtimeSignalError &&
      error.code === "realtime_invalid_id",
  );
});

test("notify adapters resolve and the recorder snapshots safe wire signals", async () => {
  const noop = new NoopRealtimeNotifyPort();
  await noop.publish(signals[0]!);

  const recording = new RecordingRealtimeNotifyPort();
  await Promise.all(signals.map((signal) => recording.publish(signal)));
  assert.deepEqual(recording.wireSignals, signals.map(toRealtimeWireSignal));
  assert.deepEqual(recording.failures, []);

  const mutableSignal: RealtimeSignal = {
    kind: "conversation",
    organizationId: "org-1",
    conversationId: "room-mutable",
    sequenceHint: 3,
  };
  await recording.publish(mutableSignal);
  mutableSignal.sequenceHint = 99;
  assert.deepEqual(recording.wireSignals.at(-1), {
    kind: "conversation",
    conversationId: "room-mutable",
    sequenceHint: 3,
  });
});

test("recording adapter absorbs invalid notification input", async () => {
  const recording = new RecordingRealtimeNotifyPort();
  await recording.publish({
    kind: "presence",
    organizationId: "..",
  });
  assert.deepEqual(recording.wireSignals, []);
  assert.equal(recording.failures[0]?.code, "realtime_invalid_id");
});
