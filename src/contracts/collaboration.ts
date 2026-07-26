export const CONVERSATION_KINDS = ["direct", "room", "handoff"] as const;
export const MESSAGE_KINDS = [
  "text",
  "system",
  "context_pin",
  "handoff_transfer",
] as const;

export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export type ConversationMember = {
  principalId: string;
  displayName: string;
  principalKind: "human" | "agent" | "automation" | "policy" | "runner";
  role: "owner" | "member" | "observer";
  status: "active" | "left" | "removed";
  version: number;
  joinedAt: string;
  leftAt: string | null;
};

export type ConversationSummary = {
  id: string;
  projectId: string | null;
  teamId: string | null;
  workItemId: string | null;
  intentId: string | null;
  kind: ConversationKind;
  title: string;
  status: "active" | "archived";
  version: number;
  currentPrincipalId: string;
  currentRole: ConversationMember["role"];
  createdAt: string;
  updatedAt: string;
  latestMessage: {
    sequence: number;
    senderId: string;
    bodyText: string | null;
    erased: boolean;
    createdAt: string;
  } | null;
  members: ConversationMember[];
};

export type ConversationMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderKind: ConversationMember["principalKind"];
  contentHash: string;
  sequence: number;
  kind: MessageKind;
  bodyText: string | null;
  erased: boolean;
  createdAt: string;
};

export type ConversationPin = {
  id: string;
  conversationId: string;
  messageId: string;
  pinnedBy: string;
  pinnedByName: string;
  status: "active" | "removed";
  version: number;
  pinnedAt: string;
  unpinnedAt: string | null;
  message: Pick<
    ConversationMessage,
    | "sequence"
    | "senderId"
    | "senderName"
    | "senderKind"
    | "kind"
    | "bodyText"
    | "erased"
    | "createdAt"
  >;
};
