import type {
  ConversationKind,
  ConversationMember,
} from "@/src/contracts/collaboration";

type MembershipRole = ConversationMember["role"];
type MembershipStatus = ConversationMember["status"];

export class ConversationLifecycleError extends Error {
  constructor(
    readonly code:
      | "conversation_archived"
      | "conversation_owner_required"
      | "conversation_requires_owner"
      | "direct_membership_immutable"
      | "conversation_read_only",
    message: string,
  ) {
    super(message);
    this.name = "ConversationLifecycleError";
  }
}

export function assertCanAddConversationMember(input: {
  kind: ConversationKind;
  conversationStatus: "active" | "archived";
  actorRole: MembershipRole;
}): void {
  requireActiveConversation(input.conversationStatus);
  requireMutableMembership(input.kind);
  requireOwner(input.actorRole);
}

export function assertCanChangeConversationMember(input: {
  kind: ConversationKind;
  conversationStatus: "active" | "archived";
  actorRole: MembershipRole;
  actorId: string;
  targetId: string;
  targetRole: MembershipRole;
  targetStatus: MembershipStatus;
  nextRole: MembershipRole;
  nextStatus: MembershipStatus;
  activeOwnerCount: number;
}): void {
  requireActiveConversation(input.conversationStatus);
  requireMutableMembership(input.kind);

  const selfLeaving =
    input.actorId === input.targetId &&
    input.targetStatus === "active" &&
    input.nextStatus === "left" &&
    input.nextRole === input.targetRole;
  if (!selfLeaving) requireOwner(input.actorRole);

  const removesActiveOwner =
    input.targetRole === "owner" &&
    input.targetStatus === "active" &&
    (input.nextRole !== "owner" || input.nextStatus !== "active");
  // activeOwnerCount includes the target membership before this mutation.
  if (removesActiveOwner && input.activeOwnerCount <= 1) {
    throw new ConversationLifecycleError(
      "conversation_requires_owner",
      "A conversation must retain at least one active owner",
    );
  }
}

export function assertCanPinConversationMessage(input: {
  conversationStatus: "active" | "archived";
  actorRole: MembershipRole;
}): void {
  requireActiveConversation(input.conversationStatus);
  if (input.actorRole === "observer") {
    throw new ConversationLifecycleError(
      "conversation_read_only",
      "Observers cannot pin conversation messages",
    );
  }
}

export function assertCanUnpinConversationMessage(input: {
  conversationStatus: "active" | "archived";
  actorRole: MembershipRole;
  actorId: string;
  pinnedBy: string;
}): void {
  requireActiveConversation(input.conversationStatus);
  if (input.actorRole === "observer") {
    throw new ConversationLifecycleError(
      "conversation_read_only",
      "Observers cannot remove conversation pins",
    );
  }
  if (input.actorRole !== "owner" && input.actorId !== input.pinnedBy) {
    throw new ConversationLifecycleError(
      "conversation_owner_required",
      "Only the pin author or a conversation owner can remove a pin",
    );
  }
}

function requireActiveConversation(status: "active" | "archived"): void {
  if (status !== "active") {
    throw new ConversationLifecycleError(
      "conversation_archived",
      "Archived conversations are read-only",
    );
  }
}

function requireMutableMembership(kind: ConversationKind): void {
  if (kind === "direct") {
    throw new ConversationLifecycleError(
      "direct_membership_immutable",
      "Direct conversation membership is immutable",
    );
  }
}

function requireOwner(role: MembershipRole): void {
  if (role !== "owner") {
    throw new ConversationLifecycleError(
      "conversation_owner_required",
      "A conversation owner is required",
    );
  }
}
