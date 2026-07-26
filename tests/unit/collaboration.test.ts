import assert from "node:assert/strict";
import test from "node:test";
import { directConversationKey } from "../../src/domain/collaboration/conversation";
import { messageIntegrityHash } from "../../src/domain/collaboration/integrity";
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
