import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  actionLabel,
  mergeAttentionRefresh,
  PersistentAttentionView,
} from "../../app/attention-view";
import type { AttentionItem } from "../../src/contracts/attention";

test("labels the persistent attention UI honestly", () => {
  const html = renderToStaticMarkup(
    createElement(PersistentAttentionView, {
      onGovernance: () => undefined,
      notify: () => undefined,
    }),
  );

  assert.match(html, /ATTENTION SYSTEM · REAL/);
  assert.match(html, /Decisões continuam exclusivas do fluxo governado/);
  assert.match(html, /Carregando fila governada/);
  assert.doesNotMatch(html, /Aprovar rollout/);
  assert.doesNotMatch(html, /Rejeitar/);
  assert.doesNotMatch(html, /94%/);
});

test("turns a governed action type into a readable label", () => {
  assert.equal(
    actionLabel("nexus.simulator.publish_summary"),
    "Publicar próximo batch governado",
  );
  assert.equal(actionLabel("github.pull_request.merge"), "Pull request merge");
});

test("poll refresh preserves cursor-loaded pages until the queue fits one page", () => {
  const first = attentionItem("first", "2026-07-25T12:00:03.000Z");
  const boundary = attentionItem("boundary", "2026-07-25T12:00:02.000Z");
  const deeper = attentionItem("deeper", "2026-07-25T12:00:01.000Z");

  assert.deepEqual(
    mergeAttentionRefresh(
      [first, boundary, deeper],
      [{ ...first, status: "seen" }, boundary],
      true,
    ).map((item) => [item.id, item.status]),
    [
      ["first", "seen"],
      ["boundary", "open"],
      ["deeper", "open"],
    ],
  );
  assert.deepEqual(
    mergeAttentionRefresh([first, boundary, deeper], [first, boundary], false)
      .map((item) => item.id),
    ["first", "boundary"],
  );
  assert.deepEqual(
    mergeAttentionRefresh(
      [first, boundary, deeper],
      [first, boundary],
      true,
      2,
    ).map((item) => item.id),
    ["first", "boundary"],
    "a smaller server total discards stale deeper pages",
  );
});

function attentionItem(id: string, createdAt: string): AttentionItem {
  return {
    id,
    kind: "intent_awaiting_approval",
    status: "open",
    version: 1,
    createdAt,
    seenAt: null,
    intent: {
      id: `intent-${id}`,
      actionType: "nexus.simulator.publish_summary",
      targetRef: "nexus:simulator:v1",
      parametersHash: "a".repeat(64),
      riskTier: "medium",
      status: "proposed",
      expiresAt: "2099-01-01T00:00:00.000Z",
      projectId: "project-1",
      projectName: "Nexus Commerce",
      proposerId: "agent-1",
      proposerName: "Atlas",
    },
  };
}
