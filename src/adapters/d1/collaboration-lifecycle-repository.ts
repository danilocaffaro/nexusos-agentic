import { getD1 } from "@/db";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import type {
  ConversationKind,
  ConversationMember,
  ConversationPin,
  ConversationSummary,
} from "@/src/contracts/collaboration";
import {
  assertCanAddConversationMember,
  assertCanChangeConversationMember,
  assertCanPinConversationMessage,
  assertCanUnpinConversationMessage,
  ConversationLifecycleError,
} from "@/src/domain/collaboration/membership";
import {
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "./workspace-repository";
import { listConversations } from "./collaboration-repository";

type JsonRecord = Record<string, unknown>;

export async function addConversationMember(
  identity: RequestIdentity,
  conversationId: string,
  input: JsonRecord,
): Promise<ConversationMember> {
  await requireWorkspaceMember(identity);
  const context = await requireConversationContext(identity, conversationId);
  runLifecycleCheck(() =>
    assertCanAddConversationMember({
      kind: context.kind,
      conversationStatus: context.status,
      actorRole: context.currentRole,
    }),
  );
  const principalId = requiredId(input.principalId, "principalId");
  const role = optionalMemberRole(input.role);
  await requireEligiblePrincipal(identity.organizationId, principalId);
  const existing = await findMember(
    identity.organizationId,
    conversationId,
    principalId,
  );
  const now = new Date().toISOString();

  if (existing?.status === "active") {
    throw new WorkspaceRepositoryError("member_already_active", 409);
  }

  if (existing) {
    const result = await executeMutation(
      getD1()
        .prepare(
          `UPDATE conversation_members
           SET role = ?, status = 'active', left_at = NULL,
               version = version + 1
           WHERE id = ? AND organization_id = ? AND version = ?
             AND EXISTS (
               SELECT 1
               FROM conversations conversation
               INNER JOIN conversation_members actor
                 ON actor.conversation_id = conversation.id
                AND actor.organization_id = conversation.organization_id
               INNER JOIN principals principal
                 ON principal.id = conversation_members.principal_id
                AND principal.organization_id = conversation_members.organization_id
               WHERE conversation.id = conversation_members.conversation_id
                 AND conversation.organization_id = conversation_members.organization_id
                 AND conversation.status = 'active'
                 AND conversation.kind != 'direct'
                 AND actor.principal_id = ?
                 AND actor.status = 'active'
                 AND actor.role = 'owner'
                 AND principal.status = 'active'
                 AND (
                   principal.kind != 'human' OR EXISTS (
                     SELECT 1 FROM memberships workspace_member
                     WHERE workspace_member.organization_id = principal.organization_id
                       AND workspace_member.principal_id = principal.id
                       AND workspace_member.status = 'active'
                   )
                 )
             )`,
        )
        .bind(
          role,
          existing.id,
          identity.organizationId,
          existing.version,
          identity.id,
        ),
    );
    assertMutationChanged(result);
  } else {
    const result = await executeMutation(
      getD1()
        .prepare(
          `INSERT INTO conversation_members (
             id, organization_id, conversation_id, principal_id, role,
             status, version, joined_at
           )
           SELECT ?, conversation.organization_id, conversation.id,
                  principal.id, ?, 'active', 1, ?
           FROM conversations conversation
           INNER JOIN conversation_members actor
             ON actor.conversation_id = conversation.id
            AND actor.organization_id = conversation.organization_id
           INNER JOIN principals principal
             ON principal.id = ?
            AND principal.organization_id = conversation.organization_id
           WHERE conversation.id = ?
             AND conversation.organization_id = ?
             AND conversation.status = 'active'
             AND conversation.kind != 'direct'
             AND actor.principal_id = ?
             AND actor.status = 'active'
             AND actor.role = 'owner'
             AND principal.status = 'active'
             AND (
               principal.kind != 'human' OR EXISTS (
                 SELECT 1 FROM memberships workspace_member
                 WHERE workspace_member.organization_id = principal.organization_id
                   AND workspace_member.principal_id = principal.id
                   AND workspace_member.status = 'active'
               )
             )`,
        )
        .bind(
          crypto.randomUUID(),
          role,
          now,
          principalId,
          conversationId,
          identity.organizationId,
          identity.id,
        ),
      "member_already_exists",
    );
    assertMutationChanged(result);
  }

  return requireMember(identity.organizationId, conversationId, principalId);
}

export async function updateConversationMember(
  identity: RequestIdentity,
  conversationId: string,
  principalId: string,
  input: JsonRecord,
): Promise<ConversationMember> {
  await requireWorkspaceMember(identity);
  const context = await requireConversationContext(identity, conversationId);
  const [target, activeOwnerCount] = await Promise.all([
    requireMember(identity.organizationId, conversationId, principalId),
    countActiveOwners(identity.organizationId, conversationId),
  ]);
  const role = requiredRole(input.role);
  const expectedVersion = requiredVersion(input.expectedVersion);
  if (role === "owner") {
    await requireEligiblePrincipal(
      identity.organizationId,
      principalId,
      true,
    );
  }
  if (target.status !== "active") {
    throw new WorkspaceRepositoryError("conversation_member_inactive", 409);
  }
  runLifecycleCheck(() =>
    assertCanChangeConversationMember({
      kind: context.kind,
      conversationStatus: context.status,
      actorRole: context.currentRole,
      actorId: identity.id,
      targetId: principalId,
      targetRole: target.role,
      targetStatus: target.status,
      nextRole: role,
      nextStatus: target.status,
      activeOwnerCount,
    }),
  );

  const result = await executeMutation(
    getD1()
      .prepare(
        `UPDATE conversation_members
         SET role = ?, version = version + 1
         WHERE organization_id = ? AND conversation_id = ?
           AND principal_id = ? AND version = ? AND status = 'active'
           AND EXISTS (
             SELECT 1
             FROM conversations conversation
             INNER JOIN conversation_members actor
               ON actor.conversation_id = conversation.id
              AND actor.organization_id = conversation.organization_id
             WHERE conversation.id = conversation_members.conversation_id
               AND conversation.organization_id = conversation_members.organization_id
               AND conversation.status = 'active'
               AND conversation.kind != 'direct'
               AND actor.principal_id = ?
               AND actor.status = 'active'
               AND actor.role = 'owner'
               AND (
                 ? != 'owner' OR EXISTS (
                   SELECT 1
                   FROM principals target_principal
                   INNER JOIN memberships target_membership
                     ON target_membership.principal_id = target_principal.id
                    AND target_membership.organization_id = target_principal.organization_id
                   WHERE target_principal.id = conversation_members.principal_id
                     AND target_principal.organization_id = conversation_members.organization_id
                     AND target_principal.kind = 'human'
                     AND target_principal.status = 'active'
                     AND target_membership.status = 'active'
                 )
               )
           )`,
      )
      .bind(
        role,
        identity.organizationId,
        conversationId,
        principalId,
        expectedVersion,
        identity.id,
        role,
      ),
  );
  assertMutationChanged(result);
  return requireMember(identity.organizationId, conversationId, principalId);
}

export async function removeConversationMember(
  identity: RequestIdentity,
  conversationId: string,
  principalId: string,
  input: JsonRecord,
): Promise<ConversationMember> {
  await requireWorkspaceMember(identity);
  const context = await requireConversationContext(identity, conversationId);
  const [target, activeOwnerCount] = await Promise.all([
    requireMember(identity.organizationId, conversationId, principalId),
    countActiveOwners(identity.organizationId, conversationId),
  ]);
  const expectedVersion = requiredVersion(input.expectedVersion);
  if (target.status !== "active") {
    throw new WorkspaceRepositoryError("conversation_member_inactive", 409);
  }
  const nextStatus = identity.id === principalId ? "left" : "removed";
  runLifecycleCheck(() =>
    assertCanChangeConversationMember({
      kind: context.kind,
      conversationStatus: context.status,
      actorRole: context.currentRole,
      actorId: identity.id,
      targetId: principalId,
      targetRole: target.role,
      targetStatus: target.status,
      nextRole: target.role,
      nextStatus,
      activeOwnerCount,
    }),
  );

  const result = await executeMutation(
    getD1()
      .prepare(
        `UPDATE conversation_members
         SET status = ?, version = version + 1, left_at = ?
         WHERE organization_id = ? AND conversation_id = ?
           AND principal_id = ? AND version = ? AND status = 'active'
           AND EXISTS (
             SELECT 1
             FROM conversations conversation
             INNER JOIN conversation_members actor
               ON actor.conversation_id = conversation.id
              AND actor.organization_id = conversation.organization_id
             WHERE conversation.id = conversation_members.conversation_id
               AND conversation.organization_id = conversation_members.organization_id
               AND conversation.status = 'active'
               AND conversation.kind != 'direct'
               AND actor.principal_id = ?
               AND actor.status = 'active'
               AND (
                 actor.role = 'owner' OR actor.principal_id = conversation_members.principal_id
               )
           )`,
      )
      .bind(
        nextStatus,
        new Date().toISOString(),
        identity.organizationId,
        conversationId,
        principalId,
        expectedVersion,
        identity.id,
      ),
  );
  assertMutationChanged(result);
  return requireMember(identity.organizationId, conversationId, principalId);
}

export async function archiveConversation(
  identity: RequestIdentity,
  conversationId: string,
  input: JsonRecord,
): Promise<ConversationSummary> {
  return changeConversationStatus(
    identity,
    conversationId,
    input,
    "active",
    "archived",
  );
}

export async function reopenConversation(
  identity: RequestIdentity,
  conversationId: string,
  input: JsonRecord,
): Promise<ConversationSummary> {
  return changeConversationStatus(
    identity,
    conversationId,
    input,
    "archived",
    "active",
  );
}

export async function listConversationPins(
  identity: RequestIdentity,
  conversationId: string,
): Promise<{ pins: ConversationPin[] }> {
  await requireWorkspaceMember(identity);
  await requireConversationContext(identity, conversationId);
  const result = await getD1()
    .prepare(
      `${PIN_SELECT}
       WHERE pin.organization_id = ? AND pin.conversation_id = ?
         AND pin.status = 'active'
       ORDER BY pin.pinned_at, pin.id`,
    )
    .bind(identity.organizationId, conversationId)
    .all<PinRow>();
  return { pins: result.results.map(toPin) };
}

export async function createConversationPin(
  identity: RequestIdentity,
  conversationId: string,
  input: JsonRecord,
): Promise<ConversationPin> {
  await requireWorkspaceMember(identity);
  const context = await requireConversationContext(identity, conversationId);
  runLifecycleCheck(() =>
    assertCanPinConversationMessage({
      conversationStatus: context.status,
      actorRole: context.currentRole,
    }),
  );
  const messageId = requiredId(input.messageId, "messageId");
  const activePins = await getD1()
    .prepare(
      `SELECT COUNT(*) AS count FROM conversation_pins
       WHERE organization_id = ? AND conversation_id = ? AND status = 'active'`,
    )
    .bind(identity.organizationId, conversationId)
    .first<{ count: number }>();
  if ((activePins?.count ?? 0) >= 20) {
    throw new WorkspaceRepositoryError("pin_limit_reached", 422);
  }

  const pinId = crypto.randomUUID();
  const result = await executeMutation(
    getD1()
      .prepare(
        `INSERT INTO conversation_pins (
           id, organization_id, conversation_id, message_id, pinned_by,
           status, version, pinned_at
         )
         SELECT ?, ?, ?, ?, ?, 'active', 1, ?
         WHERE (
           SELECT COUNT(*) FROM conversation_pins
           WHERE organization_id = ? AND conversation_id = ?
             AND status = 'active'
         ) < 20`,
      )
      .bind(
        pinId,
        identity.organizationId,
        conversationId,
        messageId,
        identity.id,
        new Date().toISOString(),
        identity.organizationId,
        conversationId,
      ),
    "pin_already_active",
  );
  if (!result.meta.changes) {
    throw new WorkspaceRepositoryError("pin_limit_reached", 422);
  }
  return requirePin(identity.organizationId, conversationId, pinId);
}

export async function removeConversationPin(
  identity: RequestIdentity,
  conversationId: string,
  pinId: string,
  input: JsonRecord,
): Promise<ConversationPin> {
  await requireWorkspaceMember(identity);
  const context = await requireConversationContext(identity, conversationId);
  const pin = await requirePin(identity.organizationId, conversationId, pinId);
  runLifecycleCheck(() =>
    assertCanUnpinConversationMessage({
      conversationStatus: context.status,
      actorRole: context.currentRole,
      actorId: identity.id,
      pinnedBy: pin.pinnedBy,
    }),
  );
  const expectedVersion = requiredVersion(input.expectedVersion);
  const result = await executeMutation(
    getD1()
      .prepare(
        `UPDATE conversation_pins
         SET status = 'removed', version = version + 1, unpinned_at = ?
         WHERE id = ? AND organization_id = ? AND conversation_id = ?
           AND status = 'active' AND version = ?
           AND EXISTS (
             SELECT 1
             FROM conversations conversation
             INNER JOIN conversation_members actor
               ON actor.conversation_id = conversation.id
              AND actor.organization_id = conversation.organization_id
             WHERE conversation.id = conversation_pins.conversation_id
               AND conversation.organization_id = conversation_pins.organization_id
               AND conversation.status = 'active'
               AND actor.principal_id = ?
               AND actor.status = 'active'
               AND actor.role != 'observer'
               AND (
                 actor.role = 'owner' OR actor.principal_id = conversation_pins.pinned_by
               )
           )`,
      )
      .bind(
        new Date().toISOString(),
        pinId,
        identity.organizationId,
        conversationId,
        expectedVersion,
        identity.id,
      ),
  );
  assertMutationChanged(result);
  return requirePin(identity.organizationId, conversationId, pinId);
}

async function changeConversationStatus(
  identity: RequestIdentity,
  conversationId: string,
  input: JsonRecord,
  currentStatus: "active" | "archived",
  nextStatus: "active" | "archived",
): Promise<ConversationSummary> {
  await requireWorkspaceMember(identity);
  const context = await requireConversationContext(identity, conversationId);
  if (context.currentRole !== "owner") {
    throw new WorkspaceRepositoryError("conversation_owner_required", 403);
  }
  if (context.status !== currentStatus) {
    throw new WorkspaceRepositoryError("invalid_status_transition", 409);
  }
  const expectedVersion = requiredVersion(input.expectedVersion);
  const result = await executeMutation(
    getD1()
      .prepare(
        `UPDATE conversations
         SET status = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = ? AND version = ?
           AND EXISTS (
             SELECT 1 FROM conversation_members actor
             WHERE actor.conversation_id = conversations.id
               AND actor.organization_id = conversations.organization_id
               AND actor.principal_id = ?
               AND actor.status = 'active'
               AND actor.role = 'owner'
           )`,
      )
      .bind(
        nextStatus,
        new Date().toISOString(),
        conversationId,
        identity.organizationId,
        currentStatus,
        expectedVersion,
        identity.id,
      ),
  );
  assertMutationChanged(result);
  const conversations = await listConversations(identity);
  const updated = conversations.conversations.find(
    (conversation) => conversation.id === conversationId,
  );
  if (!updated) {
    throw new WorkspaceRepositoryError("conversation_not_found", 404);
  }
  return updated;
}

async function requireConversationContext(
  identity: RequestIdentity,
  conversationId: string,
): Promise<ConversationContext> {
  const context = await getD1()
    .prepare(
      `SELECT conversation.kind, conversation.status, conversation.version,
              viewer.role AS currentRole
       FROM conversations conversation
       INNER JOIN conversation_members viewer
         ON viewer.conversation_id = conversation.id
        AND viewer.organization_id = conversation.organization_id
       WHERE conversation.id = ? AND conversation.organization_id = ?
         AND viewer.principal_id = ? AND viewer.status = 'active'
       LIMIT 1`,
    )
    .bind(conversationId, identity.organizationId, identity.id)
    .first<ConversationContext>();
  if (!context) {
    throw new WorkspaceRepositoryError("conversation_not_found", 404);
  }
  return context;
}

async function findMember(
  organizationId: string,
  conversationId: string,
  principalId: string,
): Promise<MemberRow | null> {
  return getD1()
    .prepare(
      `${MEMBER_SELECT}
       WHERE member.organization_id = ? AND member.conversation_id = ?
         AND member.principal_id = ?
       LIMIT 1`,
    )
    .bind(organizationId, conversationId, principalId)
    .first<MemberRow>();
}

async function requireMember(
  organizationId: string,
  conversationId: string,
  principalId: string,
): Promise<ConversationMember> {
  const member = await findMember(organizationId, conversationId, principalId);
  if (!member) {
    throw new WorkspaceRepositoryError("conversation_member_not_found", 404);
  }
  return toMember(member);
}

async function countActiveOwners(
  organizationId: string,
  conversationId: string,
): Promise<number> {
  const result = await getD1()
    .prepare(
      `SELECT COUNT(*) AS count
       FROM conversation_members member
       INNER JOIN principals principal
         ON principal.id = member.principal_id
        AND principal.organization_id = member.organization_id
       INNER JOIN memberships workspace_member
         ON workspace_member.principal_id = principal.id
        AND workspace_member.organization_id = principal.organization_id
       WHERE member.organization_id = ? AND member.conversation_id = ?
         AND member.role = 'owner' AND member.status = 'active'
         AND principal.kind = 'human' AND principal.status = 'active'
         AND workspace_member.status = 'active'`,
    )
    .bind(organizationId, conversationId)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

async function requireEligiblePrincipal(
  organizationId: string,
  principalId: string,
  requireHuman = false,
): Promise<ConversationMember["principalKind"]> {
  const principal = await getD1()
    .prepare(
      `SELECT principal.kind
       FROM principals principal
       WHERE principal.id = ? AND principal.organization_id = ?
         AND principal.status = 'active'
         AND (? = 0 OR principal.kind = 'human')
         AND (
           principal.kind != 'human' OR EXISTS (
             SELECT 1 FROM memberships workspace_member
             WHERE workspace_member.organization_id = principal.organization_id
               AND workspace_member.principal_id = principal.id
               AND workspace_member.status = 'active'
           )
         )
       LIMIT 1`,
    )
    .bind(principalId, organizationId, requireHuman ? 1 : 0)
    .first<{ kind: ConversationMember["principalKind"] }>();
  if (!principal) {
    throw new WorkspaceRepositoryError("invalid_reference", 422);
  }
  return principal.kind;
}

async function requirePin(
  organizationId: string,
  conversationId: string,
  pinId: string,
): Promise<ConversationPin> {
  const pin = await getD1()
    .prepare(
      `${PIN_SELECT}
       WHERE pin.id = ? AND pin.organization_id = ?
         AND pin.conversation_id = ?
       LIMIT 1`,
    )
    .bind(pinId, organizationId, conversationId)
    .first<PinRow>();
  if (!pin) {
    throw new WorkspaceRepositoryError("conversation_pin_not_found", 404);
  }
  return toPin(pin);
}

function runLifecycleCheck(check: () => void): void {
  try {
    check();
  } catch (error) {
    if (error instanceof ConversationLifecycleError) {
      const forbidden = new Set([
        "conversation_owner_required",
        "conversation_read_only",
      ]);
      throw new WorkspaceRepositoryError(
        error.code,
        forbidden.has(error.code) ? 403 : 409,
      );
    }
    throw error;
  }
}

async function executeMutation(
  statement: D1PreparedStatement,
  duplicateCode = "version_conflict",
): Promise<D1Result> {
  try {
    return await statement.run();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new WorkspaceRepositoryError(duplicateCode, 409);
    }
    if (error instanceof Error && /conversation_requires_owner/i.test(error.message)) {
      throw new WorkspaceRepositoryError("conversation_requires_owner", 409);
    }
    if (
      error instanceof Error &&
      /(invalid_conversation_pin|invalid_collaboration_reference|FOREIGN KEY constraint failed)/i.test(
        error.message,
      )
    ) {
      throw new WorkspaceRepositoryError("invalid_reference", 422);
    }
    throw error;
  }
}

function assertMutationChanged(result: D1Result): void {
  if (!result.meta.changes) {
    throw new WorkspaceRepositoryError("version_conflict", 409);
  }
}

function requiredVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new WorkspaceRepositoryError("invalid_expectedVersion", 400);
  }
  return value as number;
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new WorkspaceRepositoryError(`invalid_${field}`, 400);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) {
    throw new WorkspaceRepositoryError(`invalid_${field}`, 400);
  }
  return normalized;
}

