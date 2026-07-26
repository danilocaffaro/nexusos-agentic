import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertRealtimeDeliveryEnvelope,
  assertRealtimeSignal,
  MAX_REALTIME_ENVELOPE_BYTES,
  MAX_REALTIME_RECIPIENTS,
  RealtimeSignalError,
  toRealtimeDeliveryEnvelope,
  toRealtimeWireSignal,
  type RealtimeSignal,
} from "../../src/contracts/realtime";
import { NoopRealtimeNotifyPort } from "../../src/adapters/realtime/noop-realtime-notify-port";
import { DurableObjectRealtimeNotifyPort } from "../../src/adapters/realtime/durable-object-realtime-notify-port";
import type { RealtimeRecipientResolver } from "../../src/adapters/d1/realtime-recipient-resolver";
import {
  isAllowedRealtimeOrigin,
  isRealtimePushEnabled,
  realtimeDurableObjectConfig,
} from "../../worker/realtime-config";
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

test("delivery envelopes normalize signals and bound unique recipients", () => {
  const contaminatedSignal = {
    ...signals[0]!,
    bodyText: "never enters the hub",
  };
  assert.deepEqual(
    toRealtimeDeliveryEnvelope(contaminatedSignal, [
      "human-2",
      "human-1",
      "human-2",
    ]),
    {
      signal: {
        kind: "conversation",
        organizationId: "org-1",
        conversationId: "room-1",
        sequenceHint: 7,
      },
      recipients: ["human-2", "human-1"],
    },
  );
  assert.throws(
    () =>
      toRealtimeDeliveryEnvelope(
        signals[0]!,
        Array.from(
          { length: MAX_REALTIME_RECIPIENTS + 1 },
          (_, index) => `human-${index}`,
        ),
      ),
    (error) =>
      error instanceof RealtimeSignalError &&
      error.code === "realtime_invalid_recipients",
  );

  const maximumRecipients = Array.from(
    { length: MAX_REALTIME_RECIPIENTS },
    (_, index) =>
      `human-${index}-`.padEnd(128, String(index % 10)),
  );
  const maximumEnvelope = toRealtimeDeliveryEnvelope(
    signals[2]!,
    maximumRecipients,
  );
  assert.ok(
    new TextEncoder().encode(JSON.stringify(maximumEnvelope)).byteLength <=
      MAX_REALTIME_ENVELOPE_BYTES,
  );
  assert.throws(
    () =>
      assertRealtimeDeliveryEnvelope({
        signal: signals[0],
        recipients: ["human-1", "human-1"],
      }),
    (error) =>
      error instanceof RealtimeSignalError &&
      error.code === "realtime_invalid_recipients",
  );
});

test("Wrangler and Vite share the same realtime Durable Object contract", () => {
  const wranglerConfig = JSON.parse(
    readFileSync(
      new URL("../../wrangler.local.jsonc", import.meta.url),
      "utf8",
    ),
  );
  const realtimeConfig = realtimeDurableObjectConfig();
  assert.deepEqual(
    wranglerConfig.durable_objects,
    realtimeConfig.durable_objects,
  );
  assert.deepEqual(wranglerConfig.migrations, realtimeConfig.migrations);
});

test("realtime push fails closed to polling unless flag and binding exist", () => {
  assert.equal(isRealtimePushEnabled({}), false);
  assert.equal(
    isRealtimePushEnabled({
      NEXUS_REALTIME_PUSH: "on",
    }),
    false,
  );
  assert.equal(
    isRealtimePushEnabled({
      NEXUS_REALTIME_PUSH: "off",
      REALTIME_HUB: {},
    }),
    false,
  );
  assert.equal(
    isRealtimePushEnabled({
      NEXUS_REALTIME_PUSH: "on",
      REALTIME_HUB: {},
    }),
    true,
  );
});

test("WebSocket origin policy accepts native clients and same-origin browsers", () => {
  const requestUrl = "https://nexus.example/api/realtime/socket";
  assert.equal(isAllowedRealtimeOrigin(requestUrl, null), true);
  assert.equal(
    isAllowedRealtimeOrigin(requestUrl, "https://nexus.example"),
    true,
  );
  assert.equal(
    isAllowedRealtimeOrigin(requestUrl, "https://foreign.example"),
    false,
  );
  assert.equal(isAllowedRealtimeOrigin(requestUrl, "not-a-url"), false);
});

test("Durable Object adapter resolves recipients and emits a private envelope", async () => {
  let publishedBody: unknown;
  const namespace = {
    getByName(name: string) {
      assert.equal(name, "org-1");
      return {
        async fetch(_url: string, init: RequestInit) {
          publishedBody = JSON.parse(String(init.body));
          return new Response(null, { status: 202 });
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  const recipients: RealtimeRecipientResolver = {
    async resolve() {
      return ["human-2", "human-1", "human-2"];
    },
  };
  const adapter = new DurableObjectRealtimeNotifyPort(
    namespace,
    recipients,
  );
  await adapter.publish(signals[0]!);
  assert.deepEqual(publishedBody, {
    signal: signals[0],
    recipients: ["human-2", "human-1"],
  });
});

test("Durable Object adapter absorbs recipient and hub failures", async () => {
  const failures: string[] = [];
  const reportFailure = (failure: {
    stage: string;
  }) => failures.push(failure.stage);
  const rejectingRecipients: RealtimeRecipientResolver = {
    async resolve() {
      throw new Error("D1 unavailable");
    },
  };
  const unusedNamespace = {
    getByName() {
      assert.fail("hub must not be called after recipient failure");
    },
  } as unknown as DurableObjectNamespace;
  await new DurableObjectRealtimeNotifyPort(
    unusedNamespace,
    rejectingRecipients,
    reportFailure,
  ).publish(signals[0]!);

  const failingNamespace = {
    getByName() {
      return {
        async fetch() {
          return new Response(null, { status: 503 });
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  await new DurableObjectRealtimeNotifyPort(failingNamespace, {
    async resolve() {
      return ["human-1"];
    },
  }, reportFailure).publish(signals[0]!);
  assert.deepEqual(failures, ["recipient_resolution", "hub_delivery"]);

  await new DurableObjectRealtimeNotifyPort(
    failingNamespace,
    {
      async resolve() {
        return ["human-1"];
      },
    },
    () => {
      throw new Error("reporter unavailable");
    },
  ).publish({
    kind: "presence",
    organizationId: "..",
  });
});

test("Durable Object adapter chunks large authorized recipient sets", async () => {
  const envelopes: unknown[] = [];
  const namespace = {
    getByName() {
      return {
        async fetch(_url: string, init: RequestInit) {
          envelopes.push(JSON.parse(String(init.body)));
          return new Response(null, { status: 202 });
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  const recipientIds = Array.from(
    { length: MAX_REALTIME_RECIPIENTS + 1 },
    (_, index) => `human-${index}`,
  );
  await new DurableObjectRealtimeNotifyPort(namespace, {
    async resolve() {
      return recipientIds;
    },
  }).publish(signals[2]!);
  assert.deepEqual(
    envelopes.map((value) =>
      (value as { recipients: string[] }).recipients.length
    ),
    [MAX_REALTIME_RECIPIENTS, 1],
  );
});
