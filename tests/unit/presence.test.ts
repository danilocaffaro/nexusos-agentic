import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPresenceSessionKey,
  assertPresenceStatus,
  canRevealPresenceRoom,
  computePresenceExpiry,
  decidePresenceLease,
  decidePresenceRelease,
  derivePresenceStatus,
  PresenceValidationError,
  resolvePublishablePresenceRoom,
} from "../../src/domain/presence";

test("presence claims, renews and fences stale sessions", () => {
  const current = {
    sessionKey: "session-current-1234",
    fencingToken: 7,
    expiresAtEpoch: 200,
  };

  assert.deepEqual(
    decidePresenceLease({
      current: null,
      sessionKey: "session-first-12345",
      nowEpoch: 100,
    }),
    {
      kind: "claim",
      fencingToken: 1,
      expiresAtEpoch: 160,
      expectedFencingToken: null,
      expectedSessionKey: null,
    },
  );
  assert.deepEqual(
    decidePresenceLease({
      current,
      sessionKey: current.sessionKey,
      fencingToken: 7,
      nowEpoch: 100,
    }),
    {
      kind: "renew",
      fencingToken: 7,
      expiresAtEpoch: 160,
      expectedFencingToken: 7,
      expectedSessionKey: "session-current-1234",
    },
  );
  assert.deepEqual(
    decidePresenceLease({
      current,
      sessionKey: "session-new-tab-1234",
      nowEpoch: 100,
    }),
    { kind: "reject", reason: "presence_stale_session" },
  );
  assert.deepEqual(
    decidePresenceLease({
      current,
      sessionKey: "session-new-tab-1234",
      takeover: true,
      nowEpoch: 100,
    }),
    {
      kind: "claim",
      fencingToken: 8,
      expiresAtEpoch: 160,
      expectedFencingToken: 7,
      expectedSessionKey: "session-current-1234",
    },
  );
  assert.deepEqual(
    decidePresenceLease({
      current,
      sessionKey: "session-stale-12345",
      fencingToken: 6,
      nowEpoch: 100,
    }),
    { kind: "reject", reason: "presence_stale_session" },
  );
});

test("an expired lease is replaced with a higher fence", () => {
  assert.deepEqual(
    decidePresenceLease({
      current: {
        sessionKey: "session-expired-123",
        fencingToken: 3,
        expiresAtEpoch: 100,
      },
      sessionKey: "session-returning-1",
      fencingToken: 3,
      nowEpoch: 100,
    }),
    {
      kind: "claim",
      fencingToken: 4,
      expiresAtEpoch: 160,
      expectedFencingToken: 3,
      expectedSessionKey: "session-expired-123",
    },
  );
});

test("offline is derived without exposing a stale room", () => {
  assert.equal(
    derivePresenceStatus({
      status: "focus",
      expiresAtEpoch: 100,
      nowEpoch: 100,
    }),
    "offline",
  );
  assert.equal(
    canRevealPresenceRoom({
      displayStatus: "offline",
      roomConversationId: "room-1",
      roomStatus: "active",
      subjectMembershipStatus: "active",
      observerMembershipStatus: "active",
    }),
    false,
  );
  assert.equal(
    canRevealPresenceRoom({
      displayStatus: "available",
      roomConversationId: "room-1",
      roomStatus: "active",
      subjectMembershipStatus: "active",
      observerMembershipStatus: "active",
    }),
    true,
  );
  assert.equal(
    canRevealPresenceRoom({
      displayStatus: "available",
      roomConversationId: "room-1",
      roomStatus: "active",
      subjectMembershipStatus: "active",
      observerMembershipStatus: "removed",
    }),
    false,
  );
  assert.equal(
    canRevealPresenceRoom({
      displayStatus: "available",
      roomConversationId: "room-1",
      roomStatus: "active",
      subjectMembershipStatus: "removed",
      observerMembershipStatus: "active",
    }),
    false,
  );
});

test("only active room memberships are publishable", () => {
  assert.deepEqual(
    resolvePublishablePresenceRoom({
      roomConversationId: "room-1",
      conversationKind: "room",
      conversationStatus: "active",
      membershipStatus: "active",
    }),
    { roomConversationId: "room-1", roomCleared: false },
  );
  assert.deepEqual(
    resolvePublishablePresenceRoom({
      roomConversationId: "room-1",
      conversationKind: "room",
      conversationStatus: "archived",
      membershipStatus: "active",
    }),
    { roomConversationId: null, roomCleared: true },
  );
  for (const conversationKind of ["direct", "handoff"] as const) {
    assert.throws(
      () =>
        resolvePublishablePresenceRoom({
          roomConversationId: "private-conversation",
          conversationKind,
          conversationStatus: "active",
          membershipStatus: "active",
        }),
      (error) =>
        error instanceof PresenceValidationError &&
        error.code === "presence_invalid_room",
    );
  }
});

test("presence release is fenced and expiry is server bounded", () => {
  const current = {
    sessionKey: "session-current-1234",
    fencingToken: 7,
    expiresAtEpoch: 200,
  };
  assert.deepEqual(
    decidePresenceRelease({
      current,
      sessionKey: current.sessionKey,
      fencingToken: 7,
    }),
    {
      kind: "release",
      expectedFencingToken: 7,
      expectedSessionKey: current.sessionKey,
    },
  );
  assert.deepEqual(
    decidePresenceRelease({
      current,
      sessionKey: "session-stale-12345",
      fencingToken: 6,
    }),
    { kind: "reject", reason: "presence_stale_session" },
  );
  assert.equal(computePresenceExpiry(100, 60), 160);
  assert.throws(() => computePresenceExpiry(100, 301));
});

test("presence status and opaque session keys are validated", () => {
  assert.doesNotThrow(() => assertPresenceStatus("dnd"));
  assert.throws(
    () => assertPresenceStatus("offline"),
    (error) =>
      error instanceof PresenceValidationError &&
      error.code === "presence_invalid_status",
  );
  assert.doesNotThrow(() => assertPresenceSessionKey("opaque_session_123"));
  assert.throws(
    () => assertPresenceSessionKey("short"),
    (error) =>
      error instanceof PresenceValidationError &&
      error.code === "presence_invalid_session",
  );
});