function requiredRole(value: unknown): ConversationMember["role"] {
  if (!["owner", "member", "observer"].includes(value as string)) {
    throw new WorkspaceRepositoryError("invalid_role", 400);
  }
  return value as ConversationMember["role"];
}

function optionalMemberRole(value: unknown): "member" | "observer" {
  if (value === undefined) return "member";
  if (value !== "member" && value !== "observer") {
    throw new WorkspaceRepositoryError("invalid_role", 400);
  }
  return value;
}

function toMember(row: MemberRow): ConversationMember {
  return {
    principalId: row.principal_id,
    displayName: row.display_name,
    principalKind: row.kind,
    role: row.role,
    status: row.status,
    version: row.version,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
  };
}

function toPin(row: PinRow): ConversationPin {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    pinnedBy: row.pinned_by,
    pinnedByName: row.pinned_by_name,
    status: row.status,
    version: row.version,
    pinnedAt: row.pinned_at,
    unpinnedAt: row.unpinned_at,
    message: {
      sequence: row.message_sequence,
      senderId: row.sender_id,
      senderName: row.sender_name,
      senderKind: row.sender_kind,
      kind: row.message_kind,
      bodyText: row.erased_at === null ? row.body_text : null,
      erased: row.erased_at !== null,
      createdAt: row.message_created_at,
    },
  };
}

