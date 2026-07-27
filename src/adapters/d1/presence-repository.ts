import { env } from "cloudflare:workers";
import { getD1 } from "@/db";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import type {
  PresenceEntry,
  PresenceRoster,
  PresenceSessionLease,
  PresenceStatus,
} from "@/src/contracts/presence";
import {
  assertPresenceSessionKey,
  assertPresenceStatus,
  canRevealPresenceRoom,
  decidePresenceLease,
  decidePresenceRelease,
  DEFAULT_PRESENCE_HEARTBEAT_SECONDS,
  DEFAULT_PRESENCE_TTL_SECONDS,
  derivePresenceStatus,
  PresenceValidationError,
  resolvePublishablePresenceRoom,
  type CurrentPresenceLease,
} from "@/src/domain/presence";
import {
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "./workspace-repository";
import { scheduleRealtimeSignal } from "../realtime/publish-realtime-signal";

type JsonRecord = Record<string, unknown>;

export async function listPresence(
  identity: RequestIdentity,
): Promise<PresenceRoster> {
  await requireWorkspaceMember(identity);
  const nowEpoch = currentEpoch();
  await cleanupExpiredPresence(identity.organizationId, nowEpoch);
  const result = await getD1()
    .prepare(
      `SELECT
         principal.id AS principal_id,
         principal.display_name,
         principal.kind AS principal_kind,
         session.status,
         session.expires_at_epoch,
         session.room_conversation_id,
         room.title AS room_title,
         room.status AS room_status,
         subject.status AS subject_membership_status,
         observer.status AS observer_membership_status
       FROM principals principal
       LEFT JOIN presence_sessions session
         ON session.organization_id = principal.organization_id
        AND session.principal_id = principal.id
       LEFT JOIN conversations room
         ON room.organization_id = session.organization_id
        AND room.id = session.room_conversation_id
       LEFT JOIN conversation_members subject
         ON subject.organization_id = room.organization_id
        AND subject.conversation_id = room.id
        AND subject.principal_id = principal.id
       LEFT JOIN conversation_members observer
         ON observer.organization_id = room.organization_id
        AND observer.conversation_id = room.id
        AND observer.principal_id = ?
       WHERE principal.organization_id = ?
         AND principal.status = 'active'
         AND NOT EXISTS (
           SELECT 1
           FROM organization_system_principals system_principal
           WHERE system_principal.organization_id =
               principal.organization_id
             AND system_principal.principal_id = principal.id
         )
         AND (
           principal.kind != 'human'
           OR EXISTS (
             SELECT 1
             FROM memberships workspace_member
             WHERE workspace_member.organization_id = principal.organization_id
               AND workspace_member.principal_id = principal.id
               AND workspace_member.status = 'active'
           )
         )
       ORDER BY
         CASE
           WHEN session.expires_at_epoch > ? THEN 0
           ELSE 1
         END,
         CASE principal.kind WHEN 'human' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END,
         principal.display_name, principal.id
       LIMIT 200`,
    )
    .bind(identity.id, identity.organizationId, nowEpoch)
    .all<PresenceRosterRow>();

  return {
    generatedAtEpoch: nowEpoch,
    entries: result.results.map((row) => toPresenceEntry(row, nowEpoch)),
  };
}

export async function updatePresenceSession(
  identity: RequestIdentity,
  input: JsonRecord,
): Promise<PresenceSessionLease> {
  await requireWorkspaceMember(identity);
  const command = parseSessionCommand(input);
  const nowEpoch = currentEpoch();
  const d1 = getD1();
  const current = await d1
    .prepare(
      `SELECT
         session_key, fencing_token, status, expires_at_epoch,
         room_conversation_id
       FROM presence_sessions
       WHERE organization_id = ? AND principal_id = ?
       LIMIT 1`,
    )
    .bind(identity.organizationId, identity.id)
    .first<PresenceSessionRow>();
  const previousProjection =
    current && current.expires_at_epoch > nowEpoch
      ? presenceProjection(current.status, current.room_conversation_id ?? null)
      : null;
  const resolvedRoom = await resolveRequestedRoom(
    identity,
    command.roomConversationId,
    current && current.expires_at_epoch > nowEpoch
      ? (current.room_conversation_id ?? null)
      : null,
  );
  const leaseDecision = decidePresenceLease({
    current: current ? toCurrentLease(current) : null,
    sessionKey: command.sessionKey,
    fencingToken: command.fencingToken,
    takeover: command.takeover,
    nowEpoch,
    ttlSeconds: presenceTtlSeconds(),
  });
  if (leaseDecision.kind === "reject") {
    throw new WorkspaceRepositoryError(leaseDecision.reason, 409);
  }

  const roomConversationId = resolvedRoom.roomConversationId;
  let persistedRoomConversationId: string | null;
  try {
    persistedRoomConversationId = await persistLease({
      identity,
      command,
      roomConversationId,
      leaseDecision,
    });
  } catch (error) {
    throw mapPresenceDatabaseError(error);
  }

  const cleanedCount = await cleanupExpiredPresence(
    identity.organizationId,
    nowEpoch,
    identity.id,
  );
  const nextProjection = presenceProjection(
    command.status,
    persistedRoomConversationId,
  );
  if (
    cleanedCount > 0 ||
    !samePresenceProjection(previousProjection, nextProjection)
  ) {
    scheduleRealtimeSignal({
      kind: "presence",
      organizationId: identity.organizationId,
    });
  }
  return {
    fencingToken: leaseDecision.fencingToken,
    ttlSeconds: leaseDecision.expiresAtEpoch - nowEpoch,
    heartbeatSeconds: heartbeatSeconds(
      leaseDecision.expiresAtEpoch - nowEpoch,
    ),
    expiresAtEpoch: leaseDecision.expiresAtEpoch,
    roomCleared:
      resolvedRoom.roomCleared ||
      (roomConversationId !== null && persistedRoomConversationId === null),
  };
}

export async function releasePresenceSession(
  identity: RequestIdentity,
  input: JsonRecord,
): Promise<void> {
  await requireWorkspaceMember(identity);
  const sessionKey = requiredSessionKey(input.sessionKey);
  const fencingToken = requiredFencingToken(input.fencingToken);
  const current = await getD1()
    .prepare(
      `SELECT session_key, fencing_token, status, expires_at_epoch
       FROM presence_sessions
       WHERE organization_id = ? AND principal_id = ?
       LIMIT 1`,
    )
    .bind(identity.organizationId, identity.id)
    .first<PresenceSessionRow>();
  const decision = decidePresenceRelease({
    current: current ? toCurrentLease(current) : null,
    sessionKey,
    fencingToken,
  });
  if (decision.kind !== "release") {
    return;
  }
  const result = await getD1()
    .prepare(
      `DELETE FROM presence_sessions
       WHERE organization_id = ? AND principal_id = ?
         AND fencing_token = ? AND session_key = ?`,
    )
    .bind(
      identity.organizationId,
      identity.id,
      decision.expectedFencingToken,
      decision.expectedSessionKey,
    )
    .run();
  if (result.meta.changes > 0) {
    scheduleRealtimeSignal({
      kind: "presence",
      organizationId: identity.organizationId,
    });
  }
}

async function persistLease(input: {
  identity: RequestIdentity;
  command: ParsedSessionCommand;
  roomConversationId: string | null;
  leaseDecision: Exclude<
    ReturnType<typeof decidePresenceLease>,
    { kind: "reject" }
  >;
}): Promise<string | null> {
  if (input.leaseDecision.expectedFencingToken === null) {
    return insertLease(input);
  }
  const updated = await updateCurrentLease(input);
  if (updated) {
    return updated.room_conversation_id;
  }
  if (input.leaseDecision.kind === "claim") {
    const stillThere = await getD1()
      .prepare(
        `SELECT 1
         FROM presence_sessions
         WHERE organization_id = ? AND principal_id = ?
         LIMIT 1`,
      )
      .bind(input.identity.organizationId, input.identity.id)
      .first();
    if (!stillThere) {
      return insertLease(input);
    }
  }
  throw new WorkspaceRepositoryError("presence_stale_session", 409);
}

async function insertLease(input: {
  identity: RequestIdentity;
  command: ParsedSessionCommand;
  roomConversationId: string | null;
  leaseDecision: Exclude<
    ReturnType<typeof decidePresenceLease>,
    { kind: "reject" }
  >;
}): Promise<string | null> {
  const inserted = await getD1()
    .prepare(
      `INSERT INTO presence_sessions (
         id, organization_id, principal_id, session_key, fencing_token,
         status, room_conversation_id, expires_at_epoch, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?,
         (
           SELECT room.id
           FROM conversations room
           INNER JOIN conversation_members subject
             ON subject.organization_id = room.organization_id
            AND subject.conversation_id = room.id
            AND subject.principal_id = ?
            AND subject.status = 'active'
           WHERE room.id = ? AND room.organization_id = ?
             AND room.kind = 'room' AND room.status = 'active'
         ),
         ?, CURRENT_TIMESTAMP
       )
       RETURNING room_conversation_id`,
    )
    .bind(
      crypto.randomUUID(),
      input.identity.organizationId,
      input.identity.id,
      input.command.sessionKey,
      input.leaseDecision.fencingToken,
      input.command.status,
      input.identity.id,
      input.roomConversationId,
      input.identity.organizationId,
      input.leaseDecision.expiresAtEpoch,
    )
    .first<{ room_conversation_id: string | null }>();
  if (!inserted) {
    throw new WorkspaceRepositoryError("presence_stale_session", 409);
  }
  return inserted.room_conversation_id;
}

async function updateCurrentLease(input: {
  identity: RequestIdentity;
  command: ParsedSessionCommand;
  roomConversationId: string | null;
  leaseDecision: Exclude<
    ReturnType<typeof decidePresenceLease>,
    { kind: "reject" }
  >;
}): Promise<{ room_conversation_id: string | null } | null> {
  return getD1()
    .prepare(
      `UPDATE presence_sessions
       SET session_key = ?, fencing_token = ?, status = ?,
           room_conversation_id = (
             SELECT room.id
             FROM conversations room
             INNER JOIN conversation_members subject
               ON subject.organization_id = room.organization_id
              AND subject.conversation_id = room.id
              AND subject.principal_id = ?
              AND subject.status = 'active'
             WHERE room.id = ? AND room.organization_id = ?
               AND room.kind = 'room' AND room.status = 'active'
           ),
           expires_at_epoch = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = ? AND principal_id = ?
         AND fencing_token = ? AND session_key = ?
       RETURNING room_conversation_id`,
    )
    .bind(
      input.command.sessionKey,
      input.leaseDecision.fencingToken,
      input.command.status,
      input.identity.id,
      input.roomConversationId,
      input.identity.organizationId,
      input.leaseDecision.expiresAtEpoch,
      input.identity.organizationId,
      input.identity.id,
      input.leaseDecision.expectedFencingToken,
      input.leaseDecision.expectedSessionKey,
    )
    .first<{ room_conversation_id: string | null }>();
}

async function resolveRequestedRoom(
  identity: RequestIdentity,
  roomConversationId: string | null,
  currentRoomConversationId: string | null,
): Promise<{ roomConversationId: string | null; roomCleared: boolean }> {
  if (roomConversationId === null) {
    return { roomConversationId: null, roomCleared: false };
  }
  const row = await getD1()
    .prepare(
      `SELECT conversation.kind, conversation.status,
              member.status AS membership_status
       FROM conversations conversation
       LEFT JOIN conversation_members member
         ON member.organization_id = conversation.organization_id
        AND member.conversation_id = conversation.id
        AND member.principal_id = ?
       WHERE conversation.id = ? AND conversation.organization_id = ?
       LIMIT 1`,
    )
    .bind(identity.id, roomConversationId, identity.organizationId)
    .first<PresenceRoomRow>();
  try {
    const resolved = resolvePublishablePresenceRoom({
      roomConversationId,
      conversationKind: row?.kind ?? null,
      conversationStatus: row?.status ?? null,
      membershipStatus: row?.membership_status ?? null,
    });
    if (
      resolved.roomCleared &&
      currentRoomConversationId !== roomConversationId
    ) {
      throw new PresenceValidationError("presence_invalid_room");
    }
    return resolved;
  } catch (error) {
    throw mapPresenceValidationError(error);
  }
}

async function cleanupExpiredPresence(
  organizationId: string,
  nowEpoch: number,
  excludedPrincipalId?: string,
): Promise<number> {
  const d1 = getD1();
  const candidate = await d1
    .prepare(
      `SELECT 1
       FROM presence_sessions
       WHERE organization_id = ? AND expires_at_epoch <= ?
         AND (? IS NULL OR principal_id != ?)
       LIMIT 1`,
    )
    .bind(
      organizationId,
      nowEpoch,
      excludedPrincipalId ?? null,
      excludedPrincipalId ?? null,
    )
    .first();
  if (!candidate) return 0;
  const result = await d1
    .prepare(
      `DELETE FROM presence_sessions
       WHERE id IN (
         SELECT id
         FROM presence_sessions
         WHERE organization_id = ? AND expires_at_epoch <= ?
           AND (? IS NULL OR principal_id != ?)
         ORDER BY expires_at_epoch, id
         LIMIT 25
       )`,
    )
    .bind(
      organizationId,
      nowEpoch,
      excludedPrincipalId ?? null,
      excludedPrincipalId ?? null,
    )
    .run();
  return result.meta.changes;
}

function presenceProjection(
  status: PresenceStatus,
  roomConversationId: string | null,
): PresenceProjection {
  return { status, roomConversationId };
}

function samePresenceProjection(
  left: PresenceProjection | null,
  right: PresenceProjection | null,
): boolean {
  return (
    left?.status === right?.status &&
    left?.roomConversationId === right?.roomConversationId
  );
}

function toPresenceEntry(
  row: PresenceRosterRow,
  nowEpoch: number,
): PresenceEntry {
  const status = derivePresenceStatus({
    status: row.status,
    expiresAtEpoch: row.expires_at_epoch,
    nowEpoch,
  });
  const revealRoom = canRevealPresenceRoom({
    displayStatus: status,
    roomConversationId: row.room_conversation_id,
    roomStatus: row.room_status,
    subjectMembershipStatus: row.subject_membership_status,
    observerMembershipStatus: row.observer_membership_status,
  });
  return {
    principalId: row.principal_id,
    displayName: row.display_name,
    principalKind: row.principal_kind,
    status,
    room:
      revealRoom && row.room_conversation_id && row.room_title
        ? {
            conversationId: row.room_conversation_id,
            title: row.room_title,
          }
        : null,
  };
}

function parseSessionCommand(input: JsonRecord): ParsedSessionCommand {
  const sessionKey = requiredSessionKey(input.sessionKey);
  let status: PresenceStatus;
  try {
    assertPresenceStatus(input.status);
    status = input.status;
  } catch (error) {
    throw mapPresenceValidationError(error);
  }
  const roomConversationId =
    input.roomConversationId === null
      ? null
      : requiredId(input.roomConversationId, "roomConversationId");
  const fencingToken =
    input.fencingToken === undefined
      ? undefined
      : requiredFencingToken(input.fencingToken);
  if (
    input.takeover !== undefined &&
    typeof input.takeover !== "boolean"
  ) {
    throw new WorkspaceRepositoryError("presence_invalid_session", 400);
  }
  const takeover = input.takeover === true;
  if (takeover && fencingToken !== undefined) {
    throw new WorkspaceRepositoryError("presence_invalid_session", 400);
  }
  return { sessionKey, status, roomConversationId, fencingToken, takeover };
}

function requiredSessionKey(value: unknown): string {
  try {
    assertPresenceSessionKey(value);
    return value;
  } catch (error) {
    throw mapPresenceValidationError(error);
  }
}

function requiredFencingToken(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new WorkspaceRepositoryError("presence_invalid_session", 400);
  }
  return Number(value);
}

