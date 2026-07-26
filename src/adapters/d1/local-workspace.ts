import { env } from "cloudflare:workers";
import { getD1 } from "@/db";
import {
  LOCAL_MESSAGE_INTEGRITY_KEY,
  messageIntegrityHash,
} from "@/src/domain/collaboration/integrity";
import { directConversationKey } from "@/src/domain/collaboration/conversation";

export const LOCAL_ORGANIZATION_ID = "org-local-aurora";
export const LOCAL_OWNER_ID = "principal-local-owner";
export const LOCAL_PROJECT_ID = "project-local-nexus";
export const LOCAL_AGENT_ID = "principal-local-atlas";
export const LOCAL_TEST_PEER_ID = "principal-local-test-peer";
export const LOCAL_TEST_OTHER_ORGANIZATION_ID = "org-local-test-other";
export const LOCAL_TEST_OTHER_OWNER_ID = "principal-local-test-other-owner";
export const LOCAL_AGENT_DEFINITION_ID = "agent-local-atlas";
export const LOCAL_CONNECTION_ID = "connection-local-claude-cli";
export const LOCAL_TEAM_ID = "team-local-checkout";
export const LOCAL_OBJECTIVE_ID = "objective-local-governed-delivery";
export const LOCAL_WORK_ITEM_ID = "work-local-persistent-graph";
export const LOCAL_DIRECT_CONVERSATION_ID = "conversation-local-owner-atlas";
export const LOCAL_ROOM_CONVERSATION_ID = "conversation-local-team-room";
export const LOCAL_HANDOFF_CONVERSATION_ID = "conversation-local-handoff";
export const LOCAL_TEST_ARCHIVED_CONVERSATION_ID =
  "conversation-local-test-archived";

