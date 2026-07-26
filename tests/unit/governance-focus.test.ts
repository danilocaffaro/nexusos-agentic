import assert from "node:assert/strict";
import test from "node:test";
import { selectGovernanceIntent } from "../../src/domain/governance/focus";

test("a missing governance focus never falls back to another intent", () => {
  const intents = [{ id: "intent-newest" }, { id: "intent-older" }];

  assert.equal(
    selectGovernanceIntent(intents, "intent-missing"),
    undefined,
  );
  assert.equal(
    selectGovernanceIntent(intents, "intent-older")?.id,
    "intent-older",
  );
  assert.equal(
    selectGovernanceIntent(intents, "")?.id,
    "intent-newest",
  );
});
