import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCanMarkAttentionSeen,
  AttentionTransitionError,
} from "../../src/domain/attention";

test("only open attention can transition to seen", () => {
  assert.doesNotThrow(() => assertCanMarkAttentionSeen("open"));
  assert.throws(
    () => assertCanMarkAttentionSeen("seen"),
    (error: unknown) =>
      error instanceof AttentionTransitionError &&
      error.code === "attention_already_seen",
  );
});
