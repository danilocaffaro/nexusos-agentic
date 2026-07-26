import assert from "node:assert/strict";
import test from "node:test";
import { buildPresenceSessionPayload } from "../../app/presence-client";

const base = {
  sessionKey: "presence-client-session-1",
  status: "focus" as const,
  roomConversationId: "room-1",
};

test("ordinary presence writes can never imply takeover", () => {
  assert.deepEqual(
    buildPresenceSessionPayload({
      ...base,
      fencingToken: null,
      takeover: false,
    }),
    base,
  );
  assert.deepEqual(
    buildPresenceSessionPayload({
      ...base,
      fencingToken: 7,
      takeover: false,
    }),
    { ...base, fencingToken: 7 },
  );
});

test("only the explicit takeover path emits takeover and drops stale fencing", () => {
  assert.deepEqual(
    buildPresenceSessionPayload({
      ...base,
      fencingToken: 7,
      takeover: true,
    }),
    { ...base, takeover: true },
  );
});
