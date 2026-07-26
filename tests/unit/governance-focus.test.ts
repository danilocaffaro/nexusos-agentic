import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("solo-owner UI discloses the commit-time peer guard", () => {
  const source = readFileSync(
    new URL("../../app/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /ausência de um peer será verificada novamente/i);
  assert.match(source, /solo_owner_peer_exists/);
  assert.match(source, /autoaprovação foi bloqueada/i);
});
