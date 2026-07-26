export type ConversationRealtimeSignal = {
  kind: "conversation";
  organizationId: string;
  conversationId: string;
  sequenceHint?: number;
};

export type AttentionRealtimeSignal = {
  kind: "attention";
  organizationId: string;
  principalId: string;
};

export type PresenceRealtimeSignal = {
  kind: "presence";
  organizationId: string;
};

export type RealtimeSignal =
  | ConversationRealtimeSignal
  | AttentionRealtimeSignal
  | PresenceRealtimeSignal;

export type RealtimeWireSignal =
  | {
      kind: "conversation";
      conversationId: string;
      sequenceHint?: number;
      organizationId?: never;
    }
  | {
      kind: "attention";
      principalId: string;
      organizationId?: never;
    }
  | {
      kind: "presence";
      organizationId?: never;
    };

export function toRealtimeWireSignal(
  signal: RealtimeSignal,
): RealtimeWireSignal {
  switch (signal.kind) {
    case "conversation": {
      const wireSignal: RealtimeWireSignal = {
        kind: signal.kind,
        conversationId: requiredOpaqueId(signal.conversationId),
      };
      if (signal.sequenceHint !== undefined) {
        wireSignal.sequenceHint = requiredSequence(signal.sequenceHint);
      }
      return wireSignal;
    }
    case "attention":
      return {
        kind: signal.kind,
        principalId: requiredOpaqueId(signal.principalId),
      };
    case "presence":
      return { kind: signal.kind };
    default:
      return invalidSignalKind(signal);
  }
}

export function assertRealtimeSignal(
  signal: unknown,
): asserts signal is RealtimeSignal {
  if (typeof signal !== "object" || signal === null) {
    throw new RealtimeSignalError("realtime_invalid_kind");
  }

  const candidate = signal as Record<string, unknown>;
  requiredOpaqueId(candidate.organizationId);

  switch (candidate.kind) {
    case "conversation":
      requiredOpaqueId(candidate.conversationId);
      if (candidate.sequenceHint !== undefined) {
        requiredSequence(candidate.sequenceHint);
      }
      return;
    case "attention":
      requiredOpaqueId(candidate.principalId);
      return;
    case "presence":
      return;
    default:
      throw new RealtimeSignalError("realtime_invalid_kind");
  }
}

function requiredOpaqueId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value) ||
    !/[A-Za-z0-9]/.test(value)
  ) {
    throw new RealtimeSignalError("realtime_invalid_id");
  }
  return value;
}

function requiredSequence(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new RealtimeSignalError("realtime_invalid_sequence");
  }
  return value;
}

function invalidSignalKind(signal: never): never {
  void signal;
  throw new RealtimeSignalError("realtime_invalid_kind");
}

export class RealtimeSignalError extends Error {
  constructor(
    public readonly code:
      | "realtime_invalid_id"
      | "realtime_invalid_sequence"
      | "realtime_invalid_kind",
  ) {
    super(code);
    this.name = "RealtimeSignalError";
  }
}
