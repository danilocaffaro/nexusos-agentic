import assert from "node:assert/strict";
import test from "node:test";
import { directConversationKey } from "../../src/domain/collaboration/conversation";
import { messageIntegrityHash } from "../../src/domain/collaboration/integrity";
import {
  assertCanAddConversationMember,
  assertCanChangeConversationMember,
  assertCanPinConversationMessage,
  assertCanUnpinConversationMessage,
  ConversationLifecycleError,
} from "../../src/domain/collaboration/membership";
import { sha256Hex } from "../../src/domain/governance/crypto";

test("direct conversation keys are canonical and duplicate-free", () => {
  assert.equal(
    directConversationKey(["principal-b", "principal-a", "principal-a"]),
    "principal-a:principal-b",
  );
});

test("message integrity hashes are keyed and context-bound", async () => {
  const secret = "unit-test-secret-with-enough-entropy";
  const body = "Approved";
  const first = await messageIntegrityHash(
    secret,
    "org-a",
    "message-a",
    body,
  );
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, await sha256Hex(body));
  assert.notEqual(
    first,
    await messageIntegrityHash(secret, "org-b", "message-a", body),
  );
  assert.notEqual(
    first,
    await messageIntegrityHash(secret, "org-a", "message-b", body),
  );
});

test("direct membership is immutable and archived rooms fail closed", () => {
  assert.throws(
    () =>
      assertCanAddConversationMember({
        kind: "direct",
        conversationStatus: "active",
        actorRole: "owner",
      }),
    (error) =>
      error instanceof ConversationLifecycleError &&
      error.code === "direct_membership_immutable",
  );
  assert.throws(
    () =>
      assertCanAddConversationMember({
        kind: "room",
        conversationStatus: "archived",
        actorRole: "owner",
      }),
    (error) =>
      error instanceof ConversationLifecycleError &&
      error.code === "conversation_archived",
  );
});

test("the final active conversation owner cannot leave or be demoted", () => {
  assert.throws(
    () =>
      assertCanChangeConversationMember({
        kind: "room",
        conversationStatus: "active",
        actorRole: "owner",
        actorId: "owner-a",
        targetId: "owner-a",
        targetRole: "owner",
        targetStatus: "active",
        nextRole: "owner",
        nextStatus: "left",
        activeOwnerCount: 1,
      }),
    (error) =>
      error instanceof ConversationLifecycleError &&
      error.code === "conversation_requires_owner",
  );
  assert.doesNotThrow(() =>
    assertCanChangeConversationMember({
      kind: "room",
      conversationStatus: "active",
      actorRole: "owner",
      actorId: "owner-a",
      targetId: "owner-a",
      targetRole: "owner",
      targetStatus: "active",
      nextRole: "owner",
      nextStatus: "left",
      activeOwnerCount: 2,
    }),
  );
});

test("members can pin, while observers cannot and only owners can unpin others", () => {
  assert.doesNotThrow(() =>
    assertCanPinConversationMessage({
      conversationStatus: "active",
      actorRole: "member",
    }),
  );
  assert.throws(
    () =>
      assertCanPinConversationMessage({
        conversationStatus: "active",
        actorRole: "observer",
      }),
    (error) =>
      error instanceof ConversationLifecycleError &&
      error.code === "conversation_read_only",
  );
  assert.throws(
    () =>
      assertCanUnpinConversationMessage({
        conversationStatus: "active",
        actorRole: "member",
        actorId: "member-a",
        pinnedBy: "member-b",
      }),
    (error) =>
      error instanceof ConversationLifecycleError &&
      error.code === "conversation_owner_required",
  );
  assert.throws(
    () =>
      assertCanUnpinConversationMessage({
        conversationStatus: "active",
        actorRole: "observer",
        actorId: "observer-a",
        pinnedBy: "observer-a",
      }),
    (error) =>
      error instanceof ConversationLifecycleError &&
      error.code === "conversation_read_only",
  );
});
