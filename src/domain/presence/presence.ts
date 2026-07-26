import {
  PRESENCE_STATUSES,
  type PresenceDisplayStatus,
  type PresenceStatus,
} from "../../contracts/presence";

export const DEFAULT_PRESENCE_TTL_SECONDS = 60;
export const DEFAULT_PRESENCE_HEARTBEAT_SECONDS = 25;

export type CurrentPresenceLease = {
  sessionKey: string;
  fencingToken: number;
  expiresAtEpoch: number;
};

export type PresenceLeaseDecision =
  | {
      kind: "claim" | "renew";
      fencingToken: number;
      expiresAtEpoch: number;
      expectedFencingToken: number | null;
      expectedSessionKey: string | null;
    }
  | { kind: "reject"; reason: "presence_stale_session" };

export type PresenceReleaseDecision =
  | {
      kind: "release";
      expectedFencingToken: number;
      expectedSessionKey: string;
    }
  | { kind: "noop" }
  | { kind: "reject"; reason: "presence_stale_session" };

export class PresenceValidationError extends Error {
  constructor(
    public readonly code:
      | "presence_invalid_session"
      | "presence_invalid_status"
      | "presence_invalid_room",
  ) {
    super(code);
    this.name = "PresenceValidationError";
  }
}

export function assertPresenceSessionKey(sessionKey: unknown): asserts sessionKey is string {
  if (
    typeof sessionKey !== "string" ||
    sessionKey.length < 16 ||
    sessionKey.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(sessionKey)
  ) {
    throw new PresenceValidationError("presence_invalid_session");
  }
}

export function assertPresenceStatus(status: unknown): asserts status is PresenceStatus {
  if (
    typeof status !== "string" ||
    !PRESENCE_STATUSES.includes(status as PresenceStatus)
  ) {
    throw new PresenceValidationError("presence_invalid_status");
  }
}

export function resolvePublishablePresenceRoom(input: {
  roomConversationId: string | null;
  conversationKind: "direct" | "room" | "handoff" | null;
  conversationStatus: "active" | "archived" | null;
  membershipStatus: "active" | "left" | "removed" | null;
}): { roomConversationId: string | null; roomCleared: boolean } {
  if (input.roomConversationId === null) {
    return { roomConversationId: null, roomCleared: false };
  }

  if (input.conversationKind !== "room") {
    throw new PresenceValidationError("presence_invalid_room");
  }

  if (
    input.conversationStatus !== "active" ||
    input.membershipStatus !== "active"
  ) {
    return { roomConversationId: null, roomCleared: true };
  }

  return {
    roomConversationId: input.roomConversationId,
    roomCleared: false,
  };
}

export function computePresenceExpiry(
  nowEpoch: number,
  ttlSeconds = DEFAULT_PRESENCE_TTL_SECONDS,
): number {
  if (
    !Number.isInteger(nowEpoch) ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > 300
  ) {
    throw new PresenceValidationError("presence_invalid_session");
  }
  return nowEpoch + ttlSeconds;
}

export function decidePresenceLease(input: {
  current: CurrentPresenceLease | null;
  sessionKey: string;
  fencingToken?: number;
  nowEpoch: number;
  ttlSeconds?: number;
}): PresenceLeaseDecision {
  const { current, sessionKey, fencingToken, nowEpoch } = input;
  const expiresAtEpoch = computePresenceExpiry(nowEpoch, input.ttlSeconds);

  if (current === null || current.expiresAtEpoch <= nowEpoch) {
    return {
      kind: "claim",
      fencingToken: current === null ? 1 : current.fencingToken + 1,
      expiresAtEpoch,
      expectedFencingToken: current?.fencingToken ?? null,
      expectedSessionKey: current?.sessionKey ?? null,
    };
  }

  if (
    fencingToken === current.fencingToken &&
    sessionKey === current.sessionKey
  ) {
    return {
      kind: "renew",
      fencingToken: current.fencingToken,
      expiresAtEpoch,
      expectedFencingToken: current.fencingToken,
      expectedSessionKey: current.sessionKey,
    };
  }

  if (fencingToken === undefined) {
    return {
      kind: "claim",
      fencingToken: current.fencingToken + 1,
      expiresAtEpoch,
      expectedFencingToken: current.fencingToken,
      expectedSessionKey: current.sessionKey,
    };
  }

  return { kind: "reject", reason: "presence_stale_session" };
}

export function decidePresenceRelease(input: {
  current: CurrentPresenceLease | null;
  sessionKey: string;
  fencingToken: number;
}): PresenceReleaseDecision {
  if (input.current === null) {
    return { kind: "noop" };
  }
  if (
    input.sessionKey !== input.current.sessionKey ||
    input.fencingToken !== input.current.fencingToken
  ) {
    return { kind: "reject", reason: "presence_stale_session" };
  }
  return {
    kind: "release",
    expectedFencingToken: input.current.fencingToken,
    expectedSessionKey: input.current.sessionKey,
  };
}

export function derivePresenceStatus(input: {
  status: PresenceStatus | null;
  expiresAtEpoch: number | null;
  nowEpoch: number;
}): PresenceDisplayStatus {
  if (
    input.status === null ||
    input.expiresAtEpoch === null ||
    input.expiresAtEpoch <= input.nowEpoch
  ) {
    return "offline";
  }
  return input.status;
}

export function canRevealPresenceRoom(input: {
  displayStatus: PresenceDisplayStatus;
  roomConversationId: string | null;
  roomStatus: "active" | "archived" | null;
  subjectMembershipStatus: "active" | "left" | "removed" | null;
  observerMembershipStatus: "active" | "left" | "removed" | null;
}): boolean {
  return (
    input.displayStatus !== "offline" &&
    input.roomConversationId !== null &&
    input.roomStatus === "active" &&
    input.subjectMembershipStatus === "active" &&
    input.observerMembershipStatus === "active"
  );
}