function requiredId(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128
  ) {
    throw new WorkspaceRepositoryError(`invalid_${field}`, 400);
  }
  return value;
}

function presenceTtlSeconds(): number {
  const configured = Number(env.NEXUS_PRESENCE_TTL_SECONDS);
  return Number.isSafeInteger(configured) && configured >= 2 && configured <= 240
    ? configured
    : DEFAULT_PRESENCE_TTL_SECONDS;
}

function heartbeatSeconds(ttlSeconds: number): number {
  return Math.max(
    1,
    Math.min(
      DEFAULT_PRESENCE_HEARTBEAT_SECONDS,
      Math.floor(ttlSeconds / 2),
    ),
  );
}

function currentEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

function mapPresenceValidationError(error: unknown): WorkspaceRepositoryError {
  if (error instanceof PresenceValidationError) {
    return new WorkspaceRepositoryError(error.code, 400);
  }
  throw error;
}

function mapPresenceDatabaseError(error: unknown): Error {
  if (error instanceof WorkspaceRepositoryError) return error;
  if (isDatabaseError(error, "UNIQUE constraint failed")) {
    return new WorkspaceRepositoryError("presence_stale_session", 409);
  }
  if (isDatabaseError(error, "presence_stale_session")) {
    return new WorkspaceRepositoryError("presence_stale_session", 409);
  }
  if (isDatabaseError(error, "invalid_presence_room")) {
    return new WorkspaceRepositoryError("presence_invalid_room", 400);
  }
  if (
    isDatabaseError(error, "invalid_presence_reference") ||
    isDatabaseError(error, "presence_reference_is_immutable")
  ) {
    return new WorkspaceRepositoryError("presence_session_rejected", 409);
  }
  if (isDatabaseError(error, "invalid_presence_state")) {
    return new WorkspaceRepositoryError("presence_invalid_session", 400);
  }
  return error instanceof Error ? error : new Error("Presence write failed");
}