const MEMBER_SELECT = `SELECT
  member.id, member.principal_id, member.role, member.status, member.version,
  member.joined_at, member.left_at, principal.display_name, principal.kind
  FROM conversation_members member
  INNER JOIN principals principal
    ON principal.id = member.principal_id
   AND principal.organization_id = member.organization_id`;

const PIN_SELECT = `SELECT
  pin.id, pin.conversation_id, pin.message_id, pin.pinned_by, pin.status,
  pin.version, pin.pinned_at, pin.unpinned_at,
  pinner.display_name AS pinned_by_name,
  message.sequence AS message_sequence, message.sender_id,
  message.kind AS message_kind, message.created_at AS message_created_at,
  sender.display_name AS sender_name, sender.kind AS sender_kind,
  payload.body_text, payload.erased_at
  FROM conversation_pins pin
  INNER JOIN principals pinner
    ON pinner.id = pin.pinned_by
   AND pinner.organization_id = pin.organization_id
  INNER JOIN messages message
    ON message.id = pin.message_id
   AND message.conversation_id = pin.conversation_id
   AND message.organization_id = pin.organization_id
  INNER JOIN principals sender
    ON sender.id = message.sender_id
   AND sender.organization_id = message.organization_id
  LEFT JOIN message_payloads payload
    ON payload.id = message.content_ref
   AND payload.organization_id = message.organization_id`;

type ConversationContext = {
  kind: ConversationKind;
  status: "active" | "archived";
  version: number;
  currentRole: ConversationMember["role"];
};

type MemberRow = {
  id: string;
  principal_id: string;
  display_name: string;
  kind: ConversationMember["principalKind"];
  role: ConversationMember["role"];
  status: ConversationMember["status"];
  version: number;
  joined_at: string;
  left_at: string | null;
};

type PinRow = {
  id: string;
  conversation_id: string;
  message_id: string;
  pinned_by: string;
  pinned_by_name: string;
  status: ConversationPin["status"];
  version: number;
  pinned_at: string;
  unpinned_at: string | null;
  message_sequence: number;
  sender_id: string;
  sender_name: string;
  sender_kind: ConversationPin["message"]["senderKind"];
  message_kind: ConversationPin["message"]["kind"];
  body_text: string | null;
  erased_at: string | null;
  message_created_at: string;
};
