import { env } from "cloudflare:workers";
import { getD1 } from "@/db";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  CONVERSATION_KINDS,
  type ConversationKind,
  type ConversationMember,
  type ConversationMessage,
  type ConversationSummary,
} from "@/src/contracts/collaboration";
import {
  LOCAL_MESSAGE_INTEGRITY_KEY,
  messageIntegrityHash,
} from "@/src/domain/collaboration/integrity";
import { directConversationKey } from "@/src/domain/collaboration/conversation";
import {
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "./workspace-repository";
import { scheduleRealtimeSignal } from "../realtime/publish-realtime-signal";

type JsonRecord = Record<string, unknown>;

export async function listConversations(
  identity: RequestIdentity,
): Promise<{ conversations: ConversationSummary[] }> {
  await requireWorkspaceMember(identity);
  const d1 = getD1();
  const [conversationResult, memberResult] = await Promise.all([
    d1
      .prepare(
        `SELECT
           c.id, c.project_id, c.team_id, c.work_item_id, c.intent_id,
           c.kind, c.title, c.status, c.version, c.created_at, c.updated_at,
           viewer.role AS current_role,
           latest.sequence AS latest_sequence,
           latest.sender_id AS latest_sender_id,
           latest.created_at AS latest_created_at,
           payload.body_text AS latest_body_text,
           payload.erased_at AS latest_erased_at
         FROM conversations c
         INNER JOIN conversation_members viewer
           ON viewer.conversation_id = c.id
          AND viewer.organization_id = c.organization_id
          AND viewer.principal_id = ?
          AND viewer.status = 'active'
         LEFT JOIN messages latest
           ON latest.id = (
             SELECT candidate.id
             FROM messages candidate
             WHERE candidate.conversation_id = c.id
               AND candidate.organization_id = c.organization_id
             ORDER BY candidate.sequence DESC
             LIMIT 1
           )
         LEFT JOIN message_payloads payload
           ON payload.id = latest.content_ref
          AND payload.organization_id = c.organization_id
         WHERE c.organization_id = ?
         ORDER BY COALESCE(latest.created_at, c.updated_at) DESC, c.id`,
      )
      .bind(identity.id, identity.organizationId)
      .all<ConversationRow>(),
    d1
      .prepare(
         `SELECT
           member.conversation_id, member.principal_id, member.role,
           member.status, member.version, member.joined_at, member.left_at,
           principal.display_name, principal.kind
         FROM conversation_members member
         INNER JOIN principals principal
           ON principal.id = member.principal_id
          AND principal.organization_id = member.organization_id
         WHERE member.organization_id = ?
           AND EXISTS (
             SELECT 1
             FROM conversation_members viewer
             WHERE viewer.conversation_id = member.conversation_id
               AND viewer.organization_id = member.organization_id
               AND viewer.principal_id = ?
               AND viewer.status = 'active'
           )
         ORDER BY member.joined_at, member.id`,
      )
      .bind(identity.organizationId, identity.id)
      .all<MemberRow>(),
  ]);

  const membersByConversation = new Map<string, ConversationMember[]>();
  for (const member of memberResult.results) {
    const members = membersByConversation.get(member.conversation_id) ?? [];
    members.push({
      principalId: member.principal_id,
      displayName: member.display_name,
      principalKind: member.kind,
      role: member.role,
      status: member.status,
      version: member.version,
      joinedAt: member.joined_at,
      leftAt: member.left_at,
    });
    membersByConversation.set(member.conversation_id, members);
  }

  return {
    conversations: conversationResult.results.map((conversation) => ({
      id: conversation.id,
      projectId: conversation.project_id,
      teamId: conversation.team_id,
      workItemId: conversation.work_item_id,
      intentId: conversation.intent_id,
      kind: conversation.kind,
      title: conversation.title,
      status: conversation.status,
      version: conversation.version,
      currentPrincipalId: identity.id,
      currentRole: conversation.current_role,
      createdAt: conversation.created_at,
      updatedAt: conversation.updated_at,
      latestMessage:
        conversation.latest_sequence === null
          ? null
          : {
              sequence: conversation.latest_sequence,
              senderId: conversation.latest_sender_id!,
              bodyText:
                conversation.latest_erased_at === null
                  ? conversation.latest_body_text
                  : null,
              erased: conversation.latest_erased_at !== null,
              createdAt: conversation.latest_created_at!,
            },
      members: membersByConversation.get(conversation.id) ?? [],
    })),
  };
}

export async function createConversation(
  identity: RequestIdentity,
  input: JsonRecord,
): Promise<ConversationSummary> {
  await requireWorkspaceMember(identity);
  const kind = requiredEnum(input.kind, CONVERSATION_KINDS);
  const memberIds = requiredMemberIds(input.memberIds, identity.id);
  if (kind === "direct" && memberIds.length !== 2) {
    throw new WorkspaceRepositoryError("direct_requires_two_members", 400);
  }
  if (memberIds.length < 2) {
    throw new WorkspaceRepositoryError("conversation_requires_members", 400);
  }

  const projectId = optionalId(input.projectId, "projectId");
  const teamId = optionalId(input.teamId, "teamId");
  const workItemId = optionalId(input.workItemId, "workItemId");
  const intentId = optionalId(input.intentId, "intentId");
  await requireConversationReferences(identity.organizationId, {
    projectId,
    teamId,
    workItemId,
    intentId,
    memberIds,
  });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = requiredText(input.title, "title", 160);
  const directKey =
    kind === "direct" ? directConversationKey(memberIds) : null;
  const d1 = getD1();
  const statements: D1PreparedStatement[] = [
    d1
      .prepare(
        `INSERT INTO conversations (
           id, organization_id, project_id, team_id, work_item_id, intent_id,
           created_by, kind, direct_key, title, status, version,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      )
      .bind(
        id,
        identity.organizationId,
        projectId,
        teamId,
        workItemId,
        intentId,
        identity.id,
        kind,
        directKey,
        title,
        now,
        now,
      ),
  ];
  for (const principalId of memberIds) {
    statements.push(
      d1
        .prepare(
          `INSERT INTO conversation_members (
             id, organization_id, conversation_id, principal_id, role,
             status, version, joined_at
           ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          identity.organizationId,
          id,
          principalId,
          principalId === identity.id ? "owner" : "member",
          now,
        ),
    );
  }
  await executeBatch(statements, "duplicate_conversation");

  const listed = await listConversations(identity);
  const created = listed.conversations.find(
    (conversation) => conversation.id === id,
  );
  if (!created) {
    throw new Error("Created conversation was not visible to its owner");
  }
  return created;
}

export async function listMessages(
  identity: RequestIdentity,
  conversationId: string,
  afterSequence: number,
): Promise<{ messages: ConversationMessage[]; nextSequence: number }> {
  await requireWorkspaceMember(identity);
  await requireConversationMember(identity, conversationId, false);
  const result = await getD1()
    .prepare(
      `SELECT
         message.id, message.conversation_id, message.sender_id,
         message.content_hash, message.sequence, message.kind,
         message.created_at, payload.body_text, payload.erased_at,
         sender.display_name AS sender_name, sender.kind AS sender_kind
       FROM messages message
       INNER JOIN principals sender
         ON sender.id = message.sender_id
        AND sender.organization_id = message.organization_id
       LEFT JOIN message_payloads payload
         ON payload.id = message.content_ref
        AND payload.organization_id = message.organization_id
       WHERE message.organization_id = ?
         AND message.conversation_id = ?
         AND message.sequence > ?
       ORDER BY message.sequence
       LIMIT 100`,
    )
    .bind(identity.organizationId, conversationId, afterSequence)
    .all<MessageRow>();
  const messages = result.results.map(toMessage);
  return {
    messages,
    nextSequence:
      messages.length === 0
        ? afterSequence
        : messages[messages.length - 1]!.sequence,
  };
}

export async function sendMessage(
  identity: RequestIdentity,
  conversationId: string,
  input: JsonRecord,
): Promise<ConversationMessage> {
  await requireWorkspaceMember(identity);
  await requireConversationMember(identity, conversationId, true);
  const bodyText = requiredText(input.bodyText, "bodyText", 4_000);
  if (input.kind !== undefined && input.kind !== "text") {
    throw new WorkspaceRepositoryError("message_kind_not_allowed", 400);
  }

  const payloadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const now = new Date().toISOString();
  const contentHash = await messageIntegrityHash(
    requireMessageIntegrityKey(),
    identity.organizationId,
    messageId,
    bodyText,
  );
  const d1 = getD1();
  await executeBatch([
    d1
      .prepare(
        `INSERT INTO message_payloads (
           id, organization_id, body_text, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .bind(payloadId, identity.organizationId, bodyText, now),
    d1
      .prepare(
        `INSERT INTO messages (
           id, organization_id, conversation_id, sender_id, content_ref,
           content_hash, sequence, kind, metadata_json, created_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?,
           (
             SELECT next_sequence
             FROM conversations
             WHERE id = ? AND organization_id = ?
           ),
           'text', '{}', ?
         )`,
      )
      .bind(
        messageId,
        identity.organizationId,
        conversationId,
        identity.id,
        payloadId,
        contentHash,
        conversationId,
        identity.organizationId,
        now,
      ),
    d1
      .prepare(
        `UPDATE conversations
         SET next_sequence = next_sequence + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'active'`,
      )
      .bind(now, conversationId, identity.organizationId),
  ]);
  scheduleRealtimeSignal({
    kind: "conversation",
    organizationId: identity.organizationId,
    conversationId,
  });

  const created = await d1
    .prepare(
      `SELECT
         message.id, message.conversation_id, message.sender_id,
         message.content_hash, message.sequence, message.kind,
         message.created_at, payload.body_text, payload.erased_at,
         sender.display_name AS sender_name, sender.kind AS sender_kind
       FROM messages message
       INNER JOIN principals sender
         ON sender.id = message.sender_id
        AND sender.organization_id = message.organization_id
       LEFT JOIN message_payloads payload
         ON payload.id = message.content_ref
        AND payload.organization_id = message.organization_id
       WHERE message.id = ? AND message.organization_id = ?`,
    )
    .bind(messageId, identity.organizationId)
    .first<MessageRow>();
  if (!created) {
    throw new Error("Created message could not be read");
  }
  return toMessage(created);
}

export function parseAfterSequence(request: Request): number {
  const raw = new URL(request.url).searchParams.get("afterSequence");
  if (raw === null || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceRepositoryError("invalid_afterSequence", 400);
  }
  return value;
}

async function requireConversationMember(
  identity: RequestIdentity,
  conversationId: string,
  writable: boolean,
): Promise<void> {
  const membership = await getD1()
    .prepare(
      `SELECT member.role, conversation.status AS conversation_status
       FROM conversation_members member
       INNER JOIN conversations conversation
         ON conversation.id = member.conversation_id
        AND conversation.organization_id = member.organization_id
       WHERE member.organization_id = ?
         AND member.conversation_id = ?
         AND member.principal_id = ?
         AND member.status = 'active'
       LIMIT 1`,
    )
    .bind(identity.organizationId, conversationId, identity.id)
    .first<{
      role: ConversationMember["role"];
      conversation_status: string;
    }>();
  if (!membership) {
    throw new WorkspaceRepositoryError("conversation_not_found", 404);
  }
  if (
    writable &&
    (membership.conversation_status !== "active" ||
      membership.role === "observer")
  ) {
    throw new WorkspaceRepositoryError("conversation_read_only", 403);
  }
}

async function requireConversationReferences(
  organizationId: string,
  references: {
    projectId: string | null;
    teamId: string | null;
    workItemId: string | null;
    intentId: string | null;
    memberIds: string[];
  },
): Promise<void> {
  const d1 = getD1();
  if (references.projectId) {
    const project = await d1
      .prepare(
        `SELECT id FROM projects
         WHERE id = ? AND organization_id = ? AND status != 'archived'`,
      )
      .bind(references.projectId, organizationId)
      .first();
    if (!project) throw new WorkspaceRepositoryError("invalid_reference", 422);
  }
  if (references.teamId) {
    const team = await d1
      .prepare(
        `SELECT project_id FROM teams
         WHERE id = ? AND organization_id = ? AND status != 'archived'`,
      )
      .bind(references.teamId, organizationId)
      .first<{ project_id: string }>();
    if (
      !team ||
      (references.projectId && team.project_id !== references.projectId)
    ) {
      throw new WorkspaceRepositoryError("invalid_reference", 422);
    }
  }
  if (references.workItemId) {
    const workItem = await d1
      .prepare(
        `SELECT project_id FROM work_items
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(references.workItemId, organizationId)
      .first<{ project_id: string }>();
    if (
      !workItem ||
      (references.projectId && workItem.project_id !== references.projectId)
    ) {
      throw new WorkspaceRepositoryError("invalid_reference", 422);
    }
  }
  if (references.intentId) {
    const intent = await d1
      .prepare(
        `SELECT project_id FROM action_intents
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(references.intentId, organizationId)
      .first<{ project_id: string }>();
    if (
      !intent ||
      (references.projectId && intent.project_id !== references.projectId)
    ) {
      throw new WorkspaceRepositoryError("invalid_reference", 422);
    }
  }

  const placeholders = references.memberIds.map(() => "?").join(", ");
  const principalResult = await d1
    .prepare(
      `SELECT id FROM principals
       WHERE organization_id = ? AND status = 'active'
         AND NOT EXISTS (
           SELECT 1
           FROM organization_system_principals system_principal
           WHERE system_principal.organization_id = principals.organization_id
             AND system_principal.principal_id = principals.id
         )
         AND id IN (${placeholders})`,
    )
    .bind(organizationId, ...references.memberIds)
    .all<{ id: string }>();
  if (principalResult.results.length !== references.memberIds.length) {
    throw new WorkspaceRepositoryError("invalid_reference", 422);
  }
}

async function executeBatch(
  statements: D1PreparedStatement[],
  duplicateCode = "duplicate_entity",
): Promise<void> {
  try {
    await getD1().batch(statements);
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed/i.test(error.message)
    ) {
      throw new WorkspaceRepositoryError(duplicateCode, 409);
    }
    if (
      error instanceof Error &&
      /(FOREIGN KEY constraint failed|invalid_collaboration_reference)/i.test(
        error.message,
      )
    ) {
      throw new WorkspaceRepositoryError("invalid_reference", 422);
    }
    if (
      error instanceof Error &&
      /conversation_membership_required/i.test(error.message)
    ) {
      throw new WorkspaceRepositoryError("conversation_not_found", 404);
    }
    throw error;
  }
}

function requiredMemberIds(value: unknown, ownerId: string): string[] {
  if (!Array.isArray(value) || value.length > 49) {
    throw new WorkspaceRepositoryError("invalid_memberIds", 400);
  }
  const ids = value.map((entry) => requiredText(entry, "memberId", 100));
  return Array.from(new Set([ownerId, ...ids]));
}

function requireMessageIntegrityKey(): string {
  if (env.NEXUS_MESSAGE_INTEGRITY_KEY) {
    return env.NEXUS_MESSAGE_INTEGRITY_KEY;
  }
  if (env.NEXUS_ALLOW_LOCAL_IDENTITY === "1") {
    return LOCAL_MESSAGE_INTEGRITY_KEY;
  }
  throw new WorkspaceRepositoryError(
    "message_integrity_key_unavailable",
    503,
  );
}

function optionalId(value: unknown, field: string): string | null {
  return value === undefined || value === null
    ? null
    : requiredText(value, field, 100);
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new WorkspaceRepositoryError(`invalid_${field}`, 400);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new WorkspaceRepositoryError(`invalid_${field}`, 400);
  }
  return normalized;
}

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new WorkspaceRepositoryError("invalid_enum_value", 400);
  }
  return value as T[number];
}

function toMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    senderKind: row.sender_kind,
    contentHash: row.content_hash,
    sequence: row.sequence,
    kind: row.kind,
    bodyText: row.erased_at === null ? row.body_text : null,
    erased: row.erased_at !== null,
    createdAt: row.created_at,
  };
}

type ConversationRow = {
  id: string;
  project_id: string | null;
  team_id: string | null;
  work_item_id: string | null;
  intent_id: string | null;
  kind: ConversationKind;
  title: string;
  status: "active" | "archived";
  version: number;
  current_role: ConversationMember["role"];
  created_at: string;
  updated_at: string;
  latest_sequence: number | null;
  latest_sender_id: string | null;
  latest_body_text: string | null;
  latest_erased_at: string | null;
  latest_created_at: string | null;
};

type MemberRow = {
  conversation_id: string;
  principal_id: string;
  display_name: string;
  kind: ConversationMember["principalKind"];
  role: ConversationMember["role"];
  status: ConversationMember["status"];
  version: number;
  joined_at: string;
  left_at: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_name: string;
  sender_kind: ConversationMember["principalKind"];
  content_hash: string;
  sequence: number;
  kind: ConversationMessage["kind"];
  body_text: string | null;
  erased_at: string | null;
  created_at: string;
};