function isDatabaseError(error: unknown, message: string): boolean {
  return error instanceof Error && error.message.includes(message);
}

function toCurrentLease(row: PresenceSessionRow): CurrentPresenceLease {
  return {
    sessionKey: row.session_key,
    fencingToken: row.fencing_token,
    expiresAtEpoch: row.expires_at_epoch,
  };
}

type ParsedSessionCommand = {
  sessionKey: string;
  status: PresenceStatus;
  roomConversationId: string | null;
  fencingToken?: number;
  takeover: boolean;
};

type PresenceSessionRow = {
  session_key: string;
  fencing_token: number;
  status: PresenceStatus;
  expires_at_epoch: number;
  room_conversation_id?: string | null;
};

type PresenceProjection = {
  status: PresenceStatus;
  roomConversationId: string | null;
};

type PresenceRoomRow = {
  kind: "direct" | "room" | "handoff";
  status: "active" | "archived";
  membership_status: "active" | "left" | "removed" | null;
};

type PresenceRosterRow = {
  principal_id: string;
  display_name: string;
  principal_kind: PresenceEntry["principalKind"];
  status: PresenceStatus | null;
  expires_at_epoch: number | null;
  room_conversation_id: string | null;
  room_title: string | null;
  room_status: "active" | "archived" | null;
  subject_membership_status: "active" | "left" | "removed" | null;
  observer_membership_status: "active" | "left" | "removed" | null;
};
