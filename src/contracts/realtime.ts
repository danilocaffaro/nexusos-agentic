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
      recipients?: never;
    }
  | {
      kind: "attention";
      principalId: string;
      organizationId?: never;
      recipients?: never;
    }
  | {
      kind: "presence";
      organizationId?: never;
      recipients?: never;
    };

export const MAX_REALTIME_ENVELOPE_BYTES = 128 * 1024;
export const MAX_REALTIME_RECIPIENTS = 500;

export type RealtimeDeliveryEnvelope = {
  signal: RealtimeSignal;
  recipients: string[];
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

export function toRealtimeDeliveryEnvelope(
  signal: RealtimeSignal,
  recipients: string[],
): RealtimeDeliveryEnvelope {
  assertRealtimeSignal(signal);
  const uniqueRecipients = Array.from(
    new Set(recipients.map(requiredOpaqueId)),
  );
  if (uniqueRecipients.length > MAX_REALTIME_RECIPIENTS) {
    throw new RealtimeSignalError("realtime_invalid_recipients");
  }
  return {
    signal: normalizeRealtimeSignal(signal),
    recipients: uniqueRecipients,
  };
}

export function assertRealtimeDeliveryEnvelope(
  value: unknown,
): asserts value is RealtimeDeliveryEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new RealtimeSignalError("realtime_invalid_envelope");
  }
  const candidate = value as Record<string, unknown>;
  assertRealtimeSignal(candidate.signal);
  if (
    !Array.isArray(candidate.recipients) ||
    candidate.recipients.length > MAX_REALTIME_RECIPIENTS
  ) {
    throw new RealtimeSignalError("realtime_invalid_recipients");
  }
  const recipients = candidate.recipients.map(requiredOpaqueId);
  if (new Set(recipients).size !== recipients.length) {
    throw new RealtimeSignalError("realtime_invalid_recipients");
  }
}

export function assertRealtimeOpaqueId(
  value: unknown,
): asserts value is string {
  requiredOpaqueId(value);
}

function normalizeRealtimeSignal(signal: RealtimeSignal): RealtimeSignal {
  const wireSignal = toRealtimeWireSignal(signal);
  switch (wireSignal.kind) {
    case "conversation": {
      const normalized: ConversationRealtimeSignal = {
        kind: wireSignal.kind,
        organizationId: requiredOpaqueId(signal.organizationId),
        conversationId: wireSignal.conversationId,
      };
      if (wireSignal.sequenceHint !== undefined) {
        normalized.sequenceHint = wireSignal.sequenceHint;
      }
      return normalized;
    }
    case "attention":
      return {
        kind: wireSignal.kind,
        organizationId: requiredOpaqueId(signal.organizationId),
        principalId: wireSignal.principalId,
      };
    case "presence":
      return {
        kind: wireSignal.kind,
        organizationId: requiredOpaqueId(signal.organizationId),
      };
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
      | "realtime_invalid_kind"
      | "realtime_invalid_recipients"
      | "realtime_invalid_envelope",
  ) {
    super(code);
    this.name = "RealtimeSignalError";
  }
}