export async function ensureLocalWorkspace(): Promise<void> {
  if (env.NEXUS_ALLOW_LOCAL_IDENTITY !== "1") {
    return;
  }
  const d1 = getD1();
  const seedComplete = await d1
    .prepare(
      `SELECT 1 FROM messages
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind("message-local-direct-1", LOCAL_ORGANIZATION_ID)
    .first();
  if (seedComplete) {
    if (env.NEXUS_ALLOW_TEST_IDENTITIES === "1") {
      await d1
        .prepare(
          `UPDATE memberships
           SET role = 'admin', updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND organization_id = ? AND role != 'admin'`,
        )
        .bind(
          "membership-local-test-peer",
          LOCAL_ORGANIZATION_ID,
        )
        .run();
    }
    return;
  }

  const directMessage =
    "Atlas, priorize o próximo small batch e sinalize qualquer decisão que precise de aprovação.";
  const roomMessage =
    "Sala operacional pronta. O trabalho ativo, as decisões e os handoffs ficam conectados ao contexto do projeto.";
  const handoffMessage =
    "Handoff aberto para revisar a experiência do Work Graph antes do próximo deploy.";
  const integrityKey =
    env.NEXUS_MESSAGE_INTEGRITY_KEY ?? LOCAL_MESSAGE_INTEGRITY_KEY;
  const [directHash, roomHash, handoffHash] = await Promise.all([
    messageIntegrityHash(
      integrityKey,
      LOCAL_ORGANIZATION_ID,
      "message-local-direct-1",
      directMessage,
    ),
    messageIntegrityHash(
      integrityKey,
      LOCAL_ORGANIZATION_ID,
      "message-local-room-1",
      roomMessage,
    ),
    messageIntegrityHash(
      integrityKey,
      LOCAL_ORGANIZATION_ID,
      "message-local-handoff-1",
      handoffMessage,
    ),
  ]);
  await d1.batch([
    d1
      .prepare(
        "INSERT OR IGNORE INTO organizations (id, slug, name) VALUES (?, ?, ?)",
      )
      .bind(LOCAL_ORGANIZATION_ID, "aurora-local", "Aurora Local"),
    d1
      .prepare(
        "INSERT OR IGNORE INTO principals (id, organization_id, kind, external_id, display_name) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        LOCAL_OWNER_ID,
        LOCAL_ORGANIZATION_ID,
        "human",
        "local:owner",
        "Local owner",
      ),
    d1
      .prepare(
        "INSERT OR IGNORE INTO principals (id, organization_id, kind, external_id, display_name) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        LOCAL_AGENT_ID,
        LOCAL_ORGANIZATION_ID,
        "agent",
        "local:atlas",
        "Atlas",
      ),
    d1
      .prepare(
        "INSERT OR IGNORE INTO principals (id, organization_id, kind, external_id, display_name) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        "nexus-effect-gateway",
        LOCAL_ORGANIZATION_ID,
        "automation",
        "system:effect-gateway",
        "Nexus effect gateway",
      ),
    d1
      .prepare(
        "INSERT OR IGNORE INTO memberships (id, organization_id, principal_id, role) VALUES (?, ?, ?, ?)",
      )
      .bind(
        "membership-local-owner",
        LOCAL_ORGANIZATION_ID,
        LOCAL_OWNER_ID,
        "owner",
      ),
    d1
      .prepare(
        "INSERT OR IGNORE INTO projects (id, organization_id, slug, name, objective) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        LOCAL_PROJECT_ID,
        LOCAL_ORGANIZATION_ID,
        "nexus-commerce",
        "Nexus Commerce",
        "Prove the governed execution spine end to end",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO model_connections (
          id, organization_id, provider, auth_method, label, status, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        LOCAL_CONNECTION_ID,
        LOCAL_ORGANIZATION_ID,
        "Anthropic",
        "cli",
        "Claude Code local",
        "disconnected",
        JSON.stringify({
          cliPath: "claude",
          poolLabel: "local-shell",
        }),
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO teams (
          id, organization_id, project_id, slug, name, mission
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        LOCAL_TEAM_ID,
        LOCAL_ORGANIZATION_ID,
        LOCAL_PROJECT_ID,
        "checkout-evolution",
        "Checkout Evolution",
        "Operate the governed NexusOS delivery loop",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO agent_definitions (
          id, organization_id, principal_id, connection_id, slug, name, role,
          model, memory_scope, autonomy_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        LOCAL_AGENT_DEFINITION_ID,
        LOCAL_ORGANIZATION_ID,
        LOCAL_AGENT_ID,
        LOCAL_CONNECTION_ID,
        "atlas",
        "Atlas",
        "Engineering Lead",
        "Claude Opus",
        "project",
        "A2",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO team_members (
          id, organization_id, team_id, principal_id, assignment_role
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        "team-member-local-owner",
        LOCAL_ORGANIZATION_ID,
        LOCAL_TEAM_ID,
        LOCAL_OWNER_ID,
        "Accountable owner",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO team_members (
          id, organization_id, team_id, principal_id, assignment_role
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        "team-member-local-atlas",
        LOCAL_ORGANIZATION_ID,
        LOCAL_TEAM_ID,
        LOCAL_AGENT_ID,
        "Engineering Lead",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO objectives (
          id, organization_id, project_id, ref, title, description, status,
          priority
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        LOCAL_OBJECTIVE_ID,
        LOCAL_ORGANIZATION_ID,
        LOCAL_PROJECT_ID,
        "OBJ-A11CE001",
        "Tornar o NexusOS um operating system agentic confiável",
        "Entregar o caminho persistente de projeto até trabalho governado.",
        "active",
        "p0",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO work_items (
          id, organization_id, project_id, objective_id, ref, kind, title,
          description, status, priority, assignee_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        LOCAL_WORK_ITEM_ID,
        LOCAL_ORGANIZATION_ID,
        LOCAL_PROJECT_ID,
        LOCAL_OBJECTIVE_ID,
        "WI-A11CE001",
        "story",
        "Conectar o Work Graph persistente à experiência de projeto",
        "Substituir o kanban demonstrativo pelo lifecycle real do NexusOS.",
        "in_progress",
        "p0",
        LOCAL_AGENT_ID,
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO conversations (
          id, organization_id, project_id, created_by, kind, direct_key, title
        ) VALUES (?, ?, ?, ?, 'direct', ?, ?)`,
      )
      .bind(
        LOCAL_DIRECT_CONVERSATION_ID,
        LOCAL_ORGANIZATION_ID,
        LOCAL_PROJECT_ID,
        LOCAL_OWNER_ID,
        directConversationKey([LOCAL_OWNER_ID, LOCAL_AGENT_ID]),
        "Atlas",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO conversations (
          id, organization_id, project_id, team_id, created_by, kind, title
        ) VALUES (?, ?, ?, ?, ?, 'room', ?)`,
      )
      .bind(
        LOCAL_ROOM_CONVERSATION_ID,
        LOCAL_ORGANIZATION_ID,
        LOCAL_PROJECT_ID,
        LOCAL_TEAM_ID,
        LOCAL_OWNER_ID,
        "Checkout Evolution · Sala operacional",
      ),
    d1
      .prepare(
        `INSERT OR IGNORE INTO conversations (
          id, organization_id, project_id, team_id, work_item_id, created_by,
          kind, title
        ) VALUES (?, ?, ?, ?, ?, ?, 'handoff', ?)`,
      )
      .bind(
        LOCAL_HANDOFF_CONVERSATION_ID,
        LOCAL_ORGANIZATION_ID,
        LOCAL_PROJECT_ID,
        LOCAL_TEAM_ID,
        LOCAL_WORK_ITEM_ID,
        LOCAL_OWNER_ID,
        "Handoff · Work Graph",
      ),
    ...[
      LOCAL_DIRECT_CONVERSATION_ID,
      LOCAL_ROOM_CONVERSATION_ID,
      LOCAL_HANDOFF_CONVERSATION_ID,
    ].flatMap((conversationId) => [
      d1
        .prepare(
          `INSERT OR IGNORE INTO conversation_members (
            id, organization_id, conversation_id, principal_id, role
          ) VALUES (?, ?, ?, ?, 'owner')`,
        )
        .bind(
          `member-${conversationId}-owner`,
          LOCAL_ORGANIZATION_ID,
          conversationId,
          LOCAL_OWNER_ID,
        ),
      d1
        .prepare(
          `INSERT OR IGNORE INTO conversation_members (
            id, organization_id, conversation_id, principal_id, role
          ) VALUES (?, ?, ?, ?, 'member')`,
        )
        .bind(
          `member-${conversationId}-atlas`,
          LOCAL_ORGANIZATION_ID,
          conversationId,
          LOCAL_AGENT_ID,
        ),
    ]),
    ...[
      {
        conversationId: LOCAL_DIRECT_CONVERSATION_ID,
        payloadId: "payload-local-direct-1",
        messageId: "message-local-direct-1",
        body: directMessage,
        hash: directHash,
      },
      {
        conversationId: LOCAL_ROOM_CONVERSATION_ID,
        payloadId: "payload-local-room-1",
        messageId: "message-local-room-1",
        body: roomMessage,
        hash: roomHash,
      },
      {
        conversationId: LOCAL_HANDOFF_CONVERSATION_ID,
        payloadId: "payload-local-handoff-1",
        messageId: "message-local-handoff-1",
        body: handoffMessage,
        hash: handoffHash,
      },
    ].flatMap((message) => [
      d1
        .prepare(
          `INSERT OR IGNORE INTO message_payloads (
            id, organization_id, body_text
          ) VALUES (?, ?, ?)`,
        )
        .bind(
          message.payloadId,
          LOCAL_ORGANIZATION_ID,
          message.body,
        ),
      d1
        .prepare(
          `INSERT INTO messages (
            id, organization_id, conversation_id, sender_id, content_ref,
            content_hash, sequence, kind
          )
          SELECT ?, ?, ?, ?, ?, ?, 1, 'text'
          WHERE NOT EXISTS (
            SELECT 1 FROM messages
            WHERE id = ? AND organization_id = ?
          )`,
        )
        .bind(
          message.messageId,
          LOCAL_ORGANIZATION_ID,
          message.conversationId,
          LOCAL_OWNER_ID,
          message.payloadId,
          message.hash,
          message.messageId,
          LOCAL_ORGANIZATION_ID,
        ),
    ]),
    d1
      .prepare(
        `UPDATE conversations
         SET next_sequence = COALESCE(
           (
             SELECT MAX(sequence) + 1
             FROM messages
             WHERE conversation_id = conversations.id
               AND organization_id = conversations.organization_id
           ),
           1
         )
         WHERE id IN (?, ?, ?) AND organization_id = ?`,
      )
      .bind(
        LOCAL_DIRECT_CONVERSATION_ID,
        LOCAL_ROOM_CONVERSATION_ID,
        LOCAL_HANDOFF_CONVERSATION_ID,
        LOCAL_ORGANIZATION_ID,
      ),
  ]);

  if (env.NEXUS_ALLOW_TEST_IDENTITIES === "1") {
    await d1.batch([
      d1
        .prepare(
          "INSERT OR IGNORE INTO principals (id, organization_id, kind, external_id, display_name) VALUES (?, ?, 'human', ?, ?)",
        )
        .bind(
          LOCAL_TEST_PEER_ID,
          LOCAL_ORGANIZATION_ID,
          "local:test-peer",
          "Integration peer",
        ),
      d1
        .prepare(
          "INSERT OR IGNORE INTO principals (id, organization_id, kind, external_id, display_name) VALUES (?, ?, 'human', ?, ?)",
        )
        .bind(
          "principal-local-test-no-membership",
          LOCAL_ORGANIZATION_ID,
          "local:test-no-membership",
          "Revoked integration human",
        ),
      d1
        .prepare(
          "INSERT OR IGNORE INTO memberships (id, organization_id, principal_id, role) VALUES (?, ?, ?, 'admin')",
        )
        .bind(
          "membership-local-test-peer",
          LOCAL_ORGANIZATION_ID,
          LOCAL_TEST_PEER_ID,
        ),
      d1
        .prepare(
          "INSERT OR IGNORE INTO organizations (id, slug, name) VALUES (?, ?, ?)",
        )
        .bind(
          LOCAL_TEST_OTHER_ORGANIZATION_ID,
          "test-other",
          "Other integration tenant",
        ),
      d1
        .prepare(
          "INSERT OR IGNORE INTO principals (id, organization_id, kind, external_id, display_name) VALUES (?, ?, 'human', ?, ?)",
        )
        .bind(
          LOCAL_TEST_OTHER_OWNER_ID,
          LOCAL_TEST_OTHER_ORGANIZATION_ID,
          "local:test-other-owner",
          "Other integration owner",
        ),
      d1
        .prepare(
          "INSERT OR IGNORE INTO memberships (id, organization_id, principal_id, role) VALUES (?, ?, ?, 'owner')",
        )
        .bind(
          "membership-local-test-other-owner",
          LOCAL_TEST_OTHER_ORGANIZATION_ID,
          LOCAL_TEST_OTHER_OWNER_ID,
        ),
      d1
        .prepare(
          `INSERT OR IGNORE INTO conversation_members (
            id, organization_id, conversation_id, principal_id, role
          ) VALUES (?, ?, ?, ?, 'observer')`,
        )
        .bind(
          "member-local-room-test-observer",
          LOCAL_ORGANIZATION_ID,
          LOCAL_ROOM_CONVERSATION_ID,
          LOCAL_TEST_PEER_ID,
        ),
      d1
        .prepare(
          `INSERT OR IGNORE INTO conversations (
            id, organization_id, project_id, created_by, kind, title, status
          ) VALUES (?, ?, ?, ?, 'room', ?, 'archived')`,
        )
        .bind(
          LOCAL_TEST_ARCHIVED_CONVERSATION_ID,
          LOCAL_ORGANIZATION_ID,
          LOCAL_PROJECT_ID,
          LOCAL_OWNER_ID,
          "Archived integration room",
        ),
      d1
        .prepare(
          `INSERT OR IGNORE INTO conversation_members (
            id, organization_id, conversation_id, principal_id, role
          ) VALUES (?, ?, ?, ?, 'owner')`,
        )
        .bind(
          "member-local-archived-owner",
          LOCAL_ORGANIZATION_ID,
          LOCAL_TEST_ARCHIVED_CONVERSATION_ID,
          LOCAL_OWNER_ID,
        ),
    ]);
  }
}
