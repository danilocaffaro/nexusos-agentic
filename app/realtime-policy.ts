import type { RealtimeWireSignal } from "@/src/contracts/realtime";

export type RealtimeClientStatus =
  | "probing"
  | "connecting"
  | "live"
  | "reconnect_wait"
  | "fallback";

export type RealtimeClientEvent =
  | RealtimeWireSignal
  | { kind: "resync" };

export type ParsedRealtimeFrame =
  | { kind: "pong" }
  | { kind: "signal"; signal: RealtimeWireSignal }
  | { kind: "invalid" };

const OPAQUE_ID = /^[A-Za-z0-9._:-]+$/;
export const INVALID_REALTIME_FRAME_CLOSE_CODE = 4001;

export function parseRealtimeFrame(value: unknown): ParsedRealtimeFrame {
  if (value === "pong") return { kind: "pong" };
  if (typeof value !== "string") return { kind: "invalid" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(parsed) || typeof parsed.kind !== "string") {
    return { kind: "invalid" };
  }

  if (
    parsed.kind === "presence" &&
    hasExactKeys(parsed, ["kind"])
  ) {
    return { kind: "signal", signal: { kind: "presence" } };
  }
  if (
    parsed.kind === "attention" &&
    hasExactKeys(parsed, ["kind", "principalId"]) &&
    isOpaqueId(parsed.principalId)
  ) {
    return {
      kind: "signal",
      signal: { kind: "attention", principalId: parsed.principalId },
    };
  }
  if (
    parsed.kind === "conversation" &&
    hasOnlyKeys(parsed, ["kind", "conversationId", "sequenceHint"]) &&
    hasRequiredKeys(parsed, ["kind", "conversationId"]) &&
    isOpaqueId(parsed.conversationId) &&
    (parsed.sequenceHint === undefined ||
      (Number.isSafeInteger(parsed.sequenceHint) &&
        Number(parsed.sequenceHint) >= 1))
  ) {
    const signal: RealtimeWireSignal = {
      kind: "conversation",
      conversationId: parsed.conversationId,
    };
    if (parsed.sequenceHint !== undefined) {
      signal.sequenceHint = Number(parsed.sequenceHint);
    }
    return { kind: "signal", signal };
  }
  return { kind: "invalid" };
}

export function reconnectDelayMs(
  failureAttempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    30_000,
    1_000 * 2 ** Math.max(0, failureAttempt),
  );
  return Math.floor(Math.max(0, Math.min(1, random())) * ceiling);
}

export function pollingDelayMs(input: {
  status: RealtimeClientStatus;
  baseDelayMs: number;
  failureCount: number;
  maximumDelayMs: number;
  liveDelayMs?: number;
}): number {
  const failureDelay = Math.min(
    input.maximumDelayMs,
    input.baseDelayMs * 2 ** Math.max(0, input.failureCount),
  );
  return input.status === "live"
    ? Math.max(input.liveDelayMs ?? 60_000, failureDelay)
    : failureDelay;
}

export function realtimeSignalKey(signal: RealtimeWireSignal): string {
  return signal.kind === "conversation"
    ? `conversation:${signal.conversationId}`
    : signal.kind;
}

export class RealtimeSignalBuffer {
  private readonly signals = new Map<string, RealtimeWireSignal>();

  add(signal: RealtimeWireSignal): void {
    this.signals.set(realtimeSignalKey(signal), signal);
  }

  drain(): RealtimeWireSignal[] {
    const drained = Array.from(this.signals.values());
    this.signals.clear();
    return drained;
  }

  get size(): number {
    return this.signals.size;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    OPAQUE_ID.test(value) &&
    /[A-Za-z0-9]/.test(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    hasRequiredKeys(value, expected) &&
    hasOnlyKeys(value, expected)
  );
}

function hasRequiredKeys(
  value: Record<string, unknown>,
  required: string[],
): boolean {
  return required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}
