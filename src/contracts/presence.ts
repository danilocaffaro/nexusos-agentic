export const PRESENCE_STATUSES = ["available", "focus", "dnd"] as const;

export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];
export type PresenceDisplayStatus = PresenceStatus | "offline";

export type PresenceRoom = {
  conversationId: string;
  title: string;
};

export type PresenceEntry = {
  principalId: string;
  displayName: string;
  principalKind: "human" | "agent" | "automation" | "policy" | "runner";
  status: PresenceDisplayStatus;
  room: PresenceRoom | null;
};

export type PresenceRoster = {
  generatedAtEpoch: number;
  entries: PresenceEntry[];
};

export type PresenceSessionCommand = {
  sessionKey: string;
  status: PresenceStatus;
  roomConversationId: string | null;
  fencingToken?: number;
};

export type PresenceSessionLease = {
  fencingToken: number;
  ttlSeconds: number;
  heartbeatSeconds: number;
  expiresAtEpoch: number;
  roomCleared: boolean;
};
