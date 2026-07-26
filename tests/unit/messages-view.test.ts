import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  conversationIdForMode,
  mergeMessages,
  PersistentMessagesView,
} from "../../app/messages-view";
import type { ConversationMessage } from "../../src/contracts/collaboration";

test("labels the persistent collaboration UI honestly", () => {
  const html = renderToStaticMarkup(
    createElement(PersistentMessagesView, {
      onProject: () => undefined,
      onOutput: () => undefined,
      notify: () => undefined,
      drafts: {},
      onDraftChange: () => undefined,
      workspace: {
        projects: [],
        teams: [],
        agents: [],
        workItems: [],
      },
    }),
  );

  assert.match(html, /COLLABORATION FABRIC · REAL/);
  assert.match(html, /DMs, salas e handoffs persistentes/);
  assert.match(html, /Nova conversa/);
  assert.match(html, /Selecione ou crie uma conversa/);
  assert.doesNotMatch(html, /PR #482 está pronto para revisão/);
});

test("never falls back to a conversation from another mode", () => {
  const conversations = [
    { id: "dm-1", kind: "direct" as const },
    { id: "room-1", kind: "room" as const },
  ];

  assert.equal(conversationIdForMode(conversations, "handoff", "dm-1"), "");
  assert.equal(conversationIdForMode(conversations, "room", "dm-1"), "room-1");
  assert.equal(
    conversationIdForMode(conversations, "direct", "dm-1"),
    "dm-1",
  );
});

test("message merge is stable when polling returns no changes", () => {
  const first = message({ id: "message-1", sequence: 1 });
  const second = message({ id: "message-2", sequence: 2 });
  const current = [first, second];

  assert.equal(mergeMessages(current, []), current);
  assert.deepEqual(mergeMessages([second], [first]), [first, second]);
  assert.deepEqual(
    mergeMessages([first], [second]),
    [first, second],
    "a resposta atrasada do snapshot deve preservar a mensagem local mais nova",
  );
  assert.equal(mergeMessages(current, [{ ...second }]), current);
});

function message(
  overrides: Pick<ConversationMessage, "id" | "sequence">,
): ConversationMessage {
  return {
    conversationId: "conversation-1",
    senderId: "principal-1",
    senderName: "Atlas",
    senderKind: "agent",
    contentHash: `hash-${overrides.id}`,
    kind: "text",
    bodyText: overrides.id,
    erased: false,
    createdAt: "2026-07-25T12:00:00.000Z",
    ...overrides,
  };
}
