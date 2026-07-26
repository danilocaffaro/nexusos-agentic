import assert from "node:assert/strict";
import test from "node:test";
import {
  occupantsForRoom,
  presenceInitials,
  summarizePresence,
} from "../../app/presence-view-model";
import type { PresenceRoster } from "../../src/contracts/presence";

const roster: PresenceRoster = {
  generatedAtEpoch: 100,
  entries: [
    {
      principalId: "human-1",
      displayName: "Rafael Caffaro",
      principalKind: "human",
      status: "available",
      room: { conversationId: "room-1", title: "Delivery" },
    },
    {
      principalId: "agent-1",
      displayName: "Atlas",
      principalKind: "agent",
      status: "focus",
      room: { conversationId: "room-1", title: "Delivery" },
    },
    {
      principalId: "human-2",
      displayName: "Camila",
      principalKind: "human",
      status: "dnd",
      room: null,
    },
    {
      principalId: "agent-2",
      displayName: "Forge",
      principalKind: "agent",
      status: "offline",
      room: null,
    },
  ],
};

test("summarizes only live, privacy-safe presence", () => {
  assert.deepEqual(summarizePresence(roster), {
    online: 3,
    humans: 2,
    agents: 1,
    activeRooms: 1,
    protectedFocus: 2,
  });
  assert.deepEqual(
    occupantsForRoom(roster, "room-1").map((entry) => entry.principalId),
    ["human-1", "agent-1"],
  );
});

test("builds compact, deterministic presence initials", () => {
  assert.equal(presenceInitials("Rafael Caffaro"), "RC");
  assert.equal(presenceInitials("Atlas"), "A");
});
